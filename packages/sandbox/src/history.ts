/**
 * The old bytes of a shared scope, kept in a git repository the scope directory
 * carries itself.
 *
 * A task folder belongs to one task and nobody can overwrite anybody there. The
 * project folder and the workspace folder are different: every run on a project
 * may write the first, a manager turn and a promotion may write the second, and
 * two writers reaching for one filename means the earlier file is gone with
 * nothing to compare against. This is the guard — not a lock, and not a review
 * step, because neither of those is worth what it costs on a folder that is
 * mostly one document per week. What is worth it is that the previous bytes
 * still exist.
 *
 * **Git, because the alternative is a schema.** A commit before a run is given
 * the directory and another after it ends yields history, diff, blame and
 * restore from tooling every reader already knows, with no version table, no
 * retention policy and no migration. `./artifacts` has said this was the answer
 * since before there was anything to version, and left {@link GIT_DIR} out of
 * the index in advance so that taking it costs no artifact rows.
 *
 * **The run is in the log.** The message names the run id and the author is the
 * identity `./committer` resolved for this process, so "which run changed this
 * file" is `git log`, and `git log --grep=<runId>` is the answer for one run.
 * The author is the human the token belongs to, exactly as on a run's own
 * branch: it says who asked, not who typed.
 *
 * **A person's edit is a commit too.** The dashboard writes into these same
 * directories, and a hand edit that left no commit would be the one change in
 * the folder that `git log` could not attribute — worse, it would be folded
 * into the next run's `before` snapshot and read as something that run was
 * handed rather than as something somebody chose. So an edit commits at the
 * moment it is made, authored by the person who made it rather than by the
 * identity `./committer` resolved for the process.
 *
 * **Nothing here may fail a run.** A repository that cannot be initialised, a
 * commit that is refused, a git that is not installed: every one of them is
 * logged and stepped over, on the same reasoning as every other teardown in this
 * package. The work a run did is worth more than the record of what the folder
 * looked like before it, and a run that failed because its history could not be
 * written would be the worst possible trade.
 *
 * **Nothing is committed when nothing changed.** An empty commit per run per
 * scope would bury the handful of commits that carry a change under a log nobody
 * can read, so the staged tree is compared with `HEAD` first and the commit only
 * happens when they differ.
 *
 * The repository is visible to a run, since it sits in a directory the container
 * has mounted. That changes nothing about what either agent CLI collects: the
 * harness points Codex's upward walk at the `.atm-root` marker rather than at
 * `.git`, and Claude's walk for instruction files has no stop at all.
 */

import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { FileScope, type ProjectId, type RunId } from "@workspace/domain";
import { Context, Effect, Layer, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  GIT_DIR,
  globalArtifactsDirOf,
  projectArtifactsDirOf,
} from "./artifacts";
import { resolveCommitter } from "./committer";
import { Git } from "./git";
import { type Committer, DEFAULT_COMMITTER } from "./repo";

/**
 * When a snapshot was taken, relative to the run it names. Two, because two is
 * what makes a diff attributable: whatever changed between a run's `before` and
 * its `after` is what that run did to the folder, and whatever changed between
 * one run's `after` and the next run's `before` is what a human or the gateway
 * did in between.
 */
export const HISTORY_PHASES = ["before", "after"] as const;

/** Which end of a run a snapshot belongs to. */
export type HistoryPhase = (typeof HISTORY_PHASES)[number];

/**
 * The branch a scope's repository is initialised on. Named rather than left to
 * the host's `init.defaultBranch`, so every install's history has the same
 * branch name and git prints no advice about the choice on a directory nobody
 * is watching.
 */
export const HISTORY_BRANCH = "main";

/**
 * How long the commands for one scope get before the snapshot is abandoned.
 *
 * A cap rather than a trust in git, because the failure this module is not
 * allowed to have is not a slow commit but a hung one: these commands run on the
 * path a run is dispatched down, and a git that never returns would hold the
 * slot no matter how carefully every error is swallowed.
 */
const SNAPSHOT_TIMEOUT = "2 minutes";

