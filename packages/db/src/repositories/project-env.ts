/**
 * A project's environment files: the paths, and the sealed text behind them.
 *
 * **The encryption is this layer's job and nobody else's.** Callers hand over
 * plaintext and get plaintext back; ciphertext never leaves this file and no
 * consumer holds a key. That is what makes "plaintext is never a query
 * parameter" a property of the store rather than a rule two applications
 * remember — the gateway saves what an operator typed, the loop reads it into a
 * checkout, and neither one contains a line of crypto.
 *
 * The key is derived from `BETTER_AUTH_SECRET` by `@workspace/token`, under a
 * label of its own. See that package for the trust boundary this sits behind.
 *
 * **The audit log records paths, never values.** Every other repository diffs
 * the columns it wrote, which here would put ciphertext — and a running history
 * of it — into a table that is deliberately append-only and never rewritten. So
 * a change to a file's text is recorded as a change to `content`, with the
 * bytes replaced by their length: the log answers "who changed this file, and
 * when", which is the question it exists for, and it answers it without holding
 * a second copy of every secret.
 *
 * **The path is the identity.** `upsert` is keyed on `(project, path)` rather
 * than on a row id, because that is how an editor saves: the caller knows where
 * the file goes and does not know whether one is already there. Two rows for
 * one path would be two files racing to be written last into the same place in
 * a checkout, which the unique index makes impossible.
 */

import {
  type EnvFilePath,
  newProjectEnvFileId,
  type ProjectEnvFileContent,
  type ProjectEnvFileId,
  type ProjectId,
  type WorkspaceId,
} from "@workspace/domain";
import { makeSecretSealer } from "@workspace/token";
import { and, asc, eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted } from "effect";
import { Database } from "../client";
import {
  decodeProjectEnvFile,
  ProjectEnvFileInsert,
  ProjectEnvFileUpdate,
} from "../rows";
import { projectEnvFile } from "../schema/project-env";
import {
  auditCreate,
  auditDelete,
  audited,
  auditUpdate,
  decodeMany,
  decodeOne,
  decodeRow,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  MalformedRow,
  writer,
} from "./audit";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

const ENTITY = "project_env_file";

/** Every read and every write names the project as well as the workspace. */
export interface ProjectEnvFileScope {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
}

/** One file inside a project. */
export interface ProjectEnvFileRef extends ProjectEnvFileScope {
  readonly id: ProjectEnvFileId;
}

/** What saving a file takes: where it goes, and the whole of its text. */
export interface ProjectEnvFileSave extends ProjectEnvFileScope {
  readonly content: string;
  readonly path: EnvFilePath;
}

/**
 * What the audit log says about a file's text: that it changed, and how long it
 * became. Never the value, and never the ciphertext either — a diff of two
 * blobs would be two copies of a secret in a table that is never rewritten.
 */
