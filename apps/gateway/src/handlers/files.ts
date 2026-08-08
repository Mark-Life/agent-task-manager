/**
 * The agent filesystem, opened for a person: one directory of the tree at a
 * time, contained twice, and committed when it changes.
 *
 * **Nothing here opens a path a caller composed.** Every path arrives branded,
 * which has already refused `..`, a leading slash, a control character and a
 * `.git` segment — and that is the cheap half. The expensive half is the disk:
 * the gateway runs on the host as the loop user, which owns the whole data
 * root, and a container with a scope mounted read-write can plant a symlink in
 * it whenever it likes. So the deepest existing ancestor of every path is
 * resolved through its links and refused unless it is still inside the scope,
 * and a write is refused outright when the last segment is itself a link.
 *
 * That last rule is the one a check of the parent directory misses. A link
 * planted at `<scope>/rules.md` pointing at a target that does not exist yet
 * passes every question about where its parent is, and the write then creates
 * the target wherever the link points — so whether the target exists at the
 * moment of the check cannot matter, and these routes never write through a
 * link at all.
 *
 * A read does follow one, and only where it lands back inside the same scope —
 * the skills layout is built out of exactly such links, so refusing them would
 * refuse the layout this tree exists to hold. The escape it has to catch is the
 * link that *is* the file: its parent is an ordinary directory inside the
 * scope, so every question about the parent answers "inside" and only the
 * resolved target says otherwise.
 *
 * **One route makes a link, and it makes a relative one.** A person names two
 * paths in one scope and the text on disk is computed between them, because a
 * scope is a bind mount: a host path in a link resolves for whoever typed it
 * and dangles inside every container that reads the tree. That is what one file
 * under two names is for — `AGENTS.md` holding a rule and `CLAUDE.md` pointing
 * at it, since neither provider reads the other's name.
 *
 * **A person, and only a person.** Every operation is admin-scoped, reads
 * included. An agent credential's ceiling is `task-write` and can never be
 * minted higher, so the refusal is arithmetic on a token rather than a check
 * somebody remembered — and the mount flags that make a worker's write above
 * its own task scope a proposal stay meaningful instead of being one HTTP call
 * away from irrelevant.
 *
 * **A change leaves a commit.** The two shared scopes are git repositories that
 * `@workspace/sandbox` snapshots around every run. An edit made here commits at
 * the moment it is made, authored by the person who made it, so a hand edit is
 * attributed the way a run's write is instead of being folded into the next
 * run's `before` snapshot and read as something that run did.
 *
 * The path algebra and the history are `@workspace/sandbox`'s. This file
 * decides who may do what and translates failures onto the wire's; a second
 * answer to "where does a scope live" is an answer waiting to disagree with the
 * mounts a run actually gets.
 */