/**
 * How many snapshots may be in flight at once, across every run this process
 * dispatches.
 *
 * One, because git serialises itself with a lock file and reports the loser as
 * a fatal error rather than waiting: a second `git add` in a repository that
 * already has one running exits 128 with "Unable to create index.lock". The
 * workspace scope is the same directory for every run, so two runs dispatched in
 * the same instant collide there every time — which is exactly the moment two
 * writers might be reaching for one filename, and exactly the snapshot this
 * module exists to take.
 *
 * Serialising costs nothing worth counting. A snapshot is a local `add` and
 * `commit` over a folder holding documents, and it is already capped, so the
 * worst a waiting run can lose is the cap.
 */
const SNAPSHOT_CONCURRENCY = 1;

/**
 * Which shared scopes one run touches. Named by what they are rather than by
 * their path, so a failure and a span say `project` where the path would say a
 * project id.
 */
const SHARED_SCOPES = ["workspace", "project"] as const;

/** Which of the two shared scopes a snapshot is of. */
export type SharedScope = (typeof SHARED_SCOPES)[number];

/** Which run is being recorded, and against which install. */
export interface ScopeHistoryInput {
  readonly dataRoot: string;
  readonly phase: HistoryPhase;
  /** Null for a task with no project, and for every manager turn. */
  readonly projectId: ProjectId | null;
  /** Named in the message, so the log answers "which run changed this file". */
  readonly runId: RunId;
}

/**
 * Where each shared scope stood once the snapshot was taken, or null for a scope
 * that has no history to stand on — a folder nothing has created yet, a
 * repository whose first commit has not been made, a git that refused.
 *
 * This is what turns "which rules did that run have" into a lookup. The `before`
 * snapshot commits whatever a person changed since the last run, so the commit
 * it leaves behind is exactly the tree the run is about to be handed — and a
 * commit names bytes somebody can still `git show`, which a content hash of the
 * same tree would not.
 */
export type ScopeCommits = Readonly<Record<SharedScope, string | null>>;

/** What one call actually wrote, and where it left each scope. */
export interface ScopeHistoryReport {
  /** The scopes that produced a commit — empty when nothing had changed. */
  readonly committed: readonly SharedScope[];
  /** The commit each scope stands at now. Null where there is no history. */
  readonly heads: ScopeCommits;
}

/** One scope's directory, and what it is called when something goes wrong. */
interface ScopeDirectory {
  readonly directory: string;
  readonly scope: SharedScope;
}

/**
 * What a scope reports when its snapshot did not happen at all — the folder is
 * absent, git timed out, git failed. No commit, and no commit to point at
 * either: a head read off a snapshot that was abandoned would name a tree
 * nobody can vouch this run was handed.
 */
const NO_SNAPSHOT: ScopeEditReport = { committed: false, head: null };

/** Which host directory one shared scope is, or null where the pair is incoherent. */
const scopeDirectoryOf = (input: {
  readonly dataRoot: string;
  readonly projectId: ProjectId | null;
  readonly scope: SharedScope;
}): ScopeDirectory | null => {
  if (input.scope === "workspace") {
    return {
      directory: globalArtifactsDirOf(input.dataRoot),
      scope: "workspace",
    };
  }
  return input.projectId === null
    ? null
    : {
        directory: projectArtifactsDirOf({
          dataRoot: input.dataRoot,
          projectId: input.projectId,
        }),
        scope: "project",
      };
};

/**
 * The directories one run shares with others. The workspace scope is in every
 * run's tree; the project scope is there only for a task that belongs to one.
 *
 * The task scope is deliberately absent. It belongs to a single task, so there
 * is nobody to overwrite and nothing a snapshot would preserve that the folder
 * itself does not already hold.
 */
const scopesOf = (input: ScopeHistoryInput): readonly ScopeDirectory[] =>
  SHARED_SCOPES.flatMap((scope) => {
    const directory = scopeDirectoryOf({
      dataRoot: input.dataRoot,
      projectId: input.projectId,
      scope,
    });
    return directory === null ? [] : [directory];
  });

/** The subject line one snapshot carries. The run id is what a reader greps for. */
export const historyMessageOf = (input: {
  readonly phase: HistoryPhase;
  readonly runId: RunId;
}) => `snapshot ${input.phase} run ${input.runId}`;

/**
 * One shared scope, and the person whose edit is about to be recorded in it.
 *
 * The scope is named the way {@link ScopeHistoryInput} names it — by what it
 * is, plus the project id the second one needs — rather than by a directory,
 * so a caller cannot hand this a path and have a commit land somewhere the
 * mount set never puts one.
 */
