import { Schema } from "effect";

/**
 * Every enum-like column is `text` plus one of the unions below, never a
 * `pgEnum`. Adding or retiring a value is then a code change and a deploy
 * rather than a migration with a lock on the table it renames.
 *
 * Each union ships as a `const` tuple as well as a schema, because a board
 * column list, a dropdown and a test that asserts exhaustiveness all want to
 * iterate the values, and re-listing them beside the schema is how they drift.
 */

/** The five board columns. There is no failure status: a crashed run lands in `review` like any other. */
export const TASK_STATUSES = [
  "ideas",
  "backlog",
  "in_progress",
  "review",
  "done",
] as const;

/** Where a task sits on the board. */
export const TaskStatus = Schema.Literals(TASK_STATUSES);
export type TaskStatus = typeof TaskStatus.Type;

/** `orchestrator` writes most rows in the system; `system` is the seed script and nothing else. */
export const ACTOR_KINDS = [
  "human",
  "manager",
  "worker_run",
  "orchestrator",
  "system",
] as const;

/** Who performed a mutation. The flattened discriminant of `Actor`. */
export const ActorKind = Schema.Literals(ACTOR_KINDS);
export type ActorKind = typeof ActorKind.Type;

/** The agent harnesses we run. */
export const SESSION_PROVIDERS = ["claude", "codex"] as const;

/** Which harness a session talks to. Stored apart from the provider's own session id, so the provider can change mid-task. */
export const SessionProvider = Schema.Literals(SESSION_PROVIDERS);
export type SessionProvider = typeof SessionProvider.Type;

/** A session that died producing nothing stays visible as `failed` rather than as an absence. */
export const SESSION_STATUSES = ["running", "finished", "failed"] as const;

/**
 * How a session ended, which is most but not all of whether it can be resumed:
 * `failed` covers the agent breaking and the wall clock running out alike, and
 * telling those apart needs the last run's outcome. `isResumable` is the whole
 * of the question; this is one of its two inputs.
 */
export const SessionStatus = Schema.Literals(SESSION_STATUSES);
export type SessionStatus = typeof SessionStatus.Type;

/** Live-versus-not. The detail of how a run ended is its `RunOutcome`. */
export const RUN_STATUSES = [
  "queued",
  "running",
  "finished",
  "failed",
  "interrupted",
] as const;

/** Whether a run is still live, which the board shows separately from the task's status. */
export const RunStatus = Schema.Literals(RUN_STATUSES);
export type RunStatus = typeof RunStatus.Type;

/**
 * How a run ended. Deliberately narrower than the `atm.run` telemetry outcome:
 * `parked` is a property of the task, and `skipped` describes a dispatch that
 * never created a run row at all, so neither has a row to live on.
 *
 * `stopped` and `interrupted` are both "something outside the run ended it",
 * and they are two values because only one of them is somebody's decision. A
 * person or the manager agent filing a stop command is `stopped`, and the row
 * says who asked; the loop going down under a run, or any other interrupt
 * nothing recorded a reason for, is `interrupted`. Folding the first into the
 * second — or, as this system did until they were told apart, into `errored` —
 * files a deliberate intervention as a fault, which puts a working Stop button
 * in the error budget and leaves the person who pressed it unnamed.
 */
export const RUN_OUTCOMES = [
  "done",
  "errored",
  "interrupted",
  "stopped",
  "timeout",
  "lost",
] as const;

/** The terminus of a run. Null while it is live — never a fabricated value. */
export const RunOutcome = Schema.Literals(RUN_OUTCOMES);
export type RunOutcome = typeof RunOutcome.Type;

/** Why the run exists. `research` and `manual` come from a `start_session` command. */
export const RUN_TRIGGERS = [
  "status_change",
  "rerun",
  "research",
  "manual",
] as const;

/** What caused a run to be created. */
export const RunTrigger = Schema.Literals(RUN_TRIGGERS);
export type RunTrigger = typeof RunTrigger.Type;

/**
 * Which of the two jobs a run is doing. One runtime serves both: the role
 * selects the system prompt, the container image, the tool credential's binding
 * and which table the run is attached to, and nothing else — dispatch, lease,
 * pool, quota, events, sessions and transcripts are shared.
 */
export const RUN_ROLES = ["worker", "manager"] as const;

/** A run works a task (`worker`) or answers a conversation (`manager`). */
export const RunRole = Schema.Literals(RUN_ROLES);
export type RunRole = typeof RunRole.Type;

/** Normalized harness events plus the lifecycle markers the orchestrator writes. */
export const RUN_EVENT_KINDS = [
  "started",
  "assistant_message",
  "reasoning",
  "tool_call",
  "tool_result",
  "usage",
  "log",
  "error",
  "finished",
  "failed",
  "stopped",
] as const;

/** The discriminator of a run event's payload. Stored as a column, so the tag is never repeated inside the blob. */
export const RunEventKind = Schema.Literals(RUN_EVENT_KINDS);
export type RunEventKind = typeof RunEventKind.Type;

