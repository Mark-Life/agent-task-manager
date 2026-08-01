import {
  AgentSessionId,
  CommentId,
  SessionProvider,
  SessionStatus,
  TaskId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { agentSession } from "../schema/agent-session";

/**
 * The watermark is two columns and stays two columns: it is compared against
 * `comment` as a `(created_at, id)` tuple, so collapsing it into one value here
 * would cost the tiebreaker that stops a same-millisecond tie from skipping a
 * comment.
 *
 * `provider_session_id` is left underived — it is whatever string the harness
 * reports, and giving it a brand of ours would suggest we mint it.
 */
const columns = {
  commentWatermarkAt: () => Timestamp,
  commentWatermarkId: () => CommentId,
  endedAt: () => Timestamp,
  id: () => AgentSessionId,
  provider: () => SessionProvider,
  status: () => SessionStatus,
  taskId: () => TaskId,
  workspaceId: () => WorkspaceId,
};

/** An `agent_session` row as the database hands it back. */
export const AgentSessionRow = createSelectSchema(agentSession, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a repository writes to open a session, in the same transaction as the run that will use it. */
export const AgentSessionInsert = createInsertSchema(agentSession, columns);

/** What a repository may change: the status and its ending, the provider's own id once reported, the watermark on each resume. */
export const AgentSessionUpdate = createUpdateSchema(agentSession, columns);

/** Turns a raw row into the domain entity. */
export const decodeAgentSession = Schema.decodeUnknownEffect(AgentSessionRow);
