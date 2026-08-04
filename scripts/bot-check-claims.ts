/**
 * How `bot:check` states one claim, and where a claim is read out of.
 *
 * Both halves are here for the same reason they are in `loop-check-claims`: a
 * claim is a value, so the whole check is one effect that stops at the first
 * broken claim and exits non-zero, and the evidence for one is a file on disk
 * rather than something the check held in memory.
 *
 * The ledger is read off the disk deliberately. `atm.chat` rows are what survive
 * the process, and the thing being proved is that an update nobody was allowed
 * to send still left one — an in-memory sink would prove that the emit function
 * was called, which is not the same claim.
 *
 * The row schema is imported from the app rather than restated. A second
 * spelling of it is a check that keeps passing while the thing it checks moves.
 */

import { existsSync, readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { CHAT_EVENT_MARKER, ChatEvent } from "../apps/bot/src/chat-event";

/**
 * One thing the bot was supposed to do and did not.
 *
 * The two fields are rendered into `message` because this is what a failing
 * check exits on: the runner prints the error and nothing else, and a tag with a
 * line number does not say which claim broke or what was found instead.
 */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()(
  "BotCheck.Failed",
  { detail: Schema.String, step: Schema.String }
) {
  override get message() {
    return `${this.step} — ${this.detail}`;
  }
}

/** Asserts one claim, naming what was expected when it does not hold. */
export const check = (options: {
  readonly detail: string;
  readonly ok: boolean;
  readonly step: string;
}) =>
  options.ok
    ? Effect.logInfo(`ok    ${options.step}`)
    : Effect.fail(
        new CheckFailed({ detail: options.detail, step: options.step })
      );

/** One decoded `atm.chat` row of the ledger this check wrote to. */
export type ChatRow = typeof ChatEvent.rowSchema.Type;

const decodeChatRow = Schema.decodeUnknownOption(ChatEvent.rowSchema);

/**
 * The `atm.chat` rows on this check's own ledger, read the way `bun run logs`
 * reads one: a line that is not JSON, or is another unit's, is skipped rather
 * than failing the read.
 */
export const chatRows = (path: string): ChatRow[] => {
  if (!existsSync(path)) {
    return [];
  }
  const rows: ChatRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0 || !line.includes(CHAT_EVENT_MARKER)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const decoded = decodeChatRow(parsed);
    if (decoded._tag === "Some") {
      rows.push(decoded.value);
    }
  }
  return rows;
};

/** The rows this check wrote for one Telegram chat, oldest first. */
export const chatRowsFor = (options: {
  readonly chatId: number;
  readonly path: string;
}) =>
  chatRows(options.path).filter((row) => row.chatId === String(options.chatId));