/** Severity of a `log` run event. */
export const RUN_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** How loud a `log` run event is, so the timeline can filter narration from alarm. */
export const RunLogLevel = Schema.Literals(RUN_LOG_LEVELS);
export type RunLogLevel = typeof RunLogLevel.Type;

/**
 * Intents anyone may write; only the orchestrator acts on them. Container
 * lifecycle only — reordering the queue is an ordinary write to the task's
 * rank, not something the orchestrator has to be asked for.
 */
export const RUN_COMMAND_KINDS = ["stop", "rerun", "start_session"] as const;

/** What a run command asks for. */
export const RunCommandKind = Schema.Literals(RUN_COMMAND_KINDS);
export type RunCommandKind = typeof RunCommandKind.Type;

/** A refused command is `rejected` with a reason, because silence is not an outcome. */
export const RUN_COMMAND_STATUSES = [
  "pending",
  "consumed",
  "rejected",
] as const;

/** Where a run command is in the orchestrator's queue. */
export const RunCommandStatus = Schema.Literals(RUN_COMMAND_STATUSES);
export type RunCommandStatus = typeof RunCommandStatus.Type;

/** The orchestrator authors the crash message, because the process that died cannot. */
export const TASK_MESSAGE_AUTHOR_KINDS = [
  "human",
  "manager",
  "agent",
  "orchestrator",
] as const;

/** Who wrote a task message. Attribution is what makes several sessions on one task readable. */
export const TaskMessageAuthorKind = Schema.Literals(TASK_MESSAGE_AUTHOR_KINDS);
export type TaskMessageAuthorKind = typeof TaskMessageAuthorKind.Type;

/** Orthogonal to the author: only `fallback` collapses in the UI. */
export const TASK_MESSAGE_KINDS = ["message", "fallback", "run_error"] as const;

/** What a task message is. `fallback` is the auto-appended final message; `run_error` is a crash, and never collapsed. */
export const TaskMessageKind = Schema.Literals(TASK_MESSAGE_KINDS);
export type TaskMessageKind = typeof TaskMessageKind.Type;

/** A thread is never deleted: the audit log points at it, and an erased conversation orphans every row that named it. */
export const THREAD_STATUSES = ["active", "archived"] as const;

/** Whether a chat thread still takes messages. */
export const ThreadStatus = Schema.Literals(THREAD_STATUSES);
export type ThreadStatus = typeof ThreadStatus.Type;

/** Two voices only: the person, and the manager answering as itself. */
export const CHAT_MESSAGE_ROLES = ["user", "manager"] as const;

/** Who spoke in a chat thread. */
export const ChatMessageRole = Schema.Literals(CHAT_MESSAGE_ROLES);
export type ChatMessageRole = typeof ChatMessageRole.Type;

/**
 * How an inbound message arrived. Kept apart from the role because it describes
 * the transport — a voice note and a typed sentence are the same words to the
 * manager and different work to the bot.
 */
export const CHAT_INTAKE_KINDS = [
  "text",
  "voice",
  "forward",
  "compose",
  "command",
  "callback",
  "api",
] as const;

/**
 * How a user message reached us. `api` is anything that came over HTTP rather
 * than through Telegram. `compose` is several messages the sender batched and
 * released as one — the row holds all of them, with the attribution the
 * per-message columns cannot carry written into the body.
 */
export const ChatIntakeKind = Schema.Literals(CHAT_INTAKE_KINDS);
export type ChatIntakeKind = typeof ChatIntakeKind.Type;

// What the bot volunteers without being asked is in `./notify`: the kinds come
// in two families now, and the rule that tells them apart belongs beside them.

/** Nested inside a run, deepest first: the global folder is the one a worker may not write. */
export const ARTIFACT_SCOPES = ["task", "project", "global"] as const;

/** Which folder an artifact lives in, and therefore who may write it. */
export const ArtifactScope = Schema.Literals(ARTIFACT_SCOPES);
export type ArtifactScope = typeof ArtifactScope.Type;

/** `promote` is queryable on its own, because promotion is a deliberate verb rather than an update. */
export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "transition",
  "promote",
] as const;

/** What an audited mutation did. */
export const AuditAction = Schema.Literals(AUDIT_ACTIONS);
export type AuditAction = typeof AuditAction.Type;

/**
 * The aggregates a repository can mutate, and therefore the ones an audit row
 * can name.
 *
 * These are table names, which is why `comment` is still here: a task message
 * lives in the `comment` table, and every audit row already written names it
 * that way. Renaming the literal would make history fail to decode and buy
 * nothing — see {@link TaskMessage}.
 */
export const AUDIT_ENTITY_TYPES = [
  "project",
  "project_env_file",
  "task",
  "comment",
  "agent_session",
  "run",
  "artifact",
  "proposal",
] as const;

/** What kind of thing an audit row is about. */
export const AuditEntityType = Schema.Literals(AUDIT_ENTITY_TYPES);
export type AuditEntityType = typeof AuditEntityType.Type;
