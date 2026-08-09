/**
 * The one markup dialect this bot speaks: Telegram HTML, with a small closed
 * tag set and every interpolated value escaped on the way in.
 *
 * Everything that reaches a chat is assembled here — a list of tasks, a
 * notice, a footer, an answer somebody's model wrote. A task title is
 * somebody's text and a repository name came off the internet, so the escape
 * is not optional and there is no second parse mode to forget it in.
 *
 * `blockquote expandable` is doing real work rather than decorating: Telegram
 * collapses it to a few lines with a tap to open, which is what keeps a long
 * quoted body from burying the line above it.
 */

import type { RunOutcome, TaskStatus } from "@workspace/domain";
import { escapeHtml, formatDuration } from "./helpers";

/** Lines past which a quoted block is worth collapsing. */
const EXPANDABLE_FROM_LINES = 4;

/** Decimal places on a dollar figure a person reads, not one an accountant sums. */
const COST_DECIMALS = 4;

/** Tokens are shown in thousands; the raw count is noise at a glance. */
const TOKENS_PER_K = 1000;

/** Where a task sits, as one character a phone renders at a glance. */
export const TASK_STATUS_ICONS: Record<TaskStatus, string> = {
  backlog: "📋",
  done: "✅",
  ideas: "💡",
  in_progress: "▶️",
  review: "👀",
};

/** How a run ended, as one character. */
export const RUN_OUTCOME_ICONS: Record<RunOutcome, string> = {
  done: "✅",
  errored: "❌",
  // Two glyphs for the two interrupts, because a reader scanning a list wants
  // the same thing the outcome column splits: the button somebody pressed, and
  // the loop that went down under a run nobody touched.
  interrupted: "🔌",
  lost: "❓",
  stopped: "⏹",
  timeout: "⏱",
};

/** Bold, in Telegram HTML. The argument is escaped; it is always somebody's text. */
export const bold = (text: string) => `<b>${escapeHtml(text)}</b>`;

/** Italic, in Telegram HTML. */
export const italic = (text: string) => `<i>${escapeHtml(text)}</i>`;

/** Inline code, in Telegram HTML — the shape an id or a path belongs in. */
export const code = (text: string) => `<code>${escapeHtml(text)}</code>`;

/**
 * A link. The label is escaped; the URL is not, because escaping it would break
 * the query string. Only URLs this process built are passed here — never one
 * that arrived in a message.
 */
export const link = (options: {
  readonly label: string;
  readonly url: string;
}) => `<a href="${options.url}">${escapeHtml(options.label)}</a>`;

/**
 * Quote a body, collapsing it behind a tap once it is long enough to be in the
 * way. Escaped here, so callers pass plain text.
 */
export const blockquote = (options: {
  readonly expandFrom?: number;
  readonly text: string;
}) => {
  const { expandFrom = EXPANDABLE_FROM_LINES, text } = options;
  const escaped = escapeHtml(text);
  return escaped.split("\n").length >= expandFrom
    ? `<blockquote expandable>${escaped}</blockquote>`
    : `<blockquote>${escaped}</blockquote>`;
};

/** What a finished turn cost, in the shape a footer wants. */
export interface TurnEconomics {
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/**
 * The one-line footer under a finished turn.
 *
 * Every field is dropped when it is null rather than shown as a zero, for the
 * same reason the wide event nulls them: a subscription run reports no dollars,
 * and a `$0.0000` in a chat is a claim that it was free. An empty footer is an
 * empty string, so a caller can append it unconditionally.
 */
export const formatFooter = (economics: TurnEconomics) => {
  const parts: string[] = [];
  if (economics.costUsd !== null) {
    parts.push(`$${economics.costUsd.toFixed(COST_DECIMALS)}`);
  }
  const duration = formatDuration(economics.durationMs);
  if (duration !== null) {
    parts.push(duration);
  }
  if (economics.totalTokens !== null) {
    parts.push(`${(economics.totalTokens / TOKENS_PER_K).toFixed(1)}k tokens`);
  }
  if (economics.turns !== null && economics.turns > 1) {
    parts.push(`${economics.turns} turns`);
  }
  return parts.length === 0 ? "" : italic(parts.join(" · "));
};

/**
 * One line for a task in a list: status icon, title, and the short id a person
 * can paste back into `/stop` or `/rerun`.
 */
export const taskLine = (options: {
  readonly id: string;
  readonly status: TaskStatus;
  readonly title: string;
}) =>
  `${TASK_STATUS_ICONS[options.status]} ${bold(options.title)}\n${code(options.id)}`;
