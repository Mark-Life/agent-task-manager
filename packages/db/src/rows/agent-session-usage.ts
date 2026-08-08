import { AgentSessionId, SessionUsage, WorkspaceId } from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { agentSessionUsage } from "../schema/agent-session-usage";

/**
 * The blob is refined all the way to {@link SessionUsage} rather than to "an
 * object", because unlike `run_event` nothing about its shape depends on a
 * column beside it. That makes this decode the whole guarantee the storage
 * offers: a summary written by an older build that no longer matches fails
 * loudly here, rather than reaching a chart that renders half a curve.
 */
const columns = {
  sessionId: () => AgentSessionId,
  usage: () => SessionUsage,
  workspaceId: () => WorkspaceId,
};

/** An `agent_session_usage` row as the database hands it back. */
export const AgentSessionUsageRow = createSelectSchema(
  agentSessionUsage,
  columns
);

/**
 * What the ingest writes at the end of a run. There is no update schema: a
 * summary is replaced whole, as an upsert on the session, because it is
 * recomputed from the entire transcript every time rather than accumulated.
 */
export const AgentSessionUsageInsert = createInsertSchema(
  agentSessionUsage,
  columns
);

/** Turns a raw row into the domain entity. */
export const decodeAgentSessionUsage =
  Schema.decodeUnknownEffect(AgentSessionUsageRow);
