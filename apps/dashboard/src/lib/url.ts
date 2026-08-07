/** A GitHub pull request path, which is the link this app carries most often. */
const PR_PATH = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;

/** The subdomain nobody reads out loud. */
const WWW = /^www\./;

/** A trailing slash carries no information in a link a person is reading. */
const TRAILING_SLASH = /\/$/;

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
