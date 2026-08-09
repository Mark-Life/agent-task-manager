import type {
  AgentSessionId,
  StoredSessionUsage,
  WorkspaceId,
} from "@workspace/domain";
import { foreignKey, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { agentSession } from "./agent-session";

/**
 * What one session spent, derived from the transcript and kept here so it
 * outlives the file.
 *
 * **Its own table rather than a column on `agent_session`.** The summary
 * carries a growth curve, and a session list that pulled a few kilobytes of
 * curve per row for a bar nobody had opened yet would pay for the chart on
 * every board refresh. It is also derived, not decided: every write replaces
 * the last one wholesale, which is a shape the audited session row should not
 * be teaching anyone. This table is in {@link UnauditedTable} for that reason —
 * "who changed this" has one answer here, the ingest, on every row.
 *
 * **One row per session, keyed by the session.** A session's summary is
 * recomputed from the whole transcript at the end of each of its runs, so it
 * grows with the conversation and there is nothing to accumulate across rows.
 * The write is an upsert on that key.
 *
 * **The summary is a blob and not columns.** Nothing queries inside it — the
 * board asks for one session's figures, or a task's — and the alternative is
 * twenty columns that would have to migrate every time the shape learns
 * something new about a provider. It is validated on the way in and on the way
 * out by the domain schema, so a blob that stopped matching is a loud decode
 * failure rather than a silently half-rendered panel.
 *
 * There is no `created_at` or `updated_at`, and no `computed_at` column: the
 * summary carries its own `computedAt`, which is the only clock that means
 * anything here — the UI shows it beside a running session's figures to say how
 * old they are — and a second copy in a column is the one that goes stale.
 */
export const agentSessionUsage = pgTable(
  "agent_session_usage",
  {
    sessionId: uuid("session_id").$type<AgentSessionId>().primaryKey(),
    usage: jsonb("usage").$type<StoredSessionUsage>().notNull(),
    workspaceId: text("workspace_id").$type<WorkspaceId>().notNull(),
  },
  (t) => [
    // Scoped by workspace like every other read, and gone when the session is:
    // a summary of a conversation nobody can reach is not a record of anything.
    foreignKey({
      columns: [t.workspaceId, t.sessionId],
      foreignColumns: [agentSession.workspaceId, agentSession.id],
      name: "agent_session_usage_session_fk",
    }).onDelete("cascade"),
  ]
);
