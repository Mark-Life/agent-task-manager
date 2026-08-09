/**
 * The tick that applies the stuck rule to every live run, and the message a
 * person gets when it fires.
 *
 * It runs in the bot because the bot is where the answer has to be delivered:
 * the orchestrator can see the same rows and has no chat to say them in. The
 * scan itself decides nothing — it surfaces a run, names what it has been
 * repeating and for how long, and leaves stopping it or leaving it alone to
 * the person or the manager.
 *
 * Two pieces of state, both read positions rather than records. The cursor is
 * the last `run_event.seq` this fiber has read for a run, so a tick reads only
 * what is new; beside it sits the tool calls of the last couple of windows,
 * which is what makes a ten-minute judgement possible on a one-minute tick
 * without re-reading the whole timeline. Both are rebuilt from `run_event`
 * after a restart, and neither is a second count of anything: the rows are the
 * record, and a run that has just been picked up simply looks quiet until a
 * window of them accrues.
 *
 * Delivery is somebody else's: resolving which chat a task belongs to and
 * claiming the send is the notification path's job, and duplicating either here
 * would be a second answer to "which chat" that could disagree with the first.
 * What this module hands over is a complete alert — including the dedupe key
 * that holds a still-stuck run to one message per window rather than one per
 * tick — and the rendered message that goes with it.
 */

import { RunEventRepo, RunRepo, TaskRepo } from "@workspace/db";
import type {
  Run,
  RunEvent,
  RunId,
  Task,
  WorkspaceId,
} from "@workspace/domain";
import { Context, DateTime, Effect, Layer, Ref, Stream } from "effect";
import { bold, code, taskLine } from "../telegram/format";
import { formatDuration } from "../telegram/helpers";
import { runNoticeKeyboard } from "../telegram/keyboard";
import {
  STUCK_EVENT_PAGE,
  STUCK_EVENT_PAGES,
  STUCK_RETAINED_WINDOWS,
  stuckConfig,
} from "./config";
import type { RunEventSample } from "./rule";
import { stuckVerdict } from "./rule";

const MS_PER_MINUTE = 60_000;

/** `listByRun` filters on `seq >` its cursor, and the first event of a run is `seq` 0. */
const BEFORE_FIRST_SEQ = -1;

/** What this fiber has read of one run, and the tail it is judging. */
interface RunCursor {
  readonly afterSeq: number;
  readonly events: readonly RunEventSample[];
}

/**
 * One run that has stopped getting anywhere, with everything a message about it
 * needs. The task travels with the run because a person is told about work, not
 * about a container.
 */
export interface StuckAlert {
  /**
   * `stuck:<runId>:<window ordinal>` — the same value for every tick inside one
   * window, so claiming it is what turns a run that stays stuck into one
   * message per window instead of one per minute.
   */
  readonly dedupeKey: string;
  readonly run: Run;
  /** The distinct `toolName summary` values it kept repeating. */
  readonly signatures: readonly string[];
  readonly stuckForMs: number;
  readonly task: Task;
  readonly toolCalls: number;
}

/**
 * Where an alert goes. A service rather than a call into the notification
 * modules, because the scan must not know how a chat is resolved or how a send
 * is claimed — and because a bot wired without a chat to talk to should still
 * be able to run the scan.
 *
 * The implementation reports its own failures: nothing here is important
 * enough to end a scan over.
 */
export class StuckAnnouncer extends Context.Service<
  StuckAnnouncer,
  { readonly announce: (alert: StuckAlert) => Effect.Effect<void> }
>()("@workspace/bot/StuckAnnouncer") {
  /** An announcer that says nothing, for a process with no chat transport. */
  static readonly silent = Layer.succeed(StuckAnnouncer, {
    announce: () => Effect.void,
  });
}

/** The window a run's elapsed time falls in, which is what the dedupe key counts. */
export const stuckDedupeKey = (options: {
  readonly runId: RunId;
  readonly sinceStartMs: number;
  readonly windowMinutes: number;
}) => {
  const windowMs = Math.max(1, options.windowMinutes) * MS_PER_MINUTE;
  const window = Math.floor(options.sinceStartMs / windowMs);
  return `stuck:${options.runId}:${window}`;
};

