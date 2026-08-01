import type {
  AuditEntry,
  TaskId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import { and, desc, eq, lt } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { Database } from "../client";
import { decodeAuditEntry } from "../rows";
import { auditEntry } from "../schema/audit";
import { decodeMany, execute } from "./audit";

/**
 * How many entries a page holds unless told otherwise. Each of these feeds a
 * list somebody scrolls, and this is the one table nothing ever deletes from, so
 * an unbounded read here gets slower forever.
 */
const DEFAULT_LIMIT = 100;

/** The table these rows live in, and what an error names them as. */
const ENTITY = "audit_entry";

/** Where a page of history starts. Absent means the newest entry. */
interface Page {
  readonly before?: Timestamp;
  readonly limit?: number;
}

const startingAt = (before: Timestamp | undefined) =>
  before === undefined
    ? undefined
    : lt(auditEntry.createdAt, DateTime.toDate(before));

const newestFirst = [desc(auditEntry.createdAt), desc(auditEntry.id)] as const;

const make = Effect.gen(function* () {
  const db = yield* Database;

  /**
   * The history of one thing, newest first. `entityId` is a globally unique
   * time-ordered uuid, so no entity type is needed to disambiguate it — and the
   * log outlives the row it describes, which is why this still answers after a
   * task has been deleted.
   */
  const forEntity = Effect.fn("AuditLogRepo.forEntity")(function* (
    input: Page & {
      readonly entityId: AuditEntry["entityId"];
      readonly workspaceId: WorkspaceId;
    }
  ) {
    yield* Effect.annotateCurrentSpan({ entityId: input.entityId });
    const rows = yield* execute(
      "AuditLogRepo.forEntity",
      db
        .select()
        .from(auditEntry)
        .where(
          and(
            eq(auditEntry.workspaceId, input.workspaceId),
            eq(auditEntry.entityId, input.entityId),
            startingAt(input.before)
          )
        )
        .orderBy(...newestFirst)
        .limit(input.limit ?? DEFAULT_LIMIT)
    );
    return yield* decodeMany({
      decode: decodeAuditEntry,
      entity: ENTITY,
      rows,
    });
  });

  /**
   * Who changed this task, newest first. It is one index scan because `task_id`
   * is denormalized onto every entry, including the ones about the task's
   * sessions, runs and artifacts — so the feed is the whole story and not just
   * the edits to the task row.
   */
  const forTask = Effect.fn("AuditLogRepo.forTask")(function* (
    input: Page & { readonly taskId: TaskId; readonly workspaceId: WorkspaceId }
  ) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    const rows = yield* execute(
      "AuditLogRepo.forTask",
      db
        .select()
        .from(auditEntry)
        .where(
          and(
            eq(auditEntry.workspaceId, input.workspaceId),
            eq(auditEntry.taskId, input.taskId),
            startingAt(input.before)
          )
        )
        .orderBy(...newestFirst)
        .limit(input.limit ?? DEFAULT_LIMIT)
    );
    return yield* decodeMany({
      decode: decodeAuditEntry,
      entity: ENTITY,
      rows,
    });
  });

  /** Everything that happened in a workspace, newest first. */
  const forWorkspace = Effect.fn("AuditLogRepo.forWorkspace")(function* (
    input: Page & { readonly workspaceId: WorkspaceId }
  ) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });
    const rows = yield* execute(
      "AuditLogRepo.forWorkspace",
      db
        .select()
        .from(auditEntry)
        .where(
          and(
            eq(auditEntry.workspaceId, input.workspaceId),
            startingAt(input.before)
          )
        )
        .orderBy(...newestFirst)
        .limit(input.limit ?? DEFAULT_LIMIT)
    );
    return yield* decodeMany({
      decode: decodeAuditEntry,
      entity: ENTITY,
      rows,
    });
  });

  return { forEntity, forTask, forWorkspace } as const;
});

/**
 * Reading the audit log. There is deliberately no write here: an entry is
 * written inside the transaction of the mutation it describes, by the helper
 * every mutating repository goes through, so a writable seam at this level would
 * be a way to record a change that never happened.
 *
 * The table is append-only and the first migration revokes UPDATE and DELETE on
 * it, so a log that can be rewritten is not merely discouraged here — it is not
 * permitted there.
 */
export class AuditLogRepo extends Context.Service<
  AuditLogRepo,
  Effect.Success<typeof make>
>()("@workspace/db/AuditLogRepo") {
  static readonly layer = Layer.effect(AuditLogRepo, make);
}
