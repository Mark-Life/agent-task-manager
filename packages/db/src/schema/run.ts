import {
  type ActorKind,
  type AgentSessionId,
  RUN_EVENT_PAYLOAD_MAX_BYTES,
  type RunCommandId,
  type RunCommandKind,
  type RunCommandStatus,
  type RunEventId,
  type RunEventKind,
  type RunId,
  type RunOutcome,
  type RunStatus,
  type RunTrigger,
  type SessionProvider,
  type TaskId,
  type UserId,
} from "@workspace/domain";
import { type SQLWrapper, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentSession } from "./agent-session";
import { baseColumns, mutableColumns, tstz } from "./columns";
import { task } from "./task";

/** A run is live while it is queued or running; every other status is a terminus. */
const isLive = (status: SQLWrapper) => sql`${status} in ('queued', 'running')`;

/**
 * One attempt at a task. Liveness lives here rather than on the task, because a
 * task sitting in the in-progress column with no live run is waiting for a slot
 * or has stalled — the board shows the difference, and it reads the run to do it.
 *
 * `outcome` stays null while the run is live: a terminus value invented up front
 * is a value someone will later group by. The economics columns follow the same
 * rule and stay null on a degraded ending rather than reporting a cost of zero.
 *
 * `cost_usd` is numeric, decoded as a string, because money that round-trips
 * through a float stops adding up. The awkwardness is one decode in the
 * repository.
 */
export const run = pgTable(
  "run",
  {
    ...mutableColumns<RunId>(),
    // This run's agent-home directory, relative to the data root: where the
    // transcript landed, which post-run ingest reads off this row. Per run, not
    // per session, because parallel containers sharing one credentials file
    // invalidate each other.
    agentHomePath: text("agent_home_path"),
    agentSessionId: uuid("agent_session_id")
      .$type<AgentSessionId>()
      .notNull()
      .references(() => agentSession.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    branch: text("branch"),
    containerId: text("container_id"),
    costUsd: numeric("cost_usd", { mode: "string", precision: 12, scale: 6 }),
    durationMs: integer("duration_ms"),
    errorClass: text("error_class"),
    errorMessage: text("error_message"),
    // Distinguishes a crash from a clean finish.
    exitCode: integer("exit_code"),
    finishedAt: tstz("finished_at"),
    model: text("model"),
    outcome: text("outcome").$type<RunOutcome>(),
    provider: text("provider").$type<SessionProvider>().notNull(),
    // Which image actually ran, against `task.sandbox_image`, which selects one.
    sandboxImage: text("sandbox_image"),
    // Null while queued, so queue wait is `started_at - created_at`.
    startedAt: tstz("started_at"),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    taskId: uuid("task_id").$type<TaskId>().notNull(),
    totalTokens: integer("total_tokens"),
    // Joins this row to the run's wide event in the telemetry ledger.
    traceId: text("trace_id"),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    turns: integer("turns"),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [task.workspaceId, task.id],
      name: "run_task_fk",
    }).onDelete("cascade"),
    // Liveness is encoded in four columns and they must agree: a live run has
    // no outcome and no finish, a running one has begun, and a queued one has
    // not. Without these the board could show a spinner on a finished run.
    check(
      "run_outcome_ck",
      sql`(${t.outcome} is null) = (${isLive(t.status)})`
    ),
    check(
      "run_finished_at_ck",
      sql`(${t.finishedAt} is null) = (${isLive(t.status)})`
    ),
    check(
      "run_started_at_ck",
      sql`${t.status} <> 'running' or ${t.startedAt} is not null`
    ),
    check(
      "run_queued_ck",
      sql`${t.status} <> 'queued' or ${t.startedAt} is null`
    ),
    uniqueIndex("run_workspace_id_id_uidx").on(t.workspaceId, t.id),
    index("run_task_id_created_at_idx").on(t.taskId, t.createdAt),
    // One live run per task, enforced rather than assumed: two agents writing
    // one artifacts directory is the failure this prevents.
    uniqueIndex("run_task_id_live_uidx").on(t.taskId).where(isLive(t.status)),
    // The orchestrator's startup reconcile, and the board's spinner.
    index("run_workspace_id_created_at_live_idx")
      .on(t.workspaceId, t.createdAt)
      .where(isLive(t.status)),
    index("run_agent_session_id_idx").on(t.agentSessionId),
  ]
);

