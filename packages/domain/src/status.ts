import { type ActorKind, TASK_STATUSES, type TaskStatus } from "./enums";

/** One legal move on the board, and who is allowed to make it. */
export interface TaskTransition {
  readonly actorKinds: readonly ActorKind[];
  readonly from: TaskStatus;
  readonly to: TaskStatus;
}

/**
 * The status machine, written down as data. Every writer — the dashboard, the
 * manager's tools, the orchestrator, a worker's task-scoped token — asks this
 * table, so the rules cannot fork into a second `if` somewhere. Anything absent
 * is illegal.
 *
 * Two rules fall out of the entries rather than being enforced separately:
 * nothing returns to `ideas` once work has started, and a worker run may only
 * end its own work — `in_progress → review` is the single move it has.
 *
 * The manager agent is trusted with every move a person has, including the ones
 * that spend a worker slot. It is a proxy for the person who is talking to it,
 * and a manager that can file a task but not start it just moves the same
 * request to a different button.
 *
 * Research spawned from `backlog` is deliberately not here: it is a
 * `start_session` command, not a status change.
 */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  // The idea survived.
  { actorKinds: ["human", "manager"], from: "ideas", to: "backlog" },
  // Skipping preparation spends a slot.
  { actorKinds: ["human", "manager"], from: "ideas", to: "in_progress" },
  // Demote.
  { actorKinds: ["human", "manager"], from: "backlog", to: "ideas" },
  // The dispatch trigger.
  { actorKinds: ["human", "manager"], from: "backlog", to: "in_progress" },
  // The run ended — cleanly, crashed, or gone without a terminal event. The
  // worker's only move, and the orchestrator's reconcile of a lost run.
  {
    actorKinds: ["human", "manager", "worker_run", "orchestrator"],
    from: "in_progress",
    to: "review",
  },
  // Pull back a stalled or wrongly started task.
  { actorKinds: ["human", "manager"], from: "in_progress", to: "backlog" },
  // Resume with the comments added since.
  { actorKinds: ["human", "manager"], from: "review", to: "in_progress" },
  // Not worth continuing now.
  { actorKinds: ["human", "manager"], from: "review", to: "backlog" },
  // Accept the work.
  { actorKinds: ["human", "manager"], from: "review", to: "done" },
  // Reopen.
  { actorKinds: ["human", "manager"], from: "done", to: "in_progress" },
  // Reopen without spending a slot.
  { actorKinds: ["human", "manager"], from: "done", to: "review" },
];

/** What a caller is asking permission for. */
interface TransitionRequest {
  readonly actorKind: ActorKind;
  readonly from: TaskStatus;
  readonly to: TaskStatus;
}

const matches = (transition: TaskTransition, request: TransitionRequest) =>
  transition.from === request.from &&
  transition.to === request.to &&
  transition.actorKinds.includes(request.actorKind);

/**
 * Whether this actor kind may make this move. The single gate every mutation
 * path runs through, so an illegal move is rejected identically whether it came
 * from a drag on the board, the manager, or an agent's token.
 */
export const canTransition = (request: TransitionRequest) =>
  TASK_TRANSITIONS.some((transition) => matches(transition, request));

/**
 * The statuses this actor kind may move a task to from here. Feeds the board's
 * drop targets and the manager's tool schema, so neither re-encodes the table
 * and drifts from it.
 */
export const nextStatuses = (request: Omit<TransitionRequest, "to">) =>
  TASK_TRANSITIONS.filter(
    (transition) =>
      transition.from === request.from &&
      transition.actorKinds.includes(request.actorKind)
  ).map((transition) => transition.to);

/**
 * The actor kinds that may file a task into any column. A person dragging a
 * card is what the board is for, and `system` is the seed script, which has to
 * be able to lay down a fixture in every column at once.
 */
const UNBOUNDED_CREATORS: readonly ActorKind[] = ["human", "system"];

/**
 * Where this actor kind may file a *new* task.
 *
 * Creation has no `from`, so the table above cannot answer it directly — and
 * that is exactly the gap worth closing, because a new row lands in a column
 * just as a move does. An agent that may never move a task to `done` must not
 * be able to create one there either. So the answer is read off the same table:
 * any column this actor could legally move a task into, plus `ideas`, the
 * unstructured landing zone that no transition targets and anyone may fill.
 */
export const creatableStatuses = (
  actorKind: ActorKind
): readonly TaskStatus[] =>
  UNBOUNDED_CREATORS.includes(actorKind)
    ? TASK_STATUSES
    : [
        ...new Set<TaskStatus>([
          "ideas",
          ...TASK_TRANSITIONS.filter((transition) =>
            transition.actorKinds.includes(actorKind)
          ).map((transition) => transition.to),
        ]),
      ];

/**
 * Whether this actor kind may file a new task straight into this column. The
 * second gate beside {@link canTransition}, so the two doors into a column are
 * governed by one table.
 */
export const canCreateWithStatus = (request: {
  readonly actorKind: ActorKind;
  readonly status: TaskStatus;
}) => creatableStatuses(request.actorKind).includes(request.status);
