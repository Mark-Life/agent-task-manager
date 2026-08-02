/**
 * One turn, start to finish: the directories it works in, the events it says,
 * and the close that follows whichever way it ended.
 *
 * **The event file is the run's own record, and `seq` is a line ordinal.** Each
 * normalized event is appended to `events.jsonl` in the run directory and
 * inserted into `run_events` under the ordinal of its line, so re-ingesting the
 * file collides on `(runId, seq)` row for row instead of writing a second,
 * shifted copy of the timeline. The counter advances even when a row fails to
 * store, which is what keeps the two views of one run in step — and it is why
 * `./ingest` can re-read the same file afterwards without duplicating anything.
 *
 * **Silence is an ending.** A provider that goes away mid-stream emits nothing
 * at all — no terminus, no error — so a stream that finishes without a `result`
 * is closed as `lost` rather than waited on. A provider that goes quiet without
 * ending the stream says even less, and the deadline is what turns that into an
 * ending too. Those two, a crash, and a clean finish are the endings, and every
 * one of them lands the task in *review*; see `./terminal`.
 *
 * **What is not here.** No retry, no park, no lease, no concurrency: a failure
 * closes the run and hands the decision back to whoever claimed it. Nothing in
 * this file decides to run a task, and nothing in it decides to run one again.
 * Which session it is and which attempt is `./open-run`.
 */

import { RunEventRepo, RunRepo, withActor } from "@workspace/db";
import {
  type AgentEvent,
  AgentEventRecord,
  agentHomeRelativePath,
  COMMENT_MARKER_ENV_VAR,
  commentMarkerPathOf,
  ProviderRegistry,
  scopedAgentHome,
  TimedOut,
} from "@workspace/harness";
import { identityEnv, repoSourceFor, Workspace } from "@workspace/sandbox";
import { Cause, DateTime, Effect, Ref, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  eventLogPathOf,
  lostTerminus,
  projectIdOf,
  type RunTerminus,
  resumeSessionIdOf,
  runIdentityOf,
  taskIdOf,
  workspaceIdOf,
} from "./dispatch-context";
import { type MappingContext, toRunEventPayload } from "./mapping";
import { openRun, type RunClaim } from "./open-run";
import { buildRunPrompt, placementOf } from "./prompt";
import {
  closeRun,
  commentMarkerSeen,
  markCommentPosted,
  type TerminalReport,
} from "./terminal";
import {
  EMPTY_TURN_PROGRESS,
  observeTurn,
  type TurnProgress,
  terminusOfFailure,
} from "./turn-progress";

/** Encoder for one line of the run's event file, built once rather than per event. */
const encodeRecord = Schema.encodeEffect(AgentEventRecord);

/**
 * Which sandbox actually serves a run, and it is a constant because there is
 * currently only one implementation of the turn.
 *
 * The provider is started here, in this process, against host paths — so the
 * prompt names host paths and the run's row says `local`. Both follow from the
 * same fact and neither may be read off `SANDBOX_MODE`: a prompt naming
 * `/artifacts/task` to a process that can only see the data root sends the
 * agent to write into a directory that does not exist, and a row claiming
 * `docker` for a host process is the one lie the field exists to prevent.
 *
 * Running the turn inside a container needs an entrypoint in the image that
 * speaks the harness's event contract; until that exists, `SANDBOX_MODE=docker`
 * is a setting the loop reports and warns about rather than one it honours.
 */
export const SERVED_BY = "local" as const;

/** What running one turn needs beyond the context it runs under. */
export interface ExecuteRunInput {
  readonly context: DispatchContext;
  /**
   * Where on-disk state lives. Passed alongside the context rather than read
   * off it: the context carries the run's own layout, and the artifact folders
   * and the repo mirror are siblings of it rather than anything under it.
   */
  readonly dataRoot: string;
  /**
   * Environment handed to the provider on top of the run's own identity and
   * agent home — the stop-hook command and the Executor MCP credentials being
   * the two that matter. Never the host's OTLP token.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly progress: Ref.Ref<TurnProgress>;
  /**
   * How long the whole turn — checkout, prompt and stream — may take before it
   * is torn down as {@link TimedOut}.
   *
   * The cap belongs here rather than in the harness, which says so: a provider
   * that stops answering produces no event and no error, and without a deadline
   * over it the slot is held until somebody notices. Enforced across the setup
   * stages too, because a `git clone` against a host that black-holes packets
   * hangs exactly as quietly as a wedged model does.
   */
  readonly timeoutMs: number;
}