import { join, relative } from "node:path";
import {
  Api,
  type FileContent,
  type FileEncoding,
  Forbidden,
  InvalidInput,
  MAX_FILE_BYTES,
  NotFound,
  PayloadTooLarge,
  Principal,
  type PrincipalShape,
} from "@workspace/api";
import type { ProjectRepo, TaskRepo } from "@workspace/db";
import type { FileScope, ScopePath } from "@workspace/domain";
import {
  ARTIFACT_DIR_MODE,
  type Committer,
  editMessageOf,
  GIT_DIR,
  historyScopeOf,
  ScopeHistory,
} from "@workspace/sandbox";
import { Config, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";
import {
  entryOf,
  makeParent,
  refuseEscape,
  refuseLink,
  requireExisting,
  resolveInScope,
  type ScopePathRequest,
  type ScopeRequest,
  scopeRootOf,
} from "./scope-paths";

/** Where the artifacts tree lives when the environment says nothing. Mirrors `@workspace/env`. */
const DEFAULT_DATA_ROOT = ".data";

/**
 * Read here rather than from a service: where the tree lives is not a request's
 * business. Exported because `./skills` writes into the same directories and a
 * second reading of the same variable is a second answer to where they are.
 */
export const dataRootConfig = Config.string("DATA_ROOT").pipe(
  Config.withDefault(DEFAULT_DATA_ROOT)
);

/**
 * The domain a person's commits are addressed at.
 *
 * A reserved TLD, on the same reasoning as the agent identity `@workspace/sandbox`
 * falls back to: the gateway knows the user id the credential resolved to and
 * does not know that person's mailbox, and inventing one would publish an
 * address its owner never offered into every commit of a folder that may be
 * pushed somewhere. The id is what the system holds, so the id is what the
 * commit says.
 */
const EDITOR_EMAIL_DOMAIN = "users.atm.invalid";

/**
 * The person whose name the commit carries.
 *
 * The middleware has already refused every credential an agent can hold, so
 * this is a total function over what is left rather than a second check of the
 * same rule. It exists because a commit names somebody: an actor with nobody
 * behind it — the loop, a seed script — is not editing the house rules, and an
 * edit attributed to nobody is the thing the git history exists to prevent.
 *
 * Exported for `./skills`, which writes into these same directories: installing
 * a skill is a person's edit like any other and is attributed the same way.
 */
export const editorOf = (
  principal: PrincipalShape
): Effect.Effect<Committer, Forbidden> =>
  principal.actor.kind === "human"
    ? Effect.succeed({
        email: `${principal.actor.userId}@${EDITOR_EMAIL_DOMAIN}`,
        name: principal.actor.userId,
      })
    : Effect.fail(
        new Forbidden({
          reason: "a scope is edited by a person",
          required: "admin",
        })
      );

/**
 * What is in one directory: directories first, then by name.
 *
 * The scope's own `.git` is not in the answer. It is the audit trail rather
 * than the contents, no path in this contract can address it, and a person
 * offered thousands of object files to click on has been told something untrue
 * about their tree.
 *
 * A scope's root that is not there lists as nothing rather than as a 404,
 * because a scope nobody has written to yet is the ordinary first case — the
 * folders are created on demand everywhere else in this system, and reading one
 * is not a reason to create it. A *named* path that is not a directory is
 * refused instead: answering a file with an empty listing would tell a browser
 * that a folder is there and empty, which is two untrue things at once.
 */
export const listScopeFiles = Effect.fn("Gateway.files.list")(function* (
  input: ScopeRequest & { readonly path?: ScopePath | undefined }
) {
  const root = yield* scopeRootOf({ create: false, request: input });
  const fs = yield* FileSystem;
  const directory =
    input.path === undefined
      ? { absolute: root, relative: "" }
      : yield* resolveInScope({ path: input.path, root }).pipe(
          Effect.flatMap(requireExisting),
          Effect.tap((target) => refuseEscape({ root, target })),
          Effect.tap((target) =>
            Effect.filterOrFail(
              fs.stat(target.real ?? target.absolute).pipe(Effect.orDie),
              (info) => info.type === "Directory",
              () =>
                new InvalidInput({
                  detail: "path does not name a directory",
                  entity: "file",
                })
            )
          )
        );
  const names = yield* fs
    .readDirectory(directory.absolute)
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  const entries = yield* Effect.forEach(
    names.filter((name) => name !== GIT_DIR),
    (name) =>
      entryOf({
        absolute: join(directory.absolute, name),
        relative:
          directory.relative === "" ? name : join(directory.relative, name),
        root,
      })
  );
  yield* Effect.annotateCurrentSpan({
    entries: entries.length,
    scope: input.scope.scope,
  });
  return entries.sort((left, right) => {
    const rank =
      Number(right.kind === "directory") - Number(left.kind === "directory");
    return rank === 0 ? left.name.localeCompare(right.name) : rank;
  });
});

/** Decodes as text, or nothing when the bytes are not text at all. */
const asText = (bytes: Uint8Array) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // A NUL is legal UTF-8 and never in a document somebody edits. Without this
    // an editor would happily open a binary that happens to decode.
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
};

/**
 * One file's bytes, capped, and tagged with the encoding they survived.
 *
 * Buffered rather than streamed on purpose: this is the editor's read, it has
 * to look at the whole file to decide whether it is text, and a file too large
 * for that is one this route should refuse rather than half-answer. The size is
 * checked from the stat before the bytes are read, so an oversized file costs a
 * stat rather than a copy in memory.
 */
