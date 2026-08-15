/**
 * Where a path a person typed becomes a path something opens, and the only
 * place in the gateway that decides whether it may.
 *
 * Its own module because the answer is one answer. Seven operations join a
 * caller's path to a scope's directory, and seven copies of a containment check
 * is six chances for one of them to be subtly weaker than the others — so the
 * routes in `./files` decide policy, and every question about where a path
 * actually lands is asked here.
 *
 * **The gateway is not inside the container.** It runs on the host as the loop
 * user, which owns the whole data root, so a link planted in a scope by a run
 * that has the scope mounted read-write points wherever it likes and this
 * process would follow it with the host's reach. That is the threat these
 * functions exist for, and it is why every check happens twice: once against
 * the string, which the branded schema has already refused the obvious forms
 * of, and once against the disk, where the string tells you nothing.
 *
 * What is left open, honestly: a parent directory swapped for a link *between*
 * the check and the write. Closing that needs the openat2 resolution flags,
 * which node does not expose, and the writer here is a person over HTTP while
 * the attacker is a container — so the window is a request rather than a
 * schedule anybody controls. Everything a link can do without winning that race
 * is refused.
 */

import { basename, dirname, relative, resolve, sep } from "node:path";
import type { FileEntry } from "@workspace/api";
import { Forbidden, NotFound, type PrincipalShape } from "@workspace/api";
import {
  type MalformedRow,
  type PersistenceError,
  ProjectRepo,
  type InvalidInput as StoreInvalidInput,
  type NotFound as StoreNotFound,
  TaskRepo,
} from "@workspace/db";
import { FileScope, type ScopePath } from "@workspace/domain";
import {
  ARTIFACT_DIR_MODE,
  type ArtifactIoFailed,
  ensureFileScopeDir,
  extOf,
  fileScopeDirOf,
  GIT_DIR,
} from "@workspace/sandbox";
import { DateTime, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";

/** Everything the store and the filesystem below a handler can fail with. */
type StoreFailure =
  | ArtifactIoFailed
  | MalformedRow
  | PersistenceError
  | StoreInvalidInput
  | StoreNotFound;

/** The store's 404 as the wire's. */
const asNotFound = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, (failure) =>
    failure._tag === "Db.NotFound"
      ? Effect.fail(new NotFound({ entity: failure.entity, id: failure.id }))
      : Effect.die(failure)
  );

/** A path that does not stay inside the scope it named, whatever made it leave. */
export const escaped = (reason: string) =>
  new Forbidden({ reason, required: "admin" });

/** What every operation here needs: whose request it is, and which directory. */
export interface ScopeRequest {
  /** The root the artifact tree hangs off. */
  readonly dataRoot: string;
  readonly principal: PrincipalShape;
  /** From the route, already decoded from one path segment into the union. */
  readonly scope: FileScope;
}

/** One path inside one scope, addressed the way the routes address it. */
export interface ScopePathRequest extends ScopeRequest {
  readonly path: ScopePath;
}

/**
 * The row a scope names, or 404.
 *
 * A project id or a task id in an address is not a permission — the workspace
 * comes off the credential — so it is looked up rather than assumed, and an id
 * from another workspace is a 404 rather than an empty folder that reads as
 * "nothing here". The two scopes that name no row have nothing to check.
 */
const requireScope = (input: ScopeRequest) =>
  FileScope.match(input.scope, {
    manager: () => Effect.void,
    project: (self) =>
      Effect.flatMap(ProjectRepo, (projects) =>
        projects
          .byId({
            id: self.projectId,
            workspaceId: input.principal.workspaceId,
          })
          .pipe(asNotFound)
      ),
    task: (self) =>
      Effect.flatMap(TaskRepo, (tasks) =>
        tasks
          .byId({ id: self.taskId, workspaceId: input.principal.workspaceId })
          .pipe(asNotFound)
      ),
    workspace: () => Effect.void,
  });

/** True when `child` is `root` or sits below it, counted in segments rather than characters. */
export const within = (child: string, root: string) =>
  child === root || child.startsWith(`${root}${sep}`);

/**
 * True when a path that is already inside the scope lands in an object store.
 *
 * The branded path refuses a `.git` segment in the string, and that refusal
 * covers only what was typed. A link is the way past it: a run holds its project
 * scope read-write, so it can leave `history -> .git` in the folder, and every
 * containment question then answers "inside the scope" — because it is. The
 * commits are the audit trail of who edited the rules a run reads, so a route
 * that could rewrite a ref or drop an object would let the record be edited by
 * the thing it is a record of.
 *
 * Asked of the resolved path rather than the typed one, and at every depth,
 * which is the same rule the schema states applied to where a path really ends
 * up.
 */
