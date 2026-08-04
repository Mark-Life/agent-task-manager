/**
 * What a run is attached to, and the one key everything else names it by.
 *
 * A worker always has a task and a manager always has a conversation. Those are
 * not two independent facts: the role is the attachment. So this is a union
 * with the role as its discriminator rather than two nullable fields, and
 * `{role: "worker", thread}` is not a value anybody can construct.
 *
 * {@link RunAttachment} carries the whole entity because the stages that read it
 * need more than an id: the prompt wants the task's brief or the thread's
 * provider, the workspace is on both, and re-reading either row per stage is the
 * second lookup that eventually disagrees with the first.
 *
 * {@link subjectKeyOf} is the other half. Everywhere the system uses an id as
 * an identity rather than as a foreign key — a lease filename, a fiber map key, a
 * "have I already said this" set — it uses this key instead, so a taskless run
 * has a name at every one of those places. Foreign keys stay foreign keys:
 * `run.task_id` and `run.thread_id` are real columns, and `RunSubject` from the
 * domain is how a repository is told which of the two a caller means.
 */

import type {
  ChatThread,
  RunSubject,
  Task,
  TaskId,
  ThreadId,
} from "@workspace/domain";

/**
 * The two denormalized id columns every table that names a subject carries:
 * `run`, `run_event`, `run_command` and `agent_session` alike.
 */
interface SubjectColumns {
  readonly taskId: TaskId | null;
  readonly threadId: ThreadId | null;
}

/**
 * What a stored row is attached to, read back off its columns.
 *
 * Null is unreachable through the database — the `*_subject_ck` constraints
 * refuse a row with neither id — and it is still returned rather than asserted,
 * because the alternative is a cast that turns a corrupted row into a crash
 * somewhere that cannot say which row it was.
 */
export const subjectOfRow = (row: SubjectColumns): RunSubject | null => {
  if (row.taskId !== null) {
    return { id: row.taskId, kind: "task" };
  }
  return row.threadId === null ? null : { id: row.threadId, kind: "thread" };
};

/** A run doing work on a task. */
export interface WorkerAttachment {
  readonly role: "worker";
  readonly task: Task;
}

/** A run answering in a conversation. */
export interface ManagerAttachment {
  readonly role: "manager";
  readonly thread: ChatThread;
}

/** What a run is attached to, which is also what role it is. */
export type RunAttachment = ManagerAttachment | WorkerAttachment;

/** A task, as the thing a run is attached to. */
export const workerAttachment = (task: Task): WorkerAttachment => ({
  role: "worker",
  task,
});

/** A conversation, as the thing a run is attached to. */
export const managerAttachment = (thread: ChatThread): ManagerAttachment => ({
  role: "manager",
  thread,
});

/** The id pair a repository is told to write, off the entity the loop is holding. */
export const subjectOfAttachment = (attached: RunAttachment): RunSubject =>
  attached.role === "worker"
    ? { id: attached.task.id, kind: "task" }
    : { id: attached.thread.id, kind: "thread" };

/** The workspace every row this run writes is scoped to. Both entities carry it. */
export const workspaceIdOfAttachment = (attached: RunAttachment) =>
  attached.role === "worker"
    ? attached.task.workspaceId
    : attached.thread.workspaceId;

/** The task, or null on a manager run — which callers have to handle. */
export const taskIdOfAttachment = (attached: RunAttachment) =>
  attached.role === "worker" ? attached.task.id : null;

/** The conversation, or null on a worker run. */
export const threadIdOfAttachment = (attached: RunAttachment) =>
  attached.role === "manager" ? attached.thread.id : null;

/**
 * `task:<uuid>` or `thread:<uuid>`. A map key, a log line and — with the colon
 * swapped for a dash — a filename. One spelling, so the in-process guard, the
 * lease file and the quota gate's "already announced" set all agree about which
 * two runs are the same piece of work.
 */
export const subjectKeyOf = (subject: RunSubject) =>
  `${subject.kind}:${subject.id}` as const;

/**
 * The same key as a filename. A uuid is already a legal filename and so is
 * `task-<uuid>`; the colon is only avoided because a Windows path cannot hold
 * one and a lease directory is the kind of thing that gets copied about.
 */
export const subjectFileNameOf = (subject: RunSubject) =>
  `${subject.kind}-${subject.id}`;
