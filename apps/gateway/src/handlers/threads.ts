/**
 * Conversations with the manager agent, and the turns they cause.
 *
 * The one thing this file is careful about is that posting a message is not a
 * special HTTP path into the agent. It writes a `chat_message` row and stops —
 * the same row the bot writes for a sentence typed into Telegram — and the
 * insert is what the orchestrator is listening for. So the two interfaces
 * cannot drift: there is one dispatch source, one queue, one turn per thread,
 * and a message that arrives here while a turn is running is unread rather than
 * held, exactly as one from a chat is.
 *
 * Nothing here starts, stops or waits for a container. Cutting a turn short is
 * an intent on the orchestrator's queue, written the way a worker's stop is,
 * which is what keeps container lifecycle with its one owner.
 *
 * Every read proves the thread first. A thread lookup is scoped to the
 * workspace and no further, so proving it once at the top of a handler is what
 * makes "no such conversation" a 404 rather than an empty page a caller reads
 * as an idle thread.
 */

import {
  Api,
  DEFAULT_MESSAGE_PAGE,
  DEFAULT_THREAD_PAGE,
  Forbidden,
  InvalidInput,
  NotFound,
  Principal,
} from "@workspace/api";
import {
  ChatMessageRepo,
  ChatThreadRepo,
  type MalformedRow,
  type PersistenceError,
  RunCommandRepo,
  RunRepo,
  InvalidInput as StoreInvalidInput,
  NotFound as StoreNotFound,
  withActor,
} from "@workspace/db";
import type {
  Actor,
  ChatThread,
  RunId,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";

/**
 * Which harness answers a conversation when the caller names none. One
 * provider is the chat provider at a time, and a thread that silently opened
 * against the other would resume against a session it never wrote.
 */
const DEFAULT_PROVIDER = "claude" as const;

/** How much of a refusal is repeated back: enough to name the field, short enough to bound the body. */
const DETAIL_LIMIT = 240;

/** What reading or writing through the store can fail with. */
type StoreFailure =
  | MalformedRow
  | PersistenceError
  | StoreInvalidInput
  | StoreNotFound;

/**
 * Turns a store failure into the one this API declares.
 *
 * `Db.NotFound` is the only one the caller had a hand in on a read. A row that
 * no longer decodes or a driver that fell over is a defect: dying on it puts it
 * in the ledger as a 500 rather than in the contract as an outcome an agent
 * might branch on.
 */
const asNotFound = (failure: StoreFailure) =>
  failure instanceof StoreNotFound
    ? Effect.fail(new NotFound({ entity: failure.entity, id: failure.id }))
    : Effect.die(failure);

/** The refusal itself, clipped: it is a schema message, and the caller needs the field. */
const refusal = (failure: StoreInvalidInput) =>
  new InvalidInput({
    detail: String(failure.cause).slice(0, DETAIL_LIMIT),
    entity: failure.entity,
  });

/** A write whose row this handler has already proved, so only its contents can be refused. */
const asInvalid = (
  failure: StoreFailure
): Effect.Effect<never, InvalidInput> =>
  failure instanceof StoreInvalidInput
    ? Effect.fail(refusal(failure))
    : Effect.die(failure);

/** A write that can be refused for its contents or for the row it names. */
const asRefusal = (
  failure: StoreFailure
): Effect.Effect<never, InvalidInput | NotFound> =>
  failure instanceof StoreInvalidInput
    ? Effect.fail(refusal(failure))
    : asNotFound(failure);

/** Reads, and the writes that can only fail by naming a row that is not there. */
const wire = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, asNotFound);

/** A write on a proved row. */
const wireInput = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, asInvalid);

/**
 * A read that cannot name a missing row, so nothing it fails with is the
 * caller's doing. A list is one: an empty workspace is an empty page.
 */
const wireList = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.orDie(effect);