const insideGitDir = (input: {
  readonly path: string;
  readonly root: string;
}) => relative(input.root, input.path).split(sep).includes(GIT_DIR);

/**
 * The scope's own directory, resolved through its links once.
 *
 * Resolved because a data root reached through a link — `/tmp` on a mac, a
 * mounted volume in production — would otherwise make every path inside it look
 * like an escape from itself. Every containment question below is asked against
 * this, so the answer is about the disk rather than about the string an operator
 * configured.
 */
export const scopeRootOf = Effect.fnUntraced(function* (input: {
  readonly create: boolean;
  readonly request: ScopeRequest;
}) {
  yield* requireScope(input.request);
  const fs = yield* FileSystem;
  const dir = fileScopeDirOf({
    dataRoot: input.request.dataRoot,
    scope: input.request.scope,
  });
  if (input.create) {
    yield* ensureFileScopeDir({
      dataRoot: input.request.dataRoot,
      scope: input.request.scope,
    }).pipe(Effect.orDie);
  }
  return yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => resolve(dir)));
});

/** What the disk says about one contained path. */
export interface ResolvedPath {
  /** Where the string says it is, inside the scope's real root. */
  readonly absolute: string;
  /** The link text when the last segment is a symlink, and null otherwise. */
  readonly link: string | null;
  /** The path with every link followed, or null when there is nothing there. */
  readonly real: string | null;
  readonly relative: string;
}

/**
 * The deepest ancestor of a path that exists, resolved through its links.
 *
 * Climbing is what makes one check cover both a path that is already there and
 * one whose parents are about to be created: whichever of them is on disk is
 * where a planted link would have to be, and everything above the root is the
 * root itself.
 */
const realAncestorOf = Effect.fnUntraced(function* (input: {
  readonly absolute: string;
  readonly root: string;
}) {
  const fs = yield* FileSystem;
  let current = dirname(input.absolute);
  while (current.length > input.root.length && within(current, input.root)) {
    const real = yield* fs.realPath(current).pipe(Effect.option);
    if (Option.isSome(real)) {
      return real.value;
    }
    current = dirname(current);
  }
  return input.root;
});

/**
 * Resolves a caller's path against a scope's root and refuses anything that
 * leaves it.
 *
 * Contained twice, and the two checks answer different questions. The string
 * test is about what was typed, which the brand has already refused the obvious
 * forms of. The disk test is about what is there: the target itself if it
 * exists, and otherwise the deepest ancestor that does — because a link
 * anywhere along the path lands the write somewhere else entirely, and the
 * gateway follows links with the host's reach rather than a container's.
 */
export const resolveInScope = Effect.fnUntraced(function* (input: {
  readonly path: string;
  readonly root: string;
}) {
  const fs = yield* FileSystem;
  const absolute = resolve(input.root, input.path);
  if (!absolute.startsWith(`${input.root}${sep}`)) {
    yield* Effect.logWarning("file path leaves its scope", {
      path: input.path,
    });
    return yield* escaped(
      "the path names a file outside the scope it addressed"
    );
  }

  const link = yield* fs.readLink(absolute).pipe(Effect.option);
  const real = yield* fs.realPath(absolute).pipe(Effect.option);
  const ancestor = yield* realAncestorOf({ absolute, root: input.root });
  if (!within(ancestor, input.root)) {
    yield* Effect.logWarning("file path resolves outside its scope", {
      path: input.path,
      through: ancestor,
    });
    return yield* escaped(
      "the path resolves through a link that leaves the scope"
    );
  }

  const landed = Option.getOrElse(real, () => ancestor);
  if (
    insideGitDir({ path: landed, root: input.root }) ||
    insideGitDir({ path: ancestor, root: input.root })
  ) {
    yield* Effect.logWarning("file path resolves into an object store", {
      path: input.path,
      through: landed,
    });
    return yield* escaped("the path resolves into the scope's git directory");
  }

  return {
    absolute,
    link: Option.getOrNull(link),
    real: Option.getOrNull(real),
    relative: input.path,
  } satisfies ResolvedPath;
});

/**
 * Refuses a target that resolves outside the scope, for the two operations that
 * follow a link rather than refusing it.
 *
 * The ancestor check cannot see this one. When the link *is* the file being
 * read, its parent is an ordinary directory inside the scope and every question
 * about the parent answers "inside" — the escape is entirely in the last
 * segment. Reading and listing follow a link that lands back inside the same
 * scope, because the skills layout is built out of exactly such links, so the
 * test is where the link goes rather than whether there is one.
 */
