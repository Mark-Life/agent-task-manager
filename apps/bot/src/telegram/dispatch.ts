/**
 * The router: one inbound message becomes one manager turn, or it does not.
 *
 * Everything that decides *whether* a message reaches the manager lives here,
 * so the decision is made once. A message that is not a supported kind is
 * refused with a sentence. A message that arrives while the chat is armed for a
 * comment becomes a comment on that task instead. Everything else is written to
 * `chat_message` and handed to the manager.
 *
 * **The user's row is written before the turn runs.** That ordering is the
 * point: a turn that crashes leaves the question in the thread, so the next
 * prompt shows what went unanswered rather than pretending it was never asked.
 * It also means the new message is already the last row of the thread when the
 * turn builds its prompt — the prompt builder reads history, and must not
 * append the same message a second time.
 *
 * **One turn per thread, and the second message waits.** A conversation with
 * two turns in flight is two agents editing the same board from the same
 * transcript. So a thread's turn is a fiber in a {@link FiberMap} keyed by
 * thread id: while it runs, further messages are answered "still working" and
 * held in memory, and the running fiber drains them when it is done. The queue
 * is memory only and a restart drops it, which is honest and visible — a table
 * would promise a delivery nobody is watching for. One consequence worth
 * knowing: the turns a drain runs are covered by the wide-event row of the
 * update that started the fiber, not by rows of their own.
 *
 * **Nothing here holds a grammy context past the reply it is sending.** The
 * turn is handed plain values — a chat id, a message id, a thread — because a
 * context captured before a five-minute turn answers into a conversation that
 * has moved on and its callback query has already expired.
 */

import {
  type ChatMessageAppend,
  ChatMessageRepo,
  type ChatThreadRepo,
} from "@workspace/db";
import type {
  ChatMessageId,
  ChatThread,
  SessionProvider,
  TaskId,
  ThreadId,
} from "@workspace/domain";
import { TelegramMessageId } from "@workspace/domain";
import { Effect, FiberMap, FiberSet, type Redacted, Schema } from "effect";
import type { Bot } from "grammy";
import { CurrentChatProgress, observeChat } from "../chat-event";
import type { TranscribeService } from "../transcribe";
import { Board } from "./board";
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

/** What a manager turn can fail as, which is also what the row's outcome says. */
export const MANAGER_TURN_FAILURES = [
  "errored",
  "interrupted",
  "timeout",
] as const;

/** What the chat is told while a turn is already running. */
export const BUSY_REPLY = "Still working — /stop to interrupt.";

/**
 * A turn that produced no answer at all. The `kind` is what the wide event's
 * outcome becomes, which is why a stop and a crash are not the same value:
 * folding a deliberate interrupt into `errored` makes every stop look like a
 * fault.
 *
 * The manager that ships never raises it — it reports a failed turn as an
 * ending, having already told the person which class it was. The channel stays
 * because it is the port's, not that implementation's: a turn runner that cannot
 * reach the chat has nothing to report and this is what it says instead.
 */
export class ManagerTurnError extends Schema.TaggedErrorClass<ManagerTurnError>()(
  "Bot.ManagerTurnFailed",
  { detail: Schema.String, kind: Schema.Literals(MANAGER_TURN_FAILURES) }
) {
  override get message() {
    return `${this.kind} — ${this.detail}`;
  }
}

/** Everything the manager needs about one message, and nothing that expires. */
export interface ManagerTurnRequest {
  readonly isPrivateChat: boolean;
  readonly message: ResolvedIntake;
  /**
   * The row this router already wrote for the message, so the turn's prompt can
   * drop it from the history rather than showing the same question twice.
   */
  readonly messageId: ChatMessageId | null;
  /** The inbound message the answer is a reply to, so a busy chat stays readable. */
  readonly replyToMessageId: number | null;
  readonly thread: ChatThread;
}

