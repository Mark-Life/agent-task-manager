/**
 * The two things the bot says about itself: that it is going down, and that it
 * is back.
 *
 * From the chat side a restart is indistinguishable from being ignored, and the
 * bot drops every update that arrived while it was away — `runBot` polls with
 * `dropPendingUpdates`, deliberately — so the silence is not only unexplained,
 * it swallowed whatever was sent into it. One line at boot is what turns that
 * into something a person can act on.
 *
 * **A process start is the only event there is.** grammy reconnects a dropped
 * long-poll inside `bot.start` without the process noticing, and the
 * notification listener retries its own connection on a schedule, so nothing
 * short of a new process ever reaches this module. "Cold start versus
 * reconnect" is therefore not a judgement made here: a reconnect cannot get
 * here, and every start is a cold one. What has to be judged is the other
 * failure — a crash loop or a rolling deploy announcing itself ten times.
 *
 * **The suppression is on the ledger, not in this process.** A process that
 * restarts has no memory, so an in-memory "last announced" would be reset by
 * exactly the event it exists to count. The claim ledger already answers "has
 * anybody said this recently" across processes, so the rule is: read the newest
 * notice of the kind about to be sent, and stay quiet if it is inside the quiet
 * window. The dedupe key is bucketed by that same window, which closes the race
 * two processes starting together would otherwise win twice — and the two
 * agree, because two instants more than one window apart always fall in
 * different buckets.
 *
 * **The pair is what makes downtime knowable.** Nothing else in the system
 * records when it stopped. A graceful stop claims `system_down` and the next
 * start reads it back: a `system_down` newer than the last `system_up` means
 * somebody asked this process to stop, which is a deploy or a planned restart,
 * and the gap between the two is how long the chat was quiet. No such row means
 * the process never got to say goodbye — a crash, an OOM, a hard reboot — and
 * the message says that instead of inventing a duration.
 *
 * What is deliberately *not* here is which cards were affected. The run rows do
 * survive: the loop closes anything still marked live as `lost` when it
 * recovers. But that is the loop's pass, running in another process at the same
 * moment as this one, so a read from here is a race — and a run the bot found
 * still live may be a perfectly healthy run belonging to a loop nobody
 * restarted. The place that knows exactly which runs were lost is the recovery
 * that closed them.
 */

import { ChatNotificationRepo } from "@workspace/db";
import type { SystemNotifyKind, WorkspaceId } from "@workspace/domain";
import { DateTime, Effect } from "effect";
import { Allowlist } from "../telegram/allowlist";
import { bold, code } from "../telegram/format";
import { formatDuration } from "../telegram/helpers";
import { Notifier } from "./send";

/**
 * How long the bot stays quiet about itself after saying something.
 *
 * Fifteen minutes: long enough that a supervisor restarting a crashing process
 * every few seconds produces one line rather than a wall of them, short enough
 * that two deploys in an afternoon are both announced.
 */
export const DEFAULT_ANNOUNCE_QUIET_MS = 900_000;

/**
 * How long the announcement may take before the boot or the shutdown it is
 * attached to gives up on it.
 *
 * Bounded because of where it runs: at shutdown this is inside a finalizer, and
 * a Telegram call that hangs there eats the process's whole shutdown budget and
 * ends in the watchdog's hard exit.
 */
export const ANNOUNCE_TIMEOUT_MS = 5000;

/** Why nothing was said. Carried into the log so a missing line is explicable. */
export type AnnounceSilence = "announced_recently";

/** How the process before this one ended, as far as the ledger can tell. */
export type PreviousStop = "clean" | "unrecorded";

/**
 * What to do about this process start.
 *
 * A union rather than a boolean beside two optionals: the downtime and the kind
 * of stop are only ever measured on the branch that speaks.
 */
export type StartupVerdict =
  | { readonly kind: "silent"; readonly reason: AnnounceSilence }
  | {
      readonly kind: "announce";
      /** How long the chat was quiet, or null when nothing recorded the stop. */
      readonly downtimeMs: number | null;
      readonly stop: PreviousStop;
    };

