import type {
  ActorAttribution,
  RunId,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import {
  flattenActor,
  newRunCommandId,
  type RunCommandId,
  type RunCommandKind,
  RunCommandPayload,
  splitPayload,
} from "@workspace/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { CurrentActor } from "../actor";
import { Database } from "../client";
import {
  decodeRunCommand,
  JsonObject,
  RunCommandInsert,
  RunCommandUpdate,
} from "../rows";
import { runCommand } from "../schema/run";
import {
  decodeMany,
  decodeWritten,
  encodeWrite,
  execute,
  InvalidInput,
  unauditedTransaction,
} from "./audit";

/** The queue is drained one command at a time: there is exactly one orchestrator. */
const ONE = 1;

/** How many commands a task's history returns unless told otherwise. */
const DEFAULT_LIMIT = 200;

/** The table these rows live in, and what an error names them as. */
const ENTITY = "run_command";

/** The predicate of the partial unique index a second identical intent collides with. */
const stillPending = sql`${runCommand.status} = 'pending'`;

const encodePayload = Schema.encodeEffect(RunCommandPayload);
const asBlob = Schema.decodeUnknownEffect(JsonObject);

/**
 * The command's own attribution: the same columns an audit row carries, minus
 * the manager's chat thread, which only a record of a mutation needs.
 */
const commandActor = ({
  actorKind,
  actorRunId,
  actorSessionId,
  actorUserId,
}: ActorAttribution) => ({
  actorKind,
  actorRunId,
  actorSessionId,
  actorUserId,
});

/** What asking for something needs. Who is asking comes from the context, not from here. */
interface EnqueueInput {
  readonly payload: RunCommandPayload;
  /** Absent targets whichever run is live. */
  readonly runId?: RunId;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}

const make = Effect.gen(function* () {
  const db = yield* Database;
  const inTransaction = unauditedTransaction(db);

  /**
   * Writes an intent for the orchestrator to act on. Anyone may write one — a
   * human, the manager, an agent holding a task-scoped token — and only the
   * orchestrator acts, which is what keeps one owner of container lifecycle while
   * everybody steers through the same rows.
   *
   * There is no audit row and there does not need to be one: this table already
   * records who asked, in columns of its own. The actor is still required from
   * the context, so an intent with nobody behind it does not compile.
   *
   * A second identical intent while the first is still pending is a no-op — a
   * double-clicked Stop returns the command already queued instead of landing a
   * second one that could only ever be rejected as noise.
   */
  const enqueue = Effect.fn("RunCommandRepo.enqueue")(function* (
    input: EnqueueInput
  ) {
    const actor = yield* CurrentActor;
    const encoded = yield* Effect.mapError(
      encodePayload(input.payload),
      (cause) => new InvalidInput({ cause, entity: ENTITY })
    );
    // The tag is named explicitly because the split is generic over any tagged
    // payload: without it the discriminator comes back as a bare string and the
    // column would take one.
    const { kind, payload } = splitPayload<RunCommandKind, typeof encoded>(
      encoded
    );
    yield* Effect.annotateCurrentSpan({ kind, taskId: input.taskId });
    const blob = yield* Effect.mapError(
      asBlob(payload),
      (cause) => new InvalidInput({ cause, entity: ENTITY })
    );
    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: RunCommandInsert,
      value: {
        ...commandActor(flattenActor(actor)),
        consumedAt: null,
        id: newRunCommandId(),
        kind,
        payload: blob,
        runId: input.runId ?? null,
        status: "pending",
        taskId: input.taskId,
        workspaceId: input.workspaceId,
      },
    });
    const written = yield* execute(
      "RunCommandRepo.enqueue",
      db
        .insert(runCommand)
        .values(values)
        .onConflictDoNothing({
          target: [runCommand.taskId, runCommand.kind],
          where: stillPending,
        })
        .returning()
    );
    const inserted = yield* decodeMany({
      decode: decodeRunCommand,
      entity: ENTITY,
      rows: written,
    });
    const [fresh] = inserted;
    if (fresh !== undefined) {
      return fresh;
    }
    const existing = yield* execute(
      "RunCommandRepo.enqueue",
      db
        .select()
        .from(runCommand)
        .where(
          and(
            eq(runCommand.workspaceId, input.workspaceId),
            eq(runCommand.taskId, input.taskId),
            eq(runCommand.kind, kind),
            stillPending
          )
        )
        .limit(ONE)
    );
    return yield* decodeWritten({
      decode: decodeRunCommand,
      entity: ENTITY,
      operation: "RunCommandRepo.enqueue",
      rows: existing,
    });
  });

  /**
   * Takes the oldest pending command off the queue and hands it over, or null
   * when nothing is waiting.
   *
   * Claiming and consuming are one step on purpose: a command that came back
   * still pending would be handed out again by the next poll, and a stop
   * delivered twice kills the container that replaced the one it meant. What the
   * orchestrator then decides — act, or refuse with {@link reject} — is recorded
   * on the row it already holds.
   *
   * The row lock skips whatever another poller is holding, so a second
   * orchestrator process would divide the queue rather than fight over it. No
   * audit row: this repository's rows are themselves the record of who asked for
   * what, and taking one off the queue changes nobody's intent.
   */
  const claimNext = Effect.fn("RunCommandRepo.claimNext")(function* (input: {
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ workspaceId: input.workspaceId });
    return yield* inTransaction(
      { operation: "RunCommandRepo.claimNext", table: ENTITY },
      (tx) =>
        Effect.gen(function* () {
          const pending = yield* execute(
            "RunCommandRepo.claimNext",
            tx
              .select({ id: runCommand.id })
              .from(runCommand)
              .where(
                and(eq(runCommand.workspaceId, input.workspaceId), stillPending)
              )
              .orderBy(asc(runCommand.createdAt), asc(runCommand.id))
              .limit(ONE)
              .for("update", { skipLocked: true })
          );
          const [next] = pending;
          if (next === undefined) {
            return null;
          }
          const consumedAt = yield* DateTime.now;
          const values = yield* encodeWrite({
            entity: ENTITY,
            schema: RunCommandUpdate,
            value: { consumedAt, status: "consumed" },
          });
          const written = yield* execute(
            "RunCommandRepo.claimNext",
            tx
              .update(runCommand)
              .set(values)
              .where(eq(runCommand.id, next.id))
              .returning()
          );
          return yield* decodeWritten({
            decode: decodeRunCommand,
            entity: ENTITY,
            operation: "RunCommandRepo.claimNext",
            rows: written,
          });
        })
    );
  });

  /**
   * Records that a claimed command was not acted on, and why. "No live run" and
   * "task not in progress" are outcomes the asker is entitled to see, not
   * silence — a rerun on a task that is not in progress is refused here rather
   * than becoming a back door into the status machine.
   */
  const reject = Effect.fn("RunCommandRepo.reject")(function* (input: {
    readonly id: RunCommandId;
    readonly reason: string;
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ commandId: input.id });
    const values = yield* encodeWrite({
      entity: ENTITY,
      schema: RunCommandUpdate,
      value: { rejectedReason: input.reason, status: "rejected" },
    });
    const written = yield* execute(
      "RunCommandRepo.reject",
      db
        .update(runCommand)
        .set(values)
        .where(
          and(
            eq(runCommand.workspaceId, input.workspaceId),
            eq(runCommand.id, input.id)
          )
        )
        .returning()
    );
    return yield* decodeWritten({
      decode: decodeRunCommand,
      entity: ENTITY,
      operation: "RunCommandRepo.reject",
      rows: written,
    });
  });

  /** Every intervention on a task, newest first, whether it was acted on or refused. */
  const listByTask = Effect.fn("RunCommandRepo.listByTask")(function* (input: {
    readonly limit?: number;
    readonly taskId: TaskId;
    readonly workspaceId: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ taskId: input.taskId });
    const rows = yield* execute(
      "RunCommandRepo.listByTask",
      db
        .select()
        .from(runCommand)
        .where(
          and(
            eq(runCommand.workspaceId, input.workspaceId),
            eq(runCommand.taskId, input.taskId)
          )
        )
        .orderBy(desc(runCommand.createdAt), desc(runCommand.id))
        .limit(input.limit ?? DEFAULT_LIMIT)
    );
    return yield* decodeMany({
      decode: decodeRunCommand,
      entity: ENTITY,
      rows,
    });
  });

  return { claimNext, enqueue, listByTask, reject } as const;
});

/**
 * Stop, rerun and start-session: the intents anyone may write and
 * only the orchestrator acts on. A research session spawned from the backlog
 * arrives here too, as a `start_session`, so run creation stays in one place and
 * the request rides the notify channel that already exists.
 */
export class RunCommandRepo extends Context.Service<
  RunCommandRepo,
  Effect.Success<typeof make>
>()("@workspace/db/RunCommandRepo") {
  static readonly layer = Layer.effect(RunCommandRepo, make);
}