/** A write that can be refused either way. */
const wireWrite = <A, R>(effect: Effect.Effect<A, StoreFailure, R>) =>
  Effect.catch(effect, asRefusal);

/** What names a conversation in a request. */
interface ThreadRoute {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

/**
 * Who a conversation speaks for, read off the credential.
 *
 * A thread carries the person it belongs to, and only two kinds of credential
 * name one: a person, and the manager acting on a person's behalf. A run's
 * token and the loop's name no user at all, and rather than inventing one the
 * request is refused — a real credential that does not reach this operation,
 * which is what 403 says.
 */
const speakerOf = (actor: Actor): UserId | null =>
  actor.kind === "human" || actor.kind === "manager" ? actor.userId : null;

/** The conversation the route names, or 404. */
const requireThread = (route: ThreadRoute) =>
  Effect.gen(function* () {
    const threads = yield* ChatThreadRepo;
    return yield* wire(
      threads.byId({ id: route.threadId, workspaceId: route.workspaceId })
    );
  });

/**
 * Refuses a run that is not this thread's turn.
 *
 * The orchestrator resolves a named run by id within the workspace and no
 * further, so without this a caller could queue a stop against a worker's run
 * through a conversation's route. A run under another subject is not this
 * thread's, so it is absent rather than forbidden.
 */
const requireTurn = (route: ThreadRoute & { readonly runId: RunId }) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const run = yield* wire(
      runs.byId({ id: route.runId, workspaceId: route.workspaceId })
    );
    if (run.threadId !== route.threadId) {
      return yield* new NotFound({ entity: "run", id: route.runId });
    }
    return run;
  });

/**
 * Applies whichever of the three changes the patch named, in an order that is
 * the same however they were spelled: the title first, then which thread the
 * chat is speaking to, and retiring it last.
 *
 * Asking to archive and to select in one request is refused rather than
 * ordered — the row's own CHECK will not hold an archived thread that is still
 * current, and picking a winner here would answer half of what was asked.
 */
const applyPatch = (
  route: ThreadRoute,
  patch: {
    readonly isCurrent?: true;
    readonly status?: "archived";
    readonly title?: string | null;
  }
) =>
  Effect.gen(function* () {
    const threads = yield* ChatThreadRepo;
    const ref = { id: route.threadId, workspaceId: route.workspaceId };

    let thread: ChatThread = yield* requireThread(route);

    if (patch.title !== undefined) {
      thread = yield* wire(threads.retitle({ ...ref, title: patch.title }));
    }
    if (patch.isCurrent !== undefined) {
      thread = yield* wireWrite(threads.setCurrent(ref));
    }
    if (patch.status !== undefined) {
      thread = yield* wire(threads.archive(ref));
    }

    return thread;
  });

