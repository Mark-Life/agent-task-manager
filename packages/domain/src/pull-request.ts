/**
 * What a pull request's state is, and how to get from the URL on a card to the
 * three things GitHub needs to be asked about it.
 *
 * `task.pr_url` is a link, which is all a person needs to open the page and
 * nothing a board can draw with. Four states are what GitHub itself draws — a
 * draft, one open for review, one merged, one closed without merging — and they
 * are what turns a row of identical icons into a column somebody can read at a
 * glance. The mapping from GitHub's own fields to these four is
 * {@link prStateOf}, and it lives here because two callers need to agree on it:
 * whatever asks GitHub, and whatever renders the answer.
 *
 * The parse is here for the same reason `parseRepoUrl` is: a browser deciding
 * whether to draw a state and a server deciding whether to ask for one have to
 * agree about what a pull request URL is, and a rule restated in two packages is
 * two rules by the end of the year.
 */

import { Schema } from "effect";

/**
 * The four states, in the order a pull request passes through them. Draft and
 * open are live; merged and closed are where one stops.
 */
export const PR_STATES = ["draft", "open", "merged", "closed"] as const;

/**
 * What a pull request is doing, as the card draws it.
 *
 * Deliberately not GitHub's own two-value `state`: that field answers `open` for
 * a draft nobody may merge yet and `closed` for both the request that shipped
 * and the one that was abandoned, which is exactly the distinction a person
 * opens the page to find out.
 */
export const PrState = Schema.Literals(PR_STATES);
export type PrState = typeof PrState.Type;

/**
 * The states nothing further happens from, and therefore the ones a refresh
 * stops at. A merged pull request is finished; a closed one can in principle be
 * reopened, and the cost of noticing that late is a stale icon on a card whose
 * link still works, against a poll that would otherwise run forever on every
 * card the board has ever produced.
 */
export const isTerminalPrState = (state: PrState) =>
  state === "merged" || state === "closed";

/** How a state reads in a sentence, tooltip or label. */
export const PR_STATE_LABEL = {
  closed: "closed",
  draft: "draft",
  merged: "merged",
  open: "open",
} as const satisfies Record<PrState, string>;

/**
 * The fields GitHub's own pull request resource carries about its state. Named
 * as GitHub names them, because the whole value of this function is that the
 * translation happens once and is visible.
 */
export interface GithubPullRequestState {
  readonly draft: boolean;
  readonly merged: boolean;
  /** GitHub's own two-value state: `open` or `closed`. */
  readonly state: string;
}

/**
 * GitHub's three fields as one of ours.
 *
 * The order of the tests is the whole of it. `merged` is checked first because a
 * merged request is also `closed`, and `draft` last because GitHub leaves
 * `draft: true` set on a draft that was closed without ever being marked ready —
 * so a draft test in front of the closed test would draw an abandoned request as
 * one still being written.
 */
export const prStateOf = (pull: GithubPullRequestState): PrState => {
  if (pull.merged) {
    return "merged";
  }
  if (pull.state !== "open") {
    return "closed";
  }
  return pull.draft ? "draft" : "open";
};

/** A pull request, taken apart far enough to ask GitHub's REST API about it. */
export interface PullRequestRef {
  /** Lowercased, so a link pasted as `GitHub.com` still matches. */
  readonly host: string;
  readonly number: number;
  readonly owner: string;
  readonly repo: string;
  /** `owner/repo#number`. Safe to put on a span or in a log line. */
  readonly slug: string;
}

/** `/owner/repo/pull/123`, with anything after the number ignored. */
const PULL_PATH_RE = /^\/([^/]+)\/([^/]+)\/pulls?\/(\d+)(?:\/.*)?$/;

/** One path segment of an owner or repository name: no slashes, no leading dot. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Ten digits is already a hundred times more than any repository has. */
const MAX_PR_NUMBER_DIGITS = 10;

/**
 * The pull request a URL names, or null for anything that is not one.
 *
 * Total and pure, and null rather than a guess: `pr_url` is a free text column
 * three writers can put anything in, and a card holding a link to an issue, a
 * commit or somebody's notes should render the plain icon it renders today
 * rather than send a request for a resource that does not exist.
 *
 * Every host is accepted here, exactly as {@link parseRepoUrl} accepts every
 * host — whether `api.github.com` can answer for it is the caller's question and
 * belongs where the endpoint is.
 */
export const parsePrUrl = (raw: string): PullRequestRef | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const match = PULL_PATH_RE.exec(url.pathname);
  const owner = match?.[1];
  const repo = match?.[2];
  const digits = match?.[3];
  if (
    owner === undefined ||
    repo === undefined ||
    digits === undefined ||
    digits.length > MAX_PR_NUMBER_DIGITS ||
    !(SEGMENT_RE.test(owner) && SEGMENT_RE.test(repo))
  ) {
    return null;
  }
  const number = Number(digits);
  if (number === 0) {
    return null;
  }
  return {
    host: url.hostname.toLowerCase(),
    number,
    owner,
    repo,
    slug: `${owner}/${repo}#${number}`,
  };
};
