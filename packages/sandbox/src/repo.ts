/**
 * Giving a run a checkout, from a mirror on the host rather than from GitHub.
 *
 * Two levels, and the split is the whole design. A **bare mirror** per repo
 * lives under the data root and is the only thing that ever talks to the
 * network; a run's workspace is an ordinary clone *of that mirror*, off local
 * disk, in the time it takes to hardlink a pack file. A repo that a hundred runs
 * touch is cloned over the network once and caught up incrementally after that,
 * so the per-run cost is a fetch of what changed rather than a fetch of the
 * history.
 *
 * The mirror is refreshed by {@link refreshMirror}, **on the dispatch path**,
 * every time a run is materialized. That is a reversal: this used to be a
 * separate operation the orchestrator was expected to schedule, on the argument
 * that a base branch an hour old still produces a correct pull request and a
 * fetch on the critical path is a network stall holding a dispatch slot. Two
 * things were wrong with it. Nothing ever owned the schedule, so a mirror was
 * fetched exactly once — when it was created — and every run after that branched
 * from the tip as it stood that day. And the premise does not survive contact
 * with a reviewer: a pull request cut from a stale base is reviewed against code
 * that is no longer what the default branch says, so the diff does not mean what
 * it looks like it means and the merge is a guess. Freshness is correctness
 * here, not latency policy, and the fetch is bounded ({@link FETCH_TIMEOUT}) so
 * the stall it was moved off the path to avoid fails loudly instead of hanging.
 * A missing mirror is still created on first use, and that clone is already at
 * the tip, so the cold path does not also fetch.
 *
 * A fetch that fails **fails the run**. There is no fallback to the stale
 * mirror: silently branching from an old base is the bug this arrangement
 * exists to prevent, and a run that cannot reach the remote also cannot push or
 * open a pull request, so continuing buys nothing. The failure is a
 * {@link CloneFailed}, which the orchestrator's ladder already retries with
 * backoff before parking the task — a network blip costs an attempt, not the
 * card.
 *
 * The workspace clone is a plain local clone, and **not** `--reference` or
 * `--shared`. Those make the checkout borrow objects from the mirror through
 * `objects/info/alternates`, which is faster still and is exactly wrong here:
 * the mirror is fetched and repacked by whichever dispatch reaches it next, and
 * a repack that prunes an object out from under a borrowing repo produces a
 * checkout that fails to read its own history halfway through a run. A local
 * clone hardlinks instead, so the workspace holds its own reference to every
 * object file it uses and the mirror can do whatever it likes. Moving the fetch
 * onto the dispatch path makes that concurrent repack likelier, not rarer, which
 * is the second reason this stays a copy.
 *
 * **A mirror is a cache, and `./sweep` is what finally gives it a lifetime.**
 * One bare clone per repo the board has ever touched used to be forever:
 * deleting the project in the dashboard left its mirror on disk with nothing
 * that would ever look at it again. The boot sweep removes a mirror no project
 * and no task still names, and the asymmetry is what makes that safe — the cost
 * of removing one somebody wants back is the cold clone {@link ensureMirror}
 * already does on first use, and never a byte of anybody's work.
 *
 * **No worktrees.** The previous generation of this machinery gave each task a
 * `git worktree` off one shared checkout, and carried the tax that implies: a
 * teardown that must run or the slot leaks, an orphan sweep for the teardowns
 * that did not, a stale-slot clear before every provision, and a copy of the
 * repo's gitignored `.env*` into each new tree. All four exist because the
 * trees share one repository and outlive the process that made them. A
 * container's workspace is created for one run and removed with it, so there is
 * no shared state to garbage-collect and none of that code is ported.
 *
 * Nothing here runs inside a container. The mirror, the clone and the branch
 * are host-side work done before the sandbox starts, and the workspace directory
 * is then bind-mounted in.
 */

