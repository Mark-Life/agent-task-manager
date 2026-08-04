import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ProjectId, TaskId, TaskStatus } from "@workspace/domain";
import {
  applyBoardMove,
  type BoardMove,
  type BoardSnapshot,
  boardsKey,
  restoreBoards,
  settleTask,
} from "@/api/board-cache";
import { keys } from "@/api/keys";
import { apiMutation, apiQuery } from "@/api/query";
import type { ApiClientShape } from "@/api/runtime";

type TaskClient = ApiClientShape["tasks"];

/** The list filters, taken from the call itself so they cannot drift from it. */
type TaskFilters = Parameters<TaskClient["list"]>[0]["query"];
type TaskCreate = Parameters<TaskClient["create"]>[0]["payload"];
type TaskPatch = Parameters<TaskClient["patch"]>[0]["payload"];
type NextSessionRequest = Parameters<TaskClient["selectNextSession"]>[0];
type NextSession = NextSessionRequest["payload"];

/** A card crossing into another column. */
export interface TaskMove extends BoardMove {
  readonly to: TaskStatus;
}

/**
 * A card moving inside its own column, which is also the dispatch queue. The
 * rank to land below is required here — the endpoint has no "bottom" case, so a
 * drop at the end names the last card's rank.
 */
export interface TaskReorder extends BoardMove {
  readonly after: number | null;
}

/** Editing one task: what to change, and which one. */
export interface TaskEdit {
  readonly patch: TaskPatch;
  readonly taskId: TaskId;
}

/** Choosing the session the next run uses. */
export interface NextSessionChoice {
  readonly next: NextSession;
  readonly taskId: TaskId;
}

/**
 * The whole board in one read, optionally narrowed to a project.
 *
 * Every column comes back including the empty ones, in the order they are
 * drawn, so the screen never has to invent a column that no card is in. The
 * project filter is part of the key: two filters are two boards, and a move
 * writes to both.
 */
export const boardQuery = (projectId: ProjectId | null = null) =>
  apiQuery(keys.board(projectId), (client) =>
    client.tasks.board({ query: projectId === null ? {} : { projectId } })
  );

/**
 * The flat list, filtered. Not a different source from the board — the server
 * answers it by flattening the same columns — so it is here for the screens
 * that want one sequence rather than five.
 */
export const tasksQuery = (filters: TaskFilters = {}) =>
  apiQuery(keys.tasks(filters), (client) =>
    client.tasks.list({ query: filters })
  );

/**
 * One task with its project and the run working on it right now.
 *
 * A null `liveRunId` on a task sitting in progress is a real state rather than
 * missing data: the task is waiting for a slot or has stalled, and the screen
 * draws that differently from a run in flight.
 */
export const taskQuery = (taskId: TaskId) =>
  apiQuery(keys.task(taskId), (client) =>
    client.tasks.get({ params: { taskId } })
  );

/**
 * `after` is passed through by presence, not by value: absent lands the card at
 * the bottom of the destination column and null puts it on top. Sending
 * `after: undefined` would be a third thing the server does not read, so the key
 * is dropped instead.
 */
const transitionPayload = (move: TaskMove) =>
  move.after === undefined
    ? { to: move.to }
    : { after: move.after, to: move.to };

/**
 * The selection is one tagged value, but the endpoint's request type is a union
 * of one request per case, and no object with a union in it satisfies a union of
 * objects. The assertion is the seam between those two spellings of the same
 * thing; the value itself is always exactly one of the cases.
 */
const nextSessionRequest = (choice: NextSessionChoice) =>
  ({
    params: { taskId: choice.taskId },
    payload: choice.next,
  }) as NextSessionRequest;

/** File a new task. The status it starts in is the status machine's to refuse. */
export const useCreateTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((payload: TaskCreate, client) =>
      client.tasks.create({ payload })
    ),
    onSuccess: (task) => settleTask(queryClient, task.id),
  });
};

/** Change what a task says. Never where it sits — that is the three below. */
export const usePatchTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((edit: TaskEdit, client) =>
      client.tasks.patch({
        params: { taskId: edit.taskId },
        payload: edit.patch,
      })
    ),
    onSuccess: (task) => settleTask(queryClient, task.id),
  });
};

/**
 * Move a card to another column, drawn before the request leaves.
 *
 * The status machine has already refused the illegal moves client-side, so the
 * optimistic write is the expected outcome rather than a guess; the rollback is
 * for the case where the server disagrees anyway, which is a task somebody else
 * moved first.
 */
export const useTransitionTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((move: TaskMove, client) =>
      client.tasks.transition({
        params: { taskId: move.taskId },
        payload: transitionPayload(move),
      })
    ),
    onError: (_error, _move, snapshot: BoardSnapshot | undefined) => {
      restoreBoards(queryClient, snapshot);
    },
    onMutate: async (move: TaskMove) => {
      await queryClient.cancelQueries({ queryKey: boardsKey });
      return applyBoardMove(queryClient, move);
    },
    onSettled: (_task, _error, move) => settleTask(queryClient, move.taskId),
  });
};

/**
 * Reorder within a column, which is the same write as changing what runs next:
 * the orchestrator spends its next slot on the top of *in progress*.
 */
export const usePlaceTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((move: TaskReorder, client) =>
      client.tasks.place({
        params: { taskId: move.taskId },
        payload: { after: move.after },
      })
    ),
    onError: (_error, _move, snapshot: BoardSnapshot | undefined) => {
      restoreBoards(queryClient, snapshot);
    },
    onMutate: async (move: TaskReorder) => {
      await queryClient.cancelQueries({ queryKey: boardsKey });
      return applyBoardMove(queryClient, move);
    },
    onSettled: (_task, _error, move) => settleTask(queryClient, move.taskId),
  });
};

/**
 * Pin what the next run on this task does. The orchestrator honours it once and
 * puts it back to the default, so a selection is spent by the run it chose and
 * the answer is re-read from the task rather than remembered by the screen.
 */
export const useSelectNextSession = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((choice: NextSessionChoice, client) =>
      client.tasks.selectNextSession(nextSessionRequest(choice))
    ),
    onSuccess: (task) => settleTask(queryClient, task.id),
  });
};

/**
 * Remove a task. Its comments, sessions, runs and artifacts go with it, so the
 * whole subtree under the task's key is dropped rather than refetched — there is
 * nothing left on the server to answer with.
 */
export const useDeleteTask = () => {
  const queryClient = useQueryClient();
  return useMutation({
    ...apiMutation((taskId: TaskId, client) =>
      client.tasks.delete({ params: { taskId } })
    ),
    onSuccess: async (_deleted, taskId) => {
      queryClient.removeQueries({ queryKey: keys.task(taskId) });
      await settleTask(queryClient, taskId);
    },
  });
};
