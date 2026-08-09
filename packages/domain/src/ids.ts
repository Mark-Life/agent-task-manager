import { Schema } from "effect";
import { uuidv7 } from "uuidv7";

/**
 * The shape of every id our own tables hold. Version-agnostic on purpose: time
 * ordering is a guarantee of the mint site below, not of the string, and a
 * version-7-only check would reject a hand-written seed row while buying
 * nothing back.
 */
export const Uuid = Schema.String.pipe(Schema.check(Schema.isUUID()));

/**
 * An id we do not mint: Better Auth writes `user.id` and `organization.id` as
 * opaque text, which is why every reference to them is a `text` column and
 * never a `uuid` one. The length is Better Auth's setting, not ours, so only
 * emptiness is rejected.
 */
const externalId = <const B extends string>(brand: B) =>
  Schema.NonEmptyString.pipe(Schema.brand(brand));

/** An id of ours: a uuid, branded so one entity's id cannot stand in for another's. */
const ownId = <const B extends string>(brand: B) =>
  Uuid.pipe(Schema.brand(brand));

/**
 * Mints a fresh id for one entity type. uuidv7 is time-ordered, so an id sorts
 * by creation and doubles as the tiebreaker on `created_at` — which is why ids
 * are minted here and not defaulted by the database, whose Postgres 17.6 has no
 * `uuidv7()` of its own.
 */
const mint =
  <Id extends string>(schema: { readonly make: (input: string) => Id }) =>
  () =>
    schema.make(uuidv7());

/** The workspace a row belongs to. Better Auth's `organization.id`; there is no workspace table of ours. */
export const WorkspaceId = externalId("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

/** A human. Attribution only — no foreign key, because history outlives accounts. */
export const UserId = externalId("UserId");
export type UserId = typeof UserId.Type;

/** A project: a repo, or an area of life with no repo at all. */
export const ProjectId = ownId("ProjectId");
export type ProjectId = typeof ProjectId.Type;

/** Mints a fresh {@link ProjectId}. */
export const newProjectId = mint(ProjectId);

/** One environment file a project hands to every run that works in its repo. */
export const ProjectEnvFileId = ownId("ProjectEnvFileId");
export type ProjectEnvFileId = typeof ProjectEnvFileId.Type;

/** Mints a fresh {@link ProjectEnvFileId}. */
export const newProjectEnvFileId = mint(ProjectEnvFileId);

/** A task: the unit a run is spent on. */
export const TaskId = ownId("TaskId");
export type TaskId = typeof TaskId.Type;

/** Mints a fresh {@link TaskId}. */
export const newTaskId = mint(TaskId);

/** One message in a task's conversation. */
export const TaskMessageId = ownId("TaskMessageId");
export type TaskMessageId = typeof TaskMessageId.Type;

/** Mints a fresh {@link TaskMessageId}. */
export const newTaskMessageId = mint(TaskMessageId);

/**
 * One agent conversation on a task. Named `AgentSession` throughout, because
 * Better Auth owns the word `session` for a browser login.
 */
export const AgentSessionId = ownId("AgentSessionId");
export type AgentSessionId = typeof AgentSessionId.Type;

/** Mints a fresh {@link AgentSessionId}. */
export const newAgentSessionId = mint(AgentSessionId);

/** One attempt at a task, inside one session. */
export const RunId = ownId("RunId");
export type RunId = typeof RunId.Type;

/** Mints a fresh {@link RunId}. */
export const newRunId = mint(RunId);

/** One appended line of a run's normalized event stream. */
export const RunEventId = ownId("RunEventId");
export type RunEventId = typeof RunEventId.Type;

/** Mints a fresh {@link RunEventId}. */
export const newRunEventId = mint(RunEventId);

/** One stop / rerun / start-session intent awaiting the orchestrator. */
export const RunCommandId = ownId("RunCommandId");
export type RunCommandId = typeof RunCommandId.Type;

/** Mints a fresh {@link RunCommandId}. */
export const newRunCommandId = mint(RunCommandId);

/** One change a run asked a person to make to a directory it could not write. */
export const ProposalId = ownId("ProposalId");
export type ProposalId = typeof ProposalId.Type;

/** Mints a fresh {@link ProposalId}. */
export const newProposalId = mint(ProposalId);

/** One file kept from a run, indexed here and stored on disk. */
export const ArtifactId = ownId("ArtifactId");
export type ArtifactId = typeof ArtifactId.Type;

/** Mints a fresh {@link ArtifactId}. */
export const newArtifactId = mint(ArtifactId);

/**
 * One conversation between a person and the manager agent, in one Telegram
 * chat. Named `Thread` because that is what the audit log's `actor_thread_id`
 * has always meant; a task's messages are a thread of a different kind and are
 * addressed by their task.
 */
export const ThreadId = ownId("ThreadId");
export type ThreadId = typeof ThreadId.Type;

/** Mints a fresh {@link ThreadId}. */
export const newThreadId = mint(ThreadId);

/** One message in a chat thread, in either direction. */
export const ChatMessageId = ownId("ChatMessageId");
export type ChatMessageId = typeof ChatMessageId.Type;

/** Mints a fresh {@link ChatMessageId}. */
export const newChatMessageId = mint(ChatMessageId);

/**
 * The row a session has read up to: a task message on a session attached to a
 * task, a `chat_message` on one attached to a thread. A brand of its own rather
 * than either of those, because the column is a position and deliberately
 * carries no foreign key — typing it as one of the two would claim it always
 * points at that table.
 */
export const UnreadWatermarkId = ownId("UnreadWatermarkId");
export type UnreadWatermarkId = typeof UnreadWatermarkId.Type;

/** One claim to deliver one notice into one chat. */
export const ChatNotificationId = ownId("ChatNotificationId");
export type ChatNotificationId = typeof ChatNotificationId.Type;

/** Mints a fresh {@link ChatNotificationId}. */
export const newChatNotificationId = mint(ChatNotificationId);

/** One recorded mutation, naming who made it. */
export const AuditEntryId = ownId("AuditEntryId");
export type AuditEntryId = typeof AuditEntryId.Type;

/** Mints a fresh {@link AuditEntryId}. */
export const newAuditEntryId = mint(AuditEntryId);