export const refuseEscape = (input: {
  readonly root: string;
  readonly target: ResolvedPath;
}) => {
  const { real } = input.target;
  return real === null || within(real, input.root)
    ? Effect.void
    : Effect.andThen(
        Effect.logWarning("file path resolves outside its scope", {
          path: input.target.relative,
          through: real,
        }),
        Effect.fail(
          escaped("the path resolves through a link that leaves the scope")
        )
      );
};

/** A path that has to be there, and the 404 when it is not. */
export const requireExisting = (target: ResolvedPath) =>
  target.real === null && target.link === null
    ? Effect.fail(new NotFound({ entity: "file", id: target.relative }))
    : Effect.succeed(target);

/**
 * Refuses a path whose last segment is a link, for the operations that would
 * write through one.
 *
 * The only rule that survives a target created after the check: whether the
 * link dangles or resolves is a race an attacker controls, and refusing the
 * link itself is what makes the ordering irrelevant. A person who wants the
 * file the link points at can open it where it really is.
 */
export const refuseLink = (target: ResolvedPath) =>
  target.link === null
    ? Effect.void
    : Effect.andThen(
        Effect.logWarning("refusing to write through a link", {
          path: target.relative,
          target: target.link,
        }),
        Effect.fail(
          escaped(
            "the path is a symbolic link, which this route will not follow"
          )
        )
      );

/** Whether following a link's own text leaves the scope. Advisory, and cheap. */
const linkEscapes = (input: {
  readonly absolute: string;
  readonly root: string;
  readonly target: string;
}) => !within(resolve(dirname(input.absolute), input.target), input.root);

/**
 * One directory entry, described by what it actually is.
 *
 * Three calls rather than one, because the filesystem service follows links on
 * `stat` and a browser that could not tell a link from the thing it points at
 * would show the skills layout — one real directory and a link beside it — as
 * two copies of one skill with no way to know which an edit lands in.
 */
export const entryOf = Effect.fnUntraced(function* (input: {
  readonly absolute: string;
  readonly relative: string;
  readonly root: string;
}) {
  const fs = yield* FileSystem;
  const link = yield* fs.readLink(input.absolute).pipe(Effect.option);
  const info = yield* fs.stat(input.absolute).pipe(Effect.option);
  const directory =
    Option.isSome(info) &&
    info.value.type === "Directory" &&
    Option.isNone(link);
  const present: FileEntry["kind"] = directory ? "directory" : "file";
  const kind: FileEntry["kind"] = Option.isSome(link) ? "symlink" : present;
  const modified = Option.flatMap(info, (value) =>
    Option.orElse(value.mtime, () => value.birthtime)
  );
  return {
    bytes:
      kind === "file" && Option.isSome(info) ? Number(info.value.size) : null,
    ext: kind === "directory" ? null : extOf(input.relative),
    kind,
    modifiedAt: Option.match(modified, {
      onNone: () => null,
      onSome: DateTime.fromDateUnsafe,
    }),
    name: basename(input.relative),
    path: input.relative,
    target: Option.getOrNull(link),
    targetOutsideScope: Option.match(link, {
      onNone: () => false,
      onSome: (target) =>
        linkEscapes({ absolute: input.absolute, root: input.root, target }),
    }),
  } satisfies FileEntry;
});

/**
 * Creates the directories above a path, proves the parent is still inside the
 * scope, and answers with where that parent really is.
 *
 * The real path is the answer rather than the string, because a relative
 * symbolic link is resolved by the kernel against the directory the link
 * physically sits in. Computing one against the typed parent instead would
 * write a link that resolves correctly only while no directory above it is
 * itself a link.
 */
export const makeParent = Effect.fnUntraced(function* (input: {
  readonly absolute: string;
  readonly root: string;
}) {
  const fs = yield* FileSystem;
  const parent = dirname(input.absolute);
  yield* fs
    .makeDirectory(parent, { mode: ARTIFACT_DIR_MODE, recursive: true })
    .pipe(Effect.orDie);
  // After the directory exists, so the answer is about the path that will
  // actually be written rather than about one that does not exist yet.
  const real = yield* fs.realPath(parent).pipe(Effect.orDie);
  if (!within(real, input.root)) {
    yield* Effect.logWarning("file parent resolves outside its scope", {
      parent: real,
    });
    return yield* escaped(
      "the path resolves through a link that leaves the scope"
    );
  }
  if (insideGitDir({ path: real, root: input.root })) {
    yield* Effect.logWarning("file parent resolves into an object store", {
      parent: real,
    });
    return yield* escaped("the path resolves into the scope's git directory");
  }
  return real;
});
