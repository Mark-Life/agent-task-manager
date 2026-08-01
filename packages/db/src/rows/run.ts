import {
  AgentSessionId,
  CostUsd,
  RunId,
  RunOutcome,
  RunStatus,
  RunTrigger,
  SessionProvider,
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
  startedAt: () => Timestamp,
  status: () => RunStatus,
  taskId: () => TaskId,
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
