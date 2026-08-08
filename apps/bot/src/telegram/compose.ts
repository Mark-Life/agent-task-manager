/**
 * Compose mode: several messages, held, and sent to the manager as one.
 *
 * Every other message this bot receives is a turn on its own — the row is
 * written, the trigger fires, the loop answers. That is the wrong shape for the
 * thing people actually do: forwarding a run of messages, forwarding both sides
 * of a dialogue, recording three voice notes about three points. Each of those
 * is *one* thing to say, and sent one at a time it becomes three prompts, three
 * turns and three answers to a question nobody finished asking.
 *
 * So `/compose` opens a buffer. While it is open every message is resolved as
 * usual — a voice note is still fetched and transcribed, a forward still keeps
 * its sender — and then held instead of stored. *Send* writes the whole
 * collection as one `chat_message` row, which is one insert, one trigger and one
 * turn. *Cancel* drops it and nothing is written at all.
 *
 * **The buffer is per chat and in memory.** Same reasoning as the pending
 * task message beside it: it holds words a person has not decided to send yet, and a
 * buffer that survived a restart would deliver, hours later, a message they
 * assumed was lost. A restart loses it, and the anchor message left in the chat
 * is answered with "that compose session has expired" rather than acted on.
 *
 * **Order is Telegram's, not this process's.** Pieces are kept sorted by
 * `message_id`. The dispatcher forks a fiber per update, so a voice note that
 * takes three seconds to transcribe finishes after the sentence typed behind it,
 * and appending on arrival would silently reorder what somebody said. Telegram
 * numbers messages per chat in the order it accepted them, which is the order
 * they were sent in.
 *
 * **Attribution goes into the text.** A row has one `intake_kind` and one
 * `forward_from`, and a batch has as many as it has pieces, so the columns
 * cannot carry it — {@link composedBody} writes a header line above each piece
 * instead. A batch of exactly one piece is not composed at all: it is stored as
 * though it had been sent on its own, so `/compose` around a single message is
 * indistinguishable from not using it.
 *
 * Nothing here decides *whether* to capture a message. The dispatcher does, in
 * one place, and this module is what it reads and what it draws.
 */

import type { ChatMessageAppend } from "@workspace/db";
import { Effect } from "effect";
import { type Api, InlineKeyboard } from "grammy";
import { encodeCallbackData } from "./callback-data";
import { bold, italic } from "./format";
import type { ResolvedIntake } from "./intake";
import { editText } from "./send";

/** How Telegram is told to parse everything this module composes. */
const HTML = { parse_mode: "HTML" } as const;

/**
 * How long a compose session survives with nothing added to it.
 *
 * It exists because the failure it prevents is silent: a person opens compose,
 * is interrupted, comes back tomorrow and types a question that goes nowhere.
 * Long enough that composing a dozen forwards is never interrupted, short
 * enough that "the bot is ignoring me" cannot outlive an afternoon. Checked
 * when the buffer is read rather than on a timer — there is nothing to do at
 * the moment it expires, and a fiber per chat to do it would be a fiber per
 * chat.
 */
const MS_PER_MINUTE = 60_000;
const COMPOSE_IDLE_MINUTES = 30;
export const COMPOSE_IDLE_MS = COMPOSE_IDLE_MINUTES * MS_PER_MINUTE;

/**
 * One held message: the words, and the little that says how they arrived.
 *
 * Derived from what {@link ResolvedIntake} already proved rather than restated,
 * so a new intake field cannot be one this buffer forgets to carry.
 */
export interface ComposePiece
  extends Pick<
    ResolvedIntake,
    | "body"
    | "forwardFrom"
    | "intakeKind"
    | "telegramMessageId"
    | "transcriptChars"
  > {}

/** One chat's open buffer, and the message in the chat that stands for it. */
export interface ComposeSession {
  /** The compose message carrying the two buttons, edited as the count changes. */
  readonly anchorMessageId: number;
  /** What is held, in the order Telegram accepted it. */
  readonly pieces: readonly ComposePiece[];
  /** When something last happened to it, for the idle window. */
  readonly touchedAt: number;
}

/**
 * What a chat's compose buffer is, at the moment somebody asked.
 *
 * Three cases rather than a nullable session, because "expired" is a thing the
 * bot has to *say* — a message that arrives into a session nobody sent is not
 * the same as a message that arrives into no session, and telling them apart at
 * the call site is what keeps a dropped buffer from being dropped silently.
 */
export type ComposeState =
  | { readonly kind: "composing"; readonly session: ComposeSession }
  | { readonly kind: "expired"; readonly session: ComposeSession }
  | { readonly kind: "idle" };

