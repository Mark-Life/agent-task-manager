import type {
  AgentSessionId,
  CostUsd,
  Run,
  RunOutcome,
  RunTrigger,
  SessionProvider,
  ThreadId,
  WorkspaceId,
} from "@workspace/domain";
import {
  LIVE_RUN_STATUSES,
  newRunId,
  RunId,
  RunStatus,
  RunSubject,
  roleOfSubject,
  type TaskId,
} from "@workspace/domain";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Database } from "../client";
import { decodeRun, RunInsert, RunUpdate } from "../rows";
import { chatThread } from "../schema/chat";
import { run } from "../schema/run";
import { task } from "../schema/task";
import {
  auditCreate,
  audited,
  auditUpdate,
  type BrandedEncoded,
  changesOf,
  decodeMany,
  decodeOne,
  decodeWritten,
  encodeWrite,
  execute,
  firstRow,
  type Transaction,
  writer,
} from "./audit";
import { subjectColumns } from "./subject";

/** A read addressed by one id matches one row, and a subject has at most one live run. */
const ONE = 1;

/**
 * How many ids one existence read carries.
 *
 * {@link make}'s `existing` is asked about whatever the boot sweep found on
 * disk, which nothing bounds, and a driver has a ceiling on bound parameters.
 * Well under it, and the cost of the split is one extra round trip per thousand
 * directories, once per boot.
 */
const EXISTENCE_CHUNK = 1000;

/** The table these rows live in, and what an error names them as. */
const ENTITY = "run";

/** The other table a run can be attached to, named for a not-found failure. */
const ENTITY_THREAD = "chat_thread";

/**
 * What the lock read selects. A constant rather than the id, so locking a task
 * and locking a thread produce one row shape and the caller only has to ask
 * whether anything came back.
 */
const LOCKED = sql<number>`1`;

/** The first attempt at a task. Later attempts count up from here for the retry backoff. */
const FIRST_ATTEMPT = 1;

/**
 * How a run ended decides whether it is filed as finished, failed or
 * interrupted. One mapping, so the two columns cannot be set to disagree — the
 * database checks that a terminal status carries an outcome, and this is what
 * makes the pair true rather than merely well-formed.
 *
 * `lost` is a failure and not an interruption: nobody asked for it, the process
 * simply stopped answering.
 */
const STATUS_OF_OUTCOME = {
  done: "finished",
  errored: "failed",
  interrupted: "interrupted",
  lost: "failed",
  timeout: "failed",
} as const satisfies Record<RunOutcome, RunStatus>;

/** What an encoded patch looks like once the domain values have become columns. */
type RunValues = BrandedEncoded<typeof RunUpdate>;

/** A run is never addressed by id alone; every query names the workspace it belongs to. */
interface RunRef {
  readonly id: RunId;
  readonly workspaceId: WorkspaceId;
}

/** What identifies the runs on one task or one thread. */
interface SubjectRef {
  readonly subject: RunSubject;
  readonly workspaceId: WorkspaceId;
}

/** What identifies a task's runs. */
interface TaskRef {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/** What identifies a thread's turns. */
interface ThreadRunsRef {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The subject already has a queued or running run. One run per task at a time
 * is what stops two containers writing the same artifacts directory, and one
 * per thread is what stops two answers to one conversation; the partial unique
 * indexes enforce both, and this is the same refusal arriving as a value rather
 * than as a constraint violation.
 */
export class RunAlreadyLive extends Schema.TaggedErrorClass<RunAlreadyLive>()(
  "RunRepo.AlreadyLive",
  { liveRunId: RunId, subject: RunSubject }
) {}

/** A run leaves the queue once. Starting it again would restate when it began. */
export class RunNotStartable extends Schema.TaggedErrorClass<RunNotStartable>()(
  "RunRepo.NotStartable",
  { id: RunId, status: RunStatus }
) {}

/**
 * The run has already reached a terminus. Closing it a second time would
 * overwrite the first ending's outcome and economics with the second's, so it is
 * refused with the status the row holds.
 */
export class RunNotLive extends Schema.TaggedErrorClass<RunNotLive>()(
  "RunRepo.NotLive",
  { id: RunId, status: RunStatus }
) {}

const liveStatuses = [...LIVE_RUN_STATUSES];

const refOf = (ref: RunRef) =>
  and(eq(run.workspaceId, ref.workspaceId), eq(run.id, ref.id));

/** The one of the two columns this subject is stored in. */
const subjectOf = (subject: RunSubject) =>
  subject.kind === "task"
    ? eq(run.taskId, subject.id)
    : eq(run.threadId, subject.id);

/** What a subject writes on a run: its id, and the role that follows from it. */
const runSubjectColumns = (subject: RunSubject) => ({
  ...subjectColumns(subject),
  role: roleOfSubject(subject),
});

const liveOn = (ref: SubjectRef) =>
  and(
    eq(run.workspaceId, ref.workspaceId),
    subjectOf(ref.subject),
    inArray(run.status, liveStatuses)
  );

/** What claiming an attempt needs. Everything the container reports comes later. */
interface CreateInput extends SubjectRef {
  readonly agentSessionId: AgentSessionId;
  /** Retry backoff and the park threshold count from here. */
  readonly attempt?: number;
  readonly provider: SessionProvider;
  /** Joins this row to its wide event in the telemetry ledger. */
  readonly traceId?: string;
  readonly trigger: RunTrigger;
}

/** What the container reported about itself once it was up. */
interface StartInput extends RunRef {
  readonly containerId?: string;
  readonly model?: string;
  readonly sandboxImage?: string;
}

/**
 * How a run ended. Every measurement is optional, and absent means "produced no
 * number" — which is not zero. A degraded run did not cost 0 and did not take
 * 0ms, and a fabricated 0 is a number someone later averages.
 */
interface CloseInput extends RunRef {
  /** The branch this run pushed, which is the PR's head. */
  readonly branch?: string;
  readonly costUsd?: CostUsd;
  readonly durationMs?: number;
  readonly errorClass?: string;
  readonly errorMessage?: string;
  readonly exitCode?: number;
  readonly outcome: RunOutcome;
  readonly totalTokens?: number;
  readonly turns?: number;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);

