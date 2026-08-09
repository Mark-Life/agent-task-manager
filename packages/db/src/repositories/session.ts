import type {
  AgentSession,
  ChatMessageId,
  ResumeCandidate,
  RunOutcome,
  RunSubject,
  SessionProvider,
  TaskId,
  TaskMessageId,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  AgentSessionId,
  isResumable,
  newAgentSessionId,
  SessionStatus,
  UnreadWatermarkId,
} from "@workspace/domain";
import { and, desc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Database } from "../client";
import {
  AgentSessionInsert,
  AgentSessionUpdate,
  decodeAgentSession,
  decodeSessionRunOutcome,
} from "../rows";
import { agentSession } from "../schema/agent-session";
import { run } from "../schema/run";
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
  writer,
} from "./audit";
import { subjectColumns } from "./subject";

/** Nothing in here reads more than one row by id. */
const ONE = 1;

/** The table these rows live in, and what an error names them as. */
const ENTITY = "agent_session";

/** The other table read here: a session's runs are where its failure has a cause. */
const ENTITY_RUN = "run";

/** What an encoded patch looks like once the domain values have become columns. */
type SessionValues = BrandedEncoded<typeof AgentSessionUpdate>;

/**
 * A session is never addressed by id alone. Every query names the workspace it
 * belongs to, so a single-workspace read today is already a scoped read and
 * nothing has to be revisited to make it one.
 */
interface SessionRef {
  readonly id: AgentSessionId;
  readonly workspaceId: WorkspaceId;
}

/** What identifies the sessions on one task or one thread. */
interface SubjectRef {
  readonly subject: RunSubject;
  readonly workspaceId: WorkspaceId;
}

/** What identifies a task's sessions. */
interface TaskRef {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

/** What identifies a thread's sessions. */
interface ThreadRef {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The session has already stopped. Ending one twice would overwrite the first
 * ending — including the message that says why a research session produced
 * nothing — so the second attempt is refused, carrying the status the row
 * actually holds.
 */
export class AgentSessionEnded extends Schema.TaggedErrorClass<AgentSessionEnded>()(
  "AgentSessionRepo.Ended",
  { id: AgentSessionId, status: SessionStatus }
) {}

const refOf = (ref: SessionRef) =>
  and(
    eq(agentSession.workspaceId, ref.workspaceId),
    eq(agentSession.id, ref.id)
  );

/** What opening a session needs. The status is not among it: a session is born running. */
interface OpenInput extends SubjectRef {
  readonly provider: SessionProvider;
}

/**
 * How far a session has been read into its conversation. The id is a task
 * message's on a task's session and a chat message's on a thread's — one position, over
 * whichever table the session's subject reads from.
 */
interface WatermarkInput extends SessionRef {
  readonly unreadAt: Timestamp;
  readonly unreadId: ChatMessageId | TaskMessageId;
}

/** The one of the two columns this subject is stored in. */
const subjectOf = (subject: RunSubject) =>
  subject.kind === "task"
    ? eq(agentSession.taskId, subject.id)
    : eq(agentSession.threadId, subject.id);

/**
 * A session, and how its runs ended. What {@link isResumable} is asked about,
 * with the whole row kept so the caller that accepts one can use it.
 */
export interface SessionResumeCandidate extends ResumeCandidate {
  readonly session: AgentSession;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const write = writer(db);

