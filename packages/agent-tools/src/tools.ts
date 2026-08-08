/**
 * The board, as the nineteen things an agent can do to it.
 *
 * One tool per gateway operation, and no tool that is not one. An agent has no
 * database handle and no container: everything it changes, it changes over the
 * same HTTP contract a dashboard would use, with a short-lived token. So this
 * list is the whole of an agent's power, and reading it is how a person finds
 * out what a run or a chat can do.
 *
 * One list for both roles, deliberately. What a worker may reach is narrower
 * than what a manager may reach because its credential is bound to one task,
 * not because it was handed fewer tools — a binding is checked on every write
 * and a second tool table would be a second place for that rule to drift.
 * {@link tasksDelete} is the one place that stops being enough: a worker's token
 * is good for writes on its own task, so who may erase a task is answered past
 * the binding, on the actor, and a worker calling this gets `IllegalDeletion`.
 *
 * Inputs are the API's own request schemas wherever one exists, picked off the
 * contract rather than restated, so a field the board calls optional is optional
 * here by construction. Outputs are the endpoint's success value as JSON, with
 * two deliberate exceptions: a task list is clipped to `limit` because a chat
 * turn cannot spend a whole context window on a board, and an artifact's bytes
 * are clipped to `maxChars` for the same reason.
 *
 * A refused run command comes back as an ordinary result carrying its
 * `rejectedReason`, not as an error — "you cannot rerun a task that is not in
 * progress" is a sentence the manager should relay, and an error there would
 * make it a silence.
 */

import {
  ProjectCreate,
  TaskCreate,
  TaskMessagePost,
  TaskPatch,
  TaskTransition,
} from "@workspace/api";
import {
  ArtifactId,
  ProjectId,
  RunId,
  TaskId,
  TaskStatus,
  ThreadId,
  ThreadStatus,
} from "@workspace/domain";
import { Effect, Schema, Stream } from "effect";
import { type AgentTool, defineTool } from "./tool";

/** The most rows a board listing returns when the caller names no limit. */
const DEFAULT_TASK_LIMIT = 50;

/** The most rows one listing may return, whatever was asked for. */
const MAX_TASK_LIMIT = 200;

/** The most conversations one listing may return, whatever was asked for. */
const MAX_THREAD_LIMIT = 100;

/** The most messages one page of a conversation may return. */
const MAX_MESSAGE_LIMIT = 500;

/** How much of an artifact one read returns when the caller names no size. */
const DEFAULT_ARTIFACT_CHARS = 8000;

/** The most an artifact read returns, whatever was asked for. */
const MAX_ARTIFACT_CHARS = 40_000;

/** How a clipped artifact says it was clipped, so the model does not read a truncation as the end of the file. */
const CLIPPED_SUFFIX = "\n…[clipped]";

/** A whole number of rows or characters, bounded so a tool cannot ask for a whole context window. */
const boundedCount = (maximum: number) =>
  Schema.Int.pipe(Schema.check(Schema.isBetween({ maximum, minimum: 1 })));

/** Only a task id, which is what most of the task-nested operations take. */
const TaskRef = Schema.Struct({ taskId: TaskId });

/** Only a thread id, which is what the conversation reads take. */
const ThreadRef = Schema.Struct({ threadId: ThreadId });

/** A task, and optionally which of its runs — absent means whichever is live. */
const RunRef = Schema.Struct({
  runId: Schema.optionalKey(RunId),
  taskId: TaskId,
});

/** Everything in the workspace a task can belong to. */
const projectsList = defineTool({
  description: "List the projects in this workspace.",
  endpoint: "GET /projects",
  input: Schema.Struct({}),
  name: "projects_list",
  run: ({ client }) => client.projects.list({}),
});

/** File a project. Only the name is required; a project with no repository is ordinary. */
const projectsCreate = defineTool({
  description:
    "Create a project. Only `name` is required; a project with no repository is an ordinary project.",
  endpoint: "POST /projects",
  input: ProjectCreate,
  name: "projects_create",
  run: ({ client, input }) => client.projects.create({ payload: input }),
});

