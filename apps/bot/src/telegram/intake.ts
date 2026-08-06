/**
 * What an inbound Telegram message *is*, decided in one total function.
 *
 * Everything downstream — the `chat_message` row, the manager's prompt, the
 * `atm.chat` row — wants the same four facts about an update: which kind of
 * intake it was, what the words are, how many characters that is, and which
 * Telegram message it came from. Deciding that in the handler, per handler, is
 * how a forwarded voice note ends up counted as text on one path and dropped on
 * another. {@link classifyMessage} is pure and total instead: every message
 * grammy can deliver lands on exactly one branch, including the ones this
 * system refuses, so a refusal is a value with a reason on it rather than a
 * handler that returns early and says nothing.
 *
 * **Words live in three places, not one.** `text` is the obvious one and
 * `caption` the well-known one; the third is `rich_message`, the Bot API's
 * structured document, which carries neither of those fields and holds every
 * word in a tree of blocks instead. A bot that answers with `sendRichMessage`
 * sends nothing else, so a forward of one used to land on the catch-all refusal
 * with its whole content sitting in a field nobody read. `./rich` is what reads
 * it.
 *
 * Classification is deliberately separate from resolution. Classifying is
 * synchronous and testable with a literal object; {@link resolveIntake} is what
 * touches the network, because only a voice note has to be fetched and
 * transcribed before anyone knows what it says. The transcript's *length* and
 * the transcription's *duration* come back beside it, measured once here, so no
 * caller has to time the call and none of them has an excuse to carry the words
 * onto an event.
 */

import { Effect, type Redacted } from "effect";
import type { Bot, Context } from "grammy";
import { TranscribeService } from "../transcribe";
import { downloadTelegramFile, type FileLocator } from "./download";
import { richMessageToText } from "./rich";

/** The kinds of message intake that become a stored conversation turn. */
export const INTAKE_MESSAGE_KINDS = ["text", "voice", "forward"] as const;

/** Why an update was refused. Closed, because each one has its own sentence. */
export const UNSUPPORTED_INTAKE_REASONS = [
  "document",
  "empty",
  "media_group",
  "photo",
  "unsupported_media",
] as const;

/** The name Groq sees for a Telegram voice note. Telegram always sends OGG/Opus. */
const VOICE_FILENAME = "voice.ogg";

/** The message shape grammy hands a handler, derived rather than re-imported. */
export type TelegramMessage = NonNullable<Context["message"]>;

/** How a forward names where it came from, as grammy models it. */
export type ForwardOrigin = NonNullable<TelegramMessage["forward_origin"]>;

/** One of {@link INTAKE_MESSAGE_KINDS}. */
export type IntakeMessageKind = (typeof INTAKE_MESSAGE_KINDS)[number];

/** One of {@link UNSUPPORTED_INTAKE_REASONS}. */
export type UnsupportedIntakeReason =
  (typeof UNSUPPORTED_INTAKE_REASONS)[number];

/** Where an update came from — the same two ids every branch carries. */
export interface IntakeOrigin {
  readonly telegramChatId: number;
  readonly telegramMessageId: number;
}

/** A plain text message. Never a forward: that is its own branch. */
export interface IntakeText extends IntakeOrigin {
  readonly body: string;
  readonly chars: number;
  readonly forwardFrom: null;
  readonly kind: "text";
}

/**
 * A voice note. It carries no body and no character count, because until it has
 * been fetched and transcribed nobody knows what it says — and a zero here
 * would be a number someone later averages.
 */
export interface IntakeVoice extends IntakeOrigin {
  readonly fileId: string;
  readonly forwardFrom: string | null;
  readonly kind: "voice";
  readonly voiceSeconds: number;
}

/**
 * A message forwarded into the chat. The sender's name is a field of its own
 * rather than a prefix on the body, so the row keeps the words a person wrote
 * and the prompt builder decides how to introduce them.
 */
export interface IntakeForward extends IntakeOrigin {
  readonly body: string;
  readonly chars: number;
  readonly forwardFrom: string;
  readonly kind: "forward";
}