/** The compose buffers, one entry per chat. */
export interface ComposeBuffers {
  /**
   * Hold one more message. Answers the session it landed in, or null when the
   * chat stopped composing while this message was being resolved — which the
   * caller reads as "store it the ordinary way".
   */
  readonly add: (input: {
    readonly chatId: number;
    readonly now: number;
    readonly piece: ComposePiece;
  }) => ComposeSession | null;
  /** End compose for a chat, answering what it was holding. */
  readonly close: (chatId: number) => ComposeSession | null;
  /**
   * Start compose for a chat, answering the session this one displaced — which
   * is what a second `/compose` produces, and what leaves an anchor above with
   * live buttons on it.
   */
  readonly open: (input: {
    readonly anchorMessageId: number;
    readonly chatId: number;
    readonly now: number;
  }) => ComposeSession | null;
  /** What this chat is doing, expiring an idle session as it looks. */
  readonly peek: (input: {
    readonly chatId: number;
    readonly now: number;
  }) => ComposeState;
  /**
   * Put a closed session back, for the one case that needs it: a *Send* whose
   * write did not land. The buffer is closed before the write so a second tap
   * cannot submit the same batch twice, which leaves the words held nowhere if
   * the write then fails — and dropping somebody's twenty forwards because
   * Postgres blinked is not an ending this bot gets to choose.
   */
  readonly restore: (input: {
    readonly chatId: number;
    readonly now: number;
    readonly session: ComposeSession;
  }) => void;
}

/** Pieces with one more in them, ordered as Telegram numbered them. */
const withPiece = (input: {
  readonly piece: ComposePiece;
  readonly pieces: readonly ComposePiece[];
}) =>
  [...input.pieces, input.piece].sort(
    (left, right) => left.telegramMessageId - right.telegramMessageId
  );

/** Builds the compose state. One per process. */
export const makeComposeBuffers = (): ComposeBuffers => {
  const open = new Map<number, ComposeSession>();

  /** The chat's session, or null once an idle one has been taken away. */
  const live = (input: { readonly chatId: number; readonly now: number }) => {
    const session = open.get(input.chatId);
    if (session === undefined) {
      return null;
    }
    if (input.now - session.touchedAt > COMPOSE_IDLE_MS) {
      open.delete(input.chatId);
      return null;
    }
    return session;
  };

  return {
    add: ({ chatId, now, piece }) => {
      const session = live({ chatId, now });
      if (session === null) {
        return null;
      }
      const next: ComposeSession = {
        anchorMessageId: session.anchorMessageId,
        pieces: withPiece({ piece, pieces: session.pieces }),
        touchedAt: now,
      };
      open.set(chatId, next);
      return next;
    },
    close: (chatId) => {
      const session = open.get(chatId) ?? null;
      open.delete(chatId);
      return session;
    },
    open: ({ anchorMessageId, chatId, now }) => {
      const displaced = live({ chatId, now });
      open.set(chatId, {
        anchorMessageId,
        // The words survive a re-anchor: a second `/compose` is somebody
        // scrolling the buttons back into reach, not somebody starting over.
        pieces: displaced?.pieces ?? [],
        touchedAt: now,
      });
      return displaced;
    },
    peek: ({ chatId, now }) => {
      const session = open.get(chatId);
      if (session === undefined) {
        return { kind: "idle" };
      }
      if (now - session.touchedAt > COMPOSE_IDLE_MS) {
        open.delete(chatId);
        return { kind: "expired", session };
      }
      return { kind: "composing", session };
    },
    restore: ({ chatId, now, session }) => {
      // Merged rather than assigned: a message may have arrived and been held
      // while the write was in flight, and it belongs in the same batch.
      const held = live({ chatId, now });
      open.set(chatId, {
        anchorMessageId: held?.anchorMessageId ?? session.anchorMessageId,
        pieces: (held?.pieces ?? []).reduce(
          (pieces, piece) => withPiece({ piece, pieces }),
          session.pieces
        ),
        touchedAt: now,
      });
    },
  };
};

/**
 * The header above one piece of a batch.
 *
 * Numbered so the manager can see where one message ends and the next begins,
 * and named so it can tell a forward from a voice note from something the
 * person typed — which the row's own columns cannot say once several messages
 * share one of them.
 */
export const composePieceLabel = (input: {
  readonly index: number;
  readonly piece: ComposePiece;
  readonly total: number;
}) => {
  const { index, piece, total } = input;
  const position = `message ${index + 1} of ${total}`;
  if (piece.intakeKind === "forward") {
    return `[${position} · forwarded from ${piece.forwardFrom ?? "someone"}]`;
  }
  if (piece.intakeKind === "voice") {
    return `[${position} · voice note, transcribed]`;
  }
  return `[${position}]`;
};

/** Every held message as one body, in order, each under its own header. */
export const composedBody = (pieces: readonly ComposePiece[]) =>
  pieces
    .map(
      (piece, index) =>
        `${composePieceLabel({ index, piece, total: pieces.length })}\n${piece.body}`
    )
    .join("\n\n");

/** The columns of the `chat_message` row a batch fills. */
export type ComposedRow = Pick<
  ChatMessageAppend,
  "body" | "forwardFrom" | "intakeKind" | "transcriptChars"