/**
 * The board as a flat list, filtered and clipped. The clip is applied here
 * rather than sent to the gateway because the contract has no limit on this
 * endpoint — the board is small and the dashboard wants all of it.
 */
const tasksList = defineTool({
  description:
    "List tasks, optionally filtered by status or project. Returns at most `limit` rows, newest column order first.",
  endpoint: "GET /tasks",
  input: Schema.Struct({
    limit: Schema.optionalKey(boundedCount(MAX_TASK_LIMIT)),
    projectId: Schema.optionalKey(ProjectId),
    status: Schema.optionalKey(TaskStatus),
  }),
  name: "tasks_list",
  run: ({ client, input }) =>
    client.tasks
      .list({
        query: {
          ...(input.projectId === undefined
            ? {}
            : { projectId: input.projectId }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
      })
      .pipe(
        Effect.map((tasks) => tasks.slice(0, input.limit ?? DEFAULT_TASK_LIMIT))
      ),
});

/** One task, its project, and the run working on it right now if there is one. */
const tasksGet = defineTool({
  description:
    "Get one task with its project and the id of the run working on it right now, if any.",
  endpoint: "GET /tasks/:taskId",
  input: TaskRef,
  name: "tasks_get",
  run: ({ client, input }) => client.tasks.get({ params: input }),
});

/**
 * File a task. The rules the manager works under say `backlog`, and the status
 * machine is what actually decides — a column this actor may not reach comes
 * back as a refusal naming both.
 */
const tasksCreate = defineTool({
  description:
    "Create a task. File new work into `backlog` and let a person move it; `status` is checked against the status machine for this actor.",
  endpoint: "POST /tasks",
  input: TaskCreate,
  name: "tasks_create",
  run: ({ client, input }) => client.tasks.create({ payload: input }),
});

/** Change what a task says. Not where it sits — that is {@link tasksMove}. */
const tasksEdit = defineTool({
  description:
    "Edit a task's fields. Cannot change its status: use `tasks_move` for that.",
  endpoint: "PATCH /tasks/:taskId",
  input: Schema.Struct({ ...TaskPatch.fields, taskId: TaskId }),
  name: "tasks_edit",
  run: ({ client, input }) => {
    const { taskId, ...patch } = input;
    return client.tasks.patch({ params: { taskId }, payload: patch });
  },
});

/**
 * Move a card, and re-prioritize with the same call: `after` is the rank of the
 * card this one lands below, and `null` is the top of the destination column —
 * which is also the top of the dispatch queue when the destination is
 * `in_progress`.
 */
const tasksMove = defineTool({
  description:
    "Move a task to another status. `after` is the rank of the card it lands below; `null` puts it at the top of the column, which for `in_progress` is the front of the run queue.",
  endpoint: "POST /tasks/:taskId/status",
  input: Schema.Struct({ ...TaskTransition.fields, taskId: TaskId }),
  name: "tasks_move",
  run: ({ client, input }) => {
    const { taskId, ...transition } = input;
    return client.tasks.transition({
      params: { taskId },
      payload: transition,
    });
  },
});

/**
 * Take a card off the board for good.
 *
 * The one tool here that destroys something, and the description says what goes
 * with it because a model asked to "clear these out" should be able to tell the
 * person what they are about to lose. The rules say to confirm first; the
 * gateway does not, which is the honest division — a confirmation is a property
 * of the conversation, and there is nobody to ask inside an HTTP call.
 */
const tasksDelete = defineTool({
  description:
    "Delete a task. Its messages, sessions, runs and artifacts go with it and there is no undo, so confirm with the person before calling this.",
  endpoint: "DELETE /tasks/:taskId",
  input: TaskRef,
  name: "tasks_delete",
  run: ({ client, input }) =>
    client.tasks
      .delete({ params: input })
      .pipe(Effect.as({ deleted: true, taskId: input.taskId })),
});

/**
 * The task's whole thread, oldest first — the order it is read in.
 *
 * The description names the task, not just the thread, because the other
 * conversation an agent can read is `threads_messages` and the two are
 * different things: this one belongs to a card and outlives every session on
 * it, that one is a chat with a person.
 */
const messagesList = defineTool({
  description:
    "Read a task's message thread, oldest first. Every session on the task speaks here, so this is what a previous run left for you.",
  endpoint: "GET /tasks/:taskId/messages",
  input: TaskRef,
  name: "messages_list",
  run: ({ client, input }) => client.messages.list({ params: input }),
});

/**
 * Say something on the task. The author is not a field: it comes off the
 * credential, so the message is attributed to the manager and the chat thread
 * behind it whatever the body says.
 */
const messagesPost = defineTool({
  description:
    "Post a message on a task. This is how the next session on that task finds out what was decided.",
  endpoint: "POST /tasks/:taskId/messages",
  input: Schema.Struct({ body: TaskMessagePost.fields.body, taskId: TaskId }),
  name: "messages_post",
  run: ({ client, input }) =>
    client.messages.post({
      params: { taskId: input.taskId },
      payload: { body: input.body },
    }),
});

/** One run, or every run on the task newest first when none is named. */
const runsStatus = defineTool({
  description:
    "Get one run when `runId` is given, otherwise every run on the task, newest first.",
  endpoint: "GET /tasks/:taskId/runs[/:runId]",
  input: RunRef,
  name: "runs_status",
  run: ({ client, input }) =>
    input.runId === undefined
      ? client.runs.list({ params: { taskId: input.taskId } })
      : client.runs.get({
          params: { runId: input.runId, taskId: input.taskId },
        }),
});

/**
 * Ask the orchestrator to kill the container. Nothing here touches one: the
 * answer is the queued intent, and a refusal arrives on it as `rejectedReason`.
 */
const runsStop = defineTool({
  description:
    "Queue a stop for a task's run. Returns the queued command; if it was refused, `rejectedReason` says why.",
  endpoint: "POST /tasks/:taskId/commands/stop",
  input: RunRef,
  name: "runs_stop",
  run: ({ client, input }) =>
    client.runCommands.stop({
      params: { taskId: input.taskId },
      payload: input.runId === undefined ? {} : { runId: input.runId },
    }),
});

/** Ask the orchestrator to resume the task's session with everything said since. */
const runsRerun = defineTool({
  description:
    "Queue a rerun for a task. Returns the queued command; if it was refused, `rejectedReason` says why.",
  endpoint: "POST /tasks/:taskId/commands/rerun",
  input: RunRef,
  name: "runs_rerun",
  run: ({ client, input }) =>
    client.runCommands.rerun({
      params: { taskId: input.taskId },
      payload: input.runId === undefined ? {} : { runId: input.runId },
    }),
});

/**
 * The index of one folder — metadata only, never the bytes.
 *
 * Two folders rather than one, because a task's own output and the material its
 * project keeps are different questions. A project's folder is what a research
 * task leaves a document in for the next task to build on, and a listing is how
 * that next task finds the document without being told its path.
 */
const artifactsList = defineTool({
  description:
    "List a task's files, or a project's shared folder when `projectId` is given instead of `taskId`. Most recently written first, metadata only; use `artifacts_read` for a task file's contents.",
  endpoint: "GET /tasks/:taskId/artifacts | GET /projects/:projectId/artifacts",
  input: Schema.Struct({
    projectId: Schema.optionalKey(ProjectId),
    taskId: Schema.optionalKey(TaskId),
  }),
  name: "artifacts_list",
  run: ({ client, input }) => {
    if (input.projectId !== undefined) {
      return client.artifacts.listProject({
        params: { projectId: input.projectId },
      });
    }
    return input.taskId === undefined
      ? // Neither folder named is a call with no subject, and a default of
        // either would list somebody's files because the argument was forgotten.
        Effect.fail("name a taskId or a projectId")
      : client.artifacts.list({ params: { taskId: input.taskId } });
  },
});

/**
 * The bytes, decoded as text and clipped.
 *
 * Clipped rather than paged: an agent that needs a whole large file needs a
 * task, not a chat turn, and a truncation that says so is more honest than a
 * cursor nobody follows.
 */
const artifactsRead = defineTool({
  description:
    "Read an artifact as text, clipped to `maxChars`. Binary files come back as whatever their bytes decode to.",
  endpoint: "GET /tasks/:taskId/artifacts/:artifactId/content",
  input: Schema.Struct({
    artifactId: ArtifactId,
    maxChars: Schema.optionalKey(boundedCount(MAX_ARTIFACT_CHARS)),
    taskId: TaskId,
  }),
  name: "artifacts_read",
  run: ({ client, input }) =>
    client.artifacts
      .read({
        params: { artifactId: input.artifactId, taskId: input.taskId },
      })
      .pipe(
        Effect.flatMap((bytes) => Stream.mkString(Stream.decodeText(bytes))),
        Effect.map((text) =>
          clip(text, input.maxChars ?? DEFAULT_ARTIFACT_CHARS)
        )
      ),
});

/** The workspace's conversations, most recently spoken in first. */
const threadsList = defineTool({
  description:
    "List the conversations in this workspace, most recently spoken in first. Archived ones are absent unless `status` asks for them.",
  endpoint: "GET /threads",
  input: Schema.Struct({
    limit: Schema.optionalKey(boundedCount(MAX_THREAD_LIMIT)),
    status: Schema.optionalKey(ThreadStatus),
  }),
  name: "threads_list",
  run: ({ client, input }) => client.threads.list({ query: input }),
});

/** One conversation, and the turn running on it when there is one. */
const threadsGet = defineTool({
  description:
    "Get one conversation by id, with the id of the turn running on it when one is.",
  endpoint: "GET /threads/:threadId",
  input: ThreadRef,
  name: "threads_get",
  run: ({ client, input }) => client.threads.get({ params: input }),
});

/**
 * What was said, oldest first. Clipped by `limit` for the reason a task list
 * is: a turn cannot spend its context window on a conversation it is not in.
 */
const threadsMessages = defineTool({
  description:
    "Read a page of a conversation, oldest first. This is how a run finds out what was decided in chat.",
  endpoint: "GET /threads/:threadId/messages",
  input: Schema.Struct({
    limit: Schema.optionalKey(boundedCount(MAX_MESSAGE_LIMIT)),
    threadId: ThreadId,
  }),
  name: "threads_messages",
  run: ({ client, input }) =>
    client.threads.messages({
      params: { threadId: input.threadId },
      query: input.limit === undefined ? {} : { limit: input.limit },
    }),
});

/** The conversation's turns, newest first — each one a run with a timeline. */
const threadsRuns = defineTool({
  description:
    "List a conversation's turns, newest first. Each is a run; read what it did through `runs_status`.",
  endpoint: "GET /threads/:threadId/runs",
  input: ThreadRef,
  name: "threads_runs",
  run: ({ client, input }) => client.threads.runs({ params: input }),
});

/** Text as much of it as was asked for, saying so when there was more. */
const clip = (text: string, maxChars: number) =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}${CLIPPED_SUFFIX}`;

/**
 * Every tool an agent holds, in the order a reader should meet them: projects,
 * then the board, then a task's message thread, then the runs, then what they
 * left behind, then the conversations with the manager.
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  projectsList,
  projectsCreate,
  tasksList,
  tasksGet,
  tasksCreate,
  tasksEdit,
  tasksMove,
  tasksDelete,
  messagesList,
  messagesPost,
  runsStatus,
  runsStop,
  runsRerun,
  artifactsList,
  artifactsRead,
  threadsList,
  threadsGet,
  threadsMessages,
  threadsRuns,
];

/** One tool by the name an MCP client calls it by. */
export const agentToolByName = (name: string) =>
  AGENT_TOOLS.find((tool) => tool.name === name);