export interface ScopeEditInput {
  /**
   * Who the commit is authored by. The person who made the edit, never the
   * identity `./committer` resolved for the process: a run's snapshot says the
   * account answerable for the board, and an edit somebody made in a browser
   * should say that somebody. A caller with nobody to name should not be
   * calling this.
   */
  readonly committer: Committer;
  readonly dataRoot: string;
  /** The subject line. {@link editMessageOf} is what the gateway builds it with. */
  readonly message: string;
  /** Required for the project scope, and null for the workspace one. */
  readonly projectId: ProjectId | null;
  readonly scope: SharedScope;
}

/**
 * Which repository an edit to one addressable scope belongs in, or null for a
 * scope that keeps no history.
 *
 * Two of the four map onto one repository. The manager's directory lives inside
 * the workspace scope's folder rather than in a bind of its own, so a manager
 * rule is a file in the workspace repository and a commit there is the commit
 * for it — a second repository nested inside the first would put its own object
 * store in the workspace's history.
 *
 * A task scope keeps none, and that is the same reasoning {@link scopesOf}
 * gives for leaving it out of a run's snapshots: it belongs to one task, so
 * there is nobody to overwrite and no earlier version anyone lost.
 */
export const historyScopeOf = (
  scope: FileScope
): Pick<ScopeEditInput, "projectId" | "scope"> | null =>
  FileScope.match(scope, {
    manager: () => ({ projectId: null, scope: "workspace" as const }),
    project: (self) => ({
      projectId: self.projectId,
      scope: "project" as const,
    }),
    task: () => null,
    workspace: () => ({ projectId: null, scope: "workspace" as const }),
  });

/** Where a scope stands after one edit was recorded, or was not. */
export interface ScopeEditReport {
  /** False when nothing changed on disk, and false when git refused. */
  readonly committed: boolean;
  /** The commit the scope stands at now, or null where it has no history. */
  readonly head: string | null;
}

/**
 * The subject line a person's edit carries. The verb and the path, because what
 * a reader of `git log` wants from a hand edit is which file and what happened
 * to it — the who is the author field, and the when is the commit date.
 */
export const editMessageOf = (input: {
  readonly operation: string;
  readonly path: string;
}) => `${input.operation} ${input.path}`;

/** Records what a shared scope held around one run, and what a person changed in it. */
export interface ScopeHistoryInterface {
  /**
   * Commits one person's edit to one shared scope, as that person.
   *
   * Separate from {@link record} because the two answer different questions and
   * are attributed differently — a snapshot brackets a run and names it, an
   * edit names a file and a person — and because an edit touches the one scope
   * it was made in rather than every scope a run was handed.
   *
   * Total, on the same reasoning as the snapshots, and for a sharper reason
   * besides: the bytes are already on disk by the time this is called, so a git
   * that refused must not turn a completed edit into a failed request. The
   * report says no commit and the warning says why.
   */
  readonly commitEdit: (
    input: ScopeEditInput
  ) => Effect.Effect<ScopeEditReport>;
  /**
   * Snapshots every shared scope this run touches, and answers with the ones
   * that had anything to record. Total: a failure is logged and the report says
   * the scope produced no commit.
   */
  readonly record: (
    input: ScopeHistoryInput
  ) => Effect.Effect<ScopeHistoryReport>;
}

/** What the recorder commits as. */
export interface ScopeHistoryOptions {
  /**
   * The identity every snapshot is authored by. Resolved once for the process
   * rather than per commit — see `./committer`, which makes the same point about
   * the checkouts.
   */
  readonly committer: Committer;
}

/**
 * The recorder over an already-resolved git runner. Exported so a test can drive
 * it against a temporary directory without the layer's GitHub lookup.
 */
