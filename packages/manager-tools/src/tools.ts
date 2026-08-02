/**
 * The board, as the fourteen things the manager can do to it.
 *
 * One tool per gateway operation, and no tool that is not one. The manager has
 * no database handle and no container: everything it changes, it changes over
 * the same HTTP contract a dashboard would use, with a short-lived token that
 * cannot reach the deletes. So this list is the whole of the manager's power,
 * and reading it is how a person finds out what a chat can do.
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
  CommentAppend,
  ProjectCreate,
  TaskCreate,
  TaskPatch,
  TaskTransition,
} from "@workspace/api";
import {
  ArtifactId,
  ProjectId,
  RunId,
  TaskId,
  TaskStatus,
} from "@workspace/domain";
import { Effect, Schema, Stream } from "effect";
import { defineTool, type ManagerTool } from "./tool";

/** The most rows a board listing returns when the caller names no limit. */
const DEFAULT_TASK_LIMIT = 50;

/** The most rows one listing may return, whatever was asked for. */
const MAX_TASK_LIMIT = 200;

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

/** The task's whole thread, oldest first — the order it is read in. */
const commentsList = defineTool({
  description: "Read a task's comment thread, oldest first.",
  endpoint: "GET /tasks/:taskId/comments",
  input: TaskRef,
  name: "comments_list",
  run: ({ client, input }) => client.comments.list({ params: input }),
});

/**
 * Say something on the task. The author is not a field: it comes off the
 * credential, so the comment is attributed to the manager and the chat thread
 * behind it whatever the body says.
 */
const commentsAdd = defineTool({
  description:
    "Post a comment on a task. This is how the next session on that task finds out what was decided in chat.",
  endpoint: "POST /tasks/:taskId/comments",
  input: Schema.Struct({ body: CommentAppend.fields.body, taskId: TaskId }),
  name: "comments_add",
  run: ({ client, input }) =>
    client.comments.append({
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

/** The index of what the task's runs kept — metadata only, never the bytes. */
const artifactsList = defineTool({
  description:
    "List a task's artifacts, most recently written first. Metadata only; use `artifacts_read` for the contents.",
  endpoint: "GET /tasks/:taskId/artifacts",
  input: TaskRef,
  name: "artifacts_list",
  run: ({ client, input }) => client.artifacts.list({ params: input }),
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

/** Text as much of it as was asked for, saying so when there was more. */
const clip = (text: string, maxChars: number) =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}${CLIPPED_SUFFIX}`;

/**
 * Every tool the manager holds, in the order a reader should meet them:
 * projects, then the board, then the conversation, then the runs, then what
 * they left behind.
 */
export const MANAGER_TOOLS: readonly ManagerTool[] = [
  projectsList,
  projectsCreate,
  tasksList,
  tasksGet,
  tasksCreate,
  tasksEdit,
  tasksMove,
  commentsList,
  commentsAdd,
  runsStatus,
  runsStop,
  runsRerun,
  artifactsList,
  artifactsRead,
];

/** One tool by the name an MCP client calls it by. */
export const managerToolByName = (name: string) =>
  MANAGER_TOOLS.find((tool) => tool.name === name);
