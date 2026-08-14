/**
 * Artifacts: the index in Postgres, the bytes on disk, and the deliberate verb
 * that shares them.
 *
 * **Postgres holds an index, never bytes.** `list` is a query and `read` is a
 * file read straight off local disk, because a local read is a page-cache hit
 * while the same bytes out of Postgres are a query round-trip plus
 * decompression of a large value — and large values bloat the write-ahead log
 * and every backup forever.
 *
 * Every column of the index is derivable from the directory, which makes the
 * table a cache rather than a source of truth. A row whose file is gone is
 * drift, not corruption, and drift gets an honest answer: 404 plus a warning
 * naming what to rescan, never a crash on a path that is not there.
 *
 * **Nothing here opens a path a caller composed.** Every path is resolved
 * against the task's own folder and refused unless it stays inside, then
 * refused again after `realPath` — a symlink planted in that folder by the run
 * that owns it points wherever it likes, and the gateway reads as the host
 * rather than from inside the container. That containment is the whole attack
 * surface of this file.
 *
 * The path algebra, the scan and the copy are `@workspace/sandbox`'s. This file
 * decides who may do what and translates the store's failures onto the wire's;
 * a second answer to "where does a task's folder live" is an answer waiting to
 * disagree with the mounts a run actually gets.
 */

import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  Api,
  ArtifactAlreadyPromoted,
  Forbidden,
  InvalidInput,
  NotFound,
  PayloadTooLarge,
  Principal,
  type PrincipalShape,
  type PromotionScope,
} from "@workspace/api";
import {
  ArtifactRepo,
  type MalformedRow,
  type PersistenceError,
  ProjectRepo,
  type ArtifactAlreadyPromoted as StoreAlreadyPromoted,
  type InvalidInput as StoreInvalidInput,
  type NotFound as StoreNotFound,
  TaskRepo,
  withActor,
} from "@workspace/db";
import type { ArtifactId, ProjectId, Task, TaskId } from "@workspace/domain";
import {
  type ArtifactIoFailed,
  copyArtifact,
  type PromotionTarget,
  promoteArtifact,
  scanArtifacts,
  taskArtifactsDirOf,
} from "@workspace/sandbox";
import { Config, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";

/** Where the artifacts tree lives when the environment says nothing. Mirrors `@workspace/env`. */
const DEFAULT_DATA_ROOT = ".data";

/**
 * The largest file this endpoint accepts, in bytes: sixty-four mebibytes.
 *
 * A cap rather than none, because these bytes land on the same volume every
 * container's artifact mount hangs off: one unbounded upload fills the disk
 * every running task is writing to. Far above the reports, plans and scrapes
 * artifacts actually are, and far below the size at which a single file is
 * really a dataset that wanted object storage.
 */
export const MAX_ARTIFACT_BYTES = 67_108_864;

/** Read here rather than from a service: where the tree lives is not a request's business. */
const dataRootConfig = Config.string("DATA_ROOT").pipe(
  Config.withDefault(DEFAULT_DATA_ROOT)
);

/**
 * Everything the store and the filesystem below a handler can fail with.
 *
 * Only some of them have a name on the wire, and which ones differ per
 * operation — the contract declares 404 where an id can be wrong and 422 where
 * a body can be, and nothing else. So the translation is three narrow
 * combinators rather than one table: an operation that lets a failure through
 * has to say so, and the ones it does not name become defects, which is a 500
 * on the request event rather than an outcome an agent might branch on.
 *
 * `MalformedRow`, `PersistenceError` and a filesystem that refused are never
 * named. A row that no longer decodes, a driver that fell over or a full disk
 * is not something a caller did or can act on.
 */
type StoreFailure =
  | ArtifactIoFailed
  | MalformedRow
  | PersistenceError
  | StoreAlreadyPromoted
  | StoreInvalidInput
  | StoreNotFound;

/** The store's 404 as the wire's. */
const asNotFound = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, (failure) =>
    failure._tag === "Db.NotFound"
      ? Effect.fail(new NotFound({ entity: failure.entity, id: failure.id }))
      : Effect.die(failure)
  );

/** The store's refusal of a value as the wire's 422. */
const asInvalidInput = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, (failure) =>
    failure._tag === "Db.InvalidInput"
      ? Effect.fail(
          new InvalidInput({
            detail: String(failure.cause),
            entity: failure.entity,
          })
        )
      : Effect.die(failure)
  );