import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  parseRepoUrl,
  type RepoIdentity,
  type TaskId,
} from "@workspace/domain";
import { Effect, Layer, Schedule } from "effect";
import { FileSystem } from "effect/FileSystem";
import { CloneFailed } from "./errors";
import { Git, redactRemote } from "./git";
import { CREDENTIAL_HELPER } from "./github";
import type { MaterializeStrategy, RepoSource } from "./spec";

/** Directory under the data root holding one bare mirror per repo. */
export const MIRRORS_SEGMENT = "mirrors";

/**
 * The prefix every branch this system pushes carries. One namespace, so a
 * human looking at a repo can tell an agent's branch from their own, and so a
 * cleanup that deletes them all is one refspec.
 */
export const BRANCH_PREFIX = "atm";

/**
 * The ref a run's branch is cut from when the project names no default branch.
 * `HEAD` rather than a guessed `main`: a clone of the mirror already points its
 * `HEAD` at whatever the remote's default is, so asking is always right and
 * guessing is wrong on every repo that still says `master`.
 */
export const FALLBACK_BASE_REF = "HEAD";

/** Who a run's commits are attributed to when the caller names nobody. */
export interface Committer {
  readonly email: string;
  readonly name: string;
}

/**
 * The identity commits get when there is nobody to name.
 *
 * Set at all because a container has no `~/.gitconfig`: git refuses to commit
 * without a name and an address, and an agent that discovers that on its first
 * commit spends the rest of the turn trying to fix it.
 *
 * It is no longer what a run normally commits as. `./committer` reads the
 * account behind `ATM_GITHUB_TOKEN` and hands that identity down, because an
 * address no account can claim is a commit GitHub cannot link to anyone: no
 * avatar, no profile, no contribution credit, and a blame that names a string.
 * The token already pushes the branch and opens the pull request as that
 * person, so the author field agreeing with the pusher is the honest reading
 * rather than a new claim — and the model's own `Co-Authored-By` trailer stays
 * on the commit to record who actually wrote it.
 *
 * `.invalid` is still deliberate here. This is the identity for a run with no
 * credential or a lookup that failed, where the alternative is guessing at a
 * person, and a reserved TLD is the shape of "nobody" that no mail server will
 * ever try to deliver to.
 */
export const DEFAULT_COMMITTER: Committer = {
  email: "agent@atm.invalid",
  name: "Agent Task Manager",
};

/** A single trailing `.git`, stripped from a mirror directory to recover its name. */
const TRAILING_GIT_RE = /\.git$/;

/**
 * The suffix a bare mirror directory carries, and the whole of what tells one
 * apart from the staging directory a killed `clone --mirror` leaves beside it.
 */
export const MIRROR_SUFFIX = ".git";

/**
 * The directory every mirror is nested under. Read by `./sweep`, which is the
 * one caller that walks the tree instead of composing a path into it.
 */
export const mirrorsRootOf = (dataRoot: string) =>
  join(dataRoot, MIRRORS_SEGMENT);

/** Where a repo's bare mirror lives on the host. Pure; the path encodes the slug. */
export const mirrorDirOf = (input: {
  readonly dataRoot: string;
  readonly repo: RepoIdentity;
}) =>
  join(
    mirrorsRootOf(input.dataRoot),
    input.repo.host,
    input.repo.owner,
    `${input.repo.name}${MIRROR_SUFFIX}`
  );

/**
 * The `owner/name` a mirror directory belongs to, recovered from the path
 * {@link mirrorDirOf} built. This is what a failure is named after when the
 * caller passed a {@link RepoSource} and no identity — the seam carries the
 * mirror path, and the path is the slug.
 */
export const repoLabelOf = (mirrorDir: string) =>
  `${basename(dirname(mirrorDir))}/${basename(mirrorDir).replace(TRAILING_GIT_RE, "")}`;

/**
 * What a run's branch is cut from. A remote-tracking ref rather than a local
 * one, because the workspace's local branches are whatever the mirror happened
 * to have and `origin/<branch>` is the thing that was actually fetched.
 */
