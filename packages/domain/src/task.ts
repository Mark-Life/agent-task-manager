import { Schema } from "effect";
import { TaskStatus } from "./enums";
import { AgentSessionId, ProjectId, TaskId } from "./ids";
import { recordFields, Timestamp } from "./primitives";

/**
 * Anything an agent wants to record that no column exists for. Free to write
 * and needs no migration; a key that proves itself gets promoted to a column
 * later. Structured task inputs live here until then.
 */
export const TaskMetadata = Schema.Record(Schema.String, Schema.Json);
export type TaskMetadata = typeof TaskMetadata.Type;

/**
 * The one metadata key the system itself reads: this card is a test fixture and
 * not work anybody asked for.
 *
 * It exists because the test suite writes real rows — the store's claims are
 * about a real database and checking them against a fake would be checking the
 * fake — and a suite pointed at the wrong database once left four of those rows
 * on the board, one of which then collected a manager comment. A flag is the
 * answer rather than a delete: the row is the only surviving record of some
 * early runs, and erasing it to tidy the board would take their trail with it.
 *
 * Read by {@link isFixtureTask}, and honoured where a column is *listed* —
 * which is both the board and the dispatch queue, since they are one read. A
 * card addressed by id still answers, so a link into a flagged card opens and
 * its thread is still there.
 */
export const FIXTURE_METADATA_KEY = "fixture";

/** What a test stamps on every card it files. See {@link FIXTURE_METADATA_KEY}. */
export const FIXTURE_METADATA = {
  [FIXTURE_METADATA_KEY]: true,
} satisfies TaskMetadata;

/**
 * Whether this card is a fixture. Exactly `true` counts: metadata is free-form
 * JSON an agent may write, and a key holding a string or an object is somebody
 * recording something else under a name that collided.
 */
export const isFixtureTask = (task: {
  readonly metadata: TaskMetadata;
}): boolean => task.metadata[FIXTURE_METADATA_KEY] === true;

/** Continue the task's latest session with its full history. The default, because resuming beats starting over. */
const LatestSession = Schema.Struct({ mode: Schema.tag("latest") });

/** Start a fresh session — how "a new session reviews the PR it did not write" is expressed. */
const NewSession = Schema.Struct({ mode: Schema.tag("new") });

/** Resume one named session, which is how the implementation session comes back after a review. */
const SpecificSession = Schema.Struct({
  mode: Schema.tag("specific"),
  sessionId: AgentSessionId,
});

/**
 * Which session the next run on a task uses. A property of the task rather than
 * an argument at dispatch, so a dropdown in the UI and a sentence to the
 * manager both end up writing one value, and the orchestrator honours whatever
 * it finds without a second protocol.
 *
 * A view over two stored columns rather than a stored value of its own: an id
 * names a session, and the one thing an id cannot say is "start fresh even
 * though sessions exist", which is what the boolean beside it carries.
 */
export const NextSession = Schema.Union([
  LatestSession,
  NewSession,
  SpecificSession,
]).pipe(Schema.toTaggedUnion("mode"));
export type NextSession = typeof NextSession.Type;

/**
 * A task. Everything the board renders is a real column; everything else an
 * agent wants to keep goes in {@link TaskMetadata}.
 */
