import { type ActorKind, TASK_STATUSES, type TaskStatus } from "./enums";

/** One legal move on the board, and who is allowed to make it. */
export interface TaskTransition {
  readonly actorKinds: readonly ActorKind[];
  readonly from: TaskStatus;
  readonly to: TaskStatus;
}

/**
 * The actor kinds that move a card wherever they like.
 *
 * A person dragging a card is what the board is for, and the manager agent is a
 * proxy for the person talking to it — a manager that can file a task but not
 * move it just moves the same request to a different button. So both of them
 * hold every move: any column to any other column, in either direction, with no
 * order to work through.
 *
 * That is a deliberate loosening of what this table used to say. A forward-only
 * machine reads well and then blocks ordinary work: a scratch card in `ideas`
 * could be pushed one step and never taken off the board, and the manager was
 * refused `ideas → done` for a card whose whole content was "never mind".
 * Judging which move makes sense is the operator's, and refusing the ones that
 * looked wrong on paper cost more than it bought.
 */
export const FREE_MOVERS = [
  "human",
  "manager",
] as const satisfies readonly ActorKind[];

/**
 * Whether this actor kind moves cards without the table's permission — a person
 * or the manager acting for one, as opposed to a run.
 *
 * Exported because the difference is not only about columns: a move into
 * `in_progress` unparks the task, a move out of it while a run is live asks for
 * that run to stop, and both are things somebody decided rather than things a
 * run did on its way past.
 */
export const movesFreely = (actorKind: ActorKind) =>
  (FREE_MOVERS as readonly ActorKind[]).includes(actorKind);

/**
 * The moves this table still constrains, written down as data. Every writer —
 * the dashboard, the manager's tools, the orchestrator, a worker's task-scoped
 * token — asks this module, so the rules cannot fork into a second `if`
 * somewhere.
 *
 * What is left in the table is the runs. A worker run may only end its own work
 * and the orchestrator may only reconcile a run that is gone, which is the same
 * single edge: `in_progress → review`. Nothing a run does reaches `done`, and
 * nothing a run does files a card back into `ideas`. Those are the two rules
 * worth keeping, and they are about machines rather than about people.
 *
 * The free movers of {@link FREE_MOVERS} are not in here, because listing every
 * ordered pair of five columns twice over would be a table nobody reads and a
 * new column would mean eight new rows.
 *
 * Research spawned from `backlog` is deliberately not here either: it is a
 * `start_session` command, not a status change.
 */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  // The run ended — cleanly, crashed, or gone without a terminal event. The
  // worker's only move, and the orchestrator's reconcile of a lost run.
  {
    actorKinds: ["worker_run", "orchestrator"],
    from: "in_progress",
    to: "review",
  },
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
 *
 * A move to the column the card is already in is nobody's, free mover included.
 * It is not a refusal of anything anyone wants: the card is already there, and
 * changing where it sits *within* a column is a placement, which is its own
 * write. Keeping it out means a transition always changes the status, so
 * `statusChangedAt` and the audit row stay answers to "when did this move".
 */
export const canTransition = (request: TransitionRequest) =>
  request.from !== request.to &&
  (movesFreely(request.actorKind) ||
    TASK_TRANSITIONS.some((transition) => matches(transition, request)));

/**
 * The statuses this actor kind may move a task to from here. Feeds the board's
 * drop targets and the task view's status selector, so neither re-encodes the
 * rules and drifts from them.
 */
export const nextStatuses = (
  request: Omit<TransitionRequest, "to">
): readonly TaskStatus[] =>
  movesFreely(request.actorKind)
    ? TASK_STATUSES.filter((status) => status !== request.from)
    : TASK_TRANSITIONS.filter(
        (transition) =>
          transition.from === request.from &&
          transition.actorKinds.includes(request.actorKind)
      ).map((transition) => transition.to);

/**
 * The actor kinds that may file a task into any column: the free movers, and
 * `system`, which is the seed script and has to be able to lay down a fixture in
 * every column at once.
 */
const UNBOUNDED_CREATORS: readonly ActorKind[] = [...FREE_MOVERS, "system"];

/**
 * Where this actor kind may file a *new* task.
 *
 * Creation has no `from`, so the rules above cannot answer it directly — and
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
 * governed by one module.
 */
export const canCreateWithStatus = (request: {
  readonly actorKind: ActorKind;
  readonly status: TaskStatus;
}) => creatableStatuses(request.actorKind).includes(request.status);

/**
 * Whether this actor kind may erase a task altogether — the third door, and the
 * only one that leads off the board.
 *
 * The same answer as {@link FREE_MOVERS}, and for the same reason: a person and
 * the manager acting for them own what is on the board. A run does not, and the
 * distinction matters here more than anywhere else, because a worker run's
 * token *is* good for writes on the task it was dispatched for — without this,
 * an agent could delete the task it was asked to work on, taking its own
 * transcript, its messages and every other run on the card with it.
 */
export const canDeleteTask = (request: { readonly actorKind: ActorKind }) =>
  movesFreely(request.actorKind);