/** The two a promotion can answer: no such row, and a decision already recorded. */
const asPromotionFailure = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(
    effect,
    (failure): Effect.Effect<never, ArtifactAlreadyPromoted | NotFound> => {
      switch (failure._tag) {
        case "Db.NotFound":
          return Effect.fail(
            new NotFound({ entity: failure.entity, id: failure.id })
          );
        case "ArtifactRepo.AlreadyPromoted":
          return Effect.fail(
            new ArtifactAlreadyPromoted({ artifactId: failure.id })
          );
        default:
          return Effect.die(failure);
      }
    }
  );

/** What every operation here needs: whose request it is, and which task's folder. */
export interface ArtifactRequest {
  /** The root the three artifact folders hang off. */
  readonly dataRoot: string;
  readonly principal: PrincipalShape;
  /** From the route, and already checked against a run's token by the access middleware. */
  readonly taskId: TaskId;
}

/** One artifact of one task, addressed the way the route addresses it. */
export interface ArtifactItemRequest extends ArtifactRequest {
  readonly artifactId: ArtifactId;
}

/**
 * A caller's path, once it is known to name a file inside the task's folder.
 *
 * The canonical relative form rather than the string that arrived: `./a/b.md`
 * and `a/b.md` are one file and the index knows only one spelling of it, so
 * that is what gets written and what a row is found by.
 */
interface ContainedPath {
  readonly absolute: string;
  readonly relative: string;
}

/**
 * Resolves a caller's relative path against a folder, or nothing if it leaves.
 *
 * `resolve` collapses `..` and answers an absolute input with itself, so both
 * ways out of the folder fail the same prefix test. A NUL byte is refused here
 * too: every filesystem call truncates at one, so a name containing one is a
 * different name than the one that was checked.
 */
const containPath = (input: {
  readonly dir: string;
  readonly path: string;
}): ContainedPath | null => {
  if (input.path.includes("\0")) {
    return null;
  }
  const root = resolve(input.dir);
  const absolute = resolve(root, input.path);
  if (!absolute.startsWith(`${root}${sep}`)) {
    return null;
  }
  return { absolute, relative: relative(root, absolute) };
};

/** The same containment, for the caller who gets 422 when the path is theirs. */
const containOrInvalid = (input: {
  readonly dir: string;
  readonly path: string;
}) =>
  Effect.suspend(() => {
    const contained = containPath(input);
    return contained === null
      ? Effect.fail(
          new InvalidInput({
            detail: "path must name a file inside the task's own folder",
            entity: "artifact",
          })
        )
      : Effect.succeed(contained);
  });

/**
 * Whether the file is really there, and really still inside the folder.
 *
 * Two questions, one call: a row whose file is gone fails here as index drift,
 * and a symlink out of the folder resolves to a target the prefix test then
 * refuses. The gateway runs on the host with the host's reach, so a link the
 * container planted is a way out unless it is followed before it is read.
 */
const resolveExisting = Effect.fnUntraced(function* (input: {
  readonly contained: ContainedPath;
  readonly dir: string;
  readonly entity: string;
  readonly id: string;
}) {
  const fs = yield* FileSystem;
  const real = yield* fs.realPath(input.contained.absolute).pipe(
    Effect.tapError(() =>
      Effect.logWarning("artifact index names a file the disk does not have", {
        path: input.contained.relative,
        remedy: "rescan the task's artifacts folder",
      })
    ),
    Effect.mapError(() => new NotFound({ entity: input.entity, id: input.id }))
  );
  // The folder is resolved the same way the file was. A data root reached
  // through a link — `/tmp` on a mac, a mounted volume in production — would
  // otherwise make every file in it look like an escape from itself.
  const root = yield* fs
    .realPath(input.dir)
    .pipe(Effect.orElseSucceed(() => resolve(input.dir)));
  if (!real.startsWith(`${root}${sep}`)) {
    yield* Effect.logWarning("artifact path leaves the task's folder", {
      path: input.contained.relative,
    });
    return yield* new NotFound({ entity: input.entity, id: input.id });
  }
  return real;
});

/** The task, or 404. Everything here is nested under one and none of it may assume it exists. */
const requireTask = Effect.fnUntraced(function* (input: ArtifactRequest) {
  const tasks = yield* TaskRepo;
  return yield* tasks
    .byId({ id: input.taskId, workspaceId: input.principal.workspaceId })
    .pipe(asNotFound);
});

