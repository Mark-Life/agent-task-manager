import type {
  Artifact,
  ArtifactStat,
  ProjectId,
  RunId,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { ArtifactId, newArtifactId } from "@workspace/domain";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Database } from "../client";
import { ArtifactInsert, ArtifactUpdate, decodeArtifact } from "../rows";
import { artifact } from "../schema/artifact";
import {
  audited,
  auditPromote,
  decodeMany,
  decodeOne,
  decodeWritten,
  encodeWrite,
  execute,
  unauditedTransaction,
  writer,
} from "./audit";

/** Nothing in here reads more than one row by id. */
const ONE = 1;

/** The table these rows live in, and what an error names them as. */
const ENTITY = "artifact";

/** The predicate of the partial unique index a task's rescan upserts on. */
const taskScoped = sql`${artifact.scope} = 'task'`;

/** The predicate of the partial unique index a promotion into a project upserts on. */
const projectScoped = sql`${artifact.scope} = 'project'`;

/** The predicate of the partial unique index a promotion into the workspace upserts on. */
const globalScoped = sql`${artifact.scope} = 'global'`;

/** An artifact is never addressed by id alone; every query names the workspace it belongs to. */
interface ArtifactRef {
  readonly id: ArtifactId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The file has already been promoted. Promotion is a deliberate verb whose audit
 * row is the trail, and a second one would claim a decision nobody made — so it
 * is refused rather than quietly restamped.
 */
export class ArtifactAlreadyPromoted extends Schema.TaggedErrorClass<ArtifactAlreadyPromoted>()(
  "ArtifactRepo.AlreadyPromoted",
  { id: ArtifactId }
) {}

const refOf = (ref: ArtifactRef) =>
  and(eq(artifact.workspaceId, ref.workspaceId), eq(artifact.id, ref.id));

/**
 * The two folders a task's file can be promoted into. Never another task's, and
 * never its own: a file is already in its task's folder, so promoting it there
 * would be a decision with no effect and an audit row claiming otherwise.
 *
 * Restated here rather than imported from the package that owns the folders,
 * because this package never imports the sandbox — the two shapes agree
 * structurally, which is what a caller passing one to the other relies on.
 */
export type PromotionDestination =
  | { readonly scope: "global" }
  | { readonly projectId: ProjectId; readonly scope: "project" };

/** Which file is being promoted, the copy that was already made of it, and where it went. */
export interface ArtifactPromotionInput extends ArtifactRef {
  /**
   * What a `stat` of the copy read, plus the digest of the bytes that were
   * written. Taken by whoever copied the file, because that is the only moment
   * the bytes are in hand — a rescan never hashes, so "have the two files
   * parted company since" stays answerable without reading the tree.
   */
  readonly copy: ArtifactStat & { readonly contentHash: string };
  readonly to: PromotionDestination;
}

/** Both halves of a promotion: the file that was promoted, and the copy every later run reads. */
export interface PromotedArtifacts {
  /** The row in the shared folder. Carries no task, so it survives the one that made it. */
  readonly destination: Artifact;
  /** The task's own row, now stamped with when it was promoted and with what it held. */
  readonly source: Artifact;
}

/**
 * The partial unique index a promotion into that scope upserts on.
 *
 * Which key applies is decided by the scope and by nothing else: a project's
 * folder is keyed by `(project_id, path)` and the global one by
 * `(workspace_id, path)`, so promoting twice over one path replaces the file
 * rather than filling the folder with rows nothing can tell apart.
 */
const conflictOf = (to: PromotionDestination) =>
  to.scope === "project"
    ? { target: [artifact.projectId, artifact.path], where: projectScoped }
    : { target: [artifact.workspaceId, artifact.path], where: globalScoped };

/** What a rescan of one task's artifacts directory found. */
interface RescanInput {
  /** Which run last touched these files. Provenance, not load-bearing. */
  readonly lastRunId: RunId | null;
  readonly stats: readonly ArtifactStat[];
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);
  const inTransaction = unauditedTransaction(db);

