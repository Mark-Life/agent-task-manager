/**
 * What a manager turn is told: the rules, and the conversation it has not read.
 *
 * The same two shapes the worker has, over `chat_message` rather than over
 * task messages. A fresh session is given the rules and the tail of the thread; a
 * resumed one is given only what has been said since its watermark — which is
 * also how several messages that arrived while a turn was running become one
 * prompt on the next turn. Coalescing is not built here; it is what a watermark
 * does.
 *
 * **The rows are rendered, not replayed.** A forwarded message's sender is a
 * column rather than a prefix inside the text, and a voice note is a transcript
 * with no marker that it was ever audio — so the attribution is put back here,
 * where it is one line of formatting instead of something written into the
 * stored body and then read back out of it.
 *
 * Pure and total: nothing here reads a clock, a database or a config, which is
 * what makes the whole composition assertable in a unit test.
 */

import type { ChatMessage } from "@workspace/domain";
import {
  conversation,
  joinSections,
  type PromptMode,
  placementSection,
  promptOf,
  type RunPlacement,
  section,
  speech,
} from "./render";
import { MANAGER_RULES, SHARED_RULES, WRITING_RULES } from "./rules";

/**
 * How many rows of a thread a first turn is given.
 *
 * Only a fresh session needs a cap: it has no watermark, so its unread list is
 * the whole conversation, and a year-old thread would fill a context window
 * with what nobody asked about. A resumed session reads only what arrived since
 * it last looked and needs no cap.
 */
export const FRESH_HISTORY_MESSAGES = 40;

/** What each side of the conversation is called in the rendered thread. */
const SPEAKER = {
  manager: "You",
  user: "Person",
} as const satisfies Record<ChatMessage["role"], string>;

/** The fields of a stored message the rendering actually reads. */
export interface RenderableMessage
  extends Pick<ChatMessage, "body" | "forwardFrom" | "intakeKind" | "role"> {}

/**
 * Who is speaking, and how their words arrived.
 *
 * The intake kind is named only where it changes how the words should be read:
 * a forward is somebody else's words quoted by the person, and a voice note was
 * dictated, which is why it rambles and why its punctuation is a guess. A
 * composed message is several of those released together, each already headed
 * with its own number and origin inside the body — so what the label adds is
 * that it is one thing to answer rather than a person repeating themselves.
 */
const speakerLabelOf = (message: RenderableMessage) => {
  const speaker = SPEAKER[message.role];
  if (message.intakeKind === "forward") {
    return `${speaker} (forwarded from ${message.forwardFrom ?? "someone"}):`;
  }
  if (message.intakeKind === "voice") {
    return `${speaker} (voice note, transcribed):`;
  }
  if (message.intakeKind === "compose") {
    return `${speaker} (several messages, sent together — answer them as one):`;
  }
  return `${speaker}:`;
};

/** One stored message as a line of conversation. */
export const renderChatMessage = (message: RenderableMessage) =>
  speech({
    body: message.body,
    gap: "space",
    label: speakerLabelOf(message),
  });

/** The thread, oldest first, blank line between speakers. */
const renderThread = (messages: readonly RenderableMessage[]) =>
  conversation(messages.map(renderChatMessage));

/** What the assembly needs: where the turn runs, and the messages it has not seen. */
export interface ManagerPromptInput {
  /**
   * How many of the most recent rows a fresh turn keeps. The tail, not the
   * head. Ignored by a resumed turn, which is already reading a delta.
   */
  readonly historyLimit?: number;
  /**
   * Every message after the session's watermark, oldest first. The one being
   * answered is the last of them; the rest are what arrived while the previous
   * turn was still running.
   */
  readonly messages: readonly ChatMessage[];
  readonly mode: PromptMode;
  readonly placement: RunPlacement;
}

/** Which message is being answered, said once rather than left to be inferred. */
const ANSWER_INSTRUCTION =
  "The last message above is the one waiting for a reply. If more than one arrived while you were busy, answer them together rather than one at a time.";

/** The full situating prompt a conversation's first turn gets. */
const freshPrompt = (input: ManagerPromptInput) => {
  const limit = input.historyLimit ?? FRESH_HISTORY_MESSAGES;
  const kept = limit <= 0 ? [] : input.messages.slice(-limit);
  return joinSections([
    MANAGER_RULES,
    WRITING_RULES,
    SHARED_RULES,
    section(
      "Where you are working",
      placementSection({ placement: input.placement, repoUrl: null })
    ),
    section("The conversation so far", renderThread(kept)),
    kept.length === 0 ? null : section("What to answer", ANSWER_INSTRUCTION),
  ]);
};

/**
 * What a session that has answered before gets: what has been said since, and
 * nothing else.
 *
 * The rules, the paths and everything already answered are in this session's
 * own history. Restating them is how a resumed turn ends up re-reading its
 * instructions as though they had changed.
 */
const resumedPrompt = (input: ManagerPromptInput) => {
  const thread = renderThread(input.messages);
  return joinSections([
    "# This conversation, continued",
    "You have answered here before and your session history is intact. What follows is everything said since you last read it.",
    section(
      "New since your last turn",
      thread.length === 0 ? "Nothing new arrived." : thread
    ),
    input.messages.length === 0
      ? null
      : section("What to answer", ANSWER_INSTRUCTION),
  ]);
};

/**
 * The prompt for one manager turn. Pure and total: the session's mode picks the
 * shape, and every other decision above is a property of the rows passed in.
 */
export const buildManagerPrompt = (input: ManagerPromptInput) =>
  promptOf(input.mode === "fresh" ? freshPrompt(input) : resumedPrompt(input));
