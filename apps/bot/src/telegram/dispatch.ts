/**
 * The router: one inbound message becomes one row, or it does not.
 *
 * Everything that decides *whether* a message reaches the manager lives here,
 * so the decision is made once. A message that is not a supported kind is
 * refused with a sentence. A message that arrives while the chat is armed for a
 * comment becomes a comment on that task instead. Everything else is written to
 * `chat_message`, and that write is the whole of this bot's dispatch: the insert
 * trigger wakes the orchestrator, which claims the thread and runs the turn.
 *
 * **Nothing here runs an agent.** There is no container, no prompt, no session
 * and no fiber holding a turn. What the router does after the write is ask the
 * database one question — is a turn already live on this thread — and say so.
 *
 * **The queue is the unread rows, not a list in this process.** A message that
 * arrives mid-turn is stored like any other and stays unread, so the next turn
 * reads it with everything else that arrived. The person is told it is waiting
 * and given the button that stops the turn in flight; both are in `./answer`,
 * because they are what the bot *says* rather than what it decides.
 *
 * **Nothing here holds a grammy context past the reply it is sending.** Every
 * call downstream takes plain values — a chat id, a thread — because a context
 * captured before a five-minute turn answers into a conversation that has moved
 * on and its callback query has already expired.
 */

import {
  type ChatMessageAppend,
  ChatMessageRepo,
  type ChatThreadRepo,
  RunRepo,
} from "@workspace/db";
import type { ChatThread, TaskId } from "@workspace/domain";
import { TelegramMessageId } from "@workspace/domain";
import { Effect, FiberSet, type Redacted } from "effect";
import type { Bot } from "grammy";
import { CurrentChatProgress, observeChat } from "../chat-event";
import type { TranscribeService } from "../transcribe";
import { noteQueued, type QueueNotices } from "./answer";
import { Board } from "./board";
import type { BotService } from "./bot-service";
import type { BotContext } from "./context";
import { swallow } from "./helpers";
import {
  type IntakeHandler,
  type IntakeUpdate,
  isIntakeMessage,
  type ResolvedIntake,
  refusalFor,
  resolveIntake,
} from "./intake";
import { ensureThread, telegramChatIdOf } from "./threads";

/**
 * The chats waiting for their next message to become a comment, armed by the
 * Comment button.
 *
 * In memory, per chat, and consumed by the first message that follows: a person
 * who taps *Comment* and then changes their mind sends anything else and the
 * arming is spent. Nothing durable, because an intent that survives a restart
 * would silently swallow a message sent hours later.
 */
export interface PendingComments {
  readonly arm: (input: { chatId: number; taskId: TaskId }) => void;
  readonly take: (chatId: number) => TaskId | null;
}

/** Builds the pending-comment state. One per process. */
export const makePendingComments = (): PendingComments => {
  const armed = new Map<number, TaskId>();
  return {
    arm: ({ chatId, taskId }) => {
      armed.set(chatId, taskId);
    },
    take: (chatId) => {
      const taskId = armed.get(chatId) ?? null;
      armed.delete(chatId);
      return taskId;
    },
  };
};

/** What the router's own effects need from the layer stack. */
export type DispatchServices =
  | Board
  | BotService
  | ChatMessageRepo
  | ChatThreadRepo
  | RunRepo
  | TranscribeService;

/** What building the router takes. */
export interface DispatcherOptions {
  readonly api: Bot<BotContext>["api"];
  readonly botToken: Redacted.Redacted<string>;
  /** Where the "still working" line for each thread is remembered. */
  readonly notices: QueueNotices;
  readonly pending: PendingComments;
}

/** The `chat_message` row a resolved user message fills. */
const userMessageRow = (input: {
  readonly message: ResolvedIntake;
  readonly thread: ChatThread;
}): ChatMessageAppend => ({
  body: input.message.body,
  forwardFrom: input.message.forwardFrom,
  intakeKind: input.message.intakeKind,
  role: "user",
  telegramChatId: input.thread.chatId,
  telegramMessageId: TelegramMessageId.make(input.message.telegramMessageId),
  threadId: input.thread.id,
  transcriptChars: input.message.transcriptChars,
  workspaceId: input.thread.workspaceId,
});