/** The `threads` group, implemented. */
export const threadsHandlers = HttpApiBuilder.group(
  Api,
  "threads",
  (handlers) =>
    Effect.gen(function* () {
      const on = yield* atBuild<
        ChatMessageRepo | ChatThreadRepo | RunCommandRepo | RunRepo
      >();

      return handlers
        .handle("list", ({ query }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              const threads = yield* ChatThreadRepo;
              return yield* wireList(
                threads.listForWorkspace({
                  limit: query.limit ?? DEFAULT_THREAD_PAGE,
                  offset: query.offset ?? 0,
                  // A retired conversation is kept for its audit trail, not
                  // for the sidebar, so it is absent unless asked for.
                  status: query.status ?? "active",
                  workspaceId,
                })
              );
            })
          )
        )
        .handle("create", ({ payload }) =>
          on(
            Effect.gen(function* () {
              const { actor, workspaceId } = yield* Principal;
              const userId = speakerOf(actor);

              if (userId === null) {
                return yield* new Forbidden({
                  reason:
                    "a conversation speaks for a person, and this credential names none",
                  required: "a credential naming a person",
                });
              }

              const threads = yield* ChatThreadRepo;
              return yield* wireInput(
                threads.open({
                  provider: payload.provider ?? DEFAULT_PROVIDER,
                  title: payload.title,
                  userId,
                  workspaceId,
                })
              );
            })
          )
        )
        .handle("get", ({ params }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              const route = { threadId: params.threadId, workspaceId };
              const thread = yield* requireThread(route);
              const runs = yield* RunRepo;
              const live = yield* wire(runs.liveForThread(route));
              return { liveRunId: live?.id ?? null, thread };
            })
          )
        )
        .handle("patch", ({ params, payload }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;

              if (Object.keys(payload).length === 0) {
                return yield* new InvalidInput({
                  detail: "name a title, a currency or an archive",
                  entity: "chat_thread",
                });
              }
              if (
                payload.isCurrent !== undefined &&
                payload.status !== undefined
              ) {
                return yield* new InvalidInput({
                  detail:
                    "an archived conversation cannot also be the current one",
                  entity: "chat_thread",
                });
              }

              return yield* applyPatch(
                { threadId: params.threadId, workspaceId },
                payload
              );
            })
          )
        )
        .handle("messages", ({ params, query }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              yield* requireThread({
                threadId: params.threadId,
                workspaceId,
              });

              const messages = yield* ChatMessageRepo;
              const limit = query.limit ?? DEFAULT_MESSAGE_PAGE;
              const offset = query.offset ?? 0;
              const page = yield* wire(
                messages.listForThread({
                  limit,
                  offset,
                  threadId: params.threadId,
                  workspaceId,
                })
              );

              // A short page has reached the end of what was said, which on a
              // thread being answered is not the end of the conversation.
              return {
                messages: page,
                nextOffset: page.length < limit ? null : offset + page.length,
              };
            })
          )
        )
        .handle("postMessage", ({ params, payload }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              const route = { threadId: params.threadId, workspaceId };
              const thread = yield* requireThread(route);

              // Only an active thread is dispatched, so a message into a retired
              // one would sit unanswered forever. Saying so is better than
              // accepting words nothing will ever read.
              if (thread.status !== "active") {
                return yield* new InvalidInput({
                  detail:
                    "this conversation is archived; make it current to speak in it",
                  entity: "chat_message",
                });
              }

              // Asked before the row is written, because afterwards the run this
              // very message starts would answer it. Two messages landing in the
              // same instant can both read "not queued"; the thread's live-run
              // index is what actually keeps them to one turn, and the second
              // message is read by that turn either way.
              const runs = yield* RunRepo;
              const live = yield* wire(runs.liveForThread(route));

              const messages = yield* ChatMessageRepo;
              const message = yield* wireWrite(
                messages.append({
                  body: payload.body,
                  intakeKind: "api",
                  role: "user",
                  threadId: params.threadId,
                  workspaceId,
                })
              );

              return { message, queued: live !== null };
            })
          )
        )
        .handle("runs", ({ params }) =>
          on(
            Effect.gen(function* () {
              const { workspaceId } = yield* Principal;
              const route = { threadId: params.threadId, workspaceId };
              yield* requireThread(route);
              const runs = yield* RunRepo;
              return yield* wire(runs.listByThread(route));
            })
          )
        )
        .handle("stop", ({ params, payload }) =>
          on(
            Effect.gen(function* () {
              const { actor, workspaceId } = yield* Principal;
              const route = { threadId: params.threadId, workspaceId };
              yield* requireThread(route);
              if (payload.runId !== undefined) {
                yield* requireTurn({ ...route, runId: payload.runId });
              }

              const commands = yield* RunCommandRepo;
              return yield* wire(
                withActor(actor)(
                  commands.enqueue({
                    payload: { kind: "stop" },
                    runId: payload.runId,
                    subject: { id: params.threadId, kind: "thread" },
                    workspaceId,
                  })
                )
              );
            })
          )
        );
    })
);