/** An update this system does not accept, with the reason it will explain. */
export interface IntakeUnsupported extends IntakeOrigin {
  readonly kind: "unsupported";
  readonly reason: UnsupportedIntakeReason;
  /**
   * Which fields the refused message actually carried, from
   * {@link messageShape}. The reason is what the person is told; this is what
   * the ledger keeps, and it is the difference between "a forward was refused"
   * and "a forward carrying `rich_message` was refused" — one of those is a
   * report, the other is the answer.
   */
  readonly shape: string;
}

/** An update that becomes a conversation turn. */
export type IntakeMessage = IntakeForward | IntakeText | IntakeVoice;

/** Every possible verdict on an inbound message. Total over what grammy delivers. */
export type IntakeClassification = IntakeMessage | IntakeUnsupported;

/**
 * A display name for where a forward came from. `hidden_user` is a person who
 * has forwarding privacy on, so Telegram gives only the name they chose to
 * show; `unknown` is the branch a future origin type lands on, named rather
 * than crashed.
 */
export const forwardSenderName = (origin: ForwardOrigin) => {
  if (origin.type === "user") {
    return origin.sender_user.first_name;
  }
  if (origin.type === "channel") {
    return origin.chat.title;
  }
  if (origin.type === "hidden_user") {
    return origin.sender_user_name;
  }
  return "unknown";
};

/**
 * The envelope every message has: who, where, when, and which message. Nothing
 * in it says what the message *is*, which is what makes everything else a clue.
 */
const MESSAGE_ENVELOPE_FIELDS = new Set(["chat", "date", "from", "message_id"]);

/** How much of a shape is worth keeping. Long enough for the oddest message. */
const MAX_SHAPE_CHARS = 200;

/**
 * What a message was made of, as a field list.
 *
 * A subtraction rather than a list of known kinds, and that is the whole point:
 * the shapes worth recording are the ones nobody thought of, so a field the Bot
 * API adds next month appears here by name on the first message that carries it.
 * Names only — a field list is a shape, not content, and the words themselves
 * belong in `chat_message` rather than in a ledger anyone can grep.
 */
export const messageShape = (message: TelegramMessage) =>
  Object.keys(message)
    .filter((field) => !MESSAGE_ENVELOPE_FIELDS.has(field))
    .sort()
    .join(",")
    .slice(0, MAX_SHAPE_CHARS);

/** The sentence a refused update gets back. One per reason, and no apology twice. */
export const refusalFor = (reason: UnsupportedIntakeReason) => {
  if (reason === "photo") {
    return "I can't read photos yet — describe it in a message instead.";
  }
  if (reason === "document") {
    return "I can't take file uploads — paste what matters into a message.";
  }
  if (reason === "media_group") {
    return "I can't take albums — send one message at a time.";
  }
  if (reason === "empty") {
    return "That message had nothing I could read.";
  }
  return "I can only work with text and voice messages.";
};

/**
 * Narrows a classification to the kinds that become a stored turn. A predicate
 * so a handler branches once and keeps the narrowed type afterwards.
 */
export const isIntakeMessage = (
  classification: IntakeClassification
): classification is IntakeMessage => classification.kind !== "unsupported";

/**
 * Decides what one inbound message is. Pure, total, and ordered on purpose: an
 * album is refused before its photos are, a voice note wins over the forward it
 * arrived inside, and a forward wins over the plain text it contains.
 */
