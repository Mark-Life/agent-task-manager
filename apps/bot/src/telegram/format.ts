/**
 * The two markup dialects this bot speaks, and where the line between them is.
 *
 * **Markdown is for what a model wrote.** The manager's answers are markdown
 * because that is what a coding model produces unprompted, and Telegram's rich
 * message API takes it raw — no escaping, because escaping a model's markdown
 * is how a code fence turns into literal backslashes.
 *
 * **HTML is for what this bot wrote.** Every list of tasks, every footer, every
 * status line is assembled here and rendered as Telegram HTML, where the tag
 * set is small and closed and every interpolated value goes through
 * `escapeHtml` on the way in. A task title is somebody's text; a repository
 * name came off the internet. The one rule this module exists to hold is that
 * bot chrome and model output never share a parse mode, because the escaping
 * they need is opposite.
 *
 * `blockquote expandable` is doing real work rather than decorating: Telegram
 * collapses it to a few lines with a tap to open, which is what keeps a
 * forty-line tool trace from burying the answer under it.
 */

import type { RunOutcome, TaskStatus } from "@workspace/domain";
import { escapeHtml, formatDuration } from "./helpers";

/** Lines past which a quoted block is worth collapsing. */
const EXPANDABLE_FROM_LINES = 4;

/** Room left for the markup around a quoted body inside one message. */
const QUOTE_MARKUP_HEADROOM = 200;

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
  interrupted: "⏹",
  lost: "❓",
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

/**
 * Render the tool calls of a turn as one italic block, collapsed once there are
 * enough of them to matter. Returns the HTML and the plain text behind it, so a
 * send that loses its parse mode still says something.
 */
export const renderToolLines = (lines: readonly string[]) => {
  const plain = lines.join("\n");
  const body = lines.map((line) => italic(line)).join("\n");
  const html =
    lines.length >= EXPANDABLE_FROM_LINES
      ? `<blockquote expandable>${body}</blockquote>`
      : body;
  return { html, plain };
};

/**
 * Render reasoning as a collapsed italic quote, keeping the tail when it does
 * not fit. The tail rather than the head: the last thing the model thought is
 * the part that explains what it did next.
 */
export const renderReasoning = (options: {
  readonly maxChars: number;
  readonly text: string;
}) => {
  const budget = Math.max(1, options.maxChars - QUOTE_MARKUP_HEADROOM);
  const plain =
    options.text.length > budget
      ? `...${options.text.slice(options.text.length - budget)}`
      : options.text;
  const escaped = escapeHtml(plain);
  const html =
    escaped.split("\n").length >= EXPANDABLE_FROM_LINES
      ? `<blockquote expandable><i>${escaped}</i></blockquote>`
      : `<i>${escaped}</i>`;
  return { html, plain };
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
