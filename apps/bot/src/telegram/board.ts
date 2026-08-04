/**
 * The one door between this chat and the board.
 *
 * The bot owns the conversation; the gateway owns the board. A tapped *Approve*
 * and the manager agent asking for the same move are the same HTTP call with
 * the same credential and the same refusal, because there is no second path — a
 * handler here cannot reach a repository that writes a task, and the store the
 * bot is given makes that a compile error rather than a rule someone remembers.
 *
 * **The credential is minted per call, never held.** A manager token is short
 * lived and carries the thread it was minted for, which is what puts
 * `actor_thread_id` on every audit row a chat causes and is the whole reason
 * `/notify` can later find its way back to the conversation that asked. Minting
 * is injected rather than done here so this file has no opinion about signing
 * keys; the composition root supplies it.
 *
 * **A refusal is a value, not a failure.** The gateway answers a stop on a task
 * with no live run by writing a `run_command` row with `rejectedReason` on it.
 * That comes back as an ordinary success, so a handler can say *"there is no
 * live run to stop"* rather than reporting an error it would have to invent
 * words for. What {@link BoardError} means is the narrower thing: the call did
 * not happen — no token, no network, an unexpected shape.
 */

import { Api, type TaskPlacement } from "@workspace/api";
import type {
  ProjectId,
  TaskId,
  TaskStatus,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { clipError } from "@workspace/telemetry";
import { Context, Effect, Layer, type Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { ChatIdentity } from "./context";

/** Who a board write is attributed to: a person, speaking through one thread. */
export interface ManagerActorRef {
  /** Null only where no conversation caused the write — a scan, a repair pass. */
  readonly threadId: ThreadId | null;
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The call did not happen. Distinct from a call the gateway answered with a
 * refusal, which is a success carrying a reason.
 *
 * `detail` is what a person is shown, so it goes through the same sanitizer the
 * event ledger uses — an error carrying a URL with a token in it must not reach
 * a chat any more than it may reach a log line.
 */
export class BoardError extends Schema.TaggedErrorClass<BoardError>()(
  "Bot.BoardCallFailed",
  { detail: Schema.String, operation: Schema.String }
) {
  override get message() {
    return `${this.operation} — ${this.detail}`;
  }
}

/**
 * Who a board write is attributed to, read off the update and the conversation
 * it happened in. One spelling, so no handler can attribute a write to a
 * different pair than the one the gate resolved.
 */
export const actorFor = (options: {
  readonly ctx: { readonly identity: ChatIdentity };
  readonly threadId: ThreadId | null;
}): ManagerActorRef => ({
  threadId: options.threadId,
  userId: options.ctx.identity.userId,
  workspaceId: options.ctx.identity.workspaceId,
});

/**
 * Mints a manager-scoped gateway token for one call.
 *
 * A function rather than a service so that the signing key, its TTL and the
 * actor schema stay in one module and this one stays about the board.
 */
export type MintManagerToken = (
  actor: ManagerActorRef
) => Effect.Effect<Redacted.Redacted<string>, BoardError>;

/** What building the board client takes. */
export interface BoardOptions {
  /** The gateway as *this process* reaches it, which is not what a container calls it. */
  readonly baseUrl: string;
  readonly mint: MintManagerToken;
}

/** Anything that went wrong on the wire, in the one shape a handler can print. */
const toBoardError = (operation: string) => (cause: unknown) => {
  const detail =
    cause instanceof Error
      ? clipError(`${cause.name}: ${cause.message}`)
      : clipError(String(cause));
  return new BoardError({ detail, operation });
};

const make = (options: BoardOptions) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;

    /**
     * One authenticated client, for one call. Constructed per call because the
     * token is: a client built once would outlive the credential inside it.
     */
    const clientFor = (actor: ManagerActorRef) =>
      Effect.gen(function* () {
        const token = yield* options.mint(actor);
        return yield* HttpApiClient.make(Api, {
          baseUrl: options.baseUrl,
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken(token)
          ),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      });

    /** Run one gateway call under a freshly minted credential. */
    const call = <A>(input: {
      readonly actor: ManagerActorRef;
      readonly operation: string;
      readonly run: (
        client: Effect.Success<ReturnType<typeof clientFor>>
      ) => Effect.Effect<A, unknown, never>;
    }) =>
      clientFor(input.actor).pipe(
        Effect.flatMap(input.run),
        Effect.mapError((cause) =>
          cause instanceof BoardError
            ? cause
            : toBoardError(input.operation)(cause)
        ),
        Effect.withSpan(input.operation)
      );

    /** Every task in the workspace, optionally one column or one project's. */
    const listTasks = (input: {
      readonly actor: ManagerActorRef;
      readonly projectId?: ProjectId;
      readonly status?: TaskStatus;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.listTasks",
        run: (client) =>
          client.tasks.list({
            query: {
              ...(input.projectId === undefined
                ? {}
                : { projectId: input.projectId }),
              ...(input.status === undefined ? {} : { status: input.status }),
            },
          }),
      });

    /** The whole board, column by column, in one round trip. */
    const columns = (input: { readonly actor: ManagerActorRef }) =>
      call({
        actor: input.actor,
        operation: "bot.board.columns",
        run: (client) => client.tasks.board({ query: {} }),
      });

    /** One task, its project and the run working on it right now if there is one. */
    const taskDetail = (input: {
      readonly actor: ManagerActorRef;
      readonly taskId: TaskId;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.taskDetail",
        run: (client) => client.tasks.get({ params: { taskId: input.taskId } }),
      });

    /** Move a task to another column. Refused moves come back as a typed failure. */
    const moveTask = (input: {
      readonly actor: ManagerActorRef;
      readonly taskId: TaskId;
      readonly to: TaskStatus;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.moveTask",
        run: (client) =>
          client.tasks.transition({
            params: { taskId: input.taskId },
            payload: { to: input.to },
          }),
      });

    /**
     * Move a task within its column — which is what re-prioritizing means, and
     * why it is a placement rather than a run command: the orchestrator spends
     * its next slot on the top of `in_progress`, so position in the column *is*
     * position in the queue. `after: null` is the top.
     */
    const placeTask = (input: {
      readonly actor: ManagerActorRef;
      readonly after: TaskPlacement["after"];
      readonly taskId: TaskId;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.placeTask",
        run: (client) =>
          client.tasks.place({
            params: { taskId: input.taskId },
            payload: { after: input.after },
          }),
      });

    /** Ask the orchestrator to kill the run on a task. Idempotent by construction. */
    const stopRun = (input: {
      readonly actor: ManagerActorRef;
      readonly taskId: TaskId;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.stopRun",
        run: (client) =>
          client.runCommands.stop({
            params: { taskId: input.taskId },
            payload: {},
          }),
      });

    /**
     * Ask the orchestrator to stop the turn running in a conversation, which
     * is what the *Force send* button means.
     *
     * The same `run_command` row a human's Stop on a task writes, naming the
     * thread instead. The interrupted turn's unread messages stay unread, so the
     * next dispatch resumes the session with them appended; there is no path
     * here that hands a message to a container directly.
     */
    const stopThread = (input: {
      readonly actor: ManagerActorRef;
      readonly threadId: ThreadId;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.stopThread",
        run: (client) =>
          client.threads.stop({
            params: { threadId: input.threadId },
            payload: {},
          }),
      });

    /** Ask the orchestrator to run a task again. */
    const rerunTask = (input: {
      readonly actor: ManagerActorRef;
      readonly taskId: TaskId;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.rerunTask",
        run: (client) =>
          client.runCommands.rerun({
            params: { taskId: input.taskId },
            payload: {},
          }),
      });

    /** Say something on a task. The author comes off the credential, not the payload. */
    const addComment = (input: {
      readonly actor: ManagerActorRef;
      readonly body: string;
      readonly taskId: TaskId;
    }) =>
      call({
        actor: input.actor,
        operation: "bot.board.addComment",
        run: (client) =>
          client.comments.append({
            params: { taskId: input.taskId },
            payload: { body: input.body },
          }),
      });

    return {
      addComment,
      columns,
      listTasks,
      moveTask,
      placeTask,
      rerunTask,
      stopRun,
      stopThread,
      taskDetail,
    } as const;
  });

/**
 * The board, as this app is allowed to touch it.
 *
 * The layer provides its own `HttpClient` rather than requiring one, so nothing
 * above has to know that reaching the board is HTTP at all — which is also what
 * keeps a future in-process transport a change to this file alone.
 */
export class Board extends Context.Service<
  Board,
  Effect.Success<ReturnType<typeof make>>
>()("@workspace/bot/Board") {
  static readonly layer = (options: BoardOptions) =>
    Layer.effect(Board, make(options)).pipe(
      Layer.provide(FetchHttpClient.layer)
    );
}
