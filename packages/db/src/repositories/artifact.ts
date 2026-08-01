import type {
  ArtifactStat,
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
   * Marks a file as promoted. Copying it into the project or global folder is the
   * sandbox's job — reuse is always a copy and never a reference, so that one
   * task's record of what it worked from cannot be made retroactively false by
   * someone refining the original. What this records is the decision, and the
   * `promote` audit row beside it is the trail that read-only shared mounts exist
   * to protect.
   *
   * The one place a content hash is written. Copying is the only moment the
   * question "are these the same bytes" is worth answering, so it is the only
   * moment the answer is stored.
   */
  const promote = Effect.fn("ArtifactRepo.promote")(function* (
    input: ArtifactRef & {
      /**
       * The digest of the bytes being promoted, taken by whoever copied the
       * file. Recorded here and nowhere else, so "has the source moved on since
       * this copy" stays answerable without hashing the tree on every rescan.
       */
      readonly contentHash: string;
    }
  ) {
    yield* Effect.annotateCurrentSpan({ artifactId: input.id });
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
          value: { contentHash: input.contentHash, promotedAt },
        });
        const written = yield* execute(
          "ArtifactRepo.promote",
          tx.update(artifact).set(values).where(refOf(input)).returning()
        );
        const promoted = yield* decodeWritten({
          decode: decodeArtifact,
          entity: ENTITY,
          operation: "ArtifactRepo.promote",
          rows: written,
        });
        return audited(
          promoted,
          auditPromote({
            entityId: promoted.id,
            taskId: promoted.taskId,
            workspaceId: promoted.workspaceId,
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
