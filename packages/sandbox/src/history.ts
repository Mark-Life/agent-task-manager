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
import type { ProjectId, RunId } from "@workspace/domain";
import { Context, Effect, Layer, Semaphore } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  GIT_DIR,
  globalArtifactsDirOf,
  projectArtifactsDirOf,
} from "./artifacts";
import { resolveCommitter } from "./committer";
import { Git } from "./git";
import type { Committer } from "./repo";

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

/** What one scope's snapshot produced: whether it committed, and where it left the branch. */
interface SnapshotResult {
  readonly committed: boolean;
  readonly head: string | null;
}

/**
 * What a scope reports when its snapshot did not happen at all — the folder is
 * absent, git timed out, git failed. No commit, and no commit to point at
 * either: a head read off a snapshot that was abandoned would name a tree
 * nobody can vouch this run was handed.
 */
const NO_SNAPSHOT: SnapshotResult = { committed: false, head: null };

/**
 * The directories one run shares with others. The workspace scope is in every
 * run's tree; the project scope is there only for a task that belongs to one.
 *
 * The task scope is deliberately absent. It belongs to a single task, so there
 * is nobody to overwrite and nothing a snapshot would preserve that the folder
 * itself does not already hold.
 */
const scopesOf = (input: ScopeHistoryInput): readonly ScopeDirectory[] => [
  { directory: globalArtifactsDirOf(input.dataRoot), scope: "workspace" },
  ...(input.projectId === null
    ? []
    : [
        {
          directory: projectArtifactsDirOf({
            dataRoot: input.dataRoot,
            projectId: input.projectId,
          }),
          scope: "project" as const,
        },
      ]),
];

/** The subject line one snapshot carries. The run id is what a reader greps for. */
export const historyMessageOf = (input: {
  readonly phase: HistoryPhase;
  readonly runId: RunId;
}) => `snapshot ${input.phase} run ${input.runId}`;

/** Records what a shared scope held around one run. */
export interface ScopeHistoryInterface {
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
  const identityArgs = [
    "-c",
    `user.name=${committer.name}`,
    "-c",
    `user.email=${committer.email}`,
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
   */
  const snapshot = Effect.fnUntraced(function* (input: {
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
        ...identityArgs,
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
      const done = yield* Semaphore.withPermit(lock)(
        snapshot({ message, scope })
      ).pipe(
        // Outside the permit, so the cap covers the wait as well as the work: a
        // run queued behind a git that hung gives up at the same two minutes
        // rather than at two minutes after it finally gets in.
        Effect.timeoutOrElse({
          duration: SNAPSHOT_TIMEOUT,
          orElse: () =>
            Effect.logWarning("scope history timed out", {
              path: scope.directory,
              scope: scope.scope,
            }).pipe(Effect.as(NO_SNAPSHOT)),
        }),
        // Per scope rather than around the loop: a workspace folder somebody
        // made read-only must not cost the project folder its history, and each
        // failure names the scope it happened in.
        Effect.catchCause((cause) =>
          Effect.logWarning("scope history not recorded", {
            cause,
            path: scope.directory,
            scope: scope.scope,
          }).pipe(Effect.as(NO_SNAPSHOT))
        )
      );
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

  return ScopeHistory.of({ record } satisfies ScopeHistoryInterface);
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
}
