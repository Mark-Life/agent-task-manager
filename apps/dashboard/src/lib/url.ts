import type { TaskId } from "@workspace/domain";

/** A GitHub pull request path, which is the link this app carries most often. */
const PR_PATH = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;

/** The subdomain nobody reads out loud. */
const WWW = /^www\./;

/** A trailing slash carries no information in a link a person is reading. */
const TRAILING_SLASH = /\/$/;

/**
 * Where a task lives, as a link that can be handed to someone else.
 *
 * `/tasks/<taskId>` is a contract, not a preference: the Telegram bot builds
 * the same address, and the manager agent reads a task out of one — so this is
 * spelled the way `taskRoute` and the bot spell it, and carries the id
 * verbatim. Whole URL rather than the bare uuid because the two readers want
 * different halves of it: a person clicks it, an agent parses the id back out.
 *
 * The origin is a parameter so this stays a function of its inputs; in the app
 * it is whichever host the reader already has open.
 */
export const taskUrl = (
  taskId: TaskId,
  origin: string = window.location.origin
) => `${origin.replace(TRAILING_SLASH, "")}/tasks/${taskId}`;

/**
 * Whether this text is something a browser can open in a new tab.
 *
 * Only the two web schemes count. The fields these strings come from accept
 * anything a person types, and a half-written `github.com/…` or a `javascript:`
 * payload must not be rendered as a link a click follows.
 */
export const isHttpUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * A URL as a person reads it, for a row where the address is the value.
 *
 * The scheme is noise — every link here is https — and a full pull request URL
 * spends forty characters saying `owner/repo#12`. Anything unparseable comes
 * back untouched, because a field holds whatever was typed into it and this is
 * a display concern, not a validator.
 */
export const prettyUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  const pr = url.hostname === "github.com" ? PR_PATH.exec(url.pathname) : null;
  if (pr !== null) {
    return `${pr[1]}#${pr[2]}`;
  }

  const host = url.hostname.replace(WWW, "");
  const path = url.pathname.replace(TRAILING_SLASH, "");
  return `${host}${path}${url.search}`;
};