export const readScopeFile = Effect.fn("Gateway.files.read")(function* (
  input: ScopePathRequest
) {
  const root = yield* scopeRootOf({ create: false, request: input });
  const target = yield* resolveInScope({ path: input.path, root }).pipe(
    Effect.flatMap(requireExisting),
    Effect.tap((resolved) => refuseEscape({ root, target: resolved }))
  );
  if (target.real === null) {
    // A link whose target is gone. There are no bytes to answer with, and
    // following it is what the containment above already refused.
    return yield* Effect.fail(
      new NotFound({ entity: "file", id: target.relative })
    );
  }

  const fs = yield* FileSystem;
  const info = yield* fs.stat(target.real).pipe(Effect.orDie);
  if (info.type === "Directory") {
    return yield* Effect.fail(
      new InvalidInput({ detail: "path names a directory", entity: "file" })
    );
  }
  const bytes = Number(info.size);
  if (bytes > MAX_FILE_BYTES) {
    return yield* Effect.fail(
      new PayloadTooLarge({ bytes, limit: MAX_FILE_BYTES })
    );
  }

  const raw = yield* fs.readFile(target.real).pipe(Effect.orDie);
  const text = asText(raw);
  const encoding: FileEncoding = text === null ? "base64" : "utf8";
  yield* Effect.annotateCurrentSpan({ bytes, scope: input.scope.scope });
  return {
    bytes,
    content: text ?? Buffer.from(raw).toString("base64"),
    encoding,
    path: target.relative,
  } satisfies FileContent;
});

/** The base64 alphabet, so bytes a caller mislabelled are refused rather than mangled. */
const BASE64 = /^[A-Za-z0-9+/\s]*={0,2}$/;

/** The bytes a write means, or the 422 for a body that does not say what it claims. */
const bytesOf = (input: {
  readonly content: string;
  readonly encoding: FileEncoding;
}) => {
  if (input.encoding === "utf8") {
    return Effect.succeed(Buffer.from(input.content, "utf8"));
  }
  return BASE64.test(input.content)
    ? Effect.succeed(Buffer.from(input.content, "base64"))
    : Effect.fail(
        new InvalidInput({
          detail: "content is not base64",
          entity: "file",
        })
      );
};

/**
 * Records one change in the scope's own git history, as the person who made it.
 *
 * Total, and after the fact: the bytes are already on disk, so a git that
 * refused must not turn a completed edit into a failed request. A task scope
 * keeps no history and is skipped — it belongs to one task, so there is nobody
 * to overwrite and no earlier version anyone lost.
 *
 * Exported for `./skills`, so an install and a hand edit leave the same kind of
 * commit in the same repository rather than two conventions in one folder.
 */
export const commitEdit = Effect.fnUntraced(function* (input: {
  readonly committer: Committer;
  readonly dataRoot: string;
  readonly operation: string;
  readonly path: string;
  readonly scope: FileScope;
}) {
  const target = historyScopeOf(input.scope);
  if (target === null) {
    return;
  }
  const history = yield* ScopeHistory;
  const done = yield* history.commitEdit({
    ...target,
    committer: input.committer,
    dataRoot: input.dataRoot,
    message: editMessageOf({ operation: input.operation, path: input.path }),
  });
  yield* Effect.annotateCurrentSpan({ committed: done.committed });
});

/**
 * Writes one file and commits the change.
 *
 * Bytes first, commit second, on the same reasoning as a promotion: a commit
 * naming bytes that are not there is a lie about the folder, while bytes with
 * no commit are a change somebody can still see in the next snapshot's diff.
 *
 * A path that already names a directory is the caller's mistake rather than the
 * disk's, and is refused here — left to the write it would fail two calls down
 * and reach them as a server fault, which is the wrong thing to tell somebody
 * to retry.
 */
export const writeScopeFile = Effect.fn("Gateway.files.write")(function* (
  input: ScopePathRequest & {
    readonly content: string;
    readonly encoding: FileEncoding;
  }
) {
  const committer = yield* editorOf(input.principal);
  const bytes = yield* bytesOf(input);
  if (bytes.length > MAX_FILE_BYTES) {
    return yield* Effect.fail(
      new PayloadTooLarge({ bytes: bytes.length, limit: MAX_FILE_BYTES })
    );
  }

  const root = yield* scopeRootOf({ create: true, request: input });
  const target = yield* resolveInScope({ path: input.path, root });
  yield* refuseLink(target);
  const fs = yield* FileSystem;
  if (target.real !== null) {
    const info = yield* fs.stat(target.real).pipe(Effect.orDie);
    if (info.type === "Directory") {
      return yield* Effect.fail(
        new InvalidInput({
          detail: "path already names a directory",
          entity: "file",
        })
      );
    }
  }

  yield* makeParent({ absolute: target.absolute, root });
  yield* fs.writeFile(target.absolute, bytes).pipe(Effect.orDie);
  const entry = yield* entryOf({
    absolute: target.absolute,
    relative: target.relative,
    root,
  });
  yield* commitEdit({
    committer,
    dataRoot: input.dataRoot,
    operation: "write",
    path: target.relative,
    scope: input.scope,
  });
  return entry;
});

