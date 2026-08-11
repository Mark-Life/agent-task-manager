/**
 * What a sandbox is: something that runs one command in an isolated environment
 * and says what happened. Declarations only — the docker and local
 * implementations live beside this file, and everything above them depends on
 * this shape rather than on either of them.
 *
 * There is one operation, and that is the design. A container has exactly one
 * interesting lifetime — create, run, stream, wait, remove — and splitting it
 * into four methods means four callers each getting the teardown wrong in their
 * own way. {@link SandboxInterface.run} owns the whole of it, so "a container is
 * always removed" and "a run always produces exactly one result" are properties
 * of this package rather than rules six call sites follow.
 *
 * Output arrives through a consumer rather than as a returned `Stream`, which is
 * the one place this deliberately differs from `@workspace/harness`. A
 * provider's event stream *is* the value a turn produces, so a stream is the
 * right return; a container's stdout is narration, and the value is the result —
 * the exit code, the kernel's verdict, and whether the container was actually
 * removed. Handing the caller a stream and the result separately makes the
 * result arrive before the output is drained, or the teardown outcome
 * unknowable. Back-pressure comes free: the consumer's effect gates the reader.
 *
 * Interruption is how a run is stopped. Interrupting the fiber inside `run`
 * tears the container down — that is what a stop command does, and it is why no
 * `kill` method exists here.
 *
 * The second seam in this file is workspace materialization: give a run its
 * directories, take them back when it is done. See {@link WorkspaceInterface}.
 *
 * One thing never crosses into a container: the host's OTLP credentials. The
 * container writes wide events to a file on a mount and the loop forwards them,
 * so an agent that reads its own environment finds a directory rather than an
 * export token for the operator's observability backend.
 */

