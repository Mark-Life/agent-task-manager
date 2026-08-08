import { defineRelationsPart } from "drizzle-orm";
import { agentSession } from "./agent-session";
import { artifact } from "./artifact";
import { auditEntry } from "./audit";
import {
  account,
  apikey,
  authRelations,
  invitation,
  member,
  organization,
  session,
  user,
  verification,
} from "./auth";
import { chatMessage, chatNotification, chatThread } from "./chat";
import { comment } from "./comment";
import { project } from "./project";
import { proposal } from "./proposal";
import { run, runCommand, runEvent } from "./run";
import { task } from "./task";

/**
 * The eight tables the auth library owns and regenerates. `apikey` has no
 * relation of its own — its `reference_id` is a user id here but the plugin
 * declares no foreign key, because the same column holds an organization id
 * under a different configuration. It is listed anyway for the reason the
 * bare part below exists: a table missing from this object has no `db.query`
 * entry, and the adapter cannot read a model it cannot address.
 */
const authTables = {
  account,
  apikey,
  invitation,
  member,
  organization,
  session,
  user,
  verification,
};

/**
 * Every table in the database, ours and the auth library's, in one record — the
 * relation builder can only reach a table it was handed, and our rows point at
 * `organization` as their workspace.
 */
const tables = {
  ...authTables,
  agentSession,
  artifact,
  auditEntry,
  chatMessage,
  chatNotification,
  chatThread,
  comment,
  project,
  proposal,
  run,
  runCommand,
  runEvent,
  task,
};

/**
 * Relations for the tables we own. Every one names its `from` and `to` columns
 * explicitly rather than leaning on a reverse lookup, which is what lets this
 * part and the generated auth part be built separately and merged.
 */