  /**
   * Replaces a task's artifact index with what is actually in its directory.
   *
   * The index is derivable from disk, which makes it a cache and not a source of
   * truth: an upsert on the path plus a delete of everything the scan did not see
   * is the whole reconciliation, and drift is fixed by running this again. There
   * is no merge, no diff and no repair path, because there is nothing here that
   * disk cannot say better.
   *
   * It writes no audit rows and needs no actor for the same reason — refreshing a
   * cache is not a decision anyone made, and auditing every rescan would bury the
   * mutations the log exists for.
   */
  const replaceTaskIndex = Effect.fn("ArtifactRepo.replaceTaskIndex")(
    function* (input: RescanInput) {
      yield* Effect.annotateCurrentSpan({
        taskId: input.taskId,
        workspaceId: input.workspaceId,
      });
      const values = yield* Effect.forEach(input.stats, (stat) =>
        encodeWrite({
          entity: ENTITY,
          schema: ArtifactInsert,
          value: {
            bytes: stat.bytes,
            // Never hashed here: a rescan only has to know the file changed, and
            // size plus modified time say that without reading a byte of it.
            contentHash: null,
            ext: stat.ext,
            id: newArtifactId(),
            lastRunId: input.lastRunId,
            modifiedAt: stat.modifiedAt,
            path: stat.path,
            projectId: null,
            promotedAt: null,
            scope: "task",
            sourceArtifactId: null,
            taskId: input.taskId,
            workspaceId: input.workspaceId,
          },
        })
      );
      return yield* inTransaction(
        { operation: "ArtifactRepo.replaceTaskIndex", table: ENTITY },
        (tx) =>
          Effect.gen(function* () {
            yield* execute(
              "ArtifactRepo.replaceTaskIndex",
              tx.delete(artifact).where(
                and(
                  eq(artifact.workspaceId, input.workspaceId),
                  eq(artifact.taskId, input.taskId),
                  eq(artifact.scope, "task"),
                  values.length === 0
                    ? undefined
                    : notInArray(
                        artifact.path,
                        values.map((value) => value.path)
                      )
                )
              )
            );
            if (values.length === 0) {
              return [];
            }
            const written = yield* execute(
              "ArtifactRepo.replaceTaskIndex",
              tx
                .insert(artifact)
                .values(values)
                .onConflictDoUpdate({
                  set: {
                    bytes: sql`excluded.bytes`,
                    ext: sql`excluded.ext`,
                    lastRunId: sql`excluded.last_run_id`,
                    modifiedAt: sql`excluded.modified_at`,
                  },
                  target: [artifact.taskId, artifact.path],
                  targetWhere: taskScoped,
                })
                .returning()
            );
            return yield* decodeMany({
              decode: decodeArtifact,
              entity: ENTITY,
              rows: written,
            });
          })
      );
    }
  );