  /**
   * Lock the row, decide what to write against what was found, write it, and
   * record the difference. The lock is what stops a stop command and a clean
   * finish from both deciding they are the one closing the run.
   */
  const revise = <E, R>(
    input: RunRef,
    operation: string,
    plan: (before: Run) => Effect.Effect<RunValues, E, R>
  ) =>
    write(({ tx }) =>
      Effect.gen(function* () {
        const rows = yield* execute(
          operation,
          tx.select().from(run).where(refOf(input)).limit(ONE).for("update")
        );
        const stored = yield* firstRow({ entity: ENTITY, id: input.id, rows });
        const before = yield* decodeOne({
          decode: decodeRun,
          entity: ENTITY,
          id: input.id,
          rows,
        });
        const values = yield* plan(before);
        const written = yield* execute(
          operation,
          tx.update(run).set(values).where(refOf(input)).returning()
        );
        const after = yield* decodeWritten({
          decode: decodeRun,
          entity: ENTITY,
          operation,
          rows: written,
        });
        return audited(
          after,
          auditUpdate({
            changes: changesOf({ after: values, before: stored }),
            entityId: after.id,
            entityType: ENTITY,
            taskId: after.taskId,
            workspaceId: after.workspaceId,
          })
        );
      })
    );

  /**
   * Locks the row a subject names, so two concurrent creates serialize on it.
   * Without the lock both read no live run under READ COMMITTED, both insert,
   * and the partial unique index decides — which is the right answer arriving
   * as a constraint violation rather than as {@link RunAlreadyLive}.
   */
  const lockSubject = (tx: Transaction, input: SubjectRef) =>
    input.subject.kind === "task"
      ? execute(
          "RunRepo.create",
          tx
            .select({ found: LOCKED })
            .from(task)
            .where(
              and(
                eq(task.workspaceId, input.workspaceId),
                eq(task.id, input.subject.id)
              )
            )
            .limit(ONE)
            .for("update")
        )
      : execute(
          "RunRepo.create",
          tx
            .select({ found: LOCKED })
            .from(chatThread)
            .where(
              and(
                eq(chatThread.workspaceId, input.workspaceId),
                eq(chatThread.id, input.subject.id)
              )
            )
            .limit(ONE)
            .for("update")
        );

  /**
   * Claims an attempt at a subject: queued, and not yet started. A queued run
   * has no `startedAt`, which is what makes the queue wait measurable as
   * `startedAt - createdAt`.
   *
   * The session it belongs to is written first, by its own repository — every run
   * belongs to a session, because that is what resuming means.
   *
   * One live run per subject is what stops two containers writing one artifacts
   * directory and two agents answering one conversation. It is enforced twice:
   * the task or thread row is locked here and the loser is told
   * {@link RunAlreadyLive}, and the partial unique index behind that catches
   * anything reaching the table by another route.
   */
  const create = Effect.fn("RunRepo.create")(function* (input: CreateInput) {
    yield* Effect.annotateCurrentSpan({
      sessionId: input.agentSessionId,
      subjectId: input.subject.id,
      subjectKind: input.subject.kind,
      workspaceId: input.workspaceId,
    });
    const id = newRunId();
    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: RunInsert,
      value: {
        ...runSubjectColumns(input.subject),
        agentSessionId: input.agentSessionId,
        attempt: input.attempt ?? FIRST_ATTEMPT,
        costUsd: null,
        durationMs: null,
        finishedAt: null,
        id,
        outcome: null,
        provider: input.provider,
        startedAt: null,
        status: "queued",
        totalTokens: null,
        traceId: input.traceId,
        trigger: input.trigger,
        turns: null,
        workspaceId: input.workspaceId,
      },
    });
    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const owner = yield* lockSubject(tx, input);
        yield* firstRow({
          entity: input.subject.kind === "task" ? "task" : ENTITY_THREAD,
          id: input.subject.id,
          rows: owner,
        });