/**
 * The message a person reads: which task, which run, how long it has looked
 * stuck, what it kept doing, and the two things they can do about it.
 *
 * The keyboard is the run-notice one — *Stop*, *Rerun*, *Message* — because
 * leaving it alone is the option that needs no button, and approving work is a
 * decision that belongs on a task message where the status is visible.
 */
export const renderStuckAlert = (options: {
  readonly alert: StuckAlert;
  readonly taskUrl?: string | null;
  readonly windowMinutes: number;
}) => {
  const { alert, taskUrl = null, windowMinutes } = options;
  const elapsed = formatDuration(alert.stuckForMs) ?? "a while";
  const lines = [
    `⚠️ ${bold("This run looks stuck")}`,
    taskLine({
      id: alert.task.id,
      status: alert.task.status,
      title: alert.task.title,
    }),
    `No file edits for ${elapsed}. ${alert.toolCalls} tool calls in the last ${windowMinutes} min, all of:`,
    ...alert.signatures.map((signature) => code(signature)),
    `run ${code(alert.run.id)} · attempt ${alert.run.attempt}`,
    "Stop it, or leave it running — it may still get there.",
  ];
  return {
    keyboard: runNoticeKeyboard({ taskId: alert.task.id, taskUrl }),
    text: lines.join("\n"),
  };
};

/** The two fields the rule reads, off rows that carry more than it needs. */
const samplesOf = (events: readonly RunEvent[]): readonly RunEventSample[] =>
  events.flatMap((event) =>
    event.payload.kind === "tool_call"
      ? [{ occurredAt: event.occurredAt, payload: event.payload }]
      : []
  );