/**
 * Builds the router.
 *
 * Scoped, because the fiber set the updates run in is: when the scope closes,
 * an update still being classified is interrupted rather than left holding a
 * connection.
 */
export const makeDispatcher = Effect.fnUntraced(function* (
  options: DispatcherOptions
) {
  const { api, botToken, notices, pending } = options;
  const board = yield* Board;
  const messages = yield* ChatMessageRepo;
  const runs = yield* RunRepo;

  const runUpdate = yield* FiberSet.makeRuntimePromise<DispatchServices>();

  /** Say one thing into the chat, and never fail the update because it could not be said. */
  const reply = (ctx: BotContext, text: string) =>
    Effect.promise(() => ctx.reply(text).catch(swallow));

  /** The armed-comment path: the next message becomes a comment, not a turn. */
  const postComment = Effect.fnUntraced(function* (input: {
    readonly body: string;
    readonly ctx: BotContext;
    readonly taskId: TaskId;
    readonly threadId: ChatThread["id"];
  }) {
    const { ctx, taskId } = input;
    const posted = yield* board
      .addComment({
        actor: {
          threadId: input.threadId,
          userId: ctx.identity.userId,
          workspaceId: ctx.identity.workspaceId,
        },
        body: input.body,
        taskId,
      })
      .pipe(Effect.option);

    yield* reply(
      ctx,
      posted._tag === "Some"
        ? "Comment posted."
        : "That comment did not reach the board."
    );
  });

  /** One inbound message, from classification to stored row. */
  const handle = Effect.fnUntraced(function* (
    update: IntakeUpdate<BotContext>
  ) {
    const { classification, ctx } = update;
    const chatId = ctx.chat?.id ?? null;
    if (chatId === null) {
      return;
    }

    if (!isIntakeMessage(classification)) {
      yield* observeChat({ outcome: "rejected", promptChars: 0 });
      yield* reply(ctx, refusalFor(classification.reason));
      return;
    }

    const thread = yield* ensureThread({
      chatId: telegramChatIdOf(chatId),
      userId: ctx.identity.userId,
      workspaceId: ctx.identity.workspaceId,
    });
    yield* observeChat({ provider: thread.provider, threadId: thread.id });

    const resolved = yield* resolveIntake({
      api,
      message: classification,
      token: botToken,
    }).pipe(Effect.option);

    if (resolved._tag === "None") {
      yield* reply(ctx, "That message could not be read.");
      return;
    }

    const message = resolved.value;
    yield* observeChat({
      promptChars: message.chars,
      transcribeMs: message.transcribeMs,
      transcriptChars: message.transcriptChars,
      updateKind: message.intakeKind,
    });

    const armed = pending.take(chatId);
    if (armed !== null) {
      yield* postComment({
        body: message.body,
        ctx,
        taskId: armed,
        threadId: thread.id,
      });
      return;
    }

    // The write *is* the dispatch: the insert trigger publishes on
    // `atm_chat_dispatch` and the orchestrator claims the thread from there.
    yield* messages.append(userMessageRow({ message, thread }));

    // Asked after the write, so a turn that claimed the thread in between is
    // seen. The other way round, a message would look like it starts a turn and
    // then sit silently behind one.
    const live = yield* runs.liveForThread({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    });
    if (live === null) {
      return;
    }

    yield* observeChat({ outcome: "queued", runId: live.id });
    yield* noteQueued({ chatId, notices, threadId: thread.id });
  });

  /**
   * The shape `registerIntake` takes: one message in, a promise that settles
   * when the update has been dealt with. A rejection travels back up grammy's
   * middleware chain to whatever is recording this update, which is where a
   * failed handler becomes a row rather than a silence.
   */
  const handleUpdate: IntakeHandler<BotContext> = (update) =>
    runUpdate(
      // The runtime under this was built at boot and knows nothing about this
      // update; the cell the row is accumulated in comes off the context, which
      // is the one thing that does.
      handle(update).pipe(
        Effect.provideService(CurrentChatProgress, update.ctx.progress)
      )
    );

  return { handle, handleUpdate } as const;
});

/** The router, derived so a caller cannot restate its shape wrongly. */
export type Dispatcher = Effect.Success<ReturnType<typeof makeDispatcher>>;
