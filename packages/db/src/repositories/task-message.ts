/**
 * The task's conversation, and the only channel that crosses sessions.
 *
 * Transcripts are captured wholesale and say what happened; a task message is the
 * short deliberate thing the next reader needs. Attribution is what makes
 * several sessions on one task readable — the UI can say "from the review
 * session" instead of presenting one undifferentiated voice — so the author is
 * a union here rather than four loose nullable columns, and the combinations
 * the database's CHECKs allow are the only ones that can be expressed.
 *
 * Append only: nothing edits or deletes a task message, which is why there is no
 * update here and no `editedAt` on the row.
 */

import {
  type AgentSessionId,
  newTaskMessageId,
  type RunId,
  type TaskId,
  type TaskMessage,
  type TaskMessageKind,
  type UserId,
  type WorkspaceId,
} from "@workspace/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { Database } from "../client";
import { decodeTaskMessage, TaskMessageInsert } from "../rows";
import { comment } from "../schema/comment";
import { task } from "../schema/task";
import {
  auditCreate,
  audited,
  decodeMany,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  writer,
} from "./audit";

/** Reads addressed by id match one row; the limit says so to the planner. */
const ONE = 1;

/**
 * The table, and the entity an audit row names. Still `comment`: the rename to
 * task message stops at this layer, so the rows already written stay readable.
 */
const ENTITY = "comment";

/** A person, in the dashboard or the bot. */
export interface HumanAuthor {
  readonly kind: "human";
  readonly userId: UserId;
}

/** The manager agent, which always speaks for a person. */
export interface ManagerAuthor {
  readonly kind: "manager";
  readonly userId: UserId;
}

/**
 * A worker agent. It names the session that spoke and the attempt it spoke
 * from, which is what lets a resuming session read "the review session found X"
 * rather than an anonymous line.
 */
export interface AgentAuthor {
  readonly kind: "agent";
  readonly runId: RunId | null;
  readonly sessionId: AgentSessionId;
}

/**
 * The orchestrator, which authors a crashed run's error text: the process that
 * died cannot write its own epitaph.
 */
export interface OrchestratorAuthor {
  readonly kind: "orchestrator";
  readonly runId: RunId | null;
}

/** Who is speaking, in the combinations the row's CHECKs allow. */
export type TaskMessageAuthor =
  | AgentAuthor
  | HumanAuthor
  | ManagerAuthor
  | OrchestratorAuthor;

/**
 * Spreads an author across the four columns. One place, so a new kind of writer
 * is a compile error here rather than a row that attributes itself to nobody.
 */
const authorColumns = (author: TaskMessageAuthor) => {
  if (author.kind === "agent") {
    return {
      agentSessionId: author.sessionId,
      authorKind: author.kind,
      authorUserId: null,
      runId: author.runId,
    };
  }
  if (author.kind === "orchestrator") {
    return {
      agentSessionId: null,
      authorKind: author.kind,
      authorUserId: null,
      runId: author.runId,
    };
  }
  return {
    agentSessionId: null,
    authorKind: author.kind,
    authorUserId: author.userId,
    runId: null,
  };
};

/** What posting a task message needs. */
export interface TaskMessagePost
  extends Pick<TaskMessage, "body" | "taskId" | "workspaceId"> {
  readonly author: TaskMessageAuthor;
  /**
   * `message` unless said otherwise. `fallback` is the auto-appended final
   * assistant message — the auto-generated flag, which the UI collapses — and
   * `run_error` is a crash, which it never does.
   */
  readonly kind?: TaskMessageKind;
}

/**
 * How far through a task's thread something has read. A position, compared as
 * the `(createdAt, id)` tuple the thread is ordered by, so a same-millisecond
 * tie cannot skip a message.
 */
export interface TaskMessageWatermark
  extends Pick<TaskMessage, "createdAt" | "id"> {}

