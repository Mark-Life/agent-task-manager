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
 * **A voice note is answered twice.** Before anything is stored, the words it
 * turned out to hold are echoed back into the chat — see `./voice` — because
 * the sender of a voice note has no other way to see what was heard. Then it
 * takes the same path every other message takes.
 *
 * **The queue is the unread rows, not a list in this process.** A message that
 * arrives mid-turn is stored like any other and stays unread, so the next turn
 * reads it with everything else that arrived. The person is told it is waiting
 * and given the button that stops the turn in flight; both are in `./answer`,
 * because they are what the bot *says* rather than what it decides.
 *
 * **Compose is the one thing that is a list in this process.** A chat with an
 * open compose buffer holds its messages instead of storing them — resolved the
 * same way, transcribed the same way, and then handed to `./compose` rather than
 * to the store. Nothing runs until the *Send* button, and what that writes is
 * one row for the whole batch, through the same append every other message takes.
 * The buffer is checked before the armed comment and before the write, because
 * those are the two things it has to come first of.
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
import type {
  ChatThread,
  TaskId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { TelegramMessageId } from "@workspace/domain";
import { Clock, Effect, FiberSet, type Redacted } from "effect";
import type { Bot } from "grammy";
import { CurrentChatProgress, observeChat } from "../chat-event";
import type { TranscribeService } from "../transcribe";
import { noteQueued, type QueueNotices } from "./answer";
import { Board } from "./board";
import type { BotService } from "./bot-service";
import {
  COMPOSE_EXPIRED_TEXT,
  COMPOSE_TIMED_OUT_TEXT,
  type ComposeBuffers,
  type ComposePiece,
  closeCompose,
  composeRow,
  showCompose,
} from "./compose";
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
import {
  echoTranscript,
  echoTranscriptFailure,
  openTranscriptNotice,
} from "./voice";

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
  /** Where a chat's held messages wait for its *Send* button. */
  readonly compose: ComposeBuffers;
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
  const { api, botToken, compose, notices, pending } = options;
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

  /**
   * Say whether a turn was already running when this write landed.
   *
   * Asked after the write, so a turn that claimed the thread in between is
   * seen. The other way round, a message would look like it starts a turn and
   * then sit silently behind one.
   */
  const noteIfQueued = Effect.fnUntraced(function* (input: {
    readonly chatId: number;
    readonly thread: ChatThread;
  }) {
    const { chatId, thread } = input;
    const live = yield* runs.liveForThread({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    });
    if (live === null) {
      return null;
    }
    yield* observeChat({ outcome: "queued", runId: live.id });
    yield* noteQueued({ chatId, notices, threadId: thread.id });
    return live.id;
  });

  /**
   * Write a held batch as one row — what the *Send* button does.
   *
   * Everything a batch is, it is here: one append, so one insert, so one
   * trigger, so one turn. The row is filed under the last message it contains,
   * because that is the last thing the person actually sent and the one a reply
   * in the chat sits below.
   *
   * Nothing after the append may fail this effect, and that is the point rather
   * than tidiness: a failure is what puts the batch back in the buffer for the
   * person to send again, so a failure raised *after* the write would be a
   * second turn on the same words. Asking whether a turn was already running is
   * therefore best-effort here, where the same question fails the update on the
   * ordinary path — nothing retries an ordinary message.
   */
  const submitCompose = Effect.fn("bot.compose.submit")(function* (input: {
    readonly chatId: number;
    readonly pieces: readonly ComposePiece[];
    readonly userId: UserId;
    readonly workspaceId: WorkspaceId;
  }) {
    const { chatId, pieces } = input;
    const thread = yield* ensureThread({
      chatId: telegramChatIdOf(chatId),
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    const row = composeRow(pieces);
    yield* observeChat({
      promptChars: row.body.length,
      provider: thread.provider,
      threadId: thread.id,
    });

    yield* messages.append({
      ...row,
      role: "user",
      telegramChatId: thread.chatId,
      telegramMessageId: TelegramMessageId.make(
        pieces.at(-1)?.telegramMessageId ?? 0
      ),
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    });

    const queuedBehind = yield* noteIfQueued({ chatId, thread }).pipe(
      Effect.orElseSucceed(() => null)
    );
    return { chars: row.body.length, queuedBehind, thread } as const;
  });

  /**
   * Hold a resolved message in the chat's compose buffer, and say whether it
   * was held — false meaning "carry on and store it the ordinary way".
   *
   * Two things fall through rather than being swallowed. A session nobody added
   * to for the idle window is gone, and the message that found it out is told
   * so and then handled normally. And a message that misses the buffer it
   * peeked at — the *Send* button was tapped while this voice note was still
   * being transcribed — is stored rather than dropped, which is the only
   * behaviour that never loses words.
   */
  const capture = Effect.fnUntraced(function* (input: {
    readonly chatId: number;
    readonly ctx: BotContext;
    readonly message: ResolvedIntake;
  }) {
    const { chatId, ctx } = input;
    const now = yield* Clock.currentTimeMillis;
    const state = compose.peek({ chatId, now });
    if (state.kind === "idle") {
      return false;
    }
    if (state.kind === "expired") {
      // The buttons on the abandoned message are taken away as well as
      // answered: a live *Send* over a buffer that no longer exists is the one
      // thing left in the chat still claiming to hold somebody's words.
      yield* closeCompose({
        api,
        chatId,
        messageId: state.session.anchorMessageId,
        text: COMPOSE_TIMED_OUT_TEXT,
      });
      yield* reply(ctx, COMPOSE_EXPIRED_TEXT);
      return false;
    }

    const held = compose.add({ chatId, now, piece: input.message });
    if (held === null) {
      return false;
    }
    yield* showCompose({
      api,
      chatId,
      messageId: held.anchorMessageId,
      waiting: held.pieces.length,
    });
    yield* observeChat({ outcome: "composing" });
    return true;
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
      // The shape goes on the row, not into a log line: the next message this
      // bot cannot read should be answerable from the ledger in one query
      // rather than from a person describing what they sent.
      yield* observeChat({
        outcome: "rejected",
        promptChars: 0,
        refusedShape: classification.shape,
      });
      yield* reply(ctx, refusalFor(classification.reason));
      return;
    }

    const thread = yield* ensureThread({
      chatId: telegramChatIdOf(chatId),
      userId: ctx.identity.userId,
      workspaceId: ctx.identity.workspaceId,
    });
    yield* observeChat({ provider: thread.provider, threadId: thread.id });

    // A voice note is the one intake whose sender cannot see what arrived, so
    // the chat says it is listening and then says what it heard. Opened before
    // the transcription because the transcription is the wait.
    const notice =
      classification.kind === "voice"
        ? yield* openTranscriptNotice({
            api,
            chatId,
            replyToMessageId: classification.telegramMessageId,
          })
        : null;

    const resolved = yield* resolveIntake({
      api,
      message: classification,
      token: botToken,
    }).pipe(Effect.option);

    if (resolved._tag === "None") {
      if (classification.kind === "voice") {
        yield* echoTranscriptFailure({ api, chatId, noticeId: notice });
        return;
      }
      yield* reply(ctx, "That message could not be read.");
      return;
    }

    const message = resolved.value;
    if (classification.kind === "voice") {
      yield* echoTranscript({
        api,
        chatId,
        noticeId: notice,
        text: message.body,
      });
    }
    yield* observeChat({
      promptChars: message.chars,
      transcribeMs: message.transcribeMs,
      transcriptChars: message.transcriptChars,
      updateKind: message.intakeKind,
    });

    // Compose comes first, because it is the mode that says nothing else
    // happens.
    if (yield* capture({ chatId, ctx, message })) {
      return;
    }

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
    yield* noteIfQueued({ chatId, thread });
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

  return { handle, handleUpdate, submitCompose } as const;
});

/** The router, derived so a caller cannot restate its shape wrongly. */
export type Dispatcher = Effect.Success<ReturnType<typeof makeDispatcher>>;
