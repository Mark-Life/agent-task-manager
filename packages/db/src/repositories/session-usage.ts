/**
 * What each session spent, written once per run and read whole.
 *
 * The write is an upsert and the table is unaudited, and both follow from the
 * same fact: this row is derived, not decided. It is recomputed from the entire
 * transcript at the end of every run on the session, so the new value replaces
 * the old one rather than amending it, and "who changed this" has one answer —
 * the ingest — on every row that will ever exist. An audit trail of that is
 * noise in a log whose whole value is that it is not noise.
 *
 * Reads are scoped by workspace like every other read here, and the list is
 * scoped by task through the session it belongs to. A session with no summary
 * is simply absent from the list: a run that died before its first response
 * spent nothing anybody can account for, and a zeroed row would say it spent
 * nothing at all.
 */

import type {
  AgentSessionId,
  SessionUsage,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Database } from "../client";
import { AgentSessionUsageInsert, decodeAgentSessionUsage } from "../rows";
import { agentSession } from "../schema/agent-session";
import { agentSessionUsage } from "../schema/agent-session-usage";
import {
  decodeMany,
  encodeWrite,
  execute,
  unauditedTransaction,
} from "./audit";

/** The table these rows live in, and what a decode failure names them as. */
const ENTITY = "agent_session_usage";

/** What identifies one session's summary. */
interface UsageRef {
  readonly sessionId: AgentSessionId;
  readonly workspaceId: WorkspaceId;
}

/** A summary to store, against the session it describes. */
interface RecordInput extends UsageRef {
  readonly usage: SessionUsage;
}

/** What identifies the summaries under one task. */
interface TaskRef {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = unauditedTransaction(db);

  /**
   * Stores this session's summary, replacing whatever the last run left.
   *
   * Replacing rather than merging is the whole reason a re-ingest is safe: the
   * summary describes the transcript as it stands, so reading the same file
   * twice writes the same row twice and reading a file that has grown writes
   * the larger answer.
   */
  const record = Effect.fn("AgentSessionUsageRepo.record")(function* (
    input: RecordInput
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: input.sessionId });
    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: AgentSessionUsageInsert,
      value: {
        sessionId: input.sessionId,
        usage: input.usage,
        workspaceId: input.workspaceId,
      },
    });
    yield* write(
      { operation: "AgentSessionUsageRepo.record", table: ENTITY },
      (tx) =>
        execute(
          "AgentSessionUsageRepo.record",
          tx
            .insert(agentSessionUsage)
            .values(values)
            .onConflictDoUpdate({
              set: { usage: values.usage },
              target: agentSessionUsage.sessionId,
            })
        )
    );
  });

  /**
   * Every summary under one task, in no particular order — the caller already
   * has the session list and is joining onto it by id.
   */
  const listByTask = Effect.fn("AgentSessionUsageRepo.listByTask")(function* (
    input: TaskRef
  ) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    const rows = yield* execute(
      "AgentSessionUsageRepo.listByTask",
      db
        .select({
          sessionId: agentSessionUsage.sessionId,
          usage: agentSessionUsage.usage,
          workspaceId: agentSessionUsage.workspaceId,
        })
        .from(agentSessionUsage)
        .innerJoin(
          agentSession,
          and(
            eq(agentSession.id, agentSessionUsage.sessionId),
            eq(agentSession.workspaceId, agentSessionUsage.workspaceId)
          )
        )
        .where(
          and(
            eq(agentSessionUsage.workspaceId, input.workspaceId),
            eq(agentSession.taskId, input.taskId)
          )
        )
    );
    return yield* decodeMany({
      decode: decodeAgentSessionUsage,
      entity: ENTITY,
      rows,
    });
  });

  /** One session's summary, or null where no run has produced one yet. */
  const byId = Effect.fn("AgentSessionUsageRepo.byId")(function* (
    input: UsageRef
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: input.sessionId });
    const rows = yield* execute(
      "AgentSessionUsageRepo.byId",
      db
        .select()
        .from(agentSessionUsage)
        .where(
          and(
            eq(agentSessionUsage.workspaceId, input.workspaceId),
            eq(agentSessionUsage.sessionId, input.sessionId)
          )
        )
    );
    const found = yield* decodeMany({
      decode: decodeAgentSessionUsage,
      entity: ENTITY,
      rows,
    });
    return found[0] ?? null;
  });

  return { byId, listByTask, record } as const;
});

/** What each of a task's sessions spent, as the board reads it. */
export class AgentSessionUsageRepo extends Context.Service<
  AgentSessionUsageRepo,
  Effect.Success<typeof make>
>()("@workspace/db/AgentSessionUsageRepo") {
  static readonly layer = Layer.effect(AgentSessionUsageRepo, make);
}
