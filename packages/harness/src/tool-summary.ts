/**
 * How a tool call is described on the timeline without describing what it was
 * given.
 *
 * The rule these two functions encode is the one `./events` states and every
 * normalizer has to obey: a tool's arguments never travel. A `git push` line
 * carries a token, a signed URL carries one in its query, and a timeline is a
 * durable, widely-read place to put either. What a reader actually wants is
 * coarser than the argv anyway — *which* tool, and roughly what it was pointed
 * at — so the summary keeps the identifying head of a value and stops at the
 * first character that could be holding something.
 *
 * Extracted here rather than left in one vendor's normalizer because the second
 * provider that runs a shell needs the same rule, and a safety rule with two
 * copies is a rule with one copy and one near-miss. What stays with each vendor
 * is which of its tools has a summarizable field at all: that is a fact about
 * somebody's tool table, and guessing at an unfamiliar one is exactly how a
 * credential reaches a row.
 *
 * Pure, and total over anything: every path returns a string, and a value of the
 * wrong shape summarizes as nothing rather than as `[object Object]`.
 */

/**
 * Leading words of a shell command kept as its label.
 *
 * Three, because two is the width of a runner and not of a command: `bun run`,
 * `npm run` and `git submodule` all say nothing about what ran, and every
 * `bun run <script>` in the repository collapsed into one indistinguishable
 * row. The third word is what a reader is actually grouping by. It costs
 * nothing in safety — the bare-word rule below still stops at the first word
 * that could hold a value, and a positional secret in third place would already
 * have been reachable in second.
 */
const COMMAND_LABEL_WORDS = 3;

/** A word safe to show: no quotes, no separators, nothing that holds a value. */
const BARE_WORD = /^[\w./-]+$/;

/** Whitespace between the words of a shell command. */
const WHITESPACE = /\s+/;

/** The text of a value that is supposed to be a string, and often is not. */
export const stringOf = (value: unknown) =>
  typeof value === "string" ? value : "";

/**
 * Whether a tool's input is the open bag every caller here reads it as. Both
 * vendors declare a tool's arguments as `unknown`, so what a tool actually sent
 * is only known once something has looked.
 */
export const isRecord = (
  value: unknown
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A shell command reduced to its verb. The argv never travels: a `git push` or
 * a `gh api` line carries a token often enough that the only safe rule is to
 * keep the program and what it was asked to do — {@link COMMAND_LABEL_WORDS}
 * words at most — and stop at the first word that is not a bare one.
 */
export const commandLabel = (command: string) => {
  const kept: string[] = [];
  for (const word of command.trim().split(WHITESPACE)) {
    if (
      kept.length >= COMMAND_LABEL_WORDS ||
      word.startsWith("-") ||
      !BARE_WORD.test(word)
    ) {
      break;
    }
    kept.push(word);
  }
  return kept.join(" ");
};

/** A URL without its query or fragment, which is where a signed link hides. */
export const urlLabel = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
};