import type {
  AgentSessionId,
  EnvFileWrite,
  ProjectId,
  RunId,
  SessionProvider,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { TURN_ENV_VARS } from "@workspace/harness";
import { Context, type Effect, Schema, type Scope } from "effect";
import type { EnvFilesWritten } from "./env-files";
import type { SandboxError } from "./errors";
import type { HardeningSpec } from "./hardening";
import type { Mount, MountSources, RunLabels } from "./mounts";
import type { LabelledContainer } from "./reap";

/**
 * The two implementations. `docker` is what production runs; `local` runs the
 * same command as a plain subprocess on the host with no isolation at all, for
 * debugging a harness change without a five-minute image build. `local` is an
 * escape hatch and is never what a dispatched run uses — it is recorded on the
 * `atm.sandbox` row precisely so an unisolated run cannot be mistaken for a
 * sandboxed one later.
 */
export const SANDBOX_KINDS = ["docker", "local"] as const;

/** Which implementation served a run. */
export const SandboxKind = Schema.Literals(SANDBOX_KINDS);
export type SandboxKind = typeof SandboxKind.Type;

/**
 * The environment variable carrying the run's trace context into the container,
 * in W3C form. Named as the OTel SDKs expect it, so a tool inside the container
 * that already knows the convention joins the trace without being told.
 */
export const TRACEPARENT_ENV_VAR = "TRACEPARENT";

/**
 * The ids one run joins on. Every event the container writes carries them, which
 * is what makes an `atm.turn` row written inside a sandbox joinable to the
 * `atm.run` row the loop wrote outside it.
 *
 * `traceparent` is the host's span, not the container's: the container starts a
 * child trace under it, so one query spans the dispatch, the container, and the
 * turns inside it.
 */
export interface RunIdentity {
  readonly runId: RunId;
  /** Null on the first run of a session, before the provider has named one. */
  readonly sessionId: AgentSessionId | null;
  /**
   * Null for a turn that is about no task at all — the manager agent answering
   * a chat message, which reads and writes the board over HTTP and belongs to a
   * conversation rather than to a card. Every dispatched worker run has one, so
   * a null here is what tells the two apart on a row that carries both.
   */
  readonly taskId: TaskId | null;
  /** W3C `traceparent` of the span that started this run, or null outside a trace. */
  readonly traceparent: string | null;
  readonly workspaceId: WorkspaceId;
}

/**
 * The correlation environment a container is started with. Pure, and it lives
 * here rather than in an implementation because it is the entire contract
 * between the two sides of the mount: the sandbox sets exactly these names and
 * the harness reads exactly these names, from one object, so the two cannot
 * drift into separate spellings of the same id.
 *
 * A null id is an absent variable rather than an empty string, because the
 * harness reads an empty variable as unset anyway and a blank id on a row makes
 * an unknown look like a supplied one.
 */
export const identityEnv = (
  identity: RunIdentity
): Readonly<Record<string, string>> => ({
  [TURN_ENV_VARS.runId]: identity.runId,
  [TURN_ENV_VARS.workspaceId]: identity.workspaceId,
  ...(identity.taskId === null
    ? {}
    : { [TURN_ENV_VARS.taskId]: identity.taskId }),
  ...(identity.sessionId === null
    ? {}
    : { [TURN_ENV_VARS.sessionId]: identity.sessionId }),
  ...(identity.traceparent === null
    ? {}
    : { [TRACEPARENT_ENV_VAR]: identity.traceparent }),
});

/**
 * Everything one container needs to exist. Every field is required and
 * explicitly nullable where it can be absent — an omitted key is how a run
 * silently gets the daemon's default instead of the operator's decision.
 */
export interface SandboxSpec {
  readonly args: readonly string[];
  /** The executable, resolved inside the image. */
  readonly command: string;
  /**
   * Environment on top of {@link identityEnv}, which the implementation merges
   * in and which wins: a caller cannot overwrite the ids its own row joins on.
   * Secrets that belong to the host — the OTLP export token above all — do not
   * belong here.
   */
  readonly env: Readonly<Record<string, string>>;
  /** The confinement. Never absent, never partially applied. */
  readonly hardening: HardeningSpec;
  /** Whose run this is, and what it joins to. */
  readonly identity: RunIdentity;
  /** Image tag, pinned. The `base` or `browser` image, both arm64. */
  readonly image: string;
  /** Built by `mountsFor`, never assembled by hand. */
  readonly mounts: readonly Mount[];
  /** Wall-clock cap, or null for none. A run with no cap is a run that can hold a slot forever. */
  readonly timeoutMs: number | null;
  /** Working directory inside the container, normally the workspace mount. */
  readonly workingDir: string;
}

/** Which of the container's two streams a chunk came from. */
export const OUTPUT_STREAMS = ["stdout", "stderr"] as const;

/** The stream a chunk was read from. */
export const OutputStream = Schema.Literals(OUTPUT_STREAMS);
export type OutputStream = typeof OutputStream.Type;

/**
 * One piece of a container's output, as it arrives. Decoded text rather than
 * bytes, and unbuffered by line: a container that prints a progress bar without
 * a newline should still be visible to whoever is watching.
 */
export interface OutputChunk {
  readonly stream: OutputStream;
  readonly text: string;
}

/**
 * What happened to the container after the work ended. `skipped` is the local
 * implementation, which has nothing to remove — an outcome of its own rather
 * than a fabricated success, so a query for "runs whose container was actually
 * removed" is answerable.
 */
export const TEARDOWN_OUTCOMES = ["removed", "failed", "skipped"] as const;

/** Whether the container is really gone. */
export const TeardownOutcome = Schema.Literals(TEARDOWN_OUTCOMES);
export type TeardownOutcome = typeof TeardownOutcome.Type;

/**
 * What one container run produced. This is the row `atm.sandbox` is built from,
 * which is why it carries facts nobody needs at the call site: the mount count
 * and the pull flag are questions asked months later — "did the runs that
 * failed have more mounts", "how much of the p99 is a cold image".
 *
 * `exitCode` is data, not a failure. A container whose command exits 1 ran
 * exactly as asked; only the sandbox's own failures are in
 * {@link SandboxError}.
 */
export interface SandboxResult {
  /** Null where the container never got an id, which is every start failure. */
  readonly containerId: string | null;
  /** Null where the container was killed before it could produce one. */
  readonly exitCode: number | null;
  /** The image that actually ran, which the ledger keeps against the one that was asked for. */
  readonly image: string;
  /** True when the daemon had to fetch the image. The cold-start half of a slow run. */
  readonly imagePulled: boolean;
  readonly kind: SandboxKind;
  /** How many mounts the container was given. The set, counted, without carrying paths onto a row. */
  readonly mountCount: number;
  /** `State.OOMKilled`. The only thing that tells a memory kill from a teardown's SIGKILL. */
  readonly oomKilled: boolean;
  /** Peak memory in bytes, or null where the runtime reported none. */
  readonly peakMemoryBytes: number | null;
  readonly teardown: TeardownOutcome;
  /** Measured across every exit path, so it is real even where nothing else is. */
  readonly wallClockMs: number;
}

/**
 * The container this run is about to be given, named before it exists.
 *
 * A name rather than an id, because an id is not available yet and the name is:
 * the handle is minted on the host so that a fiber interrupted between the
 * spawn and the first byte of output still has something to remove, and the
 * same property makes it the only identifier a run that never got as far as an
 * inspect can report. The daemon takes it everywhere it takes an id, so
 * `docker logs <name>` reads a container this names while it is still up.
 */
export interface ContainerHandle {
  readonly name: string;
}

/** One run: the container to build, and who reads what it prints. */
export interface SandboxRunInput<E, R> {
  /**
   * Called once, with the name of the container this run is about to create,
   * before it is created — so a caller that records the handle records it for
   * the runs that die first as well as the ones that finish. Never called by an
   * implementation that starts no container; see {@link SandboxResult.containerId}.
   * A caller with nothing to record passes `() => Effect.void`.
   */
  readonly onContainer: (
    container: ContainerHandle
  ) => Effect.Effect<void, E, R>;
  /**
   * Called for each chunk as it arrives. Its effect gates the reader, so a slow
   * consumer slows the container rather than filling a buffer nobody bounded.
   * A caller with nothing to do with the output passes `() => Effect.void`.
   */
  readonly onOutput: (chunk: OutputChunk) => Effect.Effect<void, E, R>;
  readonly spec: SandboxSpec;
}

/**
 * One sandbox. `run` creates the container, streams its output to the consumer,
 * waits for it, removes it, and answers with everything that happened —
 * including a teardown that failed, which is on the result rather than in the
 * failure channel because the work itself already succeeded or failed on its own
 * terms and a leftover container should not relabel it.
 */
export interface SandboxInterface {
  /**
   * Every container this system started that the daemon still holds, whatever
   * state it is in. Which of them is an orphan is the caller's to decide — it
   * takes a database read this package must not do — so this only ever lists.
   *
   * Empty where there is no daemon to ask, which is not a degraded answer: a
   * mode that starts no containers leaves none behind.
   */
  readonly held: Effect.Effect<readonly LabelledContainer[], SandboxError>;
  /**
   * Removes one container by name, whether or not it is still running. Used by
   * the caller's sweep; the ordinary teardown is part of {@link run} and needs
   * nothing from here.
   */
  readonly remove: (name: string) => Effect.Effect<void, SandboxError>;
  readonly run: <E, R>(
    input: SandboxRunInput<E, R>
  ) => Effect.Effect<SandboxResult, E | SandboxError, R>;
}

/**
 * The sandbox as a service, so the orchestrator can dispatch a run without
 * importing either implementation — which is what lets `local` be swapped in
 * for a debugging session by changing one layer.
 */
export class Sandbox extends Context.Service<Sandbox, SandboxInterface>()(
  "@workspace/sandbox/Sandbox"
) {}

/**
 * How a run's directories were made available. `mount` bind-mounts host
 * directories straight into the container; `copy` materializes them from
 * elsewhere before the run and persists what changed afterwards.
 */
export const MATERIALIZE_STRATEGIES = ["mount", "copy"] as const;

/** Which materialization served a run. Recorded, because the failure modes differ. */
export const MaterializeStrategy = Schema.Literals(MATERIALIZE_STRATEGIES);
export type MaterializeStrategy = typeof MaterializeStrategy.Type;

/**
 * Where a run's checkout comes from. The mirror is a host-side bare clone
 * fetched at the start of every materialization, so a run branches from the
 * remote's tip as it stands at dispatch while still building its working tree
 * off local disk rather than pulling the whole history over the network.
 */
export interface RepoSource {
  /**
   * What the run's branch is cut from, `origin/main` and the like — and what a
   * branch that already exists is measured against before it is continued.
   */
  readonly baseRef: string;
  /**
   * The branch the run pushes, which becomes the PR's head. A later run on the
   * same task continues it: where the remote already has this branch with
   * commits {@link RepoSource.baseRef} does not, the checkout starts at that tip
   * rather than at the base, so a rerun adds to the work instead of replacing
   * it.
   */
  readonly branch: string;
  /** Used only when the mirror does not exist yet. Null forbids creating it. */
  readonly cloneUrl: string | null;
  /** The bare mirror on the host. */
  readonly mirrorDir: string;
}

/** What to materialize, for whom. */
export interface MaterializeInput {
  /**
   * The host directory holding the run's provider login, already resolved by
   * whoever read the configuration. Passed in rather than derived because
   * materialization must not invent it: an auto-created empty home boots a
   * container that reports an auth error nobody can tell from an expired token.
   */
  readonly agentHomeDir: string;
  readonly dataRoot: string;
  /**
   * The project's environment files, already decrypted, written into the
   * checkout after the clone returns.
   *
   * Plain values rather than a reference to whatever holds them, because this
   * package never imports `@workspace/db`: the caller reads the rows and opens
   * them, and materialization learns bytes and paths. Empty for a task whose
   * project has none, and for a task with no project at all.
   */
  readonly envFiles: readonly EnvFileWrite[];
  readonly identity: RunIdentity;
  /**
   * The names the run's container paths are spelled with — the project's name,
   * the repository's, and the task's title.
   *
   * Beside the ids rather than derived from them, because they answer different
   * questions and only the caller holds both: the id keys the host directory
   * and the label names the directory inside the container. A caller that knows
   * a `projectId` always knows the project's name, and materialization must not
   * be the thing that looks one up — this package reads no database.
   */
  readonly labels: RunLabels;
  /** Null for a task with no project: there is no promoted folder to show it. */
  readonly projectId: ProjectId | null;
  /**
   * Which provider's login the run will use. Beside `agentHomeDir` rather than
   * derived from it, so a home that is absent can be reported with the one-time
   * login line that fixes it — the two spellings differ per vendor.
   */
  readonly provider: SessionProvider;
  /** Null for a task with no repo — a scratch directory, and the same machinery otherwise. */
  readonly repo: RepoSource | null;
  /**
   * The skills directory the install shares with every run, or null when it
   * names none.
   *
   * The broadest source of the skills this run is composed, and the only one
   * that is not a scope of its own tree — it is one directory for the whole
   * host, read from the loop's settings, like the entrypoint bundle. What comes
   * out is a directory of the run's own; see `./composed-skills`.
   */
  readonly skillsDir: string | null;
  /**
   * Whose artifacts folder the checkout is materialized against. Carried here
   * rather than read off {@link RunIdentity} because materializing a checkout
   * is task work: the identity is now nullable for turns that are about no
   * task, and those turns do not materialize a workspace at all. The input
   * already carries `projectId` separately for the same reason.
   */
  readonly taskId: TaskId;
}

/**
 * The host paths a run got, ready to be handed straight to `mountsFor`. It
 * extends the mount sources rather than restating them, so the thing that
 * produces the directories and the thing that mounts them cannot disagree about
 * what a run has.
 */
export interface RunWorkspace extends MountSources {
  /** The branch checked out, or null for a run with no repo. */
  readonly branch: string | null;
  /**
   * The project's environment files as they were actually put into the
   * checkout: where each went, and whether git was told to ignore them. Paths
   * only — the values are in the checkout and nowhere else this returns.
   */
  readonly envFiles: EnvFilesWritten;
  readonly strategy: MaterializeStrategy;
}

/**
 * Give a run its directories, take them back when it is done.
 *
 * One interface, two implementations, and the split is between bind-mounting
 * local directories and copying a directory in and out of object storage. The
 * agent sees a plain directory either way, which is the whole point: it uses its
 * native write and edit tools against absolute paths, and neither knows nor
 * cares which one it got.
 *
 * The result is scoped, and the scope close is the "take it back": the local
 * implementation removes the run's checkout, and a bucket implementation
 * persists whatever changed before removing the staging directory. Anything that
 * needs to read the directory — the artifact rescan above all — has to happen
 * inside the scope, because after it closes there may be nothing on the host at
 * all.
 *
 * A FUSE mount of a bucket is not this interface, and is not a shortcut to it.
 * The adapters that present object storage as a filesystem have no atomic
 * rename and poor partial writes, and an agent edits files in place constantly —
 * so the failure mode is a half-written file that looks whole, discovered by the
 * next run that reads it. Materialize-then-persist is the same shape CI already
 * uses for a cache, it fails loudly, and it needs nothing from the kernel.
 */
export interface WorkspaceInterface {
  readonly materialize: (
    input: MaterializeInput
  ) => Effect.Effect<RunWorkspace, SandboxError, Scope.Scope>;
}

/**
 * Workspace materialization as a service, so the orchestrator asks for a run's
 * directories without knowing whether they came off local disk or a bucket.
 */
export class Workspace extends Context.Service<Workspace, WorkspaceInterface>()(
  "@workspace/sandbox/Workspace"
) {}