        const held = yield* execute(
          "RunRepo.create",
          tx.select({ id: run.id }).from(run).where(liveOn(input)).limit(ONE)
        );
        const [live] = held;
        if (live !== undefined) {
          return yield* Effect.fail(
            new RunAlreadyLive({
              liveRunId: RunId.make(live.id),
              subject: input.subject,
            })
          );
        }
        const written = yield* execute(
          "RunRepo.create",
          tx.insert(run).values(values).returning()
        );
        const attempt = yield* decodeWritten({
          decode: decodeRun,
          entity: ENTITY,
          operation: "RunRepo.create",
          rows: written,
        });
        return audited(
          attempt,
          auditCreate({
            entityId: attempt.id,
            entityType: ENTITY,
            taskId: attempt.taskId,
            workspaceId: attempt.workspaceId,
          })
        );
      })
    );
  });

  /**
   * The container is up and the harness is working. Records what actually ran —
   * the image, the model, the container to tear down — against the request that
   * only asked for them.
   */
  const start = Effect.fn("RunRepo.start")(function* (input: StartInput) {
    yield* Effect.annotateCurrentSpan({ runId: input.id });
    return yield* revise(input, "RunRepo.start", (before) =>
      Effect.gen(function* () {
        if (before.status !== "queued") {
          return yield* Effect.fail(
            new RunNotStartable({ id: input.id, status: before.status })
          );
        }
        const startedAt = yield* DateTime.now;
        return yield* encodeWrite({
          entity: ENTITY,
          schema: RunUpdate,
          value: {
            containerId: input.containerId,
            model: input.model,
            sandboxImage: input.sandboxImage,
            startedAt,
            status: "running",
          },
        });
      })
    );
  });

  /**
   * Closes the run out on its terminal event, whichever one arrived: a clean
   * finish, a crash, a stop somebody asked for, or the orchestrator noticing that
   * the process is simply gone. The status follows from the outcome, so the two
   * cannot be written to disagree.
   */
  const close = Effect.fn("RunRepo.close")(function* (input: CloseInput) {
    yield* Effect.annotateCurrentSpan({
      outcome: input.outcome,
      runId: input.id,
    });
    return yield* revise(input, "RunRepo.close", (before) =>
      Effect.gen(function* () {
        if (before.outcome !== null) {
          return yield* Effect.fail(
            new RunNotLive({ id: input.id, status: before.status })
          );
        }
        const finishedAt = yield* DateTime.now;
        return yield* encodeWrite({
          entity: ENTITY,
          schema: RunUpdate,
          value: {
            branch: input.branch,
            costUsd: input.costUsd,
            durationMs: input.durationMs,
            errorClass: input.errorClass,
            errorMessage: input.errorMessage,
            exitCode: input.exitCode,
            finishedAt,
            outcome: input.outcome,
            status: STATUS_OF_OUTCOME[input.outcome],
            totalTokens: input.totalTokens,
            turns: input.turns,
          },
        });
      })
    );
  });

  /** One run, for the timeline header and for a command that names its target. */
  const byId = Effect.fn("RunRepo.byId")(function* (input: RunRef) {
    yield* Effect.annotateCurrentSpan({ runId: input.id });
    const rows = yield* execute(
      "RunRepo.byId",
      db.select().from(run).where(refOf(input)).limit(ONE)
    );
    return yield* decodeOne({
      decode: decodeRun,
      entity: ENTITY,
      id: input.id,
      rows,
    });
  });

  const liveOne = (operation: string, input: SubjectRef) =>
    Effect.gen(function* () {
      const rows = yield* execute(
        operation,
        db.select().from(run).where(liveOn(input)).limit(ONE)
      );
      const found = yield* decodeMany({
        decode: decodeRun,
        entity: ENTITY,
        rows,
      });
      return found[0] ?? null;
    });

  /**
   * The task's live run, or null. This is the difference the board draws between
   * a task sitting in the in-progress column and an agent actually working: no
   * live run means it is waiting for a slot or has stalled. Null is also what
   * makes "no live run" a real answer to a stop command rather than silence.
   */
  const liveForTask = Effect.fn("RunRepo.liveForTask")(function* (
    input: TaskRef
  ) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    return yield* liveOne("RunRepo.liveForTask", {
      subject: { id: input.taskId, kind: "task" },
      workspaceId: input.workspaceId,
    });
  });

  /**
   * The thread's live turn, or null. What the bot asks before it answers a
   * message that arrived mid-turn: a live run means the message is queued and
   * the next turn will read it, and null means this message starts one.
   */
  const liveForThread = Effect.fn("RunRepo.liveForThread")(function* (
    input: ThreadRunsRef
  ) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId });
    return yield* liveOne("RunRepo.liveForThread", {
      subject: { id: input.threadId, kind: "thread" },
      workspaceId: input.workspaceId,
    });
  });

  /**
   * Every run the database still believes is live. The orchestrator reads this at
   * startup: a run left queued or running by a process that died has no container
   * behind it, and closing it out as `lost` is what stops its task waiting
   * forever.
   */
  const listLive = Effect.fn("RunRepo.listLive")(function* (input: {
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });
    const rows = yield* execute(
      "RunRepo.listLive",
      db
        .select()
        .from(run)
        .where(
          and(
            eq(run.workspaceId, input.workspaceId),
            inArray(run.status, liveStatuses)
          )
        )
        .orderBy(asc(run.createdAt))
    );
    return yield* decodeMany({ decode: decodeRun, entity: ENTITY, rows });
  });

  /**
   * Which of these run ids the database still has rows for, live or finished a
   * month ago.
   *
   * The database half of "is this run directory still anybody's". A run
   * directory holds the transcript at full length and the event ledger the
   * timeline is rebuilt from, so what keeps it on disk is the row and not the
   * run's liveness — and a task deleted takes its runs with it, which is how a
   * directory comes to have no row at all.
   *
   * Asked about the ids the caller found rather than answered with every id in
   * the table: the read is then bounded by what is on disk, which is the thing
   * being decided about, and a board with a hundred thousand runs behind it does
   * not pay for them at every boot.
   */
  const existing = Effect.fn("RunRepo.existing")(function* (input: {
    readonly ids: readonly RunId[];
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({
      asked: input.ids.length,
      workspaceId: input.workspaceId,
    });
    const found: RunId[] = [];
    for (let from = 0; from < input.ids.length; from += EXISTENCE_CHUNK) {
      const rows = yield* execute(
        "RunRepo.existing",
        db
          .select({ id: run.id })
          .from(run)
          .where(
            and(
              eq(run.workspaceId, input.workspaceId),
              inArray(run.id, input.ids.slice(from, from + EXISTENCE_CHUNK))
            )
          )
      );
      for (const row of rows) {
        found.push(row.id);
      }
    }
    return found as readonly RunId[];
  });

  const listOn = (operation: string, input: SubjectRef) =>
    Effect.gen(function* () {
      const rows = yield* execute(
        operation,
        db
          .select()
          .from(run)
          .where(
            and(
              eq(run.workspaceId, input.workspaceId),
              subjectOf(input.subject)
            )
          )
          .orderBy(desc(run.createdAt), desc(run.id))
      );
      return yield* decodeMany({ decode: decodeRun, entity: ENTITY, rows });
    });

  /** A task's attempts, newest first. */
  const listByTask = Effect.fn("RunRepo.listByTask")(function* (
    input: TaskRef
  ) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    return yield* listOn("RunRepo.listByTask", {
      subject: { id: input.taskId, kind: "task" },
      workspaceId: input.workspaceId,
    });
  });

  /** A thread's turns, newest first — one run each, and their events behind them. */
  const listByThread = Effect.fn("RunRepo.listByThread")(function* (
    input: ThreadRunsRef
  ) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId });
    return yield* listOn("RunRepo.listByThread", {
      subject: { id: input.threadId, kind: "thread" },
      workspaceId: input.workspaceId,
    });
  });

  return {
    byId,
    close,
    create,
    existing,
    listByTask,
    listByThread,
    listLive,
    liveForTask,
    liveForThread,
    start,
  } as const;
});

/**
 * The attempts at a task. Liveness lives here rather than on the task, which is
 * why the board can show a spinner on one in-progress card and not on another.
 */
export class RunRepo extends Context.Service<
  RunRepo,
  Effect.Success<typeof make>
>()("@workspace/db/RunRepo") {
  static readonly layer = Layer.effect(RunRepo, make);
}
