/**
 * The `atm.chat` wide event: one row per unit of chat work the bot does. The
 * bounded counters derived from the same ending live in `./chat-metrics`, which
 * is where the cardinality rules are kept.
 *
 * A unit is one inbound update — a typed sentence, a voice note, a forward, a
 * slash command, a tapped button — or one outbound notification. It is the only
 * row that exists for the updates that never become a run, which is most of
 * them.
 *
 * **It is not a row about a turn.** An agent turn is an `atm.run` and counts
 * itself; what a message cost, how many tools it called and how its container
 * exited are that row's questions, asked of a process this one does not run.
 * The join between the two is `runId` — the live turn this update queued behind,
 * null when it started one or caused none. The other direction, "which turn
 * answered this", is `chat_message.run_id` on the row the loop writes.
 *
 * Four properties are load-bearing, and this file enforces each rather than
 * documenting it.
 *
 * **Exactly one row per unit, on every exit path.** The emit goes through
 * {@link withWideEvent} and is never hand-rolled, so a handler that threw, an
 * update interrupted by shutdown and a sender who was turned away each leave
 * one row.
 *
 * **A refusal is a row, never a silence.** A sender who is not on the
 * allow-list is `outcome: "not_allowed"` with a null `userId`, and an update
 * the bot declined to act on is `outcome: "rejected"` — both on the row
 * everything else is counted from, rather than a log line nobody groups by.
 *
 * **No economics at all.** The shared cost fields are null on every row here:
 * an update is a message being read, and every dollar and token this system
 * spends belongs to the run that spent it. A number copied across from a turn
 * would be double-counted the moment anybody summed both events.
 *
 * **Content is measured, never carried.** The prompt is a character count, the
 * reply is a character count, the transcript is a character count. This is not
 * a rule this file could break if it wanted to: `defineEvent` rejects `body`,
 * `text`, `prompt`, `transcript` and `command` as field names outright, which
 * is why the row carries `promptChars` and `commandName`. The words themselves
 * live in `chat_message`, which is workspace-scoped Postgres — a different
 * store with different retention, holding them for the manager's memory rather
 * than for an operator's grep.
 */

import { NotifyKind, SessionProvider } from "@workspace/domain";
import {
  clipError,
  defineEvent,
  outcomeField,
  SanitizedText,
  type WideEventContext,
  withWideEvent,
} from "@workspace/telemetry";
import {
  Cause,
  Clock,
  Context,
  Effect,
  type Exit,
  Option,
  Ref,
  Schema,
} from "effect";
import {
  CHAT_EXTRA_OUTCOMES,
  CHAT_UPDATE_KINDS,
  type ChatOutcome,
  type ChatUpdateKind,
  recordChatMetrics,
} from "./chat-metrics";

export {
  CHAT_EXTRA_OUTCOMES,
  CHAT_OUTCOMES,
  CHAT_UPDATE_KINDS,
  type ChatOutcome,
  type ChatUpdateKind,
} from "./chat-metrics";

/** The filter key every query over chat traffic starts from. */
export const CHAT_EVENT_MARKER = "atm.chat";

/**
 * One unit of chat work. The shared identity, economics, outcome and
 * environment vocabulary comes from the telemetry base; everything below is a
 * question about a conversation that the base cannot answer.
 *
 * `sessionId` is inherited and always null: the session a conversation is
 * answered in belongs to the run, not to the update that asked. `runId` is the
 * run this update caused — the turn it queued behind, or the turn whose answer
 * is being delivered — and null on every update that caused none.
 */
export const ChatEvent = defineEvent(CHAT_EVENT_MARKER, {
  /** The Telegram chat, as text. A row field only: it is unbounded as a tag. */
  chatId: Schema.String,
  /** Which slash command ran. `command` is a banned field name, and this is the shape that survives it. */
  commandName: Schema.NullOr(SanitizedText),
  /** Why the bot spoke first. Non-null exactly when `updateKind` is `notify`. */
  notifyKind: Schema.NullOr(NotifyKind),
  outcome: outcomeField(CHAT_EXTRA_OUTCOMES),
  /** What the person said, measured. The words themselves are `chat_message`'s. */
  promptChars: Schema.Natural,
  /** Which harness the conversation runs on. Null before there is a conversation. */
  provider: Schema.NullOr(SessionProvider),
  /**
   * What a refused message was made of — its field names, never its content.
   * Non-null exactly when `outcome` is `rejected`. It is here rather than in a
   * log line because "a forward was refused" is a report and "a forward
   * carrying `rich_message` was refused" is the answer, and only one of them
   * can be grouped by.
   */
  refusedShape: Schema.NullOr(SanitizedText),
  /** The Telegram account that sent the update, present even when nothing else is. */
  telegramUserId: Schema.String,
  /** The conversation this update belongs to. Null before one exists. */
  threadId: Schema.NullOr(SanitizedText),
  /** How long transcription took. Non-null only for a voice note. */
  transcribeMs: Schema.NullOr(Schema.Finite),
  /** The transcript, measured. Non-null only for a voice note. */
  transcriptChars: Schema.NullOr(Schema.Natural),
  updateKind: Schema.Literals(CHAT_UPDATE_KINDS),
  /** The person behind the update. Null when the allow-list did not know them. */
  userId: Schema.NullOr(SanitizedText),
});