/**
 * Materializes the run's directories, runs the turn, and streams what it says
 * into the timeline.
 *
 * The scope is the run's lifetime: the checkout and the seeded agent home are
 * acquired inside it and released when it closes, on every path including an
 * interrupt. What survives is what should — the run directory with its event
 * file and its transcript, and the artifacts folder, which is the point.
 *
 * A failure of the turn itself is an answer rather than an error: it becomes a
 * failed terminus, because a crashed run is still a run that has to close out
 * and land its task in *review*. The deadline is the same kind of answer — see
 * {@link ExecuteRunInput.timeoutMs}. Only the stages before the turn — the
 * workspace, the credentials, the prompt — fail this effect, and the caller's
 * `onExit` closes the run out from those too.
 */
export const executeRun = (input: ExecuteRunInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { context, progress } = input;
      const fs = yield* FileSystem;
      const registry = yield* ProviderRegistry;
      const runEvents = yield* RunEventRepo;
      const runs = yield* RunRepo;
      const workspaces = yield* Workspace;

      const asActor = withActor(context.actor);
      const workspaceId = workspaceIdOf(context);
      const taskId = taskIdOf(context);
      const identity = runIdentityOf(context);
      const eventLogPath = eventLogPathOf(context);

      const made = yield* workspaces.materialize({
        dataRoot: input.dataRoot,
        identity,
        projectId: projectIdOf(context),
        repo: repoSourceFor({
          dataRoot: input.dataRoot,
          defaultBranch: context.project?.repoDefaultBranch ?? null,
          repoUrl: context.repoUrl,
          taskId,
        }),
      });
      yield* Ref.update(progress, (current) => ({
        ...current,
        branch: made.branch,
      }));

      const home = yield* scopedAgentHome({
        layout: context.layout,
        provider: context.provider,
        sourceDir: null,
      });

      // The prompt is built after the directories exist, because it names them:
      // where to write an artifact worth keeping, and which branch the checkout
      // is on. It also advances the session's watermark, so the comments that
      // went into it are not delivered twice.
      const prompt = yield* buildRunPrompt({
        context,
        placement: placementOf({ kind: SERVED_BY, workspace: made }),
      });
      yield* Ref.update(progress, (current) => ({
        ...current,
        promptChars: prompt.chars,
      }));
      const mapping: MappingContext = {
        exitCode: null,
        promptChars: prompt.chars,
        sandboxImage: context.image,
      };

      /** One line of the run's own event file, appended before the row is stored. */
      const appendLine = (record: {
        readonly event: AgentEvent;
        readonly occurredAt: DateTime.Utc;
      }) =>
        encodeRecord(record).pipe(
          Effect.flatMap((encoded) =>
            fs.writeFileString(eventLogPath, `${JSON.stringify(encoded)}\n`, {
              flag: "a",
            })
          ),
          Effect.tapError((cause) =>
            Effect.logWarning("run event not written to the event file", {
              cause,
              path: eventLogPath,
            })
          ),
          Effect.ignore
        );

      const onEvent = (event: AgentEvent) =>
        Effect.gen(function* () {
          const before = yield* Ref.get(progress);
          const occurredAt = yield* DateTime.now;
          yield* appendLine({ event, occurredAt });

          // A row the database refuses is one line of the timeline lost, and
          // the file above still has it. The ordinal is spent either way, so a
          // later re-ingest lands the missing row in its own place rather than
          // shifting everything after it.
          yield* runEvents
            .append({
              occurredAt,
              payload: toRunEventPayload(event, mapping),
              runId: context.runId,
              seq: before.eventsSeen,
              taskId,
              workspaceId,
            })
            .pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("run event not stored", {
                  cause,
                  seq: before.eventsSeen,
                })
              ),
              Effect.ignore
            );

          const after = observeTurn(before, event);
          yield* Ref.set(progress, after);

          // The run is only `running` once the harness has answered, and this
          // is the one event that says what actually ran. Recording it here
          // rather than before the stream is what keeps `model` on the row and
          // `startedAt` a measurement rather than an intention.
          if (event.kind === "session_init") {
            yield* asActor(
              runs.start({
                agentHomePath: agentHomeRelativePath(context.runId),
                id: context.runId,
                model: event.model ?? undefined,
                sandboxImage: context.image,
                workspaceId,
              })
            ).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("run not marked started", { cause })
              ),
              Effect.ignore
            );
          }

          // The marker the stop hook reads. Written the moment the comment tool
          // answers, so a turn ending in the same second is not refused for a
          // comment it has already posted.
          if (after.commentPosted && !before.commentPosted) {
            yield* markCommentPosted(context);
          }
        });

      const events = registry.get(context.provider).run({
        agentHomeDir: home.agentHomeDir,
        effort: null,
        env: {
          ...identityEnv(identity),
          ...input.env,
          // The hook runs outside a container here, so it is told where the
          // marker really is rather than assuming the container's own path.
          [COMMENT_MARKER_ENV_VAR]: commentMarkerPathOf(context.layout),
          ...home.env,
        },
        model: null,
        prompt: prompt.text,
        resumeSessionId: resumeSessionIdOf(context),
        runId: context.runId,
        signal: null,
        taskId,
        workspaceDir: made.workspaceDir,
      });

      // Only the typed failure is caught. An interrupt is a stop command and
      // belongs to the caller's `onExit`, and a defect is a bug that should not
      // be filed as a run that merely errored.
      const failure: unknown = yield* Stream.runForEach(events, onEvent).pipe(
        Effect.as(null),
        Effect.catch((error) => Effect.succeed<unknown>(error))
      );

      const state = yield* Ref.get(progress);
      if (failure !== null) {
        return terminusOfFailure(failure, state);
      }
      return (
        state.terminus ??
        // No terminus and no failure: the process went away mid-stream. Its own
        // ending, because the count of how far it got is the only thing there
        // is to say about it.
        lostTerminus({
          eventsSeen: state.eventsSeen,
          exitCode: null,
          finalText: state.finalText,
          providerSessionId: state.providerSessionId,
        })
      );
    }).pipe(
      // The cap over everything above, and an ending rather than an error: a
      // turn that outlived its deadline is one more way a run finishes, so it
      // closes out through the same path a crash does. `Harness.TimedOut` is
      // the class the vocabulary already has for it — the harness names it and
      // deliberately enforces none — so the row says `timeout` and the thread
      // says which cap, instead of a wedged run being filed as the same
      // `interrupted` a human pressing Stop produces.
      //
      // The whole body is under it, not only the stream: a `git clone` against
      // a host that black-holes packets hangs exactly as quietly as a wedged
      // model does, and the scope releases the checkout on the way out either
      // way.
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: () =>
          Effect.map(Ref.get(input.progress), (state) =>
            terminusOfFailure(
              new TimedOut({ timeoutMs: input.timeoutMs }),
              state
            )
          ),
      })
    )
  ).pipe(Effect.withSpan("Run.execute"));