const make = Effect.gen(function* () {
  const config = yield* stuckConfig;
  const events = yield* RunEventRepo;
  const runs = yield* RunRepo;
  const tasks = yield* TaskRepo;
  const announcer = yield* StuckAnnouncer;

  const cursors = yield* Ref.make(new Map<RunId, RunCursor>());

  const retainMs =
    config.thresholds.windowMinutes * STUCK_RETAINED_WINDOWS * MS_PER_MINUTE;

  /**
   * Everything a run has said since the cursor, in pages. A run chattier than
   * one tick's worth of pages is read the rest of the way on the next tick,
   * which costs latency and never memory.
   */
  const readSince = (input: {
    readonly afterSeq: number;
    readonly pages: number;
    readonly runId: RunId;
    readonly workspaceId: WorkspaceId;
  }): Effect.Effect<
    readonly RunEvent[],
    Effect.Error<ReturnType<typeof events.listByRun>>
  > =>
    Effect.gen(function* () {
      const page = yield* events.listByRun({
        afterSeq: input.afterSeq,
        limit: STUCK_EVENT_PAGE,
        runId: input.runId,
        workspaceId: input.workspaceId,
      });
      const last = page.at(-1);
      if (
        last === undefined ||
        page.length < STUCK_EVENT_PAGE ||
        input.pages <= 1
      ) {
        return page;
      }
      const rest = yield* readSince({
        ...input,
        afterSeq: last.seq,
        pages: input.pages - 1,
      });
      return [...page, ...rest];
    });

  /** One run's new events folded into its cursor, and the verdict on the result. */
  const judge = Effect.fn("StuckScan.judge")(function* (input: {
    readonly now: DateTime.Utc;
    readonly run: Run;
  }) {
    const { now, run } = input;
    const held = yield* Ref.get(cursors);
    const cursor = held.get(run.id) ?? {
      afterSeq: BEFORE_FIRST_SEQ,
      events: [],
    };

    const fresh = yield* readSince({
      afterSeq: cursor.afterSeq,
      pages: STUCK_EVENT_PAGES,
      runId: run.id,
      workspaceId: run.workspaceId,
    });

    const horizon = DateTime.toEpochMillis(now) - retainMs;
    const kept = [...cursor.events, ...samplesOf(fresh)].filter(
      (event) => DateTime.toEpochMillis(event.occurredAt) >= horizon
    );

    return {
      cursor: {
        afterSeq: fresh.at(-1)?.seq ?? cursor.afterSeq,
        events: kept,
      } satisfies RunCursor,
      verdict: stuckVerdict({
        events: kept,
        now,
        startedAt: run.startedAt,
        thresholds: config.thresholds,
      }),
    };
  });

  /**
   * One pass over a workspace's live runs. Returns what it found, so a check
   * script can assert on the finding rather than on a message having been sent.
   *
   * A run that fails to read is logged and skipped: one unreadable timeline is
   * not a reason to stop watching the rest, and the next tick tries it again.
   */
  const scanOnce = Effect.fn("StuckScan.scanOnce")(function* (input: {
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });
    const now = yield* DateTime.now;
    const live = yield* runs.listLive({ workspaceId: input.workspaceId });
    // Worker runs only. A conversation's turn is minutes at most and has no
    // task to announce against, so the repetition rule has nothing to say
    // about one and nowhere to say it.
    const working = live.filter((run) => run.taskId !== null);

    const judged = yield* Effect.forEach(working, (run) =>
      judge({ now, run }).pipe(
        Effect.map((result) => ({ ...result, run })),
        Effect.catchCause((cause) =>
          Effect.logWarning("stuck scan: run unreadable", cause).pipe(
            Effect.annotateLogs({ runId: run.id }),
            Effect.as(null)
          )
        )
      )
    );

    // Rebuilt from the live list rather than pruned, so a run that ended takes
    // its buffer with it and the map cannot outgrow the board.
    yield* Ref.set(
      cursors,
      new Map(
        judged.flatMap((result) =>
          result === null ? [] : [[result.run.id, result.cursor] as const]
        )
      )
    );

    const alerts: StuckAlert[] = [];
    for (const result of judged) {
      if (
        result === null ||
        result.verdict.kind !== "stuck" ||
        result.run.taskId === null
      ) {
        continue;
      }
      const { taskId } = result.run;
      const task = yield* tasks
        .byId({ id: taskId, workspaceId: input.workspaceId })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("stuck scan: task unreadable", cause).pipe(
              Effect.annotateLogs({ taskId }),
              Effect.as(null)
            )
          )
        );
      if (task === null) {
        continue;
      }
      alerts.push({
        dedupeKey: stuckDedupeKey({
          runId: result.run.id,
          sinceStartMs:
            DateTime.toEpochMillis(now) -
            DateTime.toEpochMillis(result.run.startedAt ?? now),
          windowMinutes: config.thresholds.windowMinutes,
        }),
        run: result.run,
        signatures: result.verdict.signatures,
        stuckForMs: result.verdict.stuckForMs,
        task,
        toolCalls: result.verdict.toolCalls,
      });
    }

    yield* Effect.forEach(alerts, (alert) =>
      Effect.ignoreCause(announcer.announce(alert))
    );

    return alerts as readonly StuckAlert[];
  });

  /**
   * The watch, for as long as the fiber lives. `Stream.tick` emits once
   * immediately, so a restart looks at the board before it waits an interval —
   * and a run that was already stuck when the bot came back is judged as soon
   * as a window of its events has been read.
   */
  const watch = (input: { readonly workspaceIds: readonly WorkspaceId[] }) =>
    Stream.tick(config.scanIntervalMs).pipe(
      Stream.runForEach(() =>
        Effect.forEach(input.workspaceIds, (workspaceId) =>
          scanOnce({ workspaceId }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("stuck scan: pass failed", cause).pipe(
                Effect.annotateLogs({ workspaceId })
              )
            )
          )
        )
      )
    );

  return { config, scanOnce, watch } as const;
});

/**
 * The stuck-run watch: a tick, the rule, and an alert handed to whoever can
 * deliver it.
 */
export class StuckScan extends Context.Service<
  StuckScan,
  Effect.Success<typeof make>
>()("@workspace/bot/StuckScan") {
  static readonly layer = Layer.effect(StuckScan, make);
}
