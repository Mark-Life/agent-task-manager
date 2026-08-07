/**
 * What the bot volunteers without being asked, and the line down the middle of
 * it.
 *
 * A notice is about somebody's card or it is about this system, and the two
 * halves are not interchangeable: one carries a task id and renders from the
 * task's row, the other carries none and is written from the clock. The claim
 * ledger holds both, which is what makes the suppression work, so the
 * distinction has to be somewhere a reader and a `CHECK` constraint can both
 * point at.
 *
 * Its own module rather than a fourth block in `./enums` because the vocabulary
 * has a shape now — two families, a union, and the guard that tells them
 * apart — and because a list of literals and the rule about them read better
 * beside each other than scattered through the enum file.
 */

import { Schema } from "effect";

/** What the bot volunteers about somebody's work. Every one of them names a task. */
export const RUN_NOTIFY_KINDS = [
  "run_finished",
  "run_failed",
  "needs_review",
  "stuck",
] as const;

/** Why a notification about a task was sent. */
export const RunNotifyKind = Schema.Literals(RUN_NOTIFY_KINDS);
export type RunNotifyKind = typeof RunNotifyKind.Type;

/**
 * What the bot volunteers about itself: that it went away, and that it is back.
 *
 * Neither names a task, which is why `chat_notification.task_id` is nullable —
 * and why the split above exists at all, because a renderer that reads a task
 * off a notice must not be handed one of these.
 */
export const SYSTEM_NOTIFY_KINDS = ["system_up", "system_down"] as const;

/** Why a notification about the system itself was sent. */
export const SystemNotifyKind = Schema.Literals(SYSTEM_NOTIFY_KINDS);
export type SystemNotifyKind = typeof SystemNotifyKind.Type;

/** Everything the bot volunteers, on one ledger. */
export const NOTIFY_KINDS = [
  ...RUN_NOTIFY_KINDS,
  ...SYSTEM_NOTIFY_KINDS,
] as const;

/** Why a notification was sent. */
export const NotifyKind = Schema.Literals(NOTIFY_KINDS);
export type NotifyKind = typeof NotifyKind.Type;

const SYSTEM_KINDS: ReadonlySet<string> = new Set(SYSTEM_NOTIFY_KINDS);

/**
 * Whether a notice is about the system rather than about a task.
 *
 * The one place the two halves are told apart at runtime, and the reason it is
 * a guard rather than a comparison at each call site: the ledger holds both, a
 * task id is required of one and forbidden of the other, and the compiler
 * should be the thing enforcing which branch may read it.
 */
export const isSystemNotifyKind = (
  kind: NotifyKind
): kind is SystemNotifyKind => SYSTEM_KINDS.has(kind);