/**
 * The artifact row, once it is known to be this task's own file.
 *
 * The route is the authority on which task is being read, and the middleware
 * checked a run's token against exactly that segment — so an id belonging to
 * another task, or to a promoted copy in a shared folder, is a 404 rather than
 * a way through a route whose ownership was already decided.
 */
const requireOwnArtifact = Effect.fnUntraced(function* (
  input: ArtifactItemRequest
) {
  const artifacts = yield* ArtifactRepo;
  const row = yield* artifacts
    .byId({ id: input.artifactId, workspaceId: input.principal.workspaceId })
    .pipe(asNotFound);
  if (row.scope !== "task" || row.taskId !== input.taskId) {
    return yield* new NotFound({ entity: "artifact", id: input.artifactId });
  }
  return row;
});

/** The folder this task's files live in, and the only one these handlers read. */
const taskDirOf = (input: ArtifactRequest) =>
  taskArtifactsDirOf({ dataRoot: input.dataRoot, taskId: input.taskId });

/**
 * A task's files, most recently written first.
 *
 * Metadata only — path, size, extension, when it changed. The bytes are
 * {@link readTaskArtifact}, one file at a time, because a listing that carried
 * content would read the whole folder to render a sidebar.
 */
export const listTaskArtifacts = Effect.fn("Gateway.artifacts.list")(function* (
  input: ArtifactRequest
) {
  yield* requireTask(input);
  const artifacts = yield* ArtifactRepo;
  return yield* artifacts
    .listByTask({
      taskId: input.taskId,
      workspaceId: input.principal.workspaceId,
    })
    // Nothing a caller supplied can make a listing fail: an empty folder is an
    // empty array, and what is left is the driver or a row that stopped decoding.
    .pipe(Effect.orDie);
});

/** Which project's shared folder is being read, and on whose behalf. */
export interface ProjectArtifactRequest {
  readonly principal: PrincipalShape;
  /** From the route. A project id is not a permission — the workspace comes off the credential. */
  readonly projectId: ProjectId;
}

/**
 * A project's shared folder, most recently written first.
 *
 * The listing the writable project mount was missing. A research task leaves a
 * document there for the next task in the project, and until this existed that
 * document was on disk, in the index, and reachable only by somebody who already
 * knew its path.
 *
 * No directory is touched. The project's folder holds what a run wrote and what
 * a promotion copied, and both are already rows — reading disk here would answer
 * a different question than the one the dashboard and the agent tools ask.
 */
export const listProjectArtifacts = Effect.fn("Gateway.artifacts.listProject")(
  function* (input: ProjectArtifactRequest) {
    const projects = yield* ProjectRepo;
    // The project is looked up rather than assumed, so an id from another
    // workspace is a 404 rather than an empty folder that reads as "nothing here".
    yield* projects
      .byId({ id: input.projectId, workspaceId: input.principal.workspaceId })
      .pipe(asNotFound);
    const artifacts = yield* ArtifactRepo;
    return yield* artifacts
      .listByProject({
        projectId: input.projectId,
        workspaceId: input.principal.workspaceId,
      })
      .pipe(Effect.orDie);
  }
);

/**
 * The bytes, as a stream off local disk.
 *
 * Streamed rather than buffered because an artifact is whatever a run decided
 * to keep, and the one that is a hundred megabytes of scraped CSV should cost
 * the gateway a chunk at a time rather than a copy in memory.
 */
export const readTaskArtifact = Effect.fn("Gateway.artifacts.read")(function* (
  input: ArtifactItemRequest
) {
  const row = yield* requireOwnArtifact(input);
  const dir = taskDirOf(input);
  const contained = yield* containOrInvalid({ dir, path: row.path }).pipe(
    // The path came off a scan of this very folder, so a row that fails
    // containment is a row somebody wrote by hand — which is a missing file as
    // far as a reader is concerned, not a malformed request.
    Effect.mapError(() => new NotFound({ entity: "artifact", id: row.id }))
  );
  const absolute = yield* resolveExisting({
    contained,
    dir,
    entity: "artifact",
    id: row.id,
  });
  const fs = yield* FileSystem;
  return fs.stream(absolute);
});