export const makeScopeHistory = Effect.fnUntraced(function* (
  options: ScopeHistoryOptions
) {
  const fs = yield* FileSystem;
  const git = yield* Git;
  const { committer } = options;
  // One per service, so it covers every run in the process rather than every
  // run in one dispatch. The layer builds this once, which is what makes that
  // true.
  const lock = yield* Semaphore.make(SNAPSHOT_CONCURRENCY);

  /**
   * The author of one commit, as arguments rather than as repository config.
   *
   * `-c` on the invocation, because the alternative is writing two keys into a
   * `.git/config` inside a directory a container has mounted — a file the loop
   * would then have to keep in step with an identity that is resolved at boot.
   */
  const identityArgs = (author: Committer) => [
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    // Off, whatever the host's own git is configured to do. These commits run
    // as the loop process on a machine whose operator may sign everything they
    // write by hand, and a signing prompt or a missing key would cost a folder
    // its history for a reason that has nothing to do with the folder.
    "-c",
    "commit.gpgsign=false",
  ];

  /**
   * The commit a scope stands at, or null where it stands at none.
   *
   * `run` rather than `mustRun`: a repository whose first commit has not been
   * made answers `rev-parse` with a non-zero exit, and a folder that was seeded
   * and never changed is a scope with no history rather than a snapshot that
   * failed.
   */
  const headOf = Effect.fnUntraced(function* (scope: ScopeDirectory) {
    const result = yield* git.run({
      args: ["rev-parse", "HEAD"],
      cwd: scope.directory,
      executable: "git",
      repo: scope.scope,
    });
    const head = result.stdout.trim();
    return result.exitCode === 0 && head.length > 0 ? head : null;
  });

  /**
   * One scope, snapshotted. Answers with whether a commit was made, and with the
   * commit the scope stands at afterwards — which is the tree the run either was
   * handed or has just left behind, depending on the phase.
   *
   * `git init` is asked for only when there is no object store, so the first run
   * on an install creates the repository and every run after it adds to the same
   * history. The staged tree is compared with `HEAD` before committing — `git
   * diff --cached --quiet` exits zero when they match, and in a repository with
   * no commits yet it compares against the empty tree, which is the same
   * question asked of a folder that was seeded and never touched.
   *
   * The author travels with the call rather than with the service, because the
   * two callers are different people: a run's snapshot is authored by the
   * account the process resolved at boot, and a person's edit by that person.
   */
  const snapshot = Effect.fnUntraced(function* (input: {
    readonly author: Committer;
    readonly message: string;
    readonly scope: ScopeDirectory;
  }) {
    const { directory, scope } = input.scope;
    const inScope = { cwd: directory, executable: "git", repo: scope } as const;

    // A folder nothing has created yet is the first run of a new project, which
    // is a scope with no history rather than a failure to record one. The
    // materialization a moment later makes the directory, and the snapshot at
    // the end of the run initialises it.
    const present = yield* fs.exists(directory);
    if (!present) {
      return NO_SNAPSHOT;
    }

    const initialised = yield* fs.exists(join(directory, GIT_DIR));
    if (!initialised) {
      yield* git.mustRun({
        ...inScope,
        args: ["init", "--quiet", `--initial-branch=${HISTORY_BRANCH}`],
      });
    }
    yield* git.mustRun({ ...inScope, args: ["add", "--all", "."] });

    const staged = yield* git.run({
      ...inScope,
      args: ["diff", "--cached", "--quiet"],
    });
    if (staged.exitCode === 0) {
      // Nothing to record, and still a tree to name: an unchanged scope is the
      // one whose commit answers "which rules did that run have" most often.
      return { committed: false, head: yield* headOf(input.scope) };
    }
    yield* git.mustRun({
      ...inScope,
      args: [
        ...identityArgs(input.author),
        "commit",
        "--quiet",
        // The hooks in a repository nobody configured are none, and a run's
        // snapshot is not the place to discover that somebody added one.
        "--no-verify",
        "--message",
        input.message,
      ],
    });
    return { committed: true, head: yield* headOf(input.scope) };
  });

  /**
   * One snapshot, serialised against every other and never allowed to fail.
   *
   * Both callers go through here, because both need exactly the same three
   * guards for the same reasons: git takes a lock file and reports the loser as
   * a fatal error rather than waiting, a git that hangs would hold the slot
   * forever, and neither a run nor a completed edit may be failed by the record
   * of it.
   */
  const guarded = (input: {
    readonly author: Committer;
    readonly message: string;
    readonly scope: ScopeDirectory;
  }) =>
    Semaphore.withPermit(lock)(snapshot(input)).pipe(
      // Outside the permit, so the cap covers the wait as well as the work: a
      // run queued behind a git that hung gives up at the same two minutes
      // rather than at two minutes after it finally gets in.
      Effect.timeoutOrElse({
        duration: SNAPSHOT_TIMEOUT,
        orElse: () =>
          Effect.logWarning("scope history timed out", {
            path: input.scope.directory,
            scope: input.scope.scope,
          }).pipe(Effect.as(NO_SNAPSHOT)),
      }),
      // Per scope rather than around a loop: a workspace folder somebody made
      // read-only must not cost the project folder its history, and each
      // failure names the scope it happened in.
      Effect.catchCause((cause) =>
        Effect.logWarning("scope history not recorded", {
          cause,
          path: input.scope.directory,
          scope: input.scope.scope,
        }).pipe(Effect.as(NO_SNAPSHOT))
      )
    );

  const record = Effect.fn("ScopeHistory.record")(function* (
    input: ScopeHistoryInput
  ) {
    const message = historyMessageOf(input);
    const committed: SharedScope[] = [];
    // A scope this run does not have stays null rather than absent, so a caller
    // reading `heads.project` gets the same answer for a task with no project as
    // for a project folder that has no history yet: nothing to point at.
    const heads: Record<SharedScope, string | null> = {
      project: null,
      workspace: null,
    };
    for (const scope of scopesOf(input)) {
      const done = yield* guarded({ author: committer, message, scope });
      if (done.committed) {
        committed.push(scope.scope);
      }
      heads[scope.scope] = done.head;
    }
    yield* Effect.annotateCurrentSpan({
      committed: committed.length,
      phase: input.phase,
    });
    return { committed, heads } satisfies ScopeHistoryReport;
  });

  const commitEdit = Effect.fn("ScopeHistory.commitEdit")(function* (
    input: ScopeEditInput
  ) {
    const scope = scopeDirectoryOf({
      dataRoot: input.dataRoot,
      projectId: input.projectId,
      scope: input.scope,
    });
    if (scope === null) {
      // A project scope with no project named. Nothing to commit into, and the
      // edit itself has already happened — so this is a warning about a caller,
      // not a failure of the request that reached it.
      yield* Effect.logWarning("scope edit names a project scope without one", {
        scope: input.scope,
      });
      return NO_SNAPSHOT;
    }
    const done = yield* guarded({
      author: input.committer,
      message: input.message,
      scope,
    });
    yield* Effect.annotateCurrentSpan({
      committed: done.committed,
      scope: scope.scope,
    });
    return done;
  });

  return ScopeHistory.of({
    commitEdit,
    record,
  } satisfies ScopeHistoryInterface);
});

