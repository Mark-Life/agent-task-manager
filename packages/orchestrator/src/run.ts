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

import {
  CONTAINER_AGENT_MCP_PATH,
  claudeManagerMcpServers,
} from "@workspace/agent-tools";
import { RunEventRepo, RunRepo, withActor } from "@workspace/db";
import {
  type AgentEvent,
  AgentEventRecord,
  COMMENT_MARKER_ENV_VAR,
  commentMarkerPathOf,
  entrypointBundlePathOf,
  mcpServersPathOf,
  ProviderRegistry,
  TimedOut,
} from "@workspace/harness";
import type { RunPlacement } from "@workspace/prompts";
import {
  identityEnv,
  type Mount,
  managerMountsFor,
  mountsFor,
  repoSourceFor,
  type SandboxKind,
  Workspace,
} from "@workspace/sandbox";
import { makeTokenSigner, mintAgentToken } from "@workspace/token";
import {
  Cause,
  DateTime,
  Effect,
  type Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  bindingOf,
  copyAgentBundle,
  scopedMcpServersFile,
} from "./agent-token";
import { materializeThreadRun, threadPlacementOf } from "./chat-turn";
import { type ContainerRecord, containerTurn } from "./container-turn";
import {
  type DispatchContext,
  eventLogPathOf,
  lostTerminus,
  projectIdOf,
  type RunTerminus,
  resumeSessionIdOf,
  runIdentityOf,
  subjectOf,
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
  terminusWithBoardAccess,
} from "./turn-progress";

/** Encoder for one line of the run's event file, built once rather than per event. */
const encodeRecord = Schema.encodeEffect(AgentEventRecord);

/**
 * The directories one turn runs over, whichever role it is.
 *
 * Assembled by {@link directoriesFor} and handed on: what a run may reach is a
 * property of what it is attached to, and deciding it once here is what lets
 * `./container-turn` stay a function of a mount set rather than of a role.
 */
export interface RunDirectories {
  /** The branch a checkout is on, or null for a run with no repo. */
  readonly branch: string | null;
  /** The exact mount set, entrypoint included. */
  readonly mounts: readonly Mount[];
  /** The paths as the run itself sees them, which is what the prompt names. */
  readonly placement: RunPlacement;
  /** Where the agent works, on the host. */
  readonly workspaceDir: string;
}

/** What running one turn needs beyond the context it runs under. */
export interface ExecuteRunInput {
  /**
   * The host's system-owned login directory for this run's provider, already
   * resolved. Shared by every run on the box, mounted read-write, never copied
   * — so a token the vendor refreshes inside the container is refreshed for
   * good rather than thrown away with it.
   */
  readonly agentHomeDir: string;
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
  /**
   * The gateway as the **container** sees it, which is rarely `localhost`, or
   * null on an install that configured none. Null is what makes a turn run with
   * no board tools rather than fail: both halves or neither, and the banner
   * says which at boot.
   */
  readonly gatewayUrl: string | null;
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
  /** How long this turn's board credential lives. */
  readonly tokenTtlMs: number;
}

/**
 * The directories and mounts this run is given, decided from what it is
 * attached to.
 *
 * A task means a checkout, its own artifacts folder and its project's; a
 * conversation means a scratch directory and the global folder to read. Both
 * end up as the same four fields, so nothing downstream asks which it got.
 */
const directoriesFor = Effect.fnUntraced(function* (input: {
  readonly agentHomeDir: string;
  readonly context: DispatchContext;
  readonly dataRoot: string;
  readonly sandboxKind: SandboxKind;
}) {
  const { context } = input;
  const extras = { entrypointPath: entrypointBundlePathOf(input.dataRoot) };

  if (context.attached.role === "manager") {
    const dirs = yield* materializeThreadRun({
      agentHomeDir: input.agentHomeDir,
      dataRoot: input.dataRoot,
      provider: context.provider,
      runId: context.runId,
    });
    return {
      branch: null,
      mounts: managerMountsFor(
        { agentHomeDir: input.agentHomeDir, ...dirs },
        extras
      ),
      placement: threadPlacementOf({ dirs, kind: input.sandboxKind }),
      workspaceDir: dirs.workspaceDir,
    } satisfies RunDirectories;
  }

  const taskId = context.attached.task.id;
  const workspaces = yield* Workspace;
  const made = yield* workspaces.materialize({
    agentHomeDir: input.agentHomeDir,
    dataRoot: input.dataRoot,
    identity: runIdentityOf(context),
    projectId: projectIdOf(context),
    provider: context.provider,
    repo: repoSourceFor({
      dataRoot: input.dataRoot,
      defaultBranch: context.project?.repoDefaultBranch ?? null,
      repoUrl: context.repoUrl,
      taskId,
    }),
    taskId,
  });
  return {
    branch: made.branch,
    mounts: mountsFor(made, extras),
    placement: placementOf({ kind: input.sandboxKind, workspace: made }),
    workspaceDir: made.workspaceDir,
  } satisfies RunDirectories;
});