/** A file to put in a task's folder, and where under it to put it. */
export interface ArtifactUploadRequest extends ArtifactRequest {
  /** Where the multipart parser persisted the upload. */
  readonly file: { readonly path: string };
  /** Relative to the task's folder. The natural key of the row. */
  readonly path: string;
}

/**
 * Writes a file into the task's folder and reindexes the folder around it.
 *
 * The whole directory is rescanned rather than one row inserted, because the
 * rescan is the only insert path the store exposes — and it is the same
 * reconciliation a run's teardown performs, so an upload and a run leave the
 * index in the same shape. The cost is real and worth naming: a rescan stamps
 * one `lastRunId` across every row it writes and an upload has no run, so
 * uploading into a task blanks the provenance of the files its runs produced.
 *
 * A path that already exists is replaced. The index is a cache of the directory
 * and not a history of it, so writing the same path twice is one file with a
 * newer modified time rather than two rows.
 */
export const uploadTaskArtifact = Effect.fn("Gateway.artifacts.upload")(
  function* (input: ArtifactUploadRequest) {
    yield* requireTask(input);
    const dir = taskDirOf(input);
    const contained = yield* containOrInvalid({ dir, path: input.path });

    const fs = yield* FileSystem;
    // The parser has already persisted the upload, so the size is a stat rather
    // than a count — and refusing it here still costs less than keeping it.
    const info = yield* fs.stat(input.file.path).pipe(Effect.orDie);
    const bytes = Number(info.size);
    if (bytes > MAX_ARTIFACT_BYTES) {
      return yield* new PayloadTooLarge({ bytes, limit: MAX_ARTIFACT_BYTES });
    }

    // A path that already names a folder is the caller's mistake, not the
    // disk's. Left to the copy it would fail three calls down and reach them as
    // a server fault, which is the wrong thing to tell somebody to retry.
    const occupant = yield* fs.stat(contained.absolute).pipe(Effect.option);
    if (Option.isSome(occupant) && occupant.value.type === "Directory") {
      return yield* new InvalidInput({
        detail: "path already names a directory",
        entity: "artifact",
      });
    }

    yield* copyArtifact({
      from: { dir: dirname(input.file.path), path: basename(input.file.path) },
      to: { dir, path: contained.relative },
    }).pipe(Effect.orDie);

    const stats = yield* scanArtifacts(dir).pipe(Effect.orDie);
    const artifacts = yield* ArtifactRepo;
    const rows = yield* artifacts
      .replaceTaskIndex({
        lastRunId: null,
        stats,
        taskId: input.taskId,
        workspaceId: input.principal.workspaceId,
      })
      .pipe(asInvalidInput);

    const written = rows.find((row) => row.path === contained.relative);
    if (written === undefined) {
      // Copied, and then not seen by a scan of the folder it was copied into.
      // Nothing a caller can act on, and nothing that should read as success.
      return yield* Effect.die(
        `uploaded artifact ${contained.relative} is missing from the rescan of ${dir}`
      );
    }
    yield* Effect.annotateCurrentSpan({ bytes, indexed: rows.length });
    return written;
  }
);

/** Which of a task's files to promote, and into which shared folder. */
export interface ArtifactPromoteRequest extends ArtifactItemRequest {
  readonly scope: PromotionScope;
}

/**
 * Which folder a promotion copies into.
 *
 * A task with no project cannot be promoted to one, and the destination is the
 * missing thing rather than the request being malformed — so it reads as a 404
 * on the project, which is the row a caller would have to create to make the
 * same call work.
 *
 * The global folder is a person's to fill. It is mounted read-only into every
 * worker so that a run which has read an untrusted repository cannot change what
 * every later run of every project is given, and a run's own token reaches this
 * route — it is `task-write`, which is what promoting into a project needs. So
 * the destination is checked against who is asking: without this, a run could
 * write a file into its own folder and promote it into the shared one, and the
 * proposal a person has to accept would be the long way round a door standing
 * open. The project folder is not checked, because a run may write it directly.
 */