/** The row one update supplies, derived from the schema so it cannot drift. */
export type ChatEventInput = Parameters<typeof ChatEvent.encode>[0];

/**
 * What one update learned while it was handled. Every field starts empty and is
 * folded in by whichever part of the bot found it out — the classifier, the
 * renderer, the manager turn — because the code that learns a fact is nowhere
 * near the middleware that writes the row, and threading a `Ref` through eight
 * handler files is how one of them ends up not doing it.
 */
export interface ChatProgress {
  readonly commandName: string | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly notifyKind: NotifyKind | null;
  /**
   * The ending the work decided for itself — a refusal, a rejection, a turn
   * that ran out of time. Null means the exit decides, which is the usual case.
   */
  readonly outcome: ChatOutcome | null;
  readonly promptChars: number;
  readonly provider: SessionProvider | null;
  /** The field names of a message this bot declined, from `messageShape`. */
  readonly refusedShape: string | null;
  /** The live turn this update queued behind, where there was one. */
  readonly runId: string | null;
  /** The task this update turned out to be about, where it was about one. */
  readonly taskId: string | null;
  readonly threadId: string | null;
  readonly transcribeMs: number | null;
  readonly transcriptChars: number | null;
  /**
   * What the update turned out to be, once a handler classified it. Null keeps
   * the guess the middleware made from the raw update, which is what a row gets
   * when no handler ever ran.
   */
  readonly updateKind: ChatUpdateKind | null;
}

/** An update that has been received and has produced nothing yet. */
export const emptyChatProgress: ChatProgress = {
  commandName: null,
  errorClass: null,
  errorMessage: null,
  notifyKind: null,
  outcome: null,
  promptChars: 0,
  provider: null,
  refusedShape: null,
  runId: null,
  taskId: null,
  threadId: null,
  transcribeMs: null,
  transcriptChars: null,
  updateKind: null,
};

/** A fresh accumulator for one update. */
export const makeChatProgress = Ref.make(emptyChatProgress);

/**
 * The cell the current update folds its facts into, or null outside one. A
 * reference rather than an argument, so a handler deep under the middleware can
 * record what it learned without every layer between them passing a `Ref`
 * along.
 */
export const CurrentChatProgress =
  Context.Reference<Ref.Ref<ChatProgress> | null>("bot/CurrentChatProgress", {
    defaultValue: () => null,
  });

/**
 * Folds what the bot just learned into this update's row —
 * `observeChat({ promptChars, threadId })` from the router, `{ commandName }`
 * from a command. A no-op outside an update: telemetry may never be why a
 * handler cannot run.
 */
export const observeChat = (patch: Partial<ChatProgress>) =>
  Effect.flatMap(CurrentChatProgress, (cell) =>
    cell === null
      ? Effect.void
      : Ref.update(cell, (current) => ({ ...current, ...patch }))
  );

/** The immutable facts an update carries before any handler has seen it. */
export interface ChatContext {
  /** The Telegram chat the update arrived in, or the one a notice is going to. */
  readonly chatId: string;
  /** The cell the work folds into; read once, as the row is built. */
  readonly progress: Ref.Ref<ChatProgress>;
  readonly telegramUserId: string;
  /**
   * What the raw update looked like before a handler classified it. A handler
   * that learns better says so through {@link observeChat}; a row written
   * because nothing ran keeps this.
   */
  readonly updateKind: ChatUpdateKind;
  /** Null until the allow-list resolves the sender, and null forever if it cannot. */
  readonly userId: string | null;
  readonly workspaceId: string | null;
}

/** How the update ended, and what to call the failure behind it. */
interface ChatEnding {
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly outcome: ChatOutcome;
}

/** What to call something thrown that named itself nothing. */
const classOf = (thrown: unknown) => {
  const tag = (thrown as { readonly _tag?: unknown } | null)?._tag;
  if (typeof tag === "string") {
    return tag;
  }
  return thrown instanceof Error ? thrown.name : "UnknownError";
};

/** The text a failure carries, before it is sanitized. */
const messageOf = (thrown: unknown) =>
  thrown instanceof Error ? thrown.message : String(thrown);

/**
 * Reads the ending off the exit and the accumulator together, because neither
 * knows it alone.
 *
 * A handler that turned a sender away or declined an update returns cleanly, so
 * those endings exist only on the accumulator. A failure, a defect and an
 * interrupt exist only on the exit — and there the accumulator may still name
 * which failure it was, which is how a turn that ran out of time stays a
 * `timeout` instead of being folded into `errored` and losing the one ending
 * worth retrying. What it may not do is call a failed exit `done`.
 */