/**
 * The history of the folders more than one run can write, as a service.
 *
 * A service rather than a function the orchestrator imports, because the
 * identity behind the commits is resolved once per process and the git runner
 * stays inside this package. The loop asks for a snapshot at two moments it
 * already owns — before a run is handed its directories, and after that run has
 * ended — and holds nothing that could run a command of its own.
 */
export class ScopeHistory extends Context.Service<
  ScopeHistory,
  ScopeHistoryInterface
>()("@workspace/sandbox/ScopeHistory") {
  /**
   * What a deployment runs: commits authored by whoever the GitHub token belongs
   * to, over the host's own git.
   *
   * The lookup happens here, at layer build, for the same reason the checkout's
   * does — it cannot change while the process runs, and asking per commit would
   * put an API request on the path of every dispatch. {@link resolveCommitter}
   * is total, so a host that cannot reach GitHub still gets a recorder, writing
   * as the agent identity `./repo` falls back to.
   */
  static readonly layer = Layer.effect(
    ScopeHistory,
    Effect.flatMap(resolveCommitter(), (committer) =>
      makeScopeHistory({ committer })
    )
  ).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, Git.layer)));

  /**
   * The same service for a process that only ever commits somebody's own edit.
   *
   * `commitEdit` carries its author in the call, so the identity the other layer
   * spends a GitHub request resolving at boot is never read here — and a process
   * that had resolved it would log, once, that runs commit as a person whose
   * name will never appear in a commit it makes. A boot line that is untrue
   * about the process printing it is worse than a missing one, and it costs a
   * request to a third party to print.
   *
   * {@link ScopeHistoryInterface.record} is still on the service and still
   * works; it writes as the fallback identity, which is the honest answer for a
   * process holding no run to attribute a snapshot to.
   */
  static readonly editsLayer = Layer.effect(
    ScopeHistory,
    makeScopeHistory({ committer: DEFAULT_COMMITTER })
  ).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, Git.layer)));
}
