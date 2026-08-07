/**
 * What a notification says, and what it offers to do about it.
 *
 * A person is told the outcome of work, not the transcript of it: which task,
 * how it ended, what it cost, how long it took, and a link. Tool calls, diffs
 * and the model's narration are deliberately absent — they are in the run's
 * timeline where somebody can go and read them, and a chat that replays them
 * is a chat nobody reads at all.
 *
 * Every number is dropped when it is null rather than shown as a zero, for the
 * reason the run row nulls them: a run on a subscription reports no dollars,
 * and `$0.0000` in a chat is a claim that the work was free.
 *
 * The buttons come from the task's status rather than from the notice, so what
 * a person is offered is what the board would actually accept. That is what
 * makes *Approve* appear exactly on the message that says something is waiting
 * for review, and *Start* on one about a task nobody has picked up — no
 * separate table of which notice gets which button, and no button whose only
 * possible outcome is the gateway's refusal.
 *
 * Pure: no service, no clock, no network. The message a person will read is
 * decided by a function a test can call.
 */

import type {
  RunNotifyKind,
  RunOutcome,
  TaskId,
  TaskStatus,
} from "@workspace/domain";
import {
  blockquote,
  bold,
  code,
  formatFooter,
  RUN_OUTCOME_ICONS,
  TASK_STATUS_ICONS,
} from "../telegram/format";
import { taskKeyboard } from "../telegram/keyboard";

/** How much of a run's own last words a notice carries before it is clipped. */
export const NOTICE_QUOTE_MAX_CHARS = 500;

/**
 * The opening line, which is the only part read on a locked screen.
 *
 * Keyed by `RunNotifyKind` rather than by every kind the ledger holds: what the
 * bot says about itself is rendered in `./system`, out of no task at all, and a
 * table that admitted those kinds would carry two entries this renderer could
 * never be given.
 */
const HEADLINES: Record<RunNotifyKind, string> = {
  needs_review: "👀 Ready for review",
  run_failed: "❌ Run failed",
  run_finished: "✅ Run finished",
  stuck: "⚠️ This run looks stuck",
};

/**
 * Everything a message about one run needs, already read off the rows.
 *
 * Free text on it — the error, the last line — is expected to have been
 * sanitized by whoever read it: a run's error message can carry a URL with a
 * token in it, and the redaction belongs at the read, not at the render.
 */
export interface RunNotice {
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly errorMessage: string | null;
  /** Whether a container is still working, which decides *Stop* against *Rerun*. */
  readonly hasLiveRun: boolean;
  readonly kind: RunNotifyKind;
  /** The run's own last words, sanitized and clipped. Null when there are none. */
  readonly lastMessage: string | null;
  readonly outcome: RunOutcome | null;
  readonly taskId: TaskId;
  readonly taskStatus: TaskStatus;
  readonly taskTitle: string;
  readonly totalTokens: number | null;
  readonly turns: number | null;
}

/** How the run ended, as an icon and a word, or nothing when it never closed. */
const outcomeLine = (notice: RunNotice) => {
  const footer = formatFooter({
    costUsd: notice.costUsd,
    durationMs: notice.durationMs,
    totalTokens: notice.totalTokens,
    turns: notice.turns,
  });
  if (notice.outcome === null) {
    return footer.length === 0 ? null : footer;
  }
  const ending = `${RUN_OUTCOME_ICONS[notice.outcome]} ${notice.outcome}`;
  return footer.length === 0 ? ending : `${ending} · ${footer}`;
};

/** The tail of the run's own words, short enough to read at a glance. */
const quoted = (text: string) =>
  blockquote({
    text:
      text.length > NOTICE_QUOTE_MAX_CHARS
        ? `${text.slice(0, NOTICE_QUOTE_MAX_CHARS)}…`
        : text,
  });

/**
 * The message and the keyboard for one notice.
 *
 * `taskUrl` is the dashboard's address for the task, or null where the
 * deployment has no public URL — in which case the id is still on the message,
 * because a person with no link needs something to paste into `/stop`.
 */
export const renderNotice = (options: {
  readonly notice: RunNotice;
  readonly taskUrl?: string | null;
}) => {
  const { notice, taskUrl = null } = options;
  const lines = [
    `${HEADLINES[notice.kind]}`,
    `${TASK_STATUS_ICONS[notice.taskStatus]} ${bold(notice.taskTitle)}`,
    code(notice.taskId),
  ];

  const ending = outcomeLine(notice);
  if (ending !== null) {
    lines.push(ending);
  }
  if (notice.errorMessage !== null) {
    lines.push(code(notice.errorMessage));
  }
  if (notice.lastMessage !== null) {
    lines.push(quoted(notice.lastMessage));
  }

  return {
    keyboard: taskKeyboard({
      hasLiveRun: notice.hasLiveRun,
      status: notice.taskStatus,
      taskId: notice.taskId,
      taskUrl,
    }),
    text: lines.join("\n"),
  };
};