export const baseRefOf = (defaultBranch: string | null) => {
  const trimmed = defaultBranch?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? FALLBACK_BASE_REF
    : `origin/${trimmed}`;
};

/**
 * The branch one task's runs push. Keyed on the task and nothing else, which is
 * the point: a rerun, a retry and a follow-up turn all land on the same branch,
 * so the pull request updates instead of a second one appearing beside it. A
 * run id in here would give every attempt its own dead branch.
 *
 * The id is a uuid, so the result needs no escaping — there is no ref-name
 * sanitizer here because there is nothing user-written in the name.
 */
export const branchForTask = (taskId: TaskId) =>
  `${BRANCH_PREFIX}/task-${taskId}`;

/** What a task needs to know to have a checkout made for it. */
export interface RepoSourceInput {
  readonly dataRoot: string;
  /** `project.repoDefaultBranch`. Null takes the clone's own `HEAD`. */
  readonly defaultBranch: string | null;
  /** `project.repoUrl`. Null, blank, or unparseable means no repo. */
  readonly repoUrl: string | null;
  readonly taskId: TaskId;
}

/**
 * The {@link RepoSource} for one task, or null when the task has no repo to
 * clone. Pure, and the single place the four decisions — which mirror, which
 * branch, which base, which URL — are made together, so the orchestrator does
 * not assemble a source whose mirror path and clone URL are for different
 * repos.
 */
export const repoSourceFor = (input: RepoSourceInput): RepoSource | null => {
  const repo = input.repoUrl === null ? null : parseRepoUrl(input.repoUrl);
  if (repo === null) {
    return null;
  }
  return {
    baseRef: baseRefOf(input.defaultBranch),
    branch: branchForTask(input.taskId),
    cloneUrl: repo.cloneUrl,
    mirrorDir: mirrorDirOf({ dataRoot: input.dataRoot, repo }),
  };
};