/**
 * What a finished turn reports.
 *
 * The turn has already said its answer into the chat, written its own
 * `chat_message` row and recorded the session the next one resumes — it is the
 * only thing that knows which message id the answer landed in and what the
 * container did. What comes back here is what the update's `atm.chat` row folds
 * in, plus the session the next queued message runs against.
 */
export interface ManagerTurnOutcome {
  readonly containerExitCode: number | null;
  readonly costUsd: number | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  /** How the turn ended, which is what this update's row says it was. */
  readonly outcome: "done" | "errored" | "timeout";
  /** The session the turn ran under, already written to the thread. */
  readonly providerSessionId: string | null;
  readonly replyChars: number | null;
  readonly toolCalls: number | null;
  readonly toolErrors: number | null;
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/** One message in, one container turn out. Implemented by the manager module. */
export type RunManagerTurn = (
  request: ManagerTurnRequest
) => Effect.Effect<ManagerTurnOutcome, ManagerTurnError>;

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

/** A message waiting behind a running turn, and the row it was stored as. */
interface QueuedMessage {
  readonly message: ResolvedIntake;
  readonly messageId: ChatMessageId | null;
}

/** What the router's own effects need from the layer stack. */
export type DispatchServices =
  | Board
  | ChatMessageRepo
  | ChatThreadRepo
  | TranscribeService;

/** What building the router takes. */
export interface DispatcherOptions {
  readonly api: Bot<BotContext>["api"];
  readonly botToken: Redacted.Redacted<string>;
  readonly pending: PendingComments;
  /** Which harness a freshly opened thread talks to. */
  readonly provider: SessionProvider;
  readonly runTurn: RunManagerTurn;
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
 * Scoped, because the fiber map is: when the scope closes, every turn still
 * running is interrupted, which is how a `SIGTERM` stops a container instead of
 * leaving one behind.
 */
export const makeDispatcher = Effect.fnUntraced(function* (
  options: DispatcherOptions
) {
  const { api, botToken, pending, runTurn } = options;
  const board = yield* Board;
  const messages = yield* ChatMessageRepo;

  const turns = yield* FiberMap.make<ThreadId>();
  const forkTurn = yield* FiberMap.runtimePromise(turns)<DispatchServices>();
  const runUpdate = yield* FiberSet.makeRuntimePromise<DispatchServices>();

  /**
   * Messages that arrived while their thread was busy, each beside the row it
   * was already stored as. A plain map because the queue is deliberately not
   * durable; see the module comment.
   */
  const queued = new Map<ThreadId, QueuedMessage[]>();

  const enqueue = (threadId: ThreadId, waiting: QueuedMessage) => {
    queued.set(threadId, [...(queued.get(threadId) ?? []), waiting]);
  };

  const dequeue = (threadId: ThreadId) => {
    const [next, ...rest] = queued.get(threadId) ?? [];
    if (rest.length === 0) {
      queued.delete(threadId);
    } else {
      queued.set(threadId, rest);
    }
    return next ?? null;
  };

  /** Say one thing into the chat, and never fail the update because it could not be said. */
  const reply = (ctx: BotContext, text: string) =>
    Effect.promise(() => ctx.reply(text).catch(swallow));

  /**
   * Run one turn and fold what it produced into this update's row.
   *
   * Nothing is written here. The turn answered into the chat, stored its own
   * message and recorded the session — writing a second row from this side would
   * put the manager's answer in the conversation twice, and the next turn's
   * prompt would show it twice with it.
   */
  const oneTurn = Effect.fnUntraced(function* (input: ManagerTurnRequest) {
    const outcome = yield* runTurn(input).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("bot: manager turn failed", error)
      ),
      Effect.option
    );

    if (outcome._tag === "None") {
      return input.thread;
    }

    const result = outcome.value;
    yield* observeChat({
      containerExitCode: result.containerExitCode,
      costUsd: result.costUsd,
      errorClass: result.errorClass,
      errorMessage: result.errorMessage,
      gatewayToolCalls: result.toolCalls,
      gatewayToolErrors: result.toolErrors,
      // Left null on the happy path so the exit decides: a turn that answered
      // and an update that then failed to be recorded are different endings.
      outcome: result.outcome === "done" ? null : result.outcome,
      providerSessionId: result.providerSessionId,
      replyChars: result.replyChars,
      totalTokens: result.totalTokens,
      turns: result.turns,
    });

    // The thread row itself was updated by the turn; this is the copy the drain
    // below hands to the next queued message, so it resumes the session the one
    // before it just opened.
    return result.providerSessionId === input.thread.providerSessionId
      ? input.thread
      : { ...input.thread, providerSessionId: result.providerSessionId };
  });

