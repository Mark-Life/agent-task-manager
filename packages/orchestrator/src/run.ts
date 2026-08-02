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
 * **One turn, two places it can happen.** A dispatched run is a container: the
 * spec goes into the run directory, the container writes its events into the
 * same directory, and `./container-turn` reads them back. The local mode runs
 * the provider in this process against host paths instead, and it is a
 * debugging escape hatch rather than a second way to dispatch. Which one served
 * a run is the resolved sandbox kind, it is what the prompt's paths are built
 * from, and it is what the run's row reports — the three follow from one fact,
 * and a row claiming `docker` for a host process is the confusion the field
 * exists to prevent.
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
import {
  identityEnv,
  repoSourceFor,
  type SandboxKind,
  Workspace,
} from "@workspace/sandbox";
import { Cause, DateTime, Effect, Ref, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { type ContainerRecord, containerTurn } from "./container-turn";
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
import { preserveTranscript } from "./transcript-ingest";
import {
  EMPTY_TURN_PROGRESS,
  observeTurn,
  type TurnProgress,
  terminusOfFailure,
} from "./turn-progress";

/** Encoder for one line of the run's event file, built once rather than per event. */
const encodeRecord = Schema.encodeEffect(AgentEventRecord);

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
   * Which implementation serves this turn, already resolved by the caller from
   * `SANDBOX_MODE`. Passed in rather than read here, because the same answer
   * has to reach the row the loop writes and the prompt this run is given, and
   * a second read is where the three come to disagree.
   */
  readonly sandboxKind: SandboxKind;
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
 * **The scope is the caller's, not this function's.** The checkout and the
 * seeded agent home are acquired into whichever scope this is run in, and
 * released when *that* closes — which is what lets {@link runOpened} copy the
 * transcript out of the agent home before the credentials in it are removed.
 * Everything acquired here is released on every path including an interrupt,
 * because that is what a scope does; the only thing this file decides is how
 * far the scope reaches. What survives it is what should — the run directory
 * with its event file and the transcript copied into it, and the artifacts
 * folder, which is the point.
 *
 * A failure of the turn itself is an answer rather than an error: it becomes a
 * failed terminus, because a crashed run is still a run that has to close out
 * and land its task in *review*. The deadline is the same kind of answer — see
 * {@link ExecuteRunInput.timeoutMs}. Only the stages before the turn — the
 * workspace, the credentials, the prompt — fail this effect, and the caller's
 * `onExit` closes the run out from those too.
 */
export const executeRun = (input: ExecuteRunInput) =>
  Effect.gen(function* () {
    const { context, progress } = input;
    const contained = input.sandboxKind === "docker";
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
      placement: placementOf({ kind: input.sandboxKind, workspace: made }),
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

    /**
     * One event of the run's timeline, stored and folded into what the run
     * knows. The `seq` is handed in rather than counted here: it is the
     * ordinal of the line in the event file, which is the only numbering a
     * re-ingest can collide with — the local path appends the line itself and
     * so knows the ordinal, and the container path reads it off the file.
     */
    const onRecord = (input_: {
      readonly event: AgentEvent;
      readonly occurredAt: DateTime.Utc;
      readonly seq: number;
    }) =>
      Effect.gen(function* () {
        const { event, occurredAt, seq } = input_;
        const before = yield* Ref.get(progress);

        // A row the database refuses is one line of the timeline lost, and
        // the file still has it. The ordinal is spent either way, so a later
        // re-ingest lands the missing row in its own place rather than
        // shifting everything after it.
        yield* runEvents
          .append({
            occurredAt,
            payload: toRunEventPayload(event, mapping),
            runId: context.runId,
            seq,
            taskId,
            workspaceId,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("run event not stored", { cause, seq })
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

    /** The container path: the file is the container's, and it is only read. */
    const fromContainer = ({ record, seq }: ContainerRecord) =>
      onRecord({ event: record.event, occurredAt: record.occurredAt, seq });

    /**
     * The local path: this process is the writer, so the line goes into the
     * event file first and its ordinal is the count of events already seen.
     */
    const fromProvider = (event: AgentEvent) =>
      Effect.gen(function* () {
        const before = yield* Ref.get(progress);
        const occurredAt = yield* DateTime.now;
        yield* appendLine({ event, occurredAt });
        yield* onRecord({ event, occurredAt, seq: before.eventsSeen });
      });

    /** The turn in this process, against host paths. The escape hatch. */
    const hostTurn = Effect.gen(function* () {
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
      yield* Stream.runForEach(events, fromProvider);
      const state = yield* Ref.get(progress);
      return (
        state.terminus ??
        // No terminus and no failure: the process went away mid-stream. Its
        // own ending, because the count of how far it got is the only thing
        // there is to say about it.
        lostTerminus({
          eventsSeen: state.eventsSeen,
          exitCode: null,
          finalText: state.finalText,
          providerSessionId: state.providerSessionId,
        })
      );
    });

    /**
     * The typed failure of either path, as the ending it is. A provider that
     * crashed and a daemon that refused are the same kind of answer, so both
     * turns are recovered here rather than each naming its own vocabulary. An
     * interrupt is a stop command and belongs to the caller's `onExit`, and a
     * defect is a bug that should not be filed as a run that merely errored.
     */
    const asEnding = (error: unknown) =>
      Effect.map(Ref.get(progress), (state) => terminusOfFailure(error, state));

    if (contained) {
      return yield* containerTurn({
        context,
        dataRoot: input.dataRoot,
        env: input.env,
        onRecord: fromContainer,
        progress,
        prompt: prompt.text,
        timeoutMs: input.timeoutMs,
        workspace: made,
      }).pipe(Effect.catch(asEnding));
    }
    return yield* hostTurn.pipe(Effect.catch(asEnding));
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
    // model does, and the caller's scope releases the checkout on the way out
    // either way.
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.map(Ref.get(input.progress), (state) =>
          terminusOfFailure(new TimedOut({ timeoutMs: input.timeoutMs }), state)
        ),
    }),
    Effect.withSpan("Run.execute")
  );

/** What running one claimed task needs. */
export interface PerformRunInput {
  readonly claim: RunClaim;
  readonly env?: Readonly<Record<string, string>>;
  /** Which implementation serves the turn. See {@link ExecuteRunInput.sandboxKind}. */
  readonly sandboxKind: SandboxKind;
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
   * It runs inside the run's own scope, so everything the turn was given is
   * still on disk — the checkout, and the agent home the provider wrote its
   * transcript into. Both are removed as this returns, and the transcript has
   * already been copied into the run directory by then.
   *
   * Total by contract. A hook that could fail would be a run that closed and
   * then failed to close.
   */
  readonly onClose?: (closed: RunClosed) => Effect.Effect<void, never, R>;
  /** Which implementation serves the turn. See {@link ExecuteRunInput.sandboxKind}. */
  readonly sandboxKind: SandboxKind;
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
        // First, because everything after it can take time and the file it
        // rescues is deleted the moment this scope closes: the provider writes
        // its transcript inside the run's agent home, and the home goes with
        // its copy of a live credential. One file is copied into the run
        // directory, which survives; the credentials stay behind and are torn
        // down as they always were. A failed copy is a warning rather than an
        // ending — the run is over, and losing its transcript must not turn
        // that into a run that failed to close.
        yield* preserveTranscript({
          context,
          providerSessionId: ending.providerSessionId,
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("transcript not copied out of the agent home", {
              cause,
            })
          ),
          Effect.ignore
        );

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

    // The scope is opened here and not inside the turn, and the ordering that
    // buys is the whole reason: turn, then close, then release. The close
    // copies the transcript the provider wrote *inside* the run's agent home
    // into the run directory, and then reads the run's directory back; the
    // release is what deletes that agent home. Released first, there is
    // nothing left to copy and every run's conversation is lost.
    //
    // It is this way round rather than by keeping the agent home alive longer:
    // the directory holds a copy of a live subscription credential, which is
    // why it is torn down at all, so the release still runs on every path an
    // `onExit` runs on — a value, a failure, a defect, an interrupt from a stop
    // command — and no run leaves credentials on disk behind it.
    const terminus = yield* Effect.scoped(
      executeRun({
        context,
        dataRoot: input.dataRoot,
        env: input.env ?? {},
        progress,
        sandboxKind: input.sandboxKind,
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
      sandboxKind: input.sandboxKind,
      timeoutMs: input.timeoutMs,
    });
  }).pipe(Effect.withSpan("Run.perform"));