export const Task = Schema.Struct({
  ...recordFields,
  /** Acceptance criteria, appended to the prompt. */
  acceptance: Schema.NullOr(Schema.String),
  /** The prompt body. */
  brief: Schema.String,
  /**
   * The W3C `traceparent` of the write that last asked this task to run, so a
   * run the loop opens later joins the request that caused it. Null for a task
   * nothing has asked to run, or one moved by a caller outside a trace.
   *
   * A plain string rather than a validated one: it is read through
   * `parseTraceparent`, which answers null for anything malformed, and a
   * refinement here would fail the whole row instead — a task that cannot be
   * decoded because of a telemetry field is a task that cannot be dispatched.
   */
  dispatchTraceparent: Schema.NullOr(Schema.String),
  id: TaskId,
  metadata: TaskMetadata,
  nextSessionId: Schema.NullOr(AgentSessionId),
  /** Start fresh on the next run even though the task has sessions to resume. */
  nextSessionNew: Schema.Boolean,
  parentTaskId: Schema.NullOr(TaskId),
  /**
   * Set when the retry threshold trips. The dispatcher skips a parked task, so
   * repeated failure stops re-dispatching instead of looping; any human move
   * into `in_progress` clears it.
   */
  parkedUntil: Schema.NullOr(Timestamp),
  projectId: Schema.NullOr(ProjectId),
  prUrl: Schema.NullOr(Schema.String),
  /** Position in its column, ascending. See {@link rankBetween}. */
  rank: Schema.Number,
  /** Overrides the project's repo. Null inherits it. */
  repoUrl: Schema.NullOr(Schema.String),
  /** Which image to run. Null takes the default one. */
  sandboxImage: Schema.NullOr(Schema.String),
  status: TaskStatus,
  /** How long the task has sat in this column, which no other column can answer without scanning the audit log. */
  statusChangedAt: Timestamp,
  title: Schema.NonEmptyString,
});

export interface Task extends Schema.Schema.Type<typeof Task> {}

/** The two columns the next-session selection is spread across. */
export type NextSessionSelection = Pick<
  Task,
  "nextSessionId" | "nextSessionNew"
>;

/**
 * Reads the selection off the two columns. Total by construction, so the
 * dispatcher learns what runs next without a second query: an id pins a
 * session, the flag asks for a fresh one, and neither set means resume whatever
 * ran last. A pinned session that has since been deleted nulls the column
 * through its foreign key, which degrades to the default rather than failing.
 */
export const nextSessionOf = (selection: NextSessionSelection) => {
  if (selection.nextSessionId !== null) {
    return NextSession.cases.specific.make({
      sessionId: selection.nextSessionId,
    });
  }
  return selection.nextSessionNew
    ? NextSession.cases.new.make({})
    : NextSession.cases.latest.make({});
};

/**
 * What the orchestrator writes back after claiming a task, and what a task
 * starts life with: continue the latest session, nothing pinned.
 */
export const DEFAULT_NEXT_SESSION: NextSessionSelection = {
  nextSessionId: null,
  nextSessionNew: false,
};

const toSelectedColumns = {
  latest: () => DEFAULT_NEXT_SESSION,
  new: () => ({ nextSessionId: null, nextSessionNew: true }),
  specific: (next: Extract<NextSession, { mode: "specific" }>) => ({
    nextSessionId: next.sessionId,
    nextSessionNew: false,
  }),
};

/** Writes a selection back to the two columns, the inverse of {@link nextSessionOf}. */
export const nextSessionColumns = (next: NextSession) =>
  NextSession.match(next, toSelectedColumns);

/**
 * The gap left between two neighbouring tasks when one is appended to the end
 * of a column. Large enough that the midpoints below stay far from each other
 * for the lifetime of a board this size.
 */
export const RANK_STEP = 1024;

/**
 * Where a task sits in its column, and therefore where it sits in the dispatch
 * queue: the board reads a column by ascending rank, and the orchestrator takes
 * the top of *in progress* as the next thing to spend a slot on.
 *
 * A fractional rank rather than an integer priority, because the gesture is
 * "put this one here" — dragging a card between two others, or telling the
 * manager agent to run something next. Both are one row write of the midpoint
 * between the neighbours; an integer would renumber every card below the drop.
 *
 * `null` for a neighbour means the end of the column: no task above means the
 * top, none below means the bottom.
 */
export const rankBetween = (
  above: number | null,
  below: number | null
): number => {
  if (above === null) {
    return below === null ? 0 : below - RANK_STEP;
  }
  return below === null ? above + RANK_STEP : (above + below) / 2;
};