export const classifyMessage = (
  message: TelegramMessage
): IntakeClassification => {
  const origin: IntakeOrigin = {
    telegramChatId: message.chat.id,
    telegramMessageId: message.message_id,
  };
  const refuse = (reason: UnsupportedIntakeReason): IntakeUnsupported => ({
    ...origin,
    kind: "unsupported",
    reason,
    shape: messageShape(message),
  });
  const forwardFrom =
    message.forward_origin === undefined
      ? null
      : forwardSenderName(message.forward_origin);

  if (message.voice) {
    return {
      ...origin,
      fileId: message.voice.file_id,
      forwardFrom,
      kind: "voice",
      voiceSeconds: message.voice.duration,
    };
  }

  // An album arrives as several updates sharing one id. Refusing the group is
  // one sentence; refusing each member is three.
  if (message.media_group_id !== undefined) {
    return refuse("media_group");
  }
  if (message.photo) {
    return refuse("photo");
  }
  if (message.document) {
    return refuse("document");
  }

  // The three places a message keeps its words, in the order Telegram fills
  // them. A rich message has neither of the first two and is entirely the
  // third; reading only `text` is what refused a bot's formatted answer as an
  // attachment.
  const rich =
    message.rich_message === undefined
      ? undefined
      : richMessageToText(message.rich_message);
  const body = message.text ?? message.caption ?? rich;
  if (body === undefined) {
    return refuse("unsupported_media");
  }
  if (body.length === 0) {
    return refuse("empty");
  }

  if (forwardFrom !== null) {
    return {
      ...origin,
      body,
      chars: body.length,
      forwardFrom,
      kind: "forward",
    };
  }
  return {
    ...origin,
    body,
    chars: body.length,
    forwardFrom: null,
    kind: "text",
  };
};

/**
 * What a resolved intake gives the caller: exactly the `chat_message` columns a
 * user turn fills, plus the two voice measurements the chat event carries. The
 * transcription fields are null for every kind but `voice`, which is the same
 * rule the row's check constraint states.
 */
export interface ResolvedIntake extends IntakeOrigin {
  readonly body: string;
  readonly chars: number;
  readonly forwardFrom: string | null;
  readonly intakeKind: IntakeMessageKind;
  readonly transcribeMs: number | null;
  readonly transcriptChars: number | null;
}

/**
 * Turns a classified message into the words it stands for.
 *
 * Text and forwards resolve without touching anything. A voice note is fetched
 * through {@link downloadTelegramFile} — the only place the bot token reaches a
 * URL — and transcribed, and the transcript's length and the call's duration
 * come back with it. The transcript itself goes to the caller, for the row and
 * the prompt; the two numbers are what an event may hold.
 */
export const resolveIntake = Effect.fn("bot.intake.resolve")(
  function* (options: {
    readonly api: FileLocator;
    readonly message: IntakeMessage;
    readonly token: Redacted.Redacted;
  }) {
    const { message } = options;
    const origin: IntakeOrigin = {
      telegramChatId: message.telegramChatId,
      telegramMessageId: message.telegramMessageId,
    };

    if (message.kind !== "voice") {
      return {
        ...origin,
        body: message.body,
        chars: message.chars,
        forwardFrom: message.forwardFrom,
        intakeKind: message.kind,
        transcribeMs: null,
        transcriptChars: null,
      } satisfies ResolvedIntake;
    }

    const transcriber = yield* TranscribeService;
    const audio = yield* downloadTelegramFile({
      api: options.api,
      fileId: message.fileId,
      token: options.token,
    });
    const transcript = yield* transcriber.transcribe({
      audio,
      filename: VOICE_FILENAME,
    });

    return {
      ...origin,
      body: transcript.text,
      chars: transcript.chars,
      forwardFrom: message.forwardFrom,
      intakeKind: message.kind,
      transcribeMs: transcript.durationMs,
      transcriptChars: transcript.chars,
    } satisfies ResolvedIntake;
  }
);

/** What a handler is handed for one inbound message. */
export interface IntakeUpdate<C extends Context> {
  readonly classification: IntakeClassification;
  readonly ctx: C;
}

/** The dispatcher's side of intake: one call per message, refusals included. */
export type IntakeHandler<C extends Context> = (
  update: IntakeUpdate<C>
) => Promise<void>;

/**
 * Registers the message intake path on the bot.
 *
 * One `bot.on("message")` rather than one per media kind, because
 * {@link classifyMessage} is already total and three overlapping registrations
 * are how a forwarded voice note gets handled twice. It is registered after the
 * commands, so a `/command` is consumed by its own handler and never reaches
 * here.
 *
 * Generic over the context so this file never has to know what the access
 * middleware attached to it.
 */
export const registerIntake = <C extends Context>(
  bot: Bot<C>,
  handle: IntakeHandler<C>
) => {
  bot.on("message", (ctx) =>
    handle({ classification: classifyMessage(ctx.message), ctx })
  );
};