/**
 * Creates a directory and its parents.
 *
 * Idempotent, because "new folder" in a browser on a path that is already a
 * folder is not an error anybody wants told about. No commit: git records
 * files, so an empty directory is nothing for a history to hold, and the write
 * that fills it is what lands in the log.
 */
export const createScopeDirectory = Effect.fn("Gateway.files.createDirectory")(
  function* (input: ScopePathRequest) {
    yield* editorOf(input.principal);
    const root = yield* scopeRootOf({ create: true, request: input });
    const target = yield* resolveInScope({ path: input.path, root });
    yield* refuseLink(target);

    const fs = yield* FileSystem;
    if (target.real !== null) {
      const info = yield* fs.stat(target.real).pipe(Effect.orDie);
      if (info.type !== "Directory") {
        return yield* Effect.fail(
          new InvalidInput({
            detail: "path already names a file",
            entity: "file",
          })
        );
      }
    }
    yield* makeParent({ absolute: target.absolute, root });
    yield* fs
      .makeDirectory(target.absolute, {
        mode: ARTIFACT_DIR_MODE,
        recursive: true,
      })
      .pipe(Effect.orDie);
    return yield* entryOf({
      absolute: target.absolute,
      relative: target.relative,
      root,
    });
  }
);

/**
 * Points one name at another file in the same scope, with a relative symbolic
 * link, and commits it.
 *
 * **The link text is computed, never taken.** A caller names two paths inside
 * one scope and the text written on disk is the way from the first's real
 * directory to the second. A scope is a bind mount, so an absolute host path in
 * a link is the bug that would look perfect in the file browser and reach
 * nothing at all inside a container — the one place this feature would fail
 * silently, and the reason the wire has no field to put one in.
 *
 * **The target has to be there, and has to be the real thing.** A dangling
 * link is a rule that quietly means nothing, and it is also how the containment
 * above would be sidestepped: a target created after the check is a target this
 * process never resolved. A target that is itself a link is refused for the
 * reader rather than for safety — one hop means a listing always says what a
 * name ends up at, and a chain means following three entries to find out.
 *
 * The `.git` refusal comes free at both ends. The branded path refuses the
 * segment, and the resolver refuses a link that lands in an object store however
 * it got there.
 */
export const linkScopePath = Effect.fn("Gateway.files.createLink")(function* (
  input: ScopePathRequest & { readonly target: ScopePath }
) {
  const committer = yield* editorOf(input.principal);
  const root = yield* scopeRootOf({ create: true, request: input });

  const link = yield* resolveInScope({ path: input.path, root });
  if (link.link !== null || link.real !== null) {
    return yield* Effect.fail(
      new InvalidInput({
        detail: "something is already there — remove it first",
        entity: "file",
      })
    );
  }

  const target = yield* resolveInScope({ path: input.target, root }).pipe(
    Effect.tap((resolved) => refuseEscape({ root, target: resolved }))
  );
  if (target.link !== null) {
    return yield* Effect.fail(
      new InvalidInput({
        detail:
          "the target is itself a link — point at what that one points at instead",
        entity: "file",
      })
    );
  }
  if (target.real === null) {
    return yield* Effect.fail(
      new NotFound({ entity: "file", id: target.relative })
    );
  }

  const parent = yield* makeParent({ absolute: link.absolute, root });
  // Both ends are proven inside the scope's real root, so the way between them
  // stays inside it too — which is what makes this relative path safe to write
  // without asking a third time where it lands.
  const text = relative(parent, target.real);
  const fs = yield* FileSystem;
  yield* fs.symlink(text, link.absolute).pipe(Effect.orDie);
  const entry = yield* entryOf({
    absolute: link.absolute,
    relative: link.relative,
    root,
  });
  yield* commitEdit({
    committer,
    dataRoot: input.dataRoot,
    operation: "link",
    path: `${link.relative} -> ${text}`,
    scope: input.scope,
  });
  yield* Effect.annotateCurrentSpan({ scope: input.scope.scope, target: text });
  return entry;
});

