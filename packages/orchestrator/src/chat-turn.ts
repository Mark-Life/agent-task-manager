/**
 * The two places a manager run differs from a worker one: the directories it is
 * given, and what its ending writes back.
 *
 * Everything else — the claim order, the lease, the pool slot, the quota check,
 * the run row, the event ingest, the transcript, the retry ladder, the two
 * `atm.run` rows — is the run path, unchanged, because a manager turn is one. This module is small on purpose: it is the whole of the difference, and
 * anything that grows here that is not about a conversation belongs in the
 * shared path instead.
 *
 * **Directories.** A manager turn has no repo, no task artifacts folder and no
 * project folder, so nothing is cloned and nothing is promoted. What it needs
 * is the same run directory every turn writes its events and its spec into, a
 * scratch working directory a CLI can put its temporary files in, and the
 * workspace scope — which it gets read-write, unlike a worker: the manager is
 * the role a human is talking to, it clones no untrusted repository, and the
 * house rules it is asked to edit are in that folder. The provider's login is
 * the host's shared agent home, checked and never created — an auto-created
 * empty home boots a container that reports an auth error nobody can tell from
 * an expired token.
 *
 * It also gets the skills of the two levels it can see, composed into a
 * directory of its own and mounted where a provider reads its personal skills.
 * A conversation has no project and no task, so its composition is two levels
 * where a worker's is four; it is the same function either way.
 *
 * The scratch directory hangs under the manager's own branch of the tree rather
 * than beside it, which is what keeps project rules out of a chat turn for free:
 * both CLIs collect instruction files by walking up from the working directory,
 * and this one's walk crosses `manager/` and the workspace scope and no project.
 *
 * **The ending.** A worker's answer is a message on its task and a move into
 * review; a manager's is a message in its conversation. One row, carrying the
 * run that produced it, so a dashboard can open the turn behind a sentence and
 * the bot can render the same row into the chat it came from. Nothing here
 * touches Telegram: this writes what was said, and the interface that a person
 * is reading in decides how to show it.
 */

import { join } from "node:path";
import { ChatMessageRepo, withActor } from "@workspace/db";
import type { RunId, SessionProvider } from "@workspace/domain";
import { agentHomeLoginHint, runDirOf } from "@workspace/harness";
import type { RunPlacement } from "@workspace/prompts";
import {
  CONTAINER_MANAGER_SCRATCH_DIR,
  CONTAINER_WORKSPACE_DIR,
  composeSkillsScoped,
  ensureArtifactDir,
  eventLogDirOf,
  MANAGER_SEGMENT,
  type MountPurpose,
  MountSourceMissing,
  managerMountsFor,
  nestedMountPointsOf,
  RUN_DIR_MODE,
  type SandboxKind,
  workspaceDirOf,
} from "@workspace/sandbox";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  type DispatchContext,
  errorFieldsOf,
  isFailure,
  type RunTerminus,
} from "./dispatch-context";

/** The host directories one manager turn is mounted over. */
export interface ThreadRunDirectories {
  /**
   * The skills gathered for this turn, or null when it was given none. A copy
   * of the run's own, made from the workspace scope and the manager's own
   * directory, because the provider that cannot walk the tree reads only this
   * path — see `composeSkills`.
   */
  readonly composedSkillsDir: string | null;
  /**
   * The global promoted folder, which is the host side of the workspace scope
   * and is read-write for this role. The manager's own rules live in a directory
   * inside it, so there is nothing further to mount for them.
   */
  readonly globalArtifactsDir: string;
  /** This run's own directory: the event ledger, the spec, the result, the tools. */
  readonly runDir: string;
  /** An empty scratch directory, mounted at the container's working directory. */
  readonly workspaceDir: string;
}

/** What materializing a manager turn's directories needs. */
export interface ThreadRunInput {
  /** The host's shared login for this provider. Checked, never created. */
  readonly agentHomeDir: string;
  readonly dataRoot: string;
  readonly provider: SessionProvider;
  readonly runId: RunId;
  /**
   * The skills directory the install shares with every run, or null when it
   * names none. The broadest level of this turn's composition.
   */
  readonly skillsDir: string | null;
}

