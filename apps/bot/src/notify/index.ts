/**
 * Everything the bot says without being asked, and the buttons it says it with.
 *
 * The path is one direction: the listener hears a run event, the summary reads
 * what it meant, the resolver decides whose conversation it belongs to, the
 * renderer writes it, and the sender claims it in the ledger before it goes
 * out.
 *
 * The way back is not here. A tapped *Start*, *Approve* or *Message* on one of
 * these messages is an ordinary callback, answered by `telegram/callbacks` over
 * `telegram/board` with a manager token carrying the chat's thread — which is
 * what makes the *next* notice about that task come back to this conversation.
 * What this module contributes to it is the keyboard: the buttons are drawn
 * from the task's status, so the message about work waiting in review is the
 * message with *Approve* on it.
 *
 * One member of this module is about no run at all. `./system` is what the bot
 * says about itself when it restarts, and it lives here because it goes out
 * over the same sender and the same ledger — that claim is the only thing
 * standing between a crash loop and a chat full of "back up".
 */

export {
  DEFAULT_NOTIFY_REPAIR_INTERVAL_MS,
  RUN_EVENT_CHANNEL,
  RunEventNotice,
  runNotifyListener,
} from "./listener";
export type { RunNotice } from "./render";
export { NOTICE_QUOTE_MAX_CHARS, renderNotice } from "./render";
export type { NotifyTarget, NotifyTargetSource } from "./resolve";
export {
  AUDIT_SCAN_LIMIT,
  resolveNotifyTargets,
  resolveWorkspaceChats,
} from "./resolve";
export type { NotifierOptions, NotifyDelivery } from "./send";
export {
  DEFAULT_NOTIFY_RETRY_GRACE_MS,
  dedupeKeyOf,
  Notifier,
  stuckAnnouncerLayer,
} from "./send";
export type { DescribedNotice, NoticeRequest } from "./summary";
export {
  describeNotice,
  NOTICE_SETTLE_MS,
  notifyKindOf,
  TERMINAL_EVENT_KINDS,
} from "./summary";
export type {
  PreviousStop,
  ShutdownVerdict,
  StartupVerdict,
  SystemAnnounceOptions,
} from "./system";
export {
  ANNOUNCE_TIMEOUT_MS,
  announceShutdown,
  announceStartup,
  buildLabel,
  DEFAULT_ANNOUNCE_QUIET_MS,
  renderSystemDown,
  renderSystemUp,
  shutdownVerdict,
  startupVerdict,
  systemDedupeKey,
} from "./system";