const contentChange = (before: number | null, after: number) => ({
  content: { from: before, to: after },
});

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);
  const sealer = yield* makeSecretSealer;

  const scopeOf = (scope: ProjectEnvFileScope) =>
    and(
      eq(projectEnvFile.workspaceId, scope.workspaceId),
      eq(projectEnvFile.projectId, scope.projectId)
    );

  const refOf = (ref: ProjectEnvFileRef) =>
    and(scopeOf(ref), eq(projectEnvFile.id, ref.id));

  /**
   * Opens one row's blob. A value that will not open is a {@link MalformedRow}
   * for the same reason a row that will not decode is: the column is there and
   * the bytes in it are not what this build can read, which is a fact about
   * storage rather than a request that was wrong.
   */
  const openRow = Effect.fnUntraced(function* (row: {
    readonly contentEnc: Buffer;
    readonly keyVersion: number;
  }) {
    const opened = yield* sealer
      .open({ content: row.contentEnc, keyVersion: row.keyVersion })
      .pipe(
        Effect.mapError((cause) => new MalformedRow({ cause, entity: ENTITY }))
      );
    return Redacted.value(opened);
  });

  /** One row as the editor and the materializer take it: metadata, and the text. */
  const withContent = Effect.fnUntraced(function* (row: {
    readonly contentEnc: Buffer;
    readonly keyVersion: number;
  }) {
    const file = yield* decodeRow({
      decode: decodeProjectEnvFile,
      entity: ENTITY,
      row,
    });
    const content = yield* openRow(row);
    return { ...file, content } satisfies ProjectEnvFileContent;
  });

  /**
   * Every file of a project, by path — the order the editor's sidebar wants,
   * and a stable one for the materializer's log line.
   *
   * Paths only. The listing is the common read and the content is a secret, so
   * the shape that carries it is a separate call somebody had to mean to make.
   */
  const list = Effect.fn("ProjectEnvFileRepo.list")(function* (
    scope: ProjectEnvFileScope
  ) {
    yield* Effect.annotateCurrentSpan({
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
    });

    const rows = yield* execute(
      "ProjectEnvFileRepo.list",
      db
        .select()
        .from(projectEnvFile)
        .where(scopeOf(scope))
        .orderBy(asc(projectEnvFile.path))
    );

    return yield* decodeMany({
      decode: decodeProjectEnvFile,
      entity: ENTITY,
      rows,
    });
  });

  /** One file, decrypted. The editor's read, and the only single-file one. */
  const read = Effect.fn("ProjectEnvFileRepo.read")(function* (
    ref: ProjectEnvFileRef
  ) {
    yield* Effect.annotateCurrentSpan({
      projectId: ref.projectId,
      workspaceId: ref.workspaceId,
    });

    const rows = yield* execute(
      "ProjectEnvFileRepo.read",
      db.select().from(projectEnvFile).where(refOf(ref)).limit(ONE)
    );

    const row = yield* firstRow({ entity: ENTITY, id: ref.id, rows });
    return yield* withContent(row);
  });

  /**
   * Every file of a project, decrypted, in one query.
   *
   * This is what a dispatch calls, and it is one call rather than a list
   * followed by a read each: the run is already waiting, and the alternative
   * puts a round trip per file on the path of every worker turn.
   */
  const contents = Effect.fn("ProjectEnvFileRepo.contents")(function* (
    scope: ProjectEnvFileScope
  ) {
    yield* Effect.annotateCurrentSpan({
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
    });

    const rows = yield* execute(
      "ProjectEnvFileRepo.contents",
      db
        .select()
        .from(projectEnvFile)
        .where(scopeOf(scope))
        .orderBy(asc(projectEnvFile.path))
    );

    return yield* Effect.forEach(rows, withContent);
  });

  /**
   * Saves a file at a path, creating it or replacing its text.
   *
   * The row is locked and read first, so the audit row says whether this was a
   * new file or a rewrite of one — and so the length recorded is a real before
   * and after rather than a null every time.
   */
  const upsert = Effect.fn("ProjectEnvFileRepo.upsert")(function* (
    input: ProjectEnvFileSave
  ) {
    yield* Effect.annotateCurrentSpan({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
    });

    const sealed = yield* sealer.seal(Redacted.make(input.content));

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const locked = yield* execute(
          "ProjectEnvFileRepo.upsert",
          tx
            .select()
            .from(projectEnvFile)
            .where(and(scopeOf(input), eq(projectEnvFile.path, input.path)))
            .limit(ONE)
            .for("update")
        );

        const [before] = locked;
        const changes = contentChange(
          before === undefined ? null : before.contentEnc.length,
          sealed.content.length
        );

        if (before === undefined) {
          const values = yield* encodeWrite({
            entity: ENTITY,
            schema: ProjectEnvFileInsert,
            value: {
              contentEnc: Buffer.from(sealed.content),
              id: newProjectEnvFileId(),
              keyVersion: sealed.keyVersion,
              path: input.path,
              projectId: input.projectId,
              workspaceId: input.workspaceId,
            },
          });

          const rows = yield* execute(
            "ProjectEnvFileRepo.upsert",
            tx.insert(projectEnvFile).values(values).returning()
          );

          const created = yield* decodeWritten({
            decode: decodeProjectEnvFile,
            entity: ENTITY,
            operation: "ProjectEnvFileRepo.upsert",
            rows,
          });

          return audited(
            created,
            auditCreate({
              entityId: created.id,
              entityType: ENTITY,
              taskId: null,
              workspaceId: created.workspaceId,
            })
          );
        }

        const values = yield* encodeWrite({
          entity: ENTITY,
          schema: ProjectEnvFileUpdate,
          value: {
            contentEnc: Buffer.from(sealed.content),
            keyVersion: sealed.keyVersion,
          },
        });

        const rows = yield* execute(
          "ProjectEnvFileRepo.upsert",
          tx
            .update(projectEnvFile)
            .set(values)
            .where(eq(projectEnvFile.id, before.id))
            .returning()
        );

        const updated = yield* decodeWritten({
          decode: decodeProjectEnvFile,
          entity: ENTITY,
          operation: "ProjectEnvFileRepo.upsert",
          rows,
        });

        return audited(
          updated,
          auditUpdate({
            changes,
            entityId: updated.id,
            entityType: ENTITY,
            taskId: null,
            workspaceId: updated.workspaceId,
          })
        );
      })
    );
  });

  /** Erases one file. The next run simply does not get it. */
  const remove = Effect.fn("ProjectEnvFileRepo.delete")(function* (
    ref: ProjectEnvFileRef
  ) {
    yield* Effect.annotateCurrentSpan({
      projectId: ref.projectId,
      workspaceId: ref.workspaceId,
    });

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const rows = yield* execute(
          "ProjectEnvFileRepo.delete",
          tx.delete(projectEnvFile).where(refOf(ref)).returning()
        );

        const deleted = yield* decodeOne({
          decode: decodeProjectEnvFile,
          entity: ENTITY,
          id: ref.id,
          rows,
        });

        return audited(
          deleted,
          auditDelete({
            entityId: deleted.id,
            entityType: ENTITY,
            taskId: null,
            workspaceId: deleted.workspaceId,
          })
        );
      })
    );
  });

  return { contents, delete: remove, list, read, upsert } as const;
});

/**
 * A project's environment files. Every mutation writes its audit row in the
 * same transaction; every value crosses this boundary in the clear and is
 * stored sealed.
 */
export class ProjectEnvFileRepo extends Context.Service<
  ProjectEnvFileRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ProjectEnvFileRepo") {
  static readonly layer = Layer.effect(ProjectEnvFileRepo, make);
}
