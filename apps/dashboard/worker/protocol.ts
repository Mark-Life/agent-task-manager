/**
 * The two things the page and the worker say to each other.
 *
 * Shared rather than spelled twice: a message whose name only matches in one of
 * the two files fails silently, and the failure is "the app stopped updating",
 * which nobody notices for a week.
 */

/** Page → worker: stop waiting, this is a good moment. The page reloads when the worker takes over. */
export const SKIP_WAITING = "atm:skip-waiting";

/** Worker → page: a file this build is made of is no longer on the server. */
export const STALE_BUILD = "atm:stale-build";

/**
 * What arrives on the other side, which is `unknown` until it is looked at —
 * `postMessage` carries anything, including a message from something that is
 * not this app at all.
 */
export interface WorkerMessage {
  readonly type?: string;
}