const endingOf = (
  exit: Exit.Exit<unknown, unknown>,
  progress: ChatProgress
): ChatEnding => {
  const { errorClass, errorMessage } = progress;
  if (exit._tag === "Success") {
    return { errorClass, errorMessage, outcome: progress.outcome ?? "done" };
  }
  // Only a cause that is nothing but interrupts is a stop: work that failed and
  // was then torn down really failed, and calling it `interrupted` hides it.
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      errorClass: errorClass ?? "Interrupted",
      errorMessage,
      outcome: "interrupted",
    };
  }
  const failure = Cause.findErrorOption(exit.cause);
  const thrown = Option.isSome(failure)
    ? failure.value
    : Cause.squash(exit.cause);
  return {
    errorClass: errorClass ?? classOf(thrown),
    errorMessage: errorMessage ?? clipError(messageOf(thrown)),
    outcome:
      progress.outcome !== null && progress.outcome !== "done"
        ? progress.outcome
        : "errored",
  };
};

/**
 * Builds the row from the three things that know about the update: what arrived,
 * what the handlers folded in, and how it ended.
 *
 * Every shared cost field is null. An update is a message being read; what a
 * turn spent is on the turn's own row, and copying it here would be counted
 * twice by anyone who summed both. `durationMs` is the exception because it is
 * measured here — update received to row written — and is the one number a
 * degraded row still carries.
 */
const chatRow = (
  context: ChatContext,
  progress: ChatProgress,
  wide: WideEventContext<unknown, unknown>
): ChatEventInput => {
  const ending = endingOf(wide.exit, progress);
  const updateKind = progress.updateKind ?? context.updateKind;
  const voice = updateKind === "voice";
  return {
    chatId: context.chatId,
    commandName: progress.commandName,
    costUsd: null,
    durationMs: wide.durationMs,
    errorClass: ending.errorClass,
    errorMessage: ending.errorMessage,
    notifyKind: progress.notifyKind,
    outcome: ending.outcome,
    // One row per update: a chat turn is short enough that a start row would
    // only double the count without making a lost one visible.
    phase: "end",
    promptChars: progress.promptChars,
    provider: progress.provider,
    queueWaitMs: null,
    refusedShape: progress.refusedShape,
    runId: progress.runId,
    // The session a conversation is answered in belongs to its run.
    sessionId: null,
    spanId: wide.spanId,
    taskId: progress.taskId,
    telegramUserId: context.telegramUserId,
    threadId: progress.threadId,
    totalTokens: null,
    traceId: wide.traceId,
    // Non-null only where a voice note was really transcribed: a 0 here would
    // say the transcription was instant and empty.
    transcribeMs: voice ? progress.transcribeMs : null,
    transcriptChars: voice ? progress.transcriptChars : null,
    turns: null,
    updateKind,
    userId: context.userId,
    workspaceId: context.workspaceId,
  };
};

/**
 * Counts the update from the same ending the row reports, off the same
 * accumulator and the same exit, so the counters and the ledger cannot
 * disagree about how an update went.
 */
const recordChat = (
  context: ChatContext,
  exit: Exit.Exit<unknown, unknown>,
  startedAt: number
) =>
  Effect.gen(function* () {
    const progress = Ref.getUnsafe(context.progress);
    const endedAt = yield* Clock.currentTimeMillis;
    yield* recordChatMetrics({
      durationMs: Math.max(0, endedAt - startedAt),
      kind: progress.updateKind ?? context.updateKind,
      outcome: endingOf(exit, progress).outcome,
      provider: progress.provider,
    });
  }).pipe(Effect.ignoreCause);

/**
 * Wraps one unit of chat work so it leaves exactly one `atm.chat` row, on every
 * exit path: an accepted message, a refused sender, a handler that threw, an
 * update interrupted by shutdown, and a notification that could not be
 * delivered.
 *
 * Two call sites, both single — the outermost `bot.use` middleware, so every
 * update funnels through one of them, and the notification sender. The
 * accumulator is provided to the work as {@link CurrentChatProgress} and read
 * back as the row is built, which is safe exactly there: everything that writes
 * to it has finished by the time the exit handler runs.
 *
 * @example
 * ```ts
 * const progress = yield* makeChatProgress;
 * yield* handle(update).pipe(
 *   withChatEvent({
 *     chatId: String(chatId),
 *     progress,
 *     telegramUserId: String(from.id),
 *     updateKind: "text",
 *     userId: identity.userId,
 *     workspaceId: identity.workspaceId,
 *   })
 * );
 * ```
 */
export const withChatEvent =
  (context: ChatContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.provideService(CurrentChatProgress, context.progress),
        // Inside the wide event, so the counters are derived before the ledger
        // write rather than after it.
        Effect.onExit((exit) => recordChat(context, exit, startedAt)),
        withWideEvent(ChatEvent, (wide: WideEventContext<A, E>) =>
          chatRow(context, Ref.getUnsafe(context.progress), wide)
        )
      );
    });