>;

/**
 * A batch as the row it becomes.
 *
 * One piece is stored as itself — same body, same intake kind, same sender —
 * because a batch of one has nothing to separate and no reason to read
 * differently from the message sent without compose. Several become one
 * `compose` row whose body carries the attribution the columns cannot.
 */
export const composeRow = (pieces: readonly ComposePiece[]): ComposedRow => {
  const only = pieces.length === 1 ? pieces[0] : undefined;
  if (only !== undefined) {
    return {
      body: only.body,
      forwardFrom: only.forwardFrom,
      intakeKind: only.intakeKind,
      transcriptChars: only.transcriptChars,
    };
  }
  return {
    body: composedBody(pieces),
    forwardFrom: null,
    intakeKind: "compose",
    transcriptChars: null,
  };
};

/** What the button that submits the batch says, with nothing held yet. */
export const COMPOSE_SEND_LABEL = "Send";

/** What the button that drops it says. */
export const COMPOSE_CANCEL_LABEL = "Cancel";

/** The two buttons under the compose message, the first counting what it holds. */
export const composeKeyboard = (waiting: number) =>
  new InlineKeyboard([
    [
      InlineKeyboard.text(
        waiting === 0
          ? COMPOSE_SEND_LABEL
          : `${COMPOSE_SEND_LABEL} ${waiting} together`,
        encodeCallbackData({ kind: "compose", verb: "cmsnd" })
      ),
      InlineKeyboard.text(
        COMPOSE_CANCEL_LABEL,
        encodeCallbackData({ kind: "compose", verb: "cmcxl" })
      ),
    ],
  ]);

/** How many messages are held, in words rather than a bare number. */
const heldCount = (waiting: number) => {
  if (waiting === 0) {
    return "nothing held yet";
  }
  return waiting === 1 ? "1 message held" : `${waiting} messages held`;
};

/** What a person is told a batch holds, on the message the buttons hang off. */
export const composeText = (waiting: number) =>
  [
    `${bold("Compose")} — ${heldCount(waiting)}.`,
    italic(
      "Everything you send from here is collected, and nothing runs until you press Send. Slash commands still work."
    ),
  ].join("\n");

/** What a person is told when a batch has gone to the manager. */
export const composeSentText = (waiting: number) =>
  italic(
    waiting === 1
      ? "Sent — one message, one turn."
      : `Sent — ${waiting} messages as one turn.`
  );

/** What a person is told when they dropped one. */
export const composeCancelledText = (waiting: number) =>
  italic(
    waiting === 0
      ? "Compose cancelled. Nothing was collected and nothing ran."
      : `Compose cancelled — ${waiting} messages discarded, and nothing ran.`
  );

/** What a person is told when they sent an empty one. */
export const COMPOSE_EMPTY_TEXT =
  "Nothing was collected, so nothing was sent. Compose is off.";

/** What a person is told when the write behind *Send* did not land. */
export const COMPOSE_FAILED_TEXT =
  "That did not reach the manager. Everything is still held — press Send again.";

/** What a message arriving into a session nobody sent is answered with. */
export const COMPOSE_EXPIRED_TEXT =
  "Compose timed out and what it held is gone. This message went to the manager on its own.";

/** What the abandoned compose message itself is left saying. */
export const COMPOSE_TIMED_OUT_TEXT = italic(
  "Compose timed out. Nothing was sent, and what it held is gone."
);

/** What a tap on a compose button with no session behind it is answered with. */
export const COMPOSE_GONE_ANSWER = "That compose session has expired.";

/** What the anchor a second `/compose` replaced is left saying. */
export const COMPOSE_MOVED_TEXT = italic(
  "Compose continues below — this message's buttons have moved."
);

/**
 * Redraw the compose message with what it now holds.
 *
 * Best effort: a count the chat refused to show changes nothing about the
 * buffer, which is what the *Send* button reads from.
 */
export const showCompose = Effect.fn("bot.compose.show")(function* (input: {
  readonly api: Api;
  readonly chatId: number;
  readonly messageId: number;
  readonly waiting: number;
}) {
  yield* editText({
    api: input.api,
    chatId: input.chatId,
    messageId: input.messageId,
    send: { ...HTML, reply_markup: composeKeyboard(input.waiting) },
    text: composeText(input.waiting),
  }).pipe(Effect.ignore);
});

/**
 * Retire a compose message: say what became of the batch, and take the buttons
 * away so the anchor cannot be tapped a second time.
 */
export const closeCompose = Effect.fn("bot.compose.close")(function* (input: {
  readonly api: Api;
  readonly chatId: number;
  readonly messageId: number;
  readonly text: string;
}) {
  yield* editText({
    api: input.api,
    chatId: input.chatId,
    messageId: input.messageId,
    send: HTML,
    text: input.text,
  }).pipe(Effect.ignore);
});
