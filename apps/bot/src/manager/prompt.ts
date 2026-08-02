/**
 * One turn's prompt: the rules, the conversation so far, and the message that
 * just arrived.
 *
 * **The history is in the prompt because the manager has no memory of its own.**
 * A turn is a container that is created, answers, and is removed. The provider's
 * session is resumed where it can be, and it usually can — but a session is the
 * vendor's transcript, held in the vendor's agent home, and it is lost to a
 * `/clear`, a provider switch, a data-root move and a vendor's own expiry. The
 * `chat_message` rows are the conversation; the session is a cache of it. So the
 * prompt carries the recent rows every time, and a lost session degrades to a
 * longer prompt rather than to amnesia.
 *
 * **The rows are rendered, not replayed.** A forwarded message's sender is a
 * column rather than a prefix inside the text, and a voice note is a
 * transcript with no marker that it was ever audio — so the attribution is put
 * back here, where it is one line of formatting instead of something written
 * into the stored body and then read back out of it.
 *
 * Pure and total: nothing here reads a clock, a database or a config, which is
 * what makes the whole composition assertable in a unit test.
 */

import type { ChatMessage } from "@workspace/domain";
import { MANAGER_RULES } from "./rules";

/** How many rows of a thread travel in a prompt unless the caller says otherwise. */
export const DEFAULT_HISTORY_MESSAGES = 40;

/** What each side of the conversation is called in the rendered history. */
const SPEAKER = {
  manager: "You",
  user: "Person",
} as const satisfies Record<ChatMessage["role"], string>;

/**
 * One stored message as a line of transcript.
 *
 * The intake kind is named only where it changes how the words should be read:
 * a forward is somebody else's words quoted by the person, and a voice note was
 * dictated, which is why it rambles and why its punctuation is a guess.
 */
export const renderHistoryMessage = (
  message: Pick<ChatMessage, "body" | "forwardFrom" | "intakeKind" | "role">
) => {
  const speaker = SPEAKER[message.role];
  if (message.intakeKind === "forward") {
    const from = message.forwardFrom ?? "someone";
    return `${speaker} (forwarded from ${from}): ${message.body}`;
  }
  if (message.intakeKind === "voice") {
    return `${speaker} (voice note, transcribed): ${message.body}`;
  }
  return `${speaker}: ${message.body}`;
};

/** What the incoming message is, beyond its words. */
export interface PromptMessage {
  readonly body: string;
  /** The sanitized sender of a forward, or null. */
  readonly forwardFrom?: string | null;
  readonly intakeKind?: ChatMessage["intakeKind"];
}

/** Everything one prompt is composed from. */
export interface PromptInput {
  /**
   * The thread's recent rows, oldest first — the order
   * `ChatMessageRepo.recent` returns and the order the index is read in. The
   * new message is *not* among them; it is stored before the turn runs, so a
   * caller passing rows it read afterwards must drop the last one.
   */
  readonly history: readonly ChatMessage[];
  /** How many of the most recent rows to keep. The tail, not the head. */
  readonly historyLimit?: number;
  readonly message: PromptMessage;
  /** Overridable so a check script can pin the rules it asserts against. */
  readonly rules?: string;
}

/** The new message, rendered the same way a stored one is. */
const renderIncoming = (message: PromptMessage) =>
  renderHistoryMessage({
    body: message.body,
    forwardFrom: message.forwardFrom ?? null,
    intakeKind: message.intakeKind ?? null,
    role: "user",
  });

/**
 * The prompt for one manager turn.
 *
 * Sections are separated by headings rather than by delimiters the model has to
 * be told about, and the new message comes last because that is what it is
 * being asked to answer. A first turn has no history section at all — an empty
 * "Conversation so far" reads as a conversation that was erased.
 */
export const buildManagerPrompt = (input: PromptInput) => {
  const limit = input.historyLimit ?? DEFAULT_HISTORY_MESSAGES;
  const kept = limit <= 0 ? [] : input.history.slice(-limit);
  const sections = [input.rules ?? MANAGER_RULES];
  if (kept.length > 0) {
    sections.push(
      ["## Conversation so far", ...kept.map(renderHistoryMessage)].join("\n\n")
    );
  }
  sections.push(["## New message", renderIncoming(input.message)].join("\n\n"));
  return sections.join("\n\n");
};