/**
 * Creates a directory a container is about to mount.
 *
 * The failure names the mount it serves, because `--mount` refuses a missing
 * source with a message about an "invalid mount config" that names none of the
 * paths, and a turn that cannot create its own event directory fails for
 * exactly the same reason as one whose scratch directory was deleted underneath
 * it.
 */
const ensureDirectory = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly purpose: MountPurpose;
}) {
  const fs = yield* FileSystem;
  yield* fs
    .makeDirectory(input.path, { mode: RUN_DIR_MODE, recursive: true })
    .pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("mount source not created", {
          cause,
          path: input.path,
        })
      ),
      Effect.mapError(
        () =>
          new MountSourceMissing({
            hostPath: input.path,
            purpose: input.purpose,
          })
      )
    );
  return input.path;
});

/**
 * The provider's login directory, checked and not made. The warning carries the
 * one-time login line because this is the failure a fresh host hits first, and
 * the operator reading it has no other way to know the directory is theirs to
 * create by hand.
 */
const requireAgentHome = Effect.fnUntraced(function* (input: {
  readonly agentHomeDir: string;
  readonly provider: SessionProvider;
}) {
  const fs = yield* FileSystem;
  const present = yield* fs
    .exists(input.agentHomeDir)
    .pipe(Effect.orElseSucceed(() => false));
  if (present) {
    return input.agentHomeDir;
  }
  yield* Effect.logWarning("agent home missing", {
    fix: agentHomeLoginHint(input.provider, input.agentHomeDir),
    path: input.agentHomeDir,
  });
  return yield* Effect.fail(
    new MountSourceMissing({
      hostPath: input.agentHomeDir,
      purpose: "agent_home",
    })
  );
});

/**
 * The directories one manager turn runs over, made if they are not there.
 *
 * Scoped, so the scratch directory is removed when the run's scope closes —
 * the same lifetime a worker's repo-less checkout gets, and for the same
 * reason: what is worth keeping is in the run directory, which survives.
 */
export const materializeThreadRun = Effect.fn("Workspace.thread")(function* (
  input: ThreadRunInput
) {
  const fs = yield* FileSystem;
  yield* Effect.annotateCurrentSpan({ runId: input.runId });

  const runDir = yield* ensureDirectory({
    path: runDirOf({ dataRoot: input.dataRoot, runId: input.runId }),
    purpose: "run",
  });
  yield* ensureDirectory({ path: eventLogDirOf(runDir), purpose: "run" });
  yield* requireAgentHome(input);

  const globalArtifactsDir = yield* ensureArtifactDir({
    dataRoot: input.dataRoot,
    location: { scope: "global" },
  }).pipe(
    Effect.mapError(
      (error) =>
        new MountSourceMissing({
          hostPath: error.path,
          purpose: "global_artifacts",
        })
    )
  );

  const workspaceDir = yield* Effect.acquireRelease(
    ensureDirectory({
      path: workspaceDirOf({ dataRoot: input.dataRoot, runId: input.runId }),
      purpose: "workspace",
    }),
    (path) =>
      fs.remove(path, { force: true, recursive: true }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("scratch directory not removed", { cause, path })
        ),
        Effect.ignore
      )
  );

  // Two levels, broadest first: the workspace scope every role reads, and the
  // manager's own directory inside it. No project and no task, because a
  // conversation is about neither — the same rule the mount set follows.
  const composed = yield* composeSkillsScoped({
    agentHomeDir: input.agentHomeDir,
    dataRoot: input.dataRoot,
    runId: input.runId,
    scopes: [
      { dir: globalArtifactsDir, level: "workspace" },
      { dir: join(globalArtifactsDir, MANAGER_SEGMENT), level: "manager" },
    ],
    sharedSkillsDir: input.skillsDir,
  });

  const dirs = {
    composedSkillsDir: composed.dir,
    globalArtifactsDir,
    runDir,
    workspaceDir,
  } satisfies ThreadRunDirectories;

  // The scratch directory is bound at a path inside the workspace scope, and a
  // bind needs its destination to already exist inside the parent's host
  // directory. The daemon would make it here — this scope is read-write for a
  // manager — but the list is read off the mount set rather than trusted to the
  // daemon, so the turn that cannot be started names the directory it wanted
  // instead of failing as an "invalid mount config", and so the manager path and
  // the worker path pre-create by the same rule.
  //
  // The skills destination is dropped and the extras are absent, exactly as in
  // a worker's materialization: both nest inside the agent home, which is
  // checked and never created, and the daemon makes that destination itself
  // through a writable parent.
  yield* Effect.forEach(
    nestedMountPointsOf(
      managerMountsFor({ agentHomeDir: input.agentHomeDir, ...dirs })
    ).filter((point) => point.purpose !== "skills"),
    ensureDirectory,
    { discard: true }
  );

  return dirs;
});