  /**
   * The turn, and then whatever arrived while it ran. The loop is here rather
   * than in a second fiber so that "one turn per thread" stays true of the
   * drain as well as of the first message.
   */
  const turnLoop = Effect.fnUntraced(function* (input: ManagerTurnRequest) {
    let thread = yield* oneTurn(input);
    let next = dequeue(thread.id);
    while (next !== null) {
      thread = yield* oneTurn({
        isPrivateChat: input.isPrivateChat,
        message: next.message,
        messageId: next.messageId,
        replyToMessageId: next.message.telegramMessageId,
        thread,
      });
      next = dequeue(thread.id);
    }
  });

  /** The armed-comment path: the next message becomes a comment, not a turn. */
  const postComment = Effect.fnUntraced(function* (input: {
    readonly body: string;
    readonly ctx: BotContext;
    readonly taskId: TaskId;
    readonly threadId: ThreadId;
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

  /** One inbound message, from classification to turn. */
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
      provider: options.provider,
      userId: ctx.identity.userId,
      workspaceId: ctx.identity.workspaceId,
    });
    yield* observeChat({
      provider: thread.provider,
      providerSessionId: thread.providerSessionId,
      threadId: thread.id,
    });

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

    // Stored before the turn runs, so the prompt reads the conversation off the
    // rows and the turn is handed the id of the one it is answering.
    const stored = yield* messages.append(userMessageRow({ message, thread }));

    if (yield* FiberMap.has(turns, thread.id)) {
      enqueue(thread.id, { message, messageId: stored.id });
      yield* reply(ctx, BUSY_REPLY);
      return;
    }

    yield* Effect.promise(() =>
      forkTurn(
        thread.id,
        turnLoop({
          isPrivateChat: ctx.chat?.type === "private",
          message,
          messageId: stored.id,
          replyToMessageId: message.telegramMessageId,
          thread,
        }),
        { onlyIfMissing: true }
      )
    );
  });

  /**
   * Stop the turn running for a thread, dropping whatever was queued behind it.
   * True when there was one to stop, so `/stop` can say which happened.
   */
  const interrupt = Effect.fnUntraced(function* (threadId: ThreadId) {
    const running = yield* FiberMap.has(turns, threadId);
    queued.delete(threadId);
    yield* FiberMap.remove(turns, threadId);
    return running;
  });

  /** Whether a thread has a turn in flight right now. */
  const isBusy = (threadId: ThreadId) => FiberMap.has(turns, threadId);

  /** How many messages are waiting behind the turn in flight. */
  const queueDepth = (threadId: ThreadId) => queued.get(threadId)?.length ?? 0;

  /**
   * The shape `registerIntake` takes: one message in, a promise that settles
   * when the update has been dealt with. A rejection travels back up grammy's
   * middleware chain to whatever is recording this update, which is where a
   * failed turn becomes a row rather than a silence.
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

  return { handle, handleUpdate, interrupt, isBusy, queueDepth } as const;
});

/** The router, derived so a caller cannot restate its shape wrongly. */
export type Dispatcher = Effect.Success<ReturnType<typeof makeDispatcher>>;