/** What to do about this process stopping. */
export type ShutdownVerdict =
  | { readonly kind: "silent"; readonly reason: AnnounceSilence }
  | { readonly kind: "announce" };

/**
 * Whether a mark is inside the quiet window.
 *
 * A mark in the future — a clock that went backwards, two hosts disagreeing —
 * counts as recent, which errs toward saying nothing. The failure mode of the
 * other choice is the exact flood this window exists to prevent.
 */
const withinQuietWindow = (options: {
  readonly markMs: number | null;
  readonly nowMs: number;
  readonly quietMs: number;
}) =>
  options.markMs !== null && options.nowMs - options.markMs < options.quietMs;

/**
 * What this start is worth saying, given what the ledger already holds.
 *
 * Pure, and given epoch millis rather than a clock, so the interesting cases —
 * a crash loop, a deploy, a first ever boot — are a table in a test rather than
 * something only a real restart can produce.
 */
export const startupVerdict = (options: {
  readonly lastDownAtMs: number | null;
  readonly lastUpAtMs: number | null;
  readonly nowMs: number;
  readonly quietMs: number;
}): StartupVerdict => {
  const { lastDownAtMs, lastUpAtMs, nowMs, quietMs } = options;
  if (withinQuietWindow({ markMs: lastUpAtMs, nowMs, quietMs })) {
    return { kind: "silent", reason: "announced_recently" };
  }
  // A stop is this one's stop only if nothing has announced a start since it.
  // An older `system_down` belongs to a restart already spoken for, and dating
  // this downtime from it would report hours the system spent working.
  const clean =
    lastDownAtMs !== null && (lastUpAtMs === null || lastDownAtMs > lastUpAtMs);
  return clean
    ? {
        downtimeMs: Math.max(0, nowMs - lastDownAtMs),
        kind: "announce",
        stop: "clean",
      }
    : { downtimeMs: null, kind: "announce", stop: "unrecorded" };
};

/** What this stop is worth saying. The same window, counted over stops. */
export const shutdownVerdict = (options: {
  readonly lastDownAtMs: number | null;
  readonly nowMs: number;
  readonly quietMs: number;
}): ShutdownVerdict =>
  withinQuietWindow({
    markMs: options.lastDownAtMs,
    nowMs: options.nowMs,
    quietMs: options.quietMs,
  })
    ? { kind: "silent", reason: "announced_recently" }
    : { kind: "announce" };

/**
 * The key every process starting inside one window computes identically.
 *
 * The bucket is the window, so the read above and this insert cannot disagree:
 * two starts far enough apart to pass the read are far enough apart to land in
 * different buckets, and two inside one window collide here even if they read
 * the ledger at the same instant and both saw nothing.
 */
export const systemDedupeKey = (options: {
  readonly kind: SystemNotifyKind;
  readonly nowMs: number;
  readonly quietMs: number;
}) =>
  `${options.kind}:${Math.floor(options.nowMs / Math.max(1, options.quietMs))}`;

/** How much of an ISO instant reads as a date and a time: `2026-08-07T09:14`. */
const ISO_MINUTE_CHARS = 16;

/**
 * A wall-clock stamp a person can match against a deploy.
 *
 * To the minute and in UTC, with the date on it: seconds are noise on a
 * restart, and a bot that was down overnight would otherwise report a time of
 * day with no day beside it.
 */
const stamp = (at: DateTime.Utc) =>
  `${DateTime.toDateUtc(at)
    .toISOString()
    .slice(0, ISO_MINUTE_CHARS)
    .replace("T", " ")} UTC`;

/** How much of a commit hash a person needs to match one against a deploy. */
const SHORT_SHA_CHARS = 7;

/**
 * Which build this process is running, or null when nothing said.
 *
 * Read from what the deployment already sets for telemetry rather than from a
 * variable of the bot's own: `SERVICE_VERSION` and `GIT_SHA` are on every event
 * this process emits, and a restart message naming a different build than the
 * traces would be worse than one naming none.
 */