  /**
   * The shape every mutation here takes: lock the row, decide what to write
   * against what was found, write it, and record the difference. The lock is
   * what stops two writers from each reading `running` and both deciding they
   * are the one ending the session.
   */
  const revise = <E, R>(
    input: SessionRef,
    operation: string,
    plan: (before: AgentSession) => Effect.Effect<SessionValues, E, R>
  ) =>
    write(({ tx }) =>
      Effect.gen(function* () {
        const rows = yield* execute(
          operation,
          tx
            .select()
            .from(agentSession)
            .where(refOf(input))
            .limit(ONE)
            .for("update")
        );
        const stored = yield* firstRow({
          entity: ENTITY,
          id: input.id,
          rows,
        });
        const before = yield* decodeOne({
          decode: decodeAgentSession,
          entity: ENTITY,
          id: input.id,
          rows,
        });
        const values = yield* plan(before);
        const written = yield* execute(
          operation,
          tx.update(agentSession).set(values).where(refOf(input)).returning()
        );
        const after = yield* decodeWritten({
          decode: decodeAgentSession,
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
   * Opens a session on a task, running from the moment it exists.
   *
   * The run that will use it is written afterwards by its own repository, so a
   * process that dies in between leaves a running session with no runs. That is
   * a state this model already names: the orchestrator's reconcile marks it
   * failed, and a session that produced nothing stays visible as a failure
   * rather than as an absence.
   */
  const open = Effect.fn("AgentSessionRepo.open")(function* (input: OpenInput) {
    yield* Effect.annotateCurrentSpan({
      subjectId: input.subject.id,
      subjectKind: input.subject.kind,
      workspaceId: input.workspaceId,
    });
    const id = newAgentSessionId();
    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: AgentSessionInsert,
      value: {
        ...subjectColumns(input.subject),
        endedAt: null,
        id,
        provider: input.provider,
        status: "running",
        unreadWatermarkAt: null,
        unreadWatermarkId: null,
        workspaceId: input.workspaceId,
      },
    });
    return yield* write(({ tx }) =>
      Effect.gen(function* () {
        const written = yield* execute(
          "AgentSessionRepo.open",
          tx.insert(agentSession).values(values).returning()
        );
        const session = yield* decodeWritten({
          decode: decodeAgentSession,
          entity: ENTITY,
          operation: "AgentSessionRepo.open",
          rows: written,
        });
        return audited(
          session,
          auditCreate({
            entityId: session.id,
            entityType: ENTITY,
            taskId: session.taskId,
            workspaceId: session.workspaceId,
          })
        );
      })
    );
  });

  const stop = (
    input: SessionRef & {
      readonly errorMessage: string | null;
      readonly operation: string;
      readonly status: "failed" | "finished";
    }
  ) =>
    revise(input, input.operation, (before) =>
      Effect.gen(function* () {
        if (before.status !== "running") {
          return yield* Effect.fail(
            new AgentSessionEnded({ id: input.id, status: before.status })
          );
        }
        const endedAt = yield* DateTime.now;
        return yield* encodeWrite({
          entity: ENTITY,
          schema: AgentSessionUpdate,
          value: {
            endedAt,
            errorMessage: input.errorMessage,
            status: input.status,
          },
        });
      })
    );

  /** The session's last run ended cleanly. It stays the default resume target. */
  const finish = Effect.fn("AgentSessionRepo.finish")(function* (
    input: SessionRef
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: input.id });
    return yield* stop({
      ...input,
      errorMessage: null,
      operation: "AgentSessionRepo.finish",
      status: "finished",
    });
  });

  /**
   * The session died. The message stays on the row so the session list can say
   * why without anyone opening the run.
   */
  const fail = Effect.fn("AgentSessionRepo.fail")(function* (
    input: SessionRef & { readonly errorMessage: string }
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: input.id });
    return yield* stop({
      ...input,
      operation: "AgentSessionRepo.fail",
      status: "failed",
    });
  });

