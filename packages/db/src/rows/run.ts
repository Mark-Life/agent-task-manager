import {
  AgentSessionId,
  CostUsd,
  RunId,
  RunOutcome,
  RunRole,
  RunStatus,
  RunTrigger,
  SessionProvider,
  TaskId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { run } from "../schema/run";

/**
 * `cost_usd` is the reason this table needs a decode at all. The column is
 * `numeric` read in string mode, because money that has been through a float
 * stops adding up; the domain brand is what keeps that string from being
 * treated as an ordinary one and parsed somewhere in the middle of a pipeline.
 *
 * The counts are `Natural` rather than `Int`: a run cannot have taken -3 turns,
 * and a negative here means an ingest bug that should surface as a decode
 * failure rather than as a number in a chart.
 */
const columns = {
  agentSessionId: () => AgentSessionId,
  attempt: () => Schema.Natural,
  costUsd: () => CostUsd,
  durationMs: () => Schema.Natural,
  finishedAt: () => Timestamp,
  id: () => RunId,
  outcome: () => RunOutcome,
  provider: () => SessionProvider,
  role: () => RunRole,
  startedAt: () => Timestamp,
  status: () => RunStatus,
  taskId: () => TaskId,
  threadId: () => ThreadId,
  totalTokens: () => Schema.Natural,
  trigger: () => RunTrigger,
  turns: () => Schema.Natural,
  workspaceId: () => WorkspaceId,
};

/** A `run` row as the database hands it back. */
export const RunRow = createSelectSchema(run, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What the orchestrator writes to claim an attempt. */
export const RunInsert = createInsertSchema(run, columns);

/** What the orchestrator writes as the attempt progresses and ends. */
export const RunUpdate = createUpdateSchema(run, columns);

/** Turns a raw row into the domain entity. */
export const decodeRun = Schema.decodeUnknownEffect(RunRow);

/**
 * The two columns the resume decision reads off a run: which session it belongs
 * to, and how it ended.
 *
 * A projection rather than the whole row, because "should this session be picked
 * up again" is a two-column question and a session with a long history should
 * not cost a page of columns to ask it.
 *
 * `outcome` is not null here where it is nullable on {@link RunRow}: the query
 * behind this excludes the live runs, which are the only ones without one. A
 * null reaching this decode is that filter having been dropped, and failing is
 * the right answer to it.
 */
export const SessionRunOutcomeRow = Schema.Struct({
  agentSessionId: AgentSessionId,
  outcome: RunOutcome,
});

/** Turns one `(session, outcome)` projection into the pair the resume gate counts. */
export const decodeSessionRunOutcome =
  Schema.decodeUnknownEffect(SessionRunOutcomeRow);