  /**
   * Records a promotion: stamps the file that was promoted, and indexes the copy
   * that now sits in the project's folder or the global one.
   *
   * Both halves, in one transaction, because half of them is worse than
   * neither. A stamp with no destination row is an audit trail claiming material
   * is shared that nothing can find; a destination row with no stamp is a file
   * anyone can promote again. The bytes are copied first, by the caller, and
   * that order is deliberate too — a row promising shared material that is not
   * on disk reads to every later run as an absence.
   *
   * The destination is an upsert on the same per-scope key a rescan uses, so
   * promoting over a path the folder already holds replaces what is there
   * instead of adding a second row nothing could tell apart. The row keeps its
   * id across that, since whatever already referred to it referred to the path.
   *
   * Reuse is a copy and never a reference: the destination is its own row over
   * its own bytes, and `sourceArtifactId` is provenance rather than a pointer.
   * Were it a pointer, one task's record of what it worked from would go
   * retroactively false the day somebody refined the original.
   *
   * One audit row, naming the file that was promoted. The destination's
   * `sourceArtifactId` leads back to it, and a second entry for the copy would
   * count one decision twice.
   *
   * The one place a content hash is written. Copying is the only moment the
   * question "are these the same bytes" is worth answering, so it is the only
   * moment the answer is stored.
   */
  const promote = Effect.fn("ArtifactRepo.promote")(function* (
    input: ArtifactPromotionInput
  ) {
    yield* Effect.annotateCurrentSpan({
      artifactId: input.id,
      scope: input.to.scope,
    });
    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const rows = yield* execute(
          "ArtifactRepo.promote",
          tx
            .select()
            .from(artifact)
            .where(refOf(input))
            .limit(ONE)
            .for("update")
        );
        const before = yield* decodeOne({
          decode: decodeArtifact,
          entity: ENTITY,
          id: input.id,
          rows,
        });
        if (before.promotedAt !== null) {
          return yield* Effect.fail(
            new ArtifactAlreadyPromoted({ id: input.id })
          );
        }
        const promotedAt = yield* DateTime.now;
        const values = yield* encodeWrite({
          entity: ENTITY,
          schema: ArtifactUpdate,
          value: { contentHash: input.copy.contentHash, promotedAt },
        });
        const written = yield* execute(
          "ArtifactRepo.promote",
          tx.update(artifact).set(values).where(refOf(input)).returning()
        );
        const source = yield* decodeWritten({
          decode: decodeArtifact,
          entity: ENTITY,
          operation: "ArtifactRepo.promote",
          rows: written,
        });

        const copy = yield* encodeWrite({
          entity: ENTITY,
          schema: ArtifactInsert,
          value: {
            bytes: input.copy.bytes,
            contentHash: input.copy.contentHash,
            ext: input.copy.ext,
            id: newArtifactId(),
            // The bytes are the ones that run produced, so the copy carries the
            // same provenance rather than none.
            lastRunId: before.lastRunId,
            modifiedAt: input.copy.modifiedAt,
            path: input.copy.path,
            projectId: input.to.scope === "project" ? input.to.projectId : null,
            promotedAt,
            scope: input.to.scope,
            sourceArtifactId: before.id,
            // A shared row names no task: it outlives the one that made it, and
            // the scope checks in the schema say the same thing.
            taskId: null,
            workspaceId: input.workspaceId,
          },
        });
        const conflict = conflictOf(input.to);
        const copied = yield* execute(
          "ArtifactRepo.promote",
          tx
            .insert(artifact)
            .values(copy)
            .onConflictDoUpdate({
              set: {
                bytes: sql`excluded.bytes`,
                contentHash: sql`excluded.content_hash`,
                ext: sql`excluded.ext`,
                lastRunId: sql`excluded.last_run_id`,
                modifiedAt: sql`excluded.modified_at`,
                promotedAt: sql`excluded.promoted_at`,
                sourceArtifactId: sql`excluded.source_artifact_id`,
              },
              target: conflict.target,
              targetWhere: conflict.where,
            })
            .returning()
        );
        const destination = yield* decodeWritten({
          decode: decodeArtifact,
          entity: ENTITY,
          operation: "ArtifactRepo.promote",
          rows: copied,
        });

        return audited(
          { destination, source } satisfies PromotedArtifacts,
          auditPromote({
            entityId: source.id,
            taskId: source.taskId,
            workspaceId: source.workspaceId,
          })
        );
      })
    );
  });

  /** One artifact, for the dashboard's preview and the promote button beside it. */
  const byId = Effect.fn("ArtifactRepo.byId")(function* (input: ArtifactRef) {
    yield* Effect.annotateCurrentSpan({ artifactId: input.id });
    const rows = yield* execute(
      "ArtifactRepo.byId",
      db.select().from(artifact).where(refOf(input)).limit(ONE)
    );
    return yield* decodeOne({
      decode: decodeArtifact,
      entity: ENTITY,
      id: input.id,
      rows,
    });
  });

  /** A task's files, most recently written first — the order the artifacts panel shows. */
  const listByTask = Effect.fn("ArtifactRepo.listByTask")(function* (input: {
    readonly taskId: TaskId;
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    const rows = yield* execute(
      "ArtifactRepo.listByTask",
      db
        .select()
        .from(artifact)
        .where(
          and(
            eq(artifact.workspaceId, input.workspaceId),
            eq(artifact.taskId, input.taskId),
            eq(artifact.scope, "task")
          )
        )
        .orderBy(desc(artifact.modifiedAt), desc(artifact.id))
    );
    return yield* decodeMany({
      decode: decodeArtifact,
      entity: ENTITY,
      rows,
    });
  });

  return { byId, listByTask, promote, replaceTaskIndex } as const;
});

/**
 * The index of what a run kept, never the bytes. Postgres is fast for metadata
 * and the filesystem is fast for bytes, and large values would bloat the
 * write-ahead log and every backup forever.
 */
export class ArtifactRepo extends Context.Service<
  ArtifactRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ArtifactRepo") {
  static readonly layer = Layer.effect(ArtifactRepo, make);
}