/** Turns a filesystem refusal into the package's own failure, without the remote in it. */
const failingFor =
  (repo: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.mapError(
      self,
      (cause) =>
        new CloneFailed({
          exitCode: null,
          repo,
          stderr: redactRemote(String(cause)),
        })
    );

/** The file a bare repository always has, and the cheapest proof one is there. */
const MIRROR_MARKER = "HEAD";

/** What {@link ensureMirror} did. */
export interface MirrorReport {
  /** True when this call created the mirror, which is the slow first fetch. */
  readonly created: boolean;
  readonly mirrorDir: string;
}

/**
 * Makes sure a repo's bare mirror exists, cloning it once if it does not.
 *
 * The clone lands in a sibling staging directory and is moved into place with a
 * rename, so a mirror is either absent or complete and never a half-fetched
 * directory that the next run treats as usable. The rename is also the lock: two
 * dispatches racing on a repo nobody has mirrored yet both fetch, and the loser's
 * rename fails against a non-empty directory, which is detected rather than
 * reported — the winner's mirror is a perfectly good answer to the question.
 */
export const ensureMirror = Effect.fn("Repo.ensureMirror")(function* (
  source: Pick<RepoSource, "cloneUrl" | "mirrorDir">
) {
  const fs = yield* FileSystem;
  const git = yield* Git;
  const repo = repoLabelOf(source.mirrorDir);
  const marker = join(source.mirrorDir, MIRROR_MARKER);

  const present = yield* fs.exists(marker).pipe(failingFor(repo));
  if (present) {
    return {
      created: false,
      mirrorDir: source.mirrorDir,
    } satisfies MirrorReport;
  }
  if (source.cloneUrl === null) {
    return yield* new CloneFailed({
      exitCode: null,
      repo,
      stderr: `no mirror at ${source.mirrorDir} and no clone url to create one`,
    });
  }

  const staging = `${source.mirrorDir}.${randomUUID()}.staging`;
  yield* fs
    .makeDirectory(dirname(source.mirrorDir), { recursive: true })
    .pipe(failingFor(repo));
  const discardStaging = fs
    .remove(staging, { force: true, recursive: true })
    .pipe(Effect.ignore);

  yield* git
    .mustRun({
      args: ["clone", "--mirror", source.cloneUrl, staging],
      cwd: null,
      executable: "git",
      repo,
    })
    .pipe(Effect.tapError(() => discardStaging));

  const moved = yield* Effect.result(
    fs.rename(staging, source.mirrorDir).pipe(failingFor(repo))
  );
  if (moved._tag === "Failure") {
    yield* discardStaging;
    // A rename onto a populated directory is how the losing side of the race
    // finds out it lost. Anything else — a full disk, a permission — is still a
    // failure, so the mirror has to actually be there before this is forgiven.
    const settled = yield* fs.exists(marker).pipe(failingFor(repo));
    if (!settled) {
      return yield* Effect.fail(moved.failure);
    }
    return {
      created: false,
      mirrorDir: source.mirrorDir,
    } satisfies MirrorReport;
  }
  return { created: true, mirrorDir: source.mirrorDir } satisfies MirrorReport;
});

/**
 * How long the fetch may take before it is torn down as a failure.
 *
 * A cap rather than the turn's own deadline, which also covers materialization
 * but is measured in tens of minutes: spending all of it on a remote that
 * black-holes packets means the run fails at the end of its budget having done
 * nothing, instead of failing in a minute with a message naming the remote.
 * Generous enough for a large repo's first catch-up over a slow link, and the
 * interrupt reaches the subprocess — `Git` kills a child that ignores SIGTERM.
 */
export const FETCH_TIMEOUT = "3 minutes";

/**
 * How many extra attempts a fetch gets, and how long it waits between them.
 *
 * Not for the network. This is for the race we cause ourselves: two dispatches
 * on the same repo at the same moment both fetch the same bare mirror, and the
 * loser's ref update loses a `.lock` file to the winner. That is a failure
 * against a mirror that is, a moment later, exactly as fresh as it needed to
 * be — so retrying costs a second and spending an attempt off the orchestrator's
 * ladder on it does not. A genuine outage still exhausts these and fails.
 */
const FETCH_RETRIES = 2;
const FETCH_RETRY_DELAY = "1 second";

/**
 * Fetches everything the remote has into an existing mirror and drops the refs
 * it has deleted.
 *
 * On the dispatch path, before every checkout — see this module's header for why
 * that changed, and why a failure here is the run's failure rather than a
 * fallback to whatever the mirror last saw.
 *
 * `--prune` matters as much as the fetch: without it a branch deleted on the
 * remote lives on in the mirror, and a task naming it as its base gets a
 * checkout of a branch that no longer exists rather than the error that would
 * have told somebody.
 */
export const refreshMirror = Effect.fn("Repo.refreshMirror")(function* (
  input: Pick<RepoSource, "mirrorDir">
) {
  const fs = yield* FileSystem;
  const git = yield* Git;
  const repo = repoLabelOf(input.mirrorDir);

  const present = yield* fs
    .exists(join(input.mirrorDir, MIRROR_MARKER))
    .pipe(failingFor(repo));
  if (!present) {
    return yield* new CloneFailed({
      exitCode: null,
      repo,
      stderr: `no mirror to refresh at ${input.mirrorDir}`,
    });
  }
  yield* git
    .mustRun({
      // `remote update --prune` rather than `fetch`: a mirror's refspec maps the
      // remote's refs onto its own, and this is the form that honours it without
      // restating the refspec here.
      args: ["remote", "update", "--prune"],
      cwd: input.mirrorDir,
      executable: "git",
      repo,
    })
    .pipe(
      Effect.retry({
        schedule: Schedule.spaced(FETCH_RETRY_DELAY),
        times: FETCH_RETRIES,
      }),
      // Outside the retry, so the cap bounds the whole ladder rather than each
      // attempt: a remote that black-holes packets costs one budget, not one
      // per try.
      Effect.timeoutOrElse({
        duration: FETCH_TIMEOUT,
        orElse: () =>
          new CloneFailed({
            exitCode: null,
            repo,
            stderr: `fetching ${repo} exceeded the ${FETCH_TIMEOUT} cap`,
          }),
      })
    );
});

/** What to check out, where, and who its commits belong to. */
export interface MaterializeRepoInput {
  /** Null takes {@link DEFAULT_COMMITTER}. */
  readonly committer: Committer | null;
  readonly repo: RepoSource;
  /** The directory that becomes the run's workspace mount. */
  readonly workspaceDir: string;
}

/** A run's checkout, ready to be mounted. */
export interface RepoCheckout {
  readonly branch: string;
  /** What the branch started at, so a diff after the run has a floor. */
  readonly headSha: string;
  /** True when the mirror had to be fetched first, which is the slow path. */
  readonly mirrorCreated: boolean;
  readonly strategy: MaterializeStrategy;
  readonly workspaceDir: string;
}

/**
 * Gives one run its checkout: mirror if needed, fetch it, clone from it, cut the
 * branch, point `origin` back at the real remote, and name the committer.
 *
 * The fetch is what makes the base the remote's tip at *dispatch* rather than
 * whenever this repo was first seen. It is skipped only when {@link ensureMirror}
 * just created the mirror, because a `clone --mirror` that finished a moment ago
 * is already the tip and a second round trip would buy nothing.
 *
 * Freshness reaches a task that overrides the base as well, without this
 * function knowing it happened. The workspace is cloned from the mirror *after*
 * the fetch, so every branch the remote has arrives as an `origin/<branch>`
 * remote-tracking ref current as of this moment — an agent told by its brief to
 * work off `mvp` gets the real `mvp`, not one a local ref remembered.
 *
 * `origin` is repointed rather than left alone because the clone's origin is a
 * host path that does not exist inside the container — an agent's `git push`
 * would fail against a directory it cannot see, which reads as a broken image
 * rather than a missing remote. Where there is no URL to point at, the remote is
 * removed outright, so a push fails saying there is no remote instead of naming
 * a path that means nothing.
 */
export const materializeRepo = Effect.fn("Repo.materialize")(function* (
  input: MaterializeRepoInput
) {
  const fs = yield* FileSystem;
  const git = yield* Git;
  const { repo: source, workspaceDir } = input;
  const repo = repoLabelOf(source.mirrorDir);
  const committer = input.committer ?? DEFAULT_COMMITTER;
  const inWorkspace = { cwd: workspaceDir, executable: "git", repo } as const;

  const mirror = yield* ensureMirror(source);
  if (!mirror.created) {
    yield* refreshMirror(source);
  }
  yield* fs
    .makeDirectory(workspaceDir, { recursive: true })
    .pipe(failingFor(repo));

  // `--no-checkout`, because the branch below is what gets checked out: cloning
  // the mirror's default first would write the whole tree twice.
  yield* git.mustRun({
    args: ["clone", "--no-checkout", source.mirrorDir, workspaceDir],
    cwd: null,
    executable: "git",
    repo,
  });
  // Asked before the checkout is attempted, purely so the message is readable.
  // `checkout -B` against a ref that is not there fails with git's "invalid
  // reference", which does not say that the *project's* default branch is the
  // thing that no longer exists on the remote — and with `--prune` above, a
  // branch deleted upstream now reaches this line instead of quietly resolving
  // against a leftover mirror ref.
  const base = yield* git.run({
    ...inWorkspace,
    args: ["rev-parse", "--verify", "--quiet", `${source.baseRef}^{commit}`],
  });
  if (base.exitCode !== 0) {
    return yield* new CloneFailed({
      exitCode: base.exitCode,
      repo,
      stderr: `base ref ${source.baseRef} does not exist on ${repo} after fetching`,
    });
  }
  // `--no-track` so the new branch has no upstream. With one, an agent's plain
  // `git push` argues with the base branch it was cut from instead of creating
  // the run's own head.
  yield* git.mustRun({
    ...inWorkspace,
    args: ["checkout", "--no-track", "-B", source.branch, source.baseRef],
  });
  yield* git.mustRun({
    ...inWorkspace,
    args:
      source.cloneUrl === null
        ? ["remote", "remove", "origin"]
        : ["remote", "set-url", "origin", source.cloneUrl],
  });
  // The helper, in the checkout rather than on the invocation, because the next
  // process to run git here is the agent's — inside the container, on this
  // directory through its mount. It names `GH_TOKEN` and holds no value, so the
  // config file the agent can read is not the credential.
  yield* git.mustRun({
    ...inWorkspace,
    args: ["config", "--local", "credential.helper", CREDENTIAL_HELPER],
  });
  yield* git.mustRun({
    ...inWorkspace,
    args: ["config", "--local", "user.name", committer.name],
  });
  yield* git.mustRun({
    ...inWorkspace,
    args: ["config", "--local", "user.email", committer.email],
  });

  const head = yield* git.mustRun({
    ...inWorkspace,
    args: ["rev-parse", "HEAD"],
  });
  // `baseRef` is on the span because "what did this run branch from" is the
  // question a reviewer holding a suspicious diff actually asks, and answering
  // it from a trace beats reconstructing it from the merge-base afterwards.
  yield* Effect.annotateCurrentSpan({
    baseRef: source.baseRef,
    branch: source.branch,
    repo,
  });

  return {
    branch: source.branch,
    headSha: head.stdout.trim(),
    mirrorCreated: mirror.created,
    strategy: "mount",
    workspaceDir,
  } satisfies RepoCheckout;
});

/**
 * The platform this module's subprocesses and filesystem calls resolve against.
 * Built once at module scope rather than per call, so a hundred dispatches do
 * not each construct a spawner.
 */
const platformLayer = Layer.mergeAll(BunFileSystem.layer, Git.layer);

/**
 * {@link materializeRepo} with its dependencies already resolved, shaped for
 * the workspace materializer's clone seam: one input, no requirements, void on
 * success.
 *
 * It exists because the materializer's `materialize` answers with `Scope` as
 * its only requirement, so the clone it is handed cannot ask for a filesystem
 * or a command runner of its own. The checkout's `headSha` and the
 * mirror-created flag are dropped here — a caller that wants them for an event
 * calls {@link materializeRepo} directly and provides the layer itself.
 *
 * The committer is optional so this still satisfies the clone seam's own type,
 * which knows about a repo and a directory and nothing about identities. What
 * fills it is the layer in `./workspace`, once, from the token.
 */
export const cloneIntoWorkspace = (input: {
  /** Null or absent takes {@link DEFAULT_COMMITTER}. */
  readonly committer?: Committer | null;
  readonly repo: RepoSource;
  readonly targetDir: string;
}) =>
  materializeRepo({
    committer: input.committer ?? null,
    repo: input.repo,
    workspaceDir: input.targetDir,
  }).pipe(Effect.asVoid, Effect.provide(platformLayer));

/*
 * There was a `refreshRepoMirror` here — {@link refreshMirror} pre-wired "for
 * whoever owns the schedule". Nobody ever did, and that is the whole of the
 * stale-base bug: an export shaped like a solved problem, on a package's public
 * surface, with no caller. The fetch is on the dispatch path now, so a wired
 * form has no user, and leaving one would rebuild the same trap. If a pre-warm
 * sweep is ever wanted — to make the dispatch fetch cheap rather than to make it
 * unnecessary — it is four lines, and it should arrive with its scheduler.
 */
