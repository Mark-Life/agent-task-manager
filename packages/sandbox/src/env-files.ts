/**
 * Putting a project's environment files into a run's checkout.
 *
 * **This module learns bytes and paths and nothing else.** It is handed a list
 * of `{path, content}` and a directory; it never learns that a project, a
 * workspace, a database row or an encryption key was involved. That is what
 * keeps `@workspace/sandbox` free of `@workspace/db` while still being the
 * thing that writes the files — the orchestrator reads and decrypts, and hands
 * over plain values.
 *
 * **The path is checked twice and the second check is the one that counts.**
 * `EnvFilePath` in the domain refuses anything that is not an ordinary
 * repo-relative path, and the brand is evidence that it did. It is re-checked
 * here anyway, because this is the line where a string becomes a filesystem
 * write under a directory the loop user owns: a value that reached here without
 * going through the schema — a hand-written row, a future caller — must not be
 * the thing that discovers the gap.
 *
 * The resolved parent is then compared against the real workspace root, which
 * is the one check the pure rule cannot make. A repo can ship `apps` as a
 * symlink to `/etc`, and a path built entirely of ordinary segments still lands
 * outside the checkout when one of them is not a directory at all.
 *
 * **The files are `0600` and the checkout is `0700`.** The data root is one
 * directory shared by a service account, and every other run's checkout is a
 * sibling of this one. Neither mode is what protects the file from the agent —
 * the agent is *given* these files, that is the point — they are what keeps the
 * rest of the host from reading them.
 *
 * **Each path is added to `.git/info/exclude`.** An environment file written
 * into a real repository is a file the agent can commit, and this is the cheap
 * and git-native half of preventing it: `git add .` skips an excluded path, and
 * `git add .env` refuses with a message naming the exclusion rather than
 * quietly staging a secret. It is per checkout, so it never touches a
 * `.gitignore` the repository tracks. What it cannot help with is a path the
 * repository *already tracks* — exclusion applies to untracked files only — and
 * that residual case is the operator's to not do.
 */

import { dirname, join, resolve, sep } from "node:path";
import { type EnvFileWrite, envPathRefusalOf } from "@workspace/domain";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { EnvFileWriteFailed } from "./errors";

/**
 * Mode of an environment file. Owner-only, because the value is a credential
 * and the directory it sits in is reachable by whatever else the service
 * account runs.
 */
export const ENV_FILE_MODE = 0o600;

/**
 * Mode of a directory this creates on the way to a file. Owner-only for the
 * same reason: a `0755` parent is a listable path to a `0600` file, which
 * names the secret even where it does not reveal it.
 */
export const ENV_DIR_MODE = 0o700;

/** Where git keeps the per-checkout exclusions, which no commit ever carries. */
export const GIT_EXCLUDE_PATH = join(".git", "info", "exclude");

/** The header written above the excluded paths, so a human reading the file knows who wrote it. */
export const GIT_EXCLUDE_HEADER =
  "# Written by the task manager: the project's environment files.";

/** What one run's env files are written from. */
export interface WriteEnvFilesInput {
  /** The files, already decrypted. Empty is the ordinary case and does nothing. */
  readonly files: readonly EnvFileWrite[];
  /** The run's checkout. Must already exist. */
  readonly workspaceDir: string;
}

/** Fails naming the path, and never the content. */
const failing = (path: string) =>
  Effect.mapError((cause: unknown) => new EnvFileWriteFailed({ cause, path }));

/** True when `child` is the root itself or something under it. */
const isUnder = (root: string, child: string) =>
  child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Writes one file, and answers with where it went.
 *
 * The order is deliberate: refuse the path, make the parent, check where the
 * parent really is, and only then write. Checking the parent after making it is
 * what catches the symlink — `realPath` on a directory that does not exist yet
 * has nothing to resolve.
 */
