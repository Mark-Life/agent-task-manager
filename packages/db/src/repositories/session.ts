import type {
  AgentSession,
  ChatMessageId,
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
  newAgentSessionId,
  SessionStatus,
  UnreadWatermarkId,
} from "@workspace/domain";
import { and, desc, eq, ne } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { Database } from "../client";
import {
  AgentSessionInsert,
  AgentSessionUpdate,
  decodeAgentSession,
} from "../rows";
import { agentSession } from "../schema/agent-session";
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
   * The session a task resumes by default: its newest one that did not fail.
   * Having ended disqualifies nothing — a cleanly finished session is the normal
   * resume target, which is what "continue the task's latest session" means — so
   * only a failure is excluded. Null means there is nothing to resume and the
   * dispatcher opens a fresh session instead.
   */
  const latestResumable = Effect.fn("AgentSessionRepo.latestResumable")(
    function* (input: SubjectRef) {
      yield* Effect.annotateCurrentSpan({
        subjectId: input.subject.id,
        subjectKind: input.subject.kind,
      });
      const rows = yield* execute(
        "AgentSessionRepo.latestResumable",
        db
          .select()
          .from(agentSession)
          .where(
            and(
              eq(agentSession.workspaceId, input.workspaceId),
              subjectOf(input.subject),
              ne(agentSession.status, "failed")
            )
          )
          .orderBy(desc(agentSession.createdAt), desc(agentSession.id))
          .limit(ONE)
      );
      const found = yield* decodeMany({
        decode: decodeAgentSession,
        entity: ENTITY,
        rows,
      });
      return found[0] ?? null;
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