/**
 * Where a manager turn works, as the turn itself sees it.
 *
 * The scratch directory is under the manager's own branch of the tree, not at
 * the root of it: the root is the shared directory every run reads, and this
 * turn's working directory is one that dies with it. Naming the two as one path
 * is what the old spelling did, and it is exactly the confusion to avoid now
 * that the shared one is writable.
 *
 * The turn has no directory of its own that outlives it, and that is stated by
 * pointing the durable field at the same scratch directory rather than by
 * inventing one — which is also what tells a placement's reader that the shared
 * directory is not read-only here. A manager's write access to it is a mount
 * flag; the only thing this record can do is not claim the opposite.
 *
 * A local turn has no mounts, so it is told the host directories it really has.
 */
export const threadPlacementOf = (input: {
  readonly dirs: ThreadRunDirectories;
  readonly kind: SandboxKind;
}): RunPlacement => {
  const local = input.kind === "local";
  const workspaceDir = local
    ? input.dirs.workspaceDir
    : CONTAINER_MANAGER_SCRATCH_DIR;
  return {
    artifactsDir: workspaceDir,
    branch: null,
    globalArtifactsDir: local
      ? input.dirs.globalArtifactsDir
      : CONTAINER_WORKSPACE_DIR,
    projectArtifactsDir: null,
    workspaceDir,
  };
};

/** What the manager said, or the reason there is nothing to show. */
const answerBodyOf = (terminus: RunTerminus) => {
  if (!isFailure(terminus)) {
    return terminus.finalText.trim();
  }
  const { errorClass, errorMessage } = errorFieldsOf(terminus);
  return `That turn failed: ${errorClass ?? "Unknown"}${
    errorMessage === null ? "." : ` — ${errorMessage}`
  }`;
};

/** One manager turn's ending, as the conversation records it. */
export interface ChatTurnClosure {
  readonly context: DispatchContext;
  readonly terminus: RunTerminus;
}

/**
 * Appends the manager's answer to the conversation it was said in.
 *
 * Best-effort and total, like every other terminal write: a message the
 * database refused must not be what leaves a run un-closed. A clean turn that
 * said nothing writes nothing — an empty answer is a turn with nothing to add,
 * and a blank message in a chat window reads as a bug.
 *
 * The failing case does write, because a conversation that goes quiet is
 * indistinguishable from a bot that died, and because the message the person
 * asked stays unread either way: the watermark advanced when the prompt was
 * built, so the next turn is about whatever they say next.
 *
 * **Called before the run row closes**, and that ordering is a contract rather
 * than a preference: the interface delivering this message into Telegram is
 * woken by the run's terminal event and waits for the run to stop reading as
 * live before it looks for the row. Written after the close, the answer is a
 * row nobody was still waiting for.
 */
export const closeChatTurn = Effect.fn("Run.closeChat")(function* (
  closure: ChatTurnClosure
) {
  const { context, terminus } = closure;
  if (context.attached.role !== "manager") {
    return false;
  }
  const { thread } = context.attached;
  const body = answerBodyOf(terminus);
  if (body.length === 0) {
    return false;
  }

  const messages = yield* ChatMessageRepo;
  return yield* messages
    .append({
      body,
      role: "manager",
      runId: context.runId,
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    })
    .pipe(
      withActor(context.actor),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logError("the manager's answer was not stored", cause),
          false
        )
      )
    );
});