/**
 * The live stream, the replay source and the run's own record, in one
 * append-only table. Append-only is enforced by revoked privileges, not by the
 * absence of an `updated_at` column.
 *
 * `seq` is the 0-based line ordinal of the event in the container's event file,
 * not a counter: re-ingesting the same file therefore collides on
 * `(run_id, seq)` by construction, which is what makes re-ingest idempotent.
 *
 * `task_id` is denormalized so an SSE subscriber can filter a task's stream
 * without a join, and both clocks are kept — the harness clock inside the
 * container and the insert clock on the host differ, and the gap is sometimes
 * the interesting part.
 */
export const runEvent = pgTable(
  "run_event",
  {
    ...baseColumns<RunEventId>(),
    kind: text("kind").$type<RunEventKind>().notNull(),
    occurredAt: tstz("occurred_at").notNull(),
    payload: jsonb("payload").notNull().default({}),
    runId: uuid("run_id").$type<RunId>().notNull(),
    seq: integer("seq").notNull(),
    taskId: uuid("task_id")
      .$type<TaskId>()
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [run.workspaceId, run.id],
      name: "run_event_run_fk",
    }).onDelete("cascade"),
    // The day-one bound on this table's growth: a chatty run cannot put
    // megabytes into the write-ahead log and every backup forever. Writers clip
    // to a budget below this, so the constraint fires only on one that did not.
    // Raw, because a constraint cannot hold a bound parameter.
    check(
      "run_event_payload_size_ck",
      sql`pg_column_size(${t.payload}) < ${sql.raw(String(RUN_EVENT_PAYLOAD_MAX_BYTES))}`
    ),
    uniqueIndex("run_event_run_id_seq_uidx").on(t.runId, t.seq),
    // The task timeline across runs, and an SSE catch-up from a cursor.
    index("run_event_task_id_id_idx").on(t.taskId, t.id.desc()),
  ]
);

/**
 * Stop, rerun and start-session, written by anyone and acted on
 * only by the orchestrator. Keeping intents in a table is what makes every
 * intervention attributable and keeps one owner of container lifecycle: the
 * manager agent asks for the same things a human does, through the same rows.
 *
 * A command may name no run, meaning whichever run is live. A rejected command
 * records why — "no live run" and "task not in progress" are outcomes, not
 * silence.
 */
export const runCommand = pgTable(
  "run_command",
  {
    ...mutableColumns<RunCommandId>(),
    actorKind: text("actor_kind").$type<ActorKind>().notNull(),
    // A worker run holding a task-scoped token writes commands too, and names
    // its run and session the way an audit row does.
    actorRunId: uuid("actor_run_id").$type<RunId>(),
    actorSessionId: uuid("actor_session_id").$type<AgentSessionId>(),
    actorUserId: text("actor_user_id").$type<UserId>(),
    consumedAt: tstz("consumed_at"),
    kind: text("kind").$type<RunCommandKind>().notNull(),
    // Rerun extras, or the trigger for a start-session.
    payload: jsonb("payload").notNull().default({}),
    rejectedReason: text("rejected_reason"),
    runId: uuid("run_id")
      .$type<RunId>()
      .references(() => run.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<RunCommandStatus>()
      .notNull()
      .default("pending"),
    taskId: uuid("task_id").$type<TaskId>().notNull(),
    // The trace of the request that wrote this intent, as a W3C `traceparent`.
    // The other half of the same idea as `task.dispatch_traceparent`: a rerun
    // or a start-session is a dispatch trigger that moves no card, so the row
    // that causes the work is this one and it carries the id that caused it.
    traceparent: text("traceparent"),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [task.workspaceId, task.id],
      name: "run_command_task_fk",
    }).onDelete("cascade"),
    // The orchestrator's poll wants pending rows and nothing else.
    index("run_command_workspace_id_created_at_pending_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // A double-clicked Stop becomes a no-op conflict rather than a second
    // command that lands as rejected noise.
    uniqueIndex("run_command_task_id_kind_pending_uidx")
      .on(t.taskId, t.kind)
      .where(sql`${t.status} = 'pending'`),
    index("run_command_task_id_created_at_idx").on(t.taskId, t.createdAt),
    index("run_command_run_id_idx").on(t.runId),
  ]
);