const promotionTargetOf = (input: {
  readonly principal: PrincipalShape;
  readonly scope: PromotionScope;
  readonly task: Task;
}) => {
  if (input.scope === "global") {
    return input.principal.actor.kind === "human"
      ? Effect.succeed({ scope: "global" } as const satisfies PromotionTarget)
      : Effect.fail(
          new Forbidden({
            reason: "the shared folder is filled by a person, not by a run",
            required: "admin",
          })
        );
  }
  return input.task.projectId === null
    ? Effect.fail(new NotFound({ entity: "project", id: input.task.id }))
    : Effect.succeed({
        projectId: input.task.projectId,
        scope: "project",
      } as const satisfies PromotionTarget);
};

/**
 * Copies one of a task's files into the project's folder or the global one,
 * indexes the copy, and records the decision.
 *
 * Promotion is a verb, not an update. The global folder is mounted read-only
 * into every worker's container, so this call and a proposal a person accepted
 * are the two ways anything reaches it — and both of them are a person, which is
 * what {@link promotionTargetOf} enforces. A project's folder a run may also
 * write, and what this call adds there is the record that somebody chose the
 * file rather than a run leaving it. That is why it carries an audit action of
 * its own rather than a flag on a row.
 *
 * Bytes first, index second. A copy with no row is a file somebody can promote
 * again over the same path; a row with no copy is a promise of shared material
 * that is not there, which every later run would read as an absence. The store
 * writes both halves of the index — the stamp on this task's row and the row in
 * the shared folder — in one transaction, so the two cannot part company.
 *
 * The task's own row is what comes back, because that is the file the caller
 * named. The copy is what every later run reads, and its id is on the span.
 */
export const promoteTaskArtifact = Effect.fn("Gateway.artifacts.promote")(
  function* (input: ArtifactPromoteRequest) {
    const row = yield* requireOwnArtifact(input);
    if (row.promotedAt !== null) {
      // The store checks this again under a row lock and that check is the
      // authority. This one is what stops a doomed call copying the bytes.
      return yield* new ArtifactAlreadyPromoted({ artifactId: row.id });
    }

    const task = yield* requireTask(input);
    const to = yield* promotionTargetOf({
      principal: input.principal,
      scope: input.scope,
      task,
    });

    const dir = taskDirOf(input);
    const contained = yield* containOrInvalid({ dir, path: row.path }).pipe(
      Effect.mapError(() => new NotFound({ entity: "artifact", id: row.id }))
    );
    yield* resolveExisting({ contained, dir, entity: "artifact", id: row.id });

    const copy = yield* promoteArtifact({
      dataRoot: input.dataRoot,
      path: contained.relative,
      taskId: input.taskId,
      to,
    }).pipe(Effect.orDie);

    const artifacts = yield* ArtifactRepo;
    const promoted = yield* artifacts
      .promote({
        copy,
        id: row.id,
        to,
        workspaceId: input.principal.workspaceId,
      })
      .pipe(withActor(input.principal.actor), asPromotionFailure);

    yield* Effect.annotateCurrentSpan({
      destinationId: promoted.destination.id,
      scope: input.scope,
    });
    return promoted.source;
  }
);

/** The `artifacts` group: the index, the bytes, and the one verb that shares them. */
export const artifactsHandlers = HttpApiBuilder.group(
  Api,
  "artifacts",
  (handlers) =>
    Effect.gen(function* () {
      // At build time, not per request: a mistyped DATA_ROOT should stop the
      // process rather than surface as a 500 on the first upload.
      const dataRoot = yield* Effect.orDie(dataRootConfig);
      const on = yield* atBuild<
        ArtifactRepo | FileSystem | ProjectRepo | TaskRepo
      >();

      return handlers.handleAll({
        list: ({ params }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              listTaskArtifacts({ dataRoot, principal, taskId: params.taskId })
            )
          ),
        listProject: ({ params }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              listProjectArtifacts({ principal, projectId: params.projectId })
            )
          ),
        promote: ({ params, payload }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              promoteTaskArtifact({
                artifactId: params.artifactId,
                dataRoot,
                principal,
                scope: payload.scope,
                taskId: params.taskId,
              })
            )
          ),
        read: ({ params }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              readTaskArtifact({
                artifactId: params.artifactId,
                dataRoot,
                principal,
                taskId: params.taskId,
              })
            )
          ),
        upload: ({ params, payload }) =>
          on(
            Effect.flatMap(Principal, (principal) =>
              uploadTaskArtifact({
                dataRoot,
                file: payload.file,
                path: payload.path,
                principal,
                taskId: params.taskId,
              })
            )
          ),
      });
    })
);