export const buildLabel = (options: {
  readonly gitSha: string | null;
  readonly serviceVersion: string | null;
}) => {
  const sha = options.gitSha?.slice(0, SHORT_SHA_CHARS) ?? null;
  if (options.serviceVersion === null) {
    return sha;
  }
  return sha === null
    ? options.serviceVersion
    : `${options.serviceVersion} (${sha})`;
};

/**
 * The line a person reads when the bot comes back.
 *
 * The dropped-updates sentence is not filler: `runBot` starts the poller with
 * `dropPendingUpdates`, so anything sent during the silence is gone rather than
 * queued, and a person who is not told that waits for an answer to a message
 * nothing will ever read.
 */
export const renderSystemUp = (options: {
  readonly at: DateTime.Utc;
  readonly build: string | null;
  readonly downtimeMs: number | null;
  readonly stop: PreviousStop;
}) => {
  const lines = [`♻️ ${bold("System restarted")}`];
  const down = formatDuration(options.downtimeMs);
  lines.push(
    options.stop === "clean"
      ? `Back up at ${stamp(options.at)}${down === null ? "" : `, down for ${down}`} — it was stopped on purpose, so a deploy or a planned restart.`
      : `Back up at ${stamp(options.at)}. Nothing recorded a clean stop, so this was a crash or a hard reboot.`
  );
  if (options.build !== null) {
    lines.push(`Running ${code(options.build)}`);
  }
  lines.push(
    "Anything sent while I was down did not reach me — send it again."
  );
  return lines.join("\n");
};

/** The line a person reads when the bot is asked to stop and has time to say so. */
export const renderSystemDown = (options: {
  readonly at: DateTime.Utc;
  readonly build: string | null;
}) => {
  const lines = [
    `🛑 ${bold("System going down")}`,
    `Stopping at ${stamp(options.at)} — a deploy or a restart. I will say when I am back.`,
  ];
  if (options.build !== null) {
    lines.push(`Was running ${code(options.build)}`);
  }
  return lines.join("\n");
};

/** What both announcements need to know about this deployment. */
export interface SystemAnnounceOptions {
  /** The version and commit this process is running, or null when unstated. */
  readonly build: string | null;
  readonly quietMs?: number;
}

/** The claim time of a notice, as epoch millis, or null when there is none. */
const claimedAtMs = (
  notice: { readonly createdAt: DateTime.Utc } | null
): number | null =>
  notice === null ? null : DateTime.toEpochMillis(notice.createdAt);

/**
 * One announcement, through the same claim-send-stamp the run notices use.
 *
 * On the ledger rather than beside it because that is the only place the
 * suppression can live, and because "everything the bot volunteered" is a
 * question one table has to be able to answer.
 */
const dispatchSystemNotice = Effect.fnUntraced(function* (input: {
  readonly kind: SystemNotifyKind;
  readonly nowMs: number;
  readonly quietMs: number;
  readonly text: string;
  readonly workspaceId: WorkspaceId;
}) {
  const notifier = yield* Notifier;
  const sent = yield* notifier.dispatch({
    dedupeKey: systemDedupeKey({
      kind: input.kind,
      nowMs: input.nowMs,
      quietMs: input.quietMs,
    }),
    keyboard: null,
    kind: input.kind,
    runId: null,
    // No task asked for this one, and the table's CHECK is what says so.
    taskId: null,
    text: input.text,
    workspaceId: input.workspaceId,
  });
  if (sent === null) {
    yield* Effect.logInfo("system notice not delivered", {
      kind: input.kind,
      workspaceId: input.workspaceId,
    });
  }
});

/**
 * Runs one workspace's announcement without letting it matter.
 *
 * Neither of these is worth failing a boot or holding up a shutdown for: the
 * bot answering messages is the service, and a line about a restart is a
 * courtesy. Every failure ends as one warning naming the workspace.
 */