const appRelations = defineRelationsPart(tables, (r) => ({
  agentSession: {
    comments: r.many.comment({
      from: r.agentSession.id,
      to: r.comment.agentSessionId,
    }),
    runs: r.many.run({ from: r.agentSession.id, to: r.run.agentSessionId }),
    task: r.one.task({
      from: r.agentSession.taskId,
      optional: false,
      to: r.task.id,
    }),
    workspace: r.one.organization({
      from: r.agentSession.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  artifact: {
    copies: r.many.artifact({
      alias: "artifactCopy",
      from: r.artifact.id,
      to: r.artifact.sourceArtifactId,
    }),
    lastRun: r.one.run({ from: r.artifact.lastRunId, to: r.run.id }),
    project: r.one.project({
      from: r.artifact.projectId,
      to: r.project.id,
    }),
    source: r.one.artifact({
      alias: "artifactCopy",
      from: r.artifact.sourceArtifactId,
      to: r.artifact.id,
    }),
    task: r.one.task({ from: r.artifact.taskId, to: r.task.id }),
    workspace: r.one.organization({
      from: r.artifact.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  auditEntry: {
    // Joined on a denormalized column with no foreign key behind it: the log
    // outlives the task, so this side can legitimately find nothing.
    task: r.one.task({ from: r.auditEntry.taskId, to: r.task.id }),
    workspace: r.one.organization({
      from: r.auditEntry.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  chatMessage: {
    thread: r.one.chatThread({
      from: r.chatMessage.threadId,
      optional: false,
      to: r.chatThread.id,
    }),
    workspace: r.one.organization({
      from: r.chatMessage.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  chatNotification: {
    // Joined on denormalized columns with no foreign key behind them: the send
    // ledger outlives the run it announced, so both sides can find nothing.
    run: r.one.run({ from: r.chatNotification.runId, to: r.run.id }),
    task: r.one.task({ from: r.chatNotification.taskId, to: r.task.id }),
    thread: r.one.chatThread({
      from: r.chatNotification.threadId,
      to: r.chatThread.id,
    }),
    workspace: r.one.organization({
      from: r.chatNotification.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  chatThread: {
    messages: r.many.chatMessage({
      from: r.chatThread.id,
      to: r.chatMessage.threadId,
    }),
    notifications: r.many.chatNotification({
      from: r.chatThread.id,
      to: r.chatNotification.threadId,
    }),
    workspace: r.one.organization({
      from: r.chatThread.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  comment: {
    run: r.one.run({ from: r.comment.runId, to: r.run.id }),
    session: r.one.agentSession({
      from: r.comment.agentSessionId,
      to: r.agentSession.id,
    }),
    task: r.one.task({
      from: r.comment.taskId,
      optional: false,
      to: r.task.id,
    }),
    workspace: r.one.organization({
      from: r.comment.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  project: {
    artifacts: r.many.artifact({
      from: r.project.id,
      to: r.artifact.projectId,
    }),
    proposals: r.many.proposal({
      from: r.project.id,
      to: r.proposal.projectId,
    }),
    tasks: r.many.task({ from: r.project.id, to: r.task.projectId }),
    workspace: r.one.organization({
      from: r.project.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  proposal: {
    // Optional on both: a proposal into the workspace scope names no project,
    // and the run that raised it can be erased while the request still waits.
    project: r.one.project({ from: r.proposal.projectId, to: r.project.id }),
    run: r.one.run({ from: r.proposal.runId, to: r.run.id }),
    task: r.one.task({
      from: r.proposal.taskId,
      optional: false,
      to: r.task.id,
    }),
    workspace: r.one.organization({
      from: r.proposal.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  run: {
    artifacts: r.many.artifact({ from: r.run.id, to: r.artifact.lastRunId }),
    commands: r.many.runCommand({ from: r.run.id, to: r.runCommand.runId }),
    comments: r.many.comment({ from: r.run.id, to: r.comment.runId }),
    events: r.many.runEvent({ from: r.run.id, to: r.runEvent.runId }),
    proposals: r.many.proposal({ from: r.run.id, to: r.proposal.runId }),
    session: r.one.agentSession({
      from: r.run.agentSessionId,
      optional: false,
      to: r.agentSession.id,
    }),
    task: r.one.task({ from: r.run.taskId, optional: false, to: r.task.id }),
    workspace: r.one.organization({
      from: r.run.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  runCommand: {
    run: r.one.run({ from: r.runCommand.runId, to: r.run.id }),
    task: r.one.task({
      from: r.runCommand.taskId,
      optional: false,
      to: r.task.id,
    }),
    workspace: r.one.organization({
      from: r.runCommand.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  runEvent: {
    run: r.one.run({ from: r.runEvent.runId, optional: false, to: r.run.id }),
    task: r.one.task({
      from: r.runEvent.taskId,
      optional: false,
      to: r.task.id,
    }),
    workspace: r.one.organization({
      from: r.runEvent.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
  task: {
    artifacts: r.many.artifact({ from: r.task.id, to: r.artifact.taskId }),
    commands: r.many.runCommand({ from: r.task.id, to: r.runCommand.taskId }),
    comments: r.many.comment({ from: r.task.id, to: r.comment.taskId }),
    events: r.many.runEvent({ from: r.task.id, to: r.runEvent.taskId }),
    // Which session runs next, when the task names a specific one.
    nextSession: r.one.agentSession({
      alias: "taskNextSession",
      from: r.task.nextSessionId,
      to: r.agentSession.id,
    }),
    parentTask: r.one.task({
      alias: "taskSubtask",
      from: r.task.parentTaskId,
      to: r.task.id,
    }),
    project: r.one.project({ from: r.task.projectId, to: r.project.id }),
    proposals: r.many.proposal({ from: r.task.id, to: r.proposal.taskId }),
    runs: r.many.run({ from: r.task.id, to: r.run.taskId }),
    sessions: r.many.agentSession({
      from: r.task.id,
      to: r.agentSession.taskId,
    }),
    subtasks: r.many.task({
      alias: "taskSubtask",
      from: r.task.id,
      to: r.task.parentTaskId,
    }),
    workspace: r.one.organization({
      from: r.task.workspaceId,
      optional: false,
      to: r.organization.id,
    }),
  },
}));

/**
 * The relational config both drizzle handles are built with — ours through
 * Effect, the auth library's over the same pool with its promise API. Three
 * parts spread into one object, later keys winning: the generated auth part is
 * regenerated by its CLI and must stay untouched, and every relation on every
 * side names its columns explicitly, so no part needs another to resolve.
 *
 * The bare part comes first because the generator emits an entry only for a
 * table that has a relation, and a table missing from this object has no
 * `db.query` entry at all — which is how the auth library reads `verification`.
 */
export const relations = {
  ...defineRelationsPart(authTables),
  ...authRelations,
  ...appRelations,
};