/** What identifies a thread. */
export interface ThreadRef {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);

  const threadOf = (ref: ThreadRef) =>
    and(
      eq(comment.workspaceId, ref.workspaceId),
      eq(comment.taskId, ref.taskId)
    );

  /**
   * Everything after a position in the thread. The comparison is one row-wise
   * `>` rather than a timestamp test with a tiebreaker bolted on, because that
   * is the shape of the `(task_id, created_at, id)` index and the shape that
   * cannot drop a message written in the same millisecond as the watermark.
   */
  const after = (watermark: TaskMessageWatermark) =>
    sql`(${comment.createdAt}, ${comment.id}) > (${DateTime.toDate(watermark.createdAt)}::timestamptz, ${watermark.id}::uuid)`;

  /**
   * Posts a message, and refuses one on a task this workspace does not have.
   * The composite foreign key would refuse it too, but as a constraint
   * violation — a caller can do something with a missing task and nothing with
   * that.
   */
  const post = Effect.fn("TaskMessageRepo.post")(function* (
    input: TaskMessagePost
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    });

    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: TaskMessageInsert,
      value: {
        ...authorColumns(input.author),
        body: input.body,
        id: newTaskMessageId(),
        kind: input.kind ?? "message",
        taskId: input.taskId,
        workspaceId: input.workspaceId,
      },
    });

    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const owner = yield* execute(
          "TaskMessageRepo.post",
          tx
            .select({ id: task.id })
            .from(task)
            .where(
              and(
                eq(task.workspaceId, input.workspaceId),
                eq(task.id, input.taskId)
              )
            )
            .limit(ONE)
        );

        yield* firstRow({ entity: "task", id: input.taskId, rows: owner });

        const rows = yield* execute(
          "TaskMessageRepo.post",
          tx.insert(comment).values(values).returning()
        );

        const posted = yield* decodeWritten({
          decode: decodeTaskMessage,
          entity: ENTITY,
          operation: "TaskMessageRepo.post",
          rows,
        });

        return audited(
          posted,
          auditCreate({
            entityId: posted.id,
            entityType: ENTITY,
            taskId: posted.taskId,
            workspaceId: posted.workspaceId,
          })
        );
      })
    );
  });

  /** The whole thread, oldest first — the order it is read in. */
  const forTask = Effect.fn("TaskMessageRepo.forTask")(function* (
    options: ThreadRef
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "TaskMessageRepo.forTask",
      db
        .select()
        .from(comment)
        .where(threadOf(options))
        .orderBy(asc(comment.createdAt), asc(comment.id))
    );

    return yield* decodeMany({
      decode: decodeTaskMessage,
      entity: ENTITY,
      rows,
    });
  });

  /**
   * What a resuming session has not read yet: every message added after its
   * watermark, oldest first, ready to become the next prompt. A session with no
   * watermark has read nothing, so it gets the thread from the beginning —
   * which is what a session resumed for the first time wants.
   */
  const since = Effect.fn("TaskMessageRepo.since")(function* (
    options: ThreadRef & { readonly watermark: TaskMessageWatermark | null }
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });

    const scope = threadOf(options);

    const rows = yield* execute(
      "TaskMessageRepo.since",
      db
        .select()
        .from(comment)
        .where(
          options.watermark === null
            ? scope
            : and(scope, after(options.watermark))
        )
        .orderBy(asc(comment.createdAt), asc(comment.id))
    );

    return yield* decodeMany({
      decode: decodeTaskMessage,
      entity: ENTITY,
      rows,
    });
  });

  /**
   * The newest message on the task, or null on a silent one. This is the
   * position a session's watermark advances to when its prompt is built —
   * including past messages its own previous run posted, otherwise a resumed
   * run reads its own fallback message back as new input.
   */
  const newest = Effect.fn("TaskMessageRepo.newest")(function* (
    options: ThreadRef
  ) {
    yield* Effect.annotateCurrentSpan({
      taskId: options.taskId,
      workspaceId: options.workspaceId,
    });

    const rows = yield* execute(
      "TaskMessageRepo.newest",
      db
        .select()
        .from(comment)
        .where(threadOf(options))
        .orderBy(desc(comment.createdAt), desc(comment.id))
        .limit(ONE)
    );

    const [row] = rows;
    if (row === undefined) {
      return null;
    }

    return yield* decodeWritten({
      decode: decodeTaskMessage,
      entity: ENTITY,
      operation: "TaskMessageRepo.newest",
      rows,
    });
  });

  return { forTask, newest, post, since } as const;
});

/** The task's conversation. Append only, and every append is audited. */
export class TaskMessageRepo extends Context.Service<
  TaskMessageRepo,
  Effect.Success<typeof make>
>()("@workspace/db/TaskMessageRepo") {
  static readonly layer = Layer.effect(TaskMessageRepo, make);
}