/**
 * Renames a path inside one scope, and commits it.
 *
 * The destination must not exist. A move that silently replaced a file would be
 * the one operation here with no warning, and the bytes it replaced would be
 * findable only by somebody who thought to look in `git log` — which the task
 * scope does not even have.
 */
export const moveScopeFile = Effect.fn("Gateway.files.move")(function* (
  input: ScopeRequest & { readonly from: ScopePath; readonly to: ScopePath }
) {
  const committer = yield* editorOf(input.principal);
  const root = yield* scopeRootOf({ create: true, request: input });
  const from = yield* resolveInScope({ path: input.from, root }).pipe(
    Effect.flatMap(requireExisting)
  );
  const to = yield* resolveInScope({ path: input.to, root });
  yield* refuseLink(to);
  if (to.real !== null) {
    return yield* Effect.fail(
      new InvalidInput({ detail: "destination already exists", entity: "file" })
    );
  }

  yield* makeParent({ absolute: to.absolute, root });
  const fs = yield* FileSystem;
  yield* fs.rename(from.absolute, to.absolute).pipe(Effect.orDie);
  const entry = yield* entryOf({
    absolute: to.absolute,
    relative: to.relative,
    root,
  });
  yield* commitEdit({
    committer,
    dataRoot: input.dataRoot,
    operation: "move",
    path: `${from.relative} -> ${to.relative}`,
    scope: input.scope,
  });
  return entry;
});

/**
 * Removes a file, a link, or a directory and everything under it, and commits
 * the removal.
 *
 * Recursive with no flag, which is safe for a reason specific to these
 * directories rather than by assumption: a shared scope is a git repository and
 * this commits, so what was deleted is still in the folder's history. The scope
 * root is not addressable, so the worst one call can do is a subtree.
 *
 * A link is unlinked rather than followed — `remove` takes the link itself, and
 * deleting a bad link is one of the repairs somebody comes to this route for.
 */
export const deleteScopePath = Effect.fn("Gateway.files.delete")(function* (
  input: ScopePathRequest
) {
  const committer = yield* editorOf(input.principal);
  const root = yield* scopeRootOf({ create: false, request: input });
  const target = yield* resolveInScope({ path: input.path, root }).pipe(
    Effect.flatMap(requireExisting)
  );

  const fs = yield* FileSystem;
  yield* fs
    .remove(target.absolute, { force: true, recursive: true })
    .pipe(Effect.orDie);
  yield* commitEdit({
    committer,
    dataRoot: input.dataRoot,
    operation: "delete",
    path: target.relative,
    scope: input.scope,
  });
});

/** The `files` group: one tree, seven operations, and a person on the other end of all of them. */
export const filesHandlers = HttpApiBuilder.group(Api, "files", (handlers) =>
  Effect.gen(function* () {
    // At build time, not per request: a mistyped DATA_ROOT should stop the
    // process rather than surface as a 500 on the first read.
    const dataRoot = yield* Effect.orDie(dataRootConfig);
    const on = yield* atBuild<
      FileSystem | ProjectRepo | ScopeHistory | TaskRepo
    >();

    return handlers.handleAll({
      createDirectory: ({ params, payload }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            createScopeDirectory({
              dataRoot,
              path: payload.path,
              principal,
              scope: params.scope,
            })
          )
        ),
      createLink: ({ params, payload }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            linkScopePath({
              dataRoot,
              path: payload.path,
              principal,
              scope: params.scope,
              target: payload.target,
            })
          )
        ),
      delete: ({ params, query }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            deleteScopePath({
              dataRoot,
              path: query.path,
              principal,
              scope: params.scope,
            })
          )
        ),
      list: ({ params, query }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            listScopeFiles({
              dataRoot,
              path: query.path,
              principal,
              scope: params.scope,
            })
          )
        ),
      move: ({ params, payload }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            moveScopeFile({
              dataRoot,
              from: payload.from,
              principal,
              scope: params.scope,
              to: payload.to,
            })
          )
        ),
      read: ({ params, query }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            readScopeFile({
              dataRoot,
              path: query.path,
              principal,
              scope: params.scope,
            })
          )
        ),
      write: ({ params, payload }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            writeScopeFile({
              content: payload.content,
              dataRoot,
              encoding: payload.encoding,
              path: payload.path,
              principal,
              scope: params.scope,
            })
          )
        ),
    });
  })
);