const writeOne = Effect.fnUntraced(function* (input: {
  readonly file: EnvFileWrite;
  readonly root: string;
  readonly workspaceDir: string;
}) {
  const fs = yield* FileSystem;
  const { file, root } = input;

  const refusal = envPathRefusalOf(file.path);
  if (refusal !== null) {
    return yield* Effect.fail(
      new EnvFileWriteFailed({
        cause: `not a repo-relative path: ${refusal}`,
        path: file.path,
      })
    );
  }

  const target = resolve(input.workspaceDir, file.path);
  const parent = dirname(target);
  yield* fs
    .makeDirectory(parent, { mode: ENV_DIR_MODE, recursive: true })
    .pipe(failing(file.path));

  const realParent = yield* fs.realPath(parent).pipe(failing(file.path));
  if (!isUnder(root, realParent)) {
    return yield* Effect.fail(
      new EnvFileWriteFailed({
        cause: `${file.path} resolves to ${realParent}, which is outside the checkout`,
        path: file.path,
      })
    );
  }

  // The mode is set on the write and again after it: `writeFileString` applies
  // its mode only when it creates the file, and a repository that tracks a
  // placeholder at this path has already created it with whatever the clone
  // gave it.
  yield* fs
    .writeFileString(target, file.content, { mode: ENV_FILE_MODE })
    .pipe(failing(file.path));
  yield* fs.chmod(target, ENV_FILE_MODE).pipe(failing(file.path));
  return file.path;
});

/**
 * Adds the written paths to the checkout's own git exclusions.
 *
 * Appended rather than rewritten, because `.git/info/exclude` ships with a
 * comment header of git's own and a repository may have put something there
 * itself. A checkout with no `.git` — a task with no repo, working in a scratch
 * directory — has nothing to exclude from, and that is a return rather than a
 * failure.
 *
 * A failure here is logged and swallowed. The files are already written and the
 * run can do its work; what is lost is a guard against a commit, and refusing to
 * start a run over it would trade a possible mistake for a certain one.
 */
const excludeFromGit = Effect.fnUntraced(function* (input: {
  readonly paths: readonly string[];
  readonly workspaceDir: string;
}) {
  const fs = yield* FileSystem;
  const excludePath = join(input.workspaceDir, GIT_EXCLUDE_PATH);
  const gitDir = dirname(dirname(excludePath));
  const isRepo = yield* fs
    .exists(gitDir)
    .pipe(Effect.orElseSucceed(() => false));
  if (!isRepo) {
    return false;
  }

  const lines = [GIT_EXCLUDE_HEADER, ...input.paths, ""].join("\n");
  return yield* fs
    .makeDirectory(dirname(excludePath), { recursive: true })
    .pipe(
      Effect.andThen(
        fs.writeFileString(excludePath, `\n${lines}`, { flag: "a" })
      ),
      Effect.as(true),
      Effect.tapError((cause) =>
        Effect.logWarning(
          "env files not added to the checkout's git exclusions",
          {
            cause,
            path: excludePath,
          }
        )
      ),
      Effect.orElseSucceed(() => false)
    );
});

/** What writing a run's env files did. Paths and counts, never content. */
export interface EnvFilesWritten {
  /** True when the paths were added to `.git/info/exclude`. False for a checkout with no repo. */
  readonly excluded: boolean;
  /** Where each file went, repo-relative and in the order given. */
  readonly paths: readonly string[];
}

/** Nothing to write, which is every task whose project has no files. */
const NOTHING_WRITTEN: EnvFilesWritten = { excluded: false, paths: [] };

/**
 * Writes every file into the checkout and excludes them from git.
 *
 * Sequential rather than concurrent: it is a handful of small files, two of
 * them often share a parent directory, and a `mkdir -p` race between two fibers
 * for one path is a failure mode bought for no measurable time.
 */
export const writeEnvFiles = Effect.fn("Workspace.writeEnvFiles")(function* (
  input: WriteEnvFilesInput
) {
  if (input.files.length === 0) {
    return NOTHING_WRITTEN;
  }
  const fs = yield* FileSystem;
  yield* Effect.annotateCurrentSpan({ files: input.files.length });

  // The root is resolved once, through whatever links the data root itself sits
  // behind — on a mac, `/var` is a link to `/private/var`, so comparing an
  // unresolved root against a resolved parent would refuse every path.
  const root = yield* fs
    .realPath(input.workspaceDir)
    .pipe(
      Effect.mapError(
        (cause) => new EnvFileWriteFailed({ cause, path: input.workspaceDir })
      )
    );

  const paths = yield* Effect.forEach(input.files, (file) =>
    writeOne({ file, root, workspaceDir: input.workspaceDir })
  );
  const excluded = yield* excludeFromGit({
    paths,
    workspaceDir: input.workspaceDir,
  });
  return { excluded, paths } satisfies EnvFilesWritten;
});
