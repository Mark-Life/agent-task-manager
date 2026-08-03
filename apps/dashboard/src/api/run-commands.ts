import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { RunCommand } from "@workspace/api";
import type { RunId, TaskId } from "@workspace/domain";
import { settleTask } from "@/api/board-cache";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type CommandClient = ApiClientShape["runCommands"];
type StartSession = Parameters<CommandClient["startSession"]>[0]["payload"];

/** Where a task's intents are cached. Their own key: they outlive the run they aimed at. */
const commandsKey = (taskId: TaskId) =>
  [...keys.task(taskId), "commands"] as const;

/**
 * Which attempt an intent is aimed at. Leaving the run out means whichever one
 * is live, which is what a Stop button means; naming one is for the caller that
 * has a run in hand and wants to be sure it is still that one.
 */
export interface RunTarget {
  readonly runId?: RunId;
  readonly taskId: TaskId;
}

/** Asking for a session without moving the task, and what to blame it on. */
export interface SessionStart {
  readonly taskId: TaskId;
  readonly trigger: StartSession["trigger"];
}

/**
 * Whether the orchestrator refused an intent.
 *
 * A refusal is a value on the row rather than an HTTP failure: "no live run" and
 * "task not in progress" are answers the asker is entitled to read, not errors,
 * and rendering them as a failed request would say the dashboard is broken when
 * it is working exactly as intended.
 */
export const refusalOf = (command: RunCommand) => command.rejectedReason;

/** Whether an intent is still waiting for the orchestrator to claim it. */
export const isPending = (command: RunCommand) => command.status === "pending";

/**
 * Every intervention on a task, newest first, refused ones included.
 *
 * Worth reading beside the run list because a rejection lands here and nowhere
 * else — the row that answered a Stop was pending when it came back, and the
 * reason it was refused appears on this list a moment later.
 */
export const commandsQuery = (taskId: TaskId) =>
  apiQuery(commandsKey(taskId), (client) =>
    client.runCommands.list({ params: { taskId } })
  );

/**
 * What an intent can have changed by the time it returns: the intent list, the
 * task's runs, and the task itself, whose live run is the thing a Stop is about
 * to end. The orchestrator acts afterwards, so these are read again on the next
 * poll rather than being final here.
 */
const settleCommand = (queryClient: QueryClient, taskId: TaskId) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: commandsKey(taskId) }),
    queryClient.invalidateQueries({ queryKey: keys.runs(taskId) }),
    settleTask(queryClient, taskId),
  ]);

/** The payload both stop and rerun take: a run, or nothing for the live one. */
const targetPayload = (target: RunTarget) =>
  target.runId === undefined ? {} : { runId: target.runId };

/**
 * Kill the container working on a task.
 *
 * Nothing here touches a container: the row is the request and the orchestrator
 * acts on it, so the answer is a queued intent rather than a stopped run. A
 * second Stop while the first is pending returns the row already queued instead
 * of writing a duplicate.
 */
export const useStopRun = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((target: RunTarget, client) =>
      client.runCommands.stop({
        params: { taskId: target.taskId },
        payload: targetPayload(target),
      })
    ),
    onSuccess: (_command, target) => settleCommand(queryClient, target.taskId),
  });
};

/**
 * Resume the task's session with everything said since as its next prompt. Not
 * a way into the status machine — a rerun on a task that is not in progress is
 * refused, which arrives as a reason on the row.
 */
export const useRerunTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((target: RunTarget, client) =>
      client.runCommands.rerun({
        params: { taskId: target.taskId },
        payload: targetPayload(target),
      })
    ),
    onSuccess: (_command, target) => settleCommand(queryClient, target.taskId),
  });
};

/**
 * Spawn a session without moving the task, which is how research from the
 * backlog happens. Run creation stays the orchestrator's; this asks for one.
 */
export const useStartSession = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((start: SessionStart, client) =>
      client.runCommands.startSession({
        params: { taskId: start.taskId },
        payload: { trigger: start.trigger },
      })
    ),
    onSuccess: (_command, start) => settleCommand(queryClient, start.taskId),
  });
};