const attempt = <A, E, R>(options: {
  readonly effect: Effect.Effect<A, E, R>;
  readonly kind: SystemNotifyKind;
  readonly workspaceId: WorkspaceId;
}) =>
  options.effect.pipe(
    Effect.asVoid,
    Effect.timeoutOrElse({
      duration: `${ANNOUNCE_TIMEOUT_MS} millis`,
      orElse: () =>
        Effect.logWarning("system notice timed out", {
          kind: options.kind,
          workspaceId: options.workspaceId,
        }),
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("system notice failed", cause).pipe(
        Effect.annotateLogs({
          kind: options.kind,
          workspaceId: options.workspaceId,
        })
      )
    )
  );

/**
 * Says the bot is back, in every workspace it serves, unless it said so
 * recently.
 *
 * Called once per process, after the handlers are registered: an announcement
 * a person can reply to is worth more than one that arrives a second earlier.
 */
export const announceStartup = Effect.fn("System.announceStartup")(function* (
  options: SystemAnnounceOptions
) {
  const quietMs = options.quietMs ?? DEFAULT_ANNOUNCE_QUIET_MS;
  const allowlist = yield* Allowlist;
  const notifications = yield* ChatNotificationRepo;
  const now = yield* DateTime.now;
  const nowMs = DateTime.toEpochMillis(now);

  yield* Effect.forEach(allowlist.workspaceIds, (workspaceId) =>
    attempt({
      effect: Effect.gen(function* () {
        const lastUp = yield* notifications.newestOfKind({
          kind: "system_up",
          workspaceId,
        });
        const lastDown = yield* notifications.newestOfKind({
          kind: "system_down",
          workspaceId,
        });
        const verdict = startupVerdict({
          lastDownAtMs: claimedAtMs(lastDown),
          lastUpAtMs: claimedAtMs(lastUp),
          nowMs,
          quietMs,
        });
        if (verdict.kind === "silent") {
          yield* Effect.logInfo("restart announcement suppressed", {
            quietMs,
            reason: verdict.reason,
            workspaceId,
          });
          return;
        }
        yield* dispatchSystemNotice({
          kind: "system_up",
          nowMs,
          quietMs,
          text: renderSystemUp({
            at: now,
            build: options.build,
            downtimeMs: verdict.downtimeMs,
            stop: verdict.stop,
          }),
          workspaceId,
        });
      }),
      kind: "system_up",
      workspaceId,
    })
  );
});

/**
 * Says the bot is going away, if the stop was orderly enough to reach here.
 *
 * A kill, an OOM or a power cut never runs this, which is exactly what makes
 * the row it writes worth reading: its absence at the next start is the
 * difference between a deploy and a crash.
 */
export const announceShutdown = Effect.fn("System.announceShutdown")(function* (
  options: SystemAnnounceOptions
) {
  const quietMs = options.quietMs ?? DEFAULT_ANNOUNCE_QUIET_MS;
  const allowlist = yield* Allowlist;
  const notifications = yield* ChatNotificationRepo;
  const now = yield* DateTime.now;
  const nowMs = DateTime.toEpochMillis(now);

  yield* Effect.forEach(allowlist.workspaceIds, (workspaceId) =>
    attempt({
      effect: Effect.gen(function* () {
        const lastDown = yield* notifications.newestOfKind({
          kind: "system_down",
          workspaceId,
        });
        const verdict = shutdownVerdict({
          lastDownAtMs: claimedAtMs(lastDown),
          nowMs,
          quietMs,
        });
        if (verdict.kind === "silent") {
          yield* Effect.logInfo("shutdown announcement suppressed", {
            quietMs,
            reason: verdict.reason,
            workspaceId,
          });
          return;
        }
        yield* dispatchSystemNotice({
          kind: "system_down",
          nowMs,
          quietMs,
          text: renderSystemDown({ at: now, build: options.build }),
          workspaceId,
        });
      }),
      kind: "system_down",
      workspaceId,
    })
  );
});