/** What running one claimed task needs. */
export interface PerformRunInput {
  readonly claim: RunClaim;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** What one run leaves behind: the context it ran under and how it was closed. */
export interface RunOutcomeReport {
  readonly context: DispatchContext;
  /**
   * Null only if the terminal path never ran, which the runtime does not do —
   * the close is a finalizer and finalizers are uninterruptible.
   */
  readonly report: TerminalReport | null;
  readonly terminus: RunTerminus;
}

/** Everything the run knew at the moment it finished closing itself out. */
export interface RunClosed {
  readonly context: DispatchContext;
  /** What the turn accumulated, read after the close rather than before it. */
  readonly progress: TurnProgress;
  readonly report: TerminalReport;
  readonly terminus: RunTerminus;
}

/**
 * Running a run whose rows already exist. Generic in what the close hook needs,
 * so the loop can read the run's directory back through its own repositories
 * without this file naming them.
 */
export interface RunOpenedInput<R = never> {
  readonly context: DispatchContext;
  readonly dataRoot: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Called once, immediately after the run is closed out and on every exit path
   * the close itself runs on — including the interrupt a stop command produces.
   * This is where reading the run's directory back belongs: the container is
   * gone by then, and a caller that waited for the value would never run it on
   * the path where there is no value.
   *
   * Total by contract. A hook that could fail would be a run that closed and
   * then failed to close.
   */
  readonly onClose?: (closed: RunClosed) => Effect.Effect<void, never, R>;
  /** The turn's deadline. Required, because a run with no cap holds its slot forever. */
  readonly timeoutMs: number;
}

/**
 * The turn and the close, over a run that has already been opened.
 *
 * Split from {@link performRun} because the wide event wraps this half and not
 * the other: `atm.run` names a `runId`, which only exists once the rows are
 * written, and the span it reports on is the one that starts at the claim. A
 * caller that wants both halves and no event calls {@link performRun}.
 *
 * The close hangs off `onExit` rather than following the turn, because the two
 * endings that are not a value — an interrupt from a stop command, and a
 * failure in one of the setup stages — have to close the run just as firmly as
 * a terminus does. A run that is not closed is a task waiting forever on a
 * container that is already gone.
 */
export const runOpened = <R = never>(input: RunOpenedInput<R>) =>
  Effect.gen(function* () {
    const { context } = input;
    const progress = yield* Ref.make(EMPTY_TURN_PROGRESS);
    const closed = yield* Ref.make<TerminalReport | null>(null);

    /** Closes the run from whatever the turn ended as, including a cause. */
    const closeFrom = (ending: RunTerminus) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(progress);
        // Two authors for one fact: the loop watching the stream, and a
        // provider that wires the comment tool in-process and creates the
        // marker itself. Either is enough to spend the fallback.
        const marked = yield* commentMarkerSeen(context);
        const report = yield* closeRun({
          branch: state.branch,
          commentPosted: state.commentPosted || marked,
          context,
          terminus: ending,
        });
        yield* Ref.set(closed, report);
        // After the close, so what the hook reads off the run's directory is
        // everything the run wrote and nothing it was still writing.
        yield* input.onClose?.({
          context,
          progress: state,
          report,
          terminus: ending,
        }) ?? Effect.void;
      });

    const terminus = yield* executeRun({
      context,
      dataRoot: input.dataRoot,
      env: input.env ?? {},
      progress,
      timeoutMs: input.timeoutMs,
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success"
          ? closeFrom(exit.value)
          : Effect.gen(function* () {
              const state = yield* Ref.get(progress);
              // An interrupt squashes to an interruption, which the harness's
              // own classifier already names — so a stopped run is filed as
              // `interrupted` rather than as an unnamed error.
              yield* closeFrom(
                terminusOfFailure(Cause.squash(exit.cause), state)
              );
            })
      )
    );

    return {
      context,
      report: yield* Ref.get(closed),
      terminus,
    } satisfies RunOutcomeReport;
  }).pipe(Effect.withSpan("Run.opened"));

/**
 * The whole lifecycle: open the rows, run the turn, close it out. What a caller
 * with a claim and no interest in the run's own record uses; the loop opens the
 * run itself, because the wide event is built around the ids opening produces.
 */
export const performRun = (input: PerformRunInput) =>
  Effect.gen(function* () {
    const context = yield* openRun(input.claim);
    return yield* runOpened({
      context,
      dataRoot: input.claim.dataRoot,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });
  }).pipe(Effect.withSpan("Run.perform"));