  /**
   * Puts a session back to running, for the run that is resuming it.
   *
   * `status`, `endedAt` and `errorMessage` describe the session's most recent
   * run — that is what the column comment on `endedAt` says and what the session
   * list shows — and a resumed session is about to have a newer one. Without
   * this the row keeps the old ending forever: {@link stop} refuses to end a
   * session that is not running, so every close after the first is refused and
   * the session goes on reading as finished, or as failed with a message about a
   * failure this run has already superseded.
   *
   * Only the ending is cleared. The provider's own session id and the watermark
   * are exactly what the resume is built from, and a resume that forgot the
   * watermark would re-read the conversation from the beginning.
   */
  const reopen = Effect.fn("AgentSessionRepo.reopen")(function* (
    input: SessionRef
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: input.id });
    return yield* revise(input, "AgentSessionRepo.reopen", () =>
      encodeWrite({
        entity: ENTITY,
        schema: AgentSessionUpdate,
        value: { endedAt: null, errorMessage: null, status: "running" },
      })
    );
  });

  /**
   * Records the id the harness minted for this conversation, which is only known
   * once the harness has answered. Kept apart from `provider` so the provider can
   * change without rewriting the session.
   */
  const recordProviderSession = Effect.fn(
    "AgentSessionRepo.recordProviderSession"
  )(function* (input: SessionRef & { readonly providerSessionId: string }) {
    yield* Effect.annotateCurrentSpan({ sessionId: input.id });
    return yield* revise(input, "AgentSessionRepo.recordProviderSession", () =>
      encodeWrite({
        entity: ENTITY,
        schema: AgentSessionUpdate,
        value: { providerSessionId: input.providerSessionId },
      })
    );
  });

  /**
   * Moves the session's reading of its conversation forward. Done at
   * prompt-build time and past this session's own previous output — a resumed
   * run that re-read its own fallback message would treat its own words as new
   * instructions.
   *
   * Both halves move together, because the comparison is a `(createdAt, id)`
   * tuple and a same-millisecond tie must not skip a row.
   */
  const advanceWatermark = Effect.fn("AgentSessionRepo.advanceWatermark")(
    function* (input: WatermarkInput) {
      yield* Effect.annotateCurrentSpan({ sessionId: input.id });
      return yield* revise(input, "AgentSessionRepo.advanceWatermark", () =>
        encodeWrite({
          entity: ENTITY,
          schema: AgentSessionUpdate,
          value: {
            unreadWatermarkAt: input.unreadAt,
            unreadWatermarkId: UnreadWatermarkId.make(input.unreadId),
          },
        })
      );
    }
  );

  /** One session, for the dashboard's switcher and for a task's `specific` selection. */
  const byId = Effect.fn("AgentSessionRepo.byId")(function* (
    input: SessionRef
  ) {
    yield* Effect.annotateCurrentSpan({ sessionId: input.id });
    const rows = yield* execute(
      "AgentSessionRepo.byId",
      db.select().from(agentSession).where(refOf(input)).limit(ONE)
    );
    return yield* decodeOne({
      decode: decodeAgentSession,
      entity: ENTITY,
      id: input.id,
      rows,
    });
  });

  const listOn = (operation: string, input: SubjectRef) =>
    Effect.gen(function* () {
      const rows = yield* execute(
        operation,
        db
          .select()
          .from(agentSession)
          .where(
            and(
              eq(agentSession.workspaceId, input.workspaceId),
              subjectOf(input.subject)
            )
          )
          .orderBy(desc(agentSession.createdAt), desc(agentSession.id))
      );
      return yield* decodeMany({
        decode: decodeAgentSession,
        entity: ENTITY,
        rows,
      });
    });

  /** A task's sessions, newest first — the order the dashboard lists them in. */
  const listByTask = Effect.fn("AgentSessionRepo.listByTask")(function* (
    input: TaskRef
  ) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    return yield* listOn("AgentSessionRepo.listByTask", {
      subject: { id: input.taskId, kind: "task" },
      workspaceId: input.workspaceId,
    });
  });

  /** A thread's sessions, newest first. More than one only after a provider switch or a session that could not be resumed. */
  const listByThread = Effect.fn("AgentSessionRepo.listByThread")(function* (
    input: ThreadRef
  ) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId });
    return yield* listOn("AgentSessionRepo.listByThread", {
      subject: { id: input.threadId, kind: "thread" },
      workspaceId: input.workspaceId,
    });
  });

  /**
   * How the runs on each of these sessions ended, newest first, keyed by
   * session.
   *
   * A second query rather than a subquery on the first. The obvious `array_agg`
   * correlated on the session's id does not survive drizzle: inside a raw `sql`
   * template it renders column references unqualified, so `agent_session_id =
   * id` compares two columns of `run` and every session comes back with no
   * outcomes at all — a wrong answer rather than an error. Two reads that the
   * query builder can name the tables in are worth one round trip.
   */
  const outcomesOf = (operation: string, sessions: readonly AgentSession[]) =>
    Effect.gen(function* () {
      const bySession = new Map<AgentSessionId, RunOutcome[]>();
      if (sessions.length === 0) {
        return bySession;
      }
      const rows = yield* execute(
        operation,
        db
          .select({
            agentSessionId: run.agentSessionId,
            outcome: run.outcome,
          })
          .from(run)
          .where(
            and(
              inArray(
                run.agentSessionId,
                sessions.map((session) => session.id)
              ),
              isNotNull(run.outcome)
            )
          )
          .orderBy(desc(run.createdAt), desc(run.id))
      );
      const ended = yield* decodeMany({
        decode: decodeSessionRunOutcome,
        entity: ENTITY_RUN,
        rows,
      });
      for (const row of ended) {
        const found = bySession.get(row.agentSessionId);
        if (found === undefined) {
          bySession.set(row.agentSessionId, [row.outcome]);
        } else {
          found.push(row.outcome);
        }
      }
      return bySession;
    });

  /**
   * Sessions matching `where`, newest first, each with the outcomes of its runs.
   *
   * Unbounded on purpose, and bounded in fact: a subject accumulates a session
   * per deliberate restart and a run per retry before the ladder parks the task,
   * so both lists are short. A limit here would instead be a number the resume
   * rule silently depends on.
   */
  const candidatesWhere = (operation: string, where: SQL | undefined) =>
    Effect.gen(function* () {
      const rows = yield* execute(
        operation,
        db
          .select()
          .from(agentSession)
          .where(where)
          .orderBy(desc(agentSession.createdAt), desc(agentSession.id))
      );
      const sessions = yield* decodeMany({
        decode: decodeAgentSession,
        entity: ENTITY,
        rows,
      });
      const outcomes = yield* outcomesOf(operation, sessions);
      return sessions.map(
        (session) =>
          ({
            outcomes: outcomes.get(session.id) ?? [],
            session,
          }) satisfies SessionResumeCandidate
      );
    });

  /**
   * The session a task resumes by default: its newest one {@link isResumable}
   * accepts. Null means there is nothing to resume and the dispatcher opens a
   * fresh session instead.
   *
   * A search rather than a check, which is why the rule is applied in here
   * rather than by the caller: the answer is *which* session, and the newest is
   * not always it. A failed one is stepped over to reach an older resumable
   * session behind it, the same way it always was — what has changed is that
   * "failed" is no longer the whole of the question. A session the wall clock
   * ended is picked up rather than stepped over, because the conversation behind
   * it is intact and the alternative is the next attempt deriving it again from
   * nothing.
   */
  const latestResumable = Effect.fn("AgentSessionRepo.latestResumable")(
    function* (input: SubjectRef) {
      yield* Effect.annotateCurrentSpan({
        subjectId: input.subject.id,
        subjectKind: input.subject.kind,
      });
      const candidates = yield* candidatesWhere(
        "AgentSessionRepo.latestResumable",
        and(
          eq(agentSession.workspaceId, input.workspaceId),
          subjectOf(input.subject)
        )
      );
      return candidates.find(isResumable)?.session ?? null;
    }
  );

  /**
   * One session by id, with what the resume gate needs to judge it. For a task
   * pinned to a specific session: the caller asks {@link isResumable} itself,
   * because a pin is a check on a session already chosen rather than a search
   * for one, and the two answers are worth reading in the same place.
   *
   * Null for a pin whose session has been deleted, which the dispatcher degrades
   * to a fresh session rather than failing on.
   */
  const resumeCandidate = Effect.fn("AgentSessionRepo.resumeCandidate")(
    function* (input: SessionRef) {
      yield* Effect.annotateCurrentSpan({ sessionId: input.id });
      const candidates = yield* candidatesWhere(
        "AgentSessionRepo.resumeCandidate",
        refOf(input)
      );
      return candidates[0] ?? null;
    }
  );

  return {
    advanceWatermark,
    byId,
    fail,
    finish,
    latestResumable,
    listByTask,
    listByThread,
    open,
    recordProviderSession,
    reopen,
    resumeCandidate,
  } as const;
});

/**
 * The agent conversations on a task. Named for the entity rather than for the
 * table the auth library owns: the unqualified word "session" in this codebase
 * means a browser login, and this is the other thing.
 */
export class AgentSessionRepo extends Context.Service<
  AgentSessionRepo,
  Effect.Success<typeof make>
>()("@workspace/db/AgentSessionRepo") {
  static readonly layer = Layer.effect(AgentSessionRepo, make);
}