/**
 * Materializes the run's directories, runs the turn, and streams what it says
 * into the timeline.
 *
 * **The scope is the caller's, not this function's.** The checkout — or, for a
 * conversation, the scratch directory — is acquired into whichever scope this
 * is run in and released when *that* closes, which is what lets
 * {@link runOpened} read the run's directory back before anything is removed.
 * Everything acquired here is released on every path including an interrupt,
 * because that is what a scope does; the only thing this file decides is how
 * far the scope reaches. What survives it is what should — the run directory
 * with its event file and the transcript copied into it, and the artifacts
 * folder, which is the point.
 *
 * The agent home is not on that list and deliberately so: it is the host's own
 * system-owned login for the provider, shared by every run and mounted rather
 * than copied, so there is nothing per-run to acquire and nothing to tear down.
 *
 * A failure of the turn itself is an answer rather than an error: it becomes a
 * failed terminus, because a crashed run is still a run that has to close out.
 * The deadline is the same kind of answer — see
 * {@link ExecuteRunInput.timeoutMs}. Only the stages before the turn — the
 * directories and the prompt — fail this effect, and the caller's `onExit`
 * closes the run out from those too.
 */
export const executeRun = (input: ExecuteRunInput) =>
  Effect.gen(function* () {
    const { context, progress } = input;
    const contained = input.sandboxKind === "docker";
    const fs = yield* FileSystem;
    const registry = yield* ProviderRegistry;
    const runEvents = yield* RunEventRepo;
    const runs = yield* RunRepo;

    const asActor = withActor(context.actor);
    const workspaceId = workspaceIdOf(context);
    const subject = subjectOf(context);
    const identity = runIdentityOf(context);
    const eventLogPath = eventLogPathOf(context);

    const made = yield* directoriesFor({
      agentHomeDir: input.agentHomeDir,
      context,
      dataRoot: input.dataRoot,
      sandboxKind: input.sandboxKind,
    });
    yield* Ref.update(progress, (current) => ({
      ...current,
      branch: made.branch,
    }));

    // The prompt is built after the directories exist, because it names them:
    // where to write an artifact worth keeping, and which branch the checkout
    // is on. It also advances the session's watermark, so the rows that went
    // into it are not delivered twice.
    const prompt = yield* buildRunPrompt({
      context,
      placement: made.placement,
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
            subject,
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
    const hostTurn = (servers: Readonly<Record<string, unknown>> | null) =>
      Effect.gen(function* () {
        const said = registry.get(context.provider).run({
          agentHomeDir: input.agentHomeDir,
          effort: null,
          env: {
            ...identityEnv(identity),
            ...input.env,
            // The hook runs outside a container here, so it is told where the
            // marker really is rather than assuming the container's own path.
            [COMMENT_MARKER_ENV_VAR]: commentMarkerPathOf(context.layout),
          },
          mcpServers: servers,
          model: null,
          prompt: prompt.text,
          resumeSessionId: resumeSessionIdOf(context),
          runId: context.runId,
          signal: null,
          taskId: taskIdOf(context),
          workspaceDir: made.workspaceDir,
        });
        yield* Stream.runForEach(said, fromProvider);
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

    /**
     * The board tools this run's token reaches, as the provider is handed them.
     *
     * Both halves or neither: an install that named no gateway runs every turn
     * without board tools, which is a smaller agent and not a broken one, and
     * the banner says so once at boot rather than every run discovering it. An
     * install that did name one must produce a bundle and a token, because an
     * agent that cannot reach the board answers anyway — and what it answers is
     * a confident account of tasks it did not file.
     *
     * The file is written into the run's own scope, so the credential is
     * removed on every path the run can end on. The map it is built from is the
     * same value the local path is handed directly, so the two sandbox modes
     * cannot be given different tools.
     */
    const mcpServers = yield* Effect.gen(function* () {
      const { gatewayUrl } = input;
      if (gatewayUrl === null) {
        return null;
      }
      const bundlePath = yield* copyAgentBundle({
        dataRoot: input.dataRoot,
        runDir: context.layout.runDir,
      });
      const signer = yield* makeTokenSigner;
      const token: Redacted.Redacted<string> = yield* mintAgentToken({
        binding: bindingOf(context),
        signer,
        ttlMs: input.tokenTtlMs,
        workspaceId,
      });
      yield* scopedMcpServersFile({
        gatewayUrl,
        path: mcpServersPathOf(context.layout),
        token,
      });
      return claudeManagerMcpServers({
        // The container reads the bundle at its own mount point; a host process
        // reads the copy where it actually is.
        bundlePath: contained ? CONTAINER_AGENT_MCP_PATH : bundlePath,
        gatewayUrl,
        token,
      });
    });

    if (contained) {
      return yield* containerTurn({
        context,
        env: input.env,
        mounts: made.mounts,
        onRecord: fromContainer,
        progress,
        prompt: prompt.text,
        timeoutMs: input.timeoutMs,
      }).pipe(Effect.catch(asEnding));
    }
    return yield* hostTurn(mcpServers).pipe(Effect.catch(asEnding));
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

/** What running one claim needs. */
export interface PerformRunInput
  extends Pick<
    ExecuteRunInput,
    "agentHomeDir" | "gatewayUrl" | "sandboxKind" | "timeoutMs" | "tokenTtlMs"
  > {
  readonly claim: RunClaim;
  readonly env?: Readonly<Record<string, string>>;
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
export interface RunOpenedInput<R = never>
  extends Pick<
    ExecuteRunInput,
    "agentHomeDir" | "gatewayUrl" | "sandboxKind" | "timeoutMs" | "tokenTtlMs"
  > {
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
   * still on disk — the checkout above all, which is removed as this returns.
   *
   * Total by contract. A hook that could fail would be a run that closed and
   * then failed to close.
   */
  readonly onClose?: (closed: RunClosed) => Effect.Effect<void, never, R>;
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
    // The ending as the close actually filed it, which is not always the one
    // the turn handed over — see `terminusWithBoardAccess`. Kept so the value
    // this function returns and the row it wrote say the same thing.
    const filed = yield* Ref.make<RunTerminus | null>(null);

    /** Closes the run from whatever the turn ended as, including a cause. */
    const closeFrom = (given: RunTerminus) =>
      Effect.gen(function* () {
        // First, because everything after it can take time and because the
        // durable copy is what makes a re-ingest weeks later read the same
        // bytes: the provider writes its transcript into the shared agent home
        // alongside every other run's, and one file — the one this run's
        // session named — is copied into the run directory. A failed copy is a
        // warning rather than an ending: the run is over, and losing its
        // transcript must not turn that into a run that failed to close.
        yield* preserveTranscript({
          agentHomeDir: input.agentHomeDir,
          context,
          providerSessionId: given.providerSessionId,
        }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("transcript not copied into the run directory", {
              cause,
            })
          ),
          Effect.ignore
        );

        const state = yield* Ref.get(progress);
        // A turn that ended cleanly having lost the board did not end cleanly,
        // and this is the one place that can say so: the model never failed,
        // so nothing below the close will ever raise it. Applied before the
        // close so the run row, the crash comment and the wide event all read
        // the same ending.
        const ending = terminusWithBoardAccess({
          progress: state,
          terminus: given,
        });
        yield* Ref.set(filed, ending);
        // Two authors for one fact: the loop watching the stream, and a
        // provider that wires the comment tool in-process and creates the
        // marker itself. Either is enough to spend the fallback.
        const marked = yield* commentMarkerSeen(context);
        const report = yield* closeRun({
          branch: state.branch,
          commentPosted: state.commentPosted || marked,
          context,
          dataRoot: input.dataRoot,
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
    // buys is the whole reason: turn, then close, then release. The close reads
    // the run's directory back, and the release is what removes the checkout it
    // is reading beside. Released first, an artifact rescan would walk a
    // directory that is already gone.
    const terminus = yield* Effect.scoped(
      executeRun({
        agentHomeDir: input.agentHomeDir,
        context,
        dataRoot: input.dataRoot,
        env: input.env ?? {},
        gatewayUrl: input.gatewayUrl,
        progress,
        sandboxKind: input.sandboxKind,
        timeoutMs: input.timeoutMs,
        tokenTtlMs: input.tokenTtlMs,
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
      // What the close actually filed, falling back to what the turn produced
      // on the one path where the close never ran. A caller reading a `done`
      // here while the row says the board was lost would be the same silent
      // success this whole path exists to remove.
      terminus: (yield* Ref.get(filed)) ?? terminus,
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
      agentHomeDir: input.agentHomeDir,
      context,
      dataRoot: input.claim.dataRoot,
      env: input.env,
      gatewayUrl: input.gatewayUrl,
      sandboxKind: input.sandboxKind,
      timeoutMs: input.timeoutMs,
      tokenTtlMs: input.tokenTtlMs,
    });
  }).pipe(Effect.withSpan("Run.perform"));
