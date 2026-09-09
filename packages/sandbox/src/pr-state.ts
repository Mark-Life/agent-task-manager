/**
 * What a pull request is doing, asked of GitHub as cheaply as GitHub allows.
 *
 * `./pull-request` finds the link a run produced, once, at the end of that run.
 * This is the other half: the link is on the card for as long as the card
 * exists, and the state behind it keeps changing — a draft is marked ready, a
 * request is approved and merged, an abandoned one is closed — so a board that
 * draws one icon for all four is a board somebody has to leave to read.
 *
 * **The conditional request is the whole design.** GitHub's own words: *"Making
 * a conditional request does not count against your primary rate limit if a
 * `304` response is returned and the request was made while correctly
 * authorized with an `Authorization` header."* So the caller keeps the `ETag`
 * that came with the last answer, sends it back as `If-None-Match`, and every
 * pull request that has not moved since is free. That is what makes refreshing
 * a board of thirty cards on view an affordable thing to do at all, and it is
 * why {@link PrStateAnswer} has a case for *unchanged* that is distinct from
 * both a state and a failure — a caller that folded it into either would be
 * throwing away the only cheap answer.
 *
 * **One pull request per request, deliberately.** A single GraphQL query could
 * fetch thirty states at once, which is fewer round trips; it is also billed by
 * point cost on every call, because GraphQL has no conditional requests. Thirty
 * `304`s cost nothing and one GraphQL query costs a point, so the two
 * optimisations do not compose and this is the one that ends at zero.
 * `.docs/pull-request-state.md` has the arithmetic.
 *
 * Total, like `./pull-request` and `./committer`. Every failure — no credential,
 * a host `api.github.com` cannot answer for, a repository the token cannot see,
 * a rate limit, a body that changed shape — answers
 * {@link PrStateUnavailable}, because the caller is a background refresh behind
 * a board that has already rendered and an unanswered lookup must leave the
 * card exactly as it was.
 */

import {
  type PrState,
  type PullRequestRef,
  parsePrUrl,
  prStateOf,
} from "@workspace/domain";
import { Effect, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { readGithubToken } from "./github";
import { GITHUB_API_ORIGIN } from "./pull-request";

/**
 * The one host `api.github.com` can answer for. `parsePrUrl` accepts every host
 * on purpose; the check belongs here, where the endpoint is.
 */
const GITHUB_HOST = "github.com";

/** Sent because GitHub rejects a request without one. */
const USER_AGENT = "agent-task-manager";

/** The REST version this shape was read against. */
const API_VERSION = "2022-11-28";

/**
 * How long one lookup gets. It runs in the background behind a board that has
 * already drawn from cache, so a GitHub that is not answering costs a card that
 * keeps the state it had — never a request that waits.
 */
const LOOKUP_TIMEOUT = "10 seconds";

/** The status that means "you already have this", and the only free answer. */
const NOT_MODIFIED = 304;

/** Where success ends. Everything from here up is an answer about the request, not the pull request. */
const FIRST_ERROR_STATUS = 400;

/**
 * The header that says how much of the hour's allowance is left. Read only when
 * GitHub refuses, where it is the difference between "this token cannot see
 * that repository" and "this token has been asking too often".
 */
const RATE_LIMIT_REMAINING_HEADER = "x-ratelimit-remaining";

/**
 * As much of a pull request as an icon needs.
 *
 * `merged` is on the single-pull-request resource and not on the list one,
 * which is the reason this asks for one pull request by number rather than
 * filtering a page: without it, a merged request and an abandoned one are both
 * `state: "closed"`.
 */
const PullRequestState = Schema.Struct({
  draft: Schema.Boolean,
  merged: Schema.Boolean,
  state: Schema.String,
});

/** The body, decoded. Total: anything else reads as unavailable. */
const decodePullRequestState = Schema.decodeUnknownOption(PullRequestState);

/** GitHub had nothing new to say, and charged nothing to say so. */
export interface PrStateUnchanged {
  readonly _tag: "unchanged";
}

/** GitHub answered with a state, and with the validator to send next time. */
export interface PrStateRead {
  readonly _tag: "state";
  /** `null` when GitHub sent no `ETag`, which costs the next read its discount and nothing else. */
  readonly etag: string | null;
  readonly state: PrState;
}

/**
 * Nothing could be read. Not an error: a card whose repository this credential
 * cannot see should draw the plain icon it drew before this existed.
 */
export interface PrStateUnavailable {
  readonly _tag: "unavailable";
}

export type PrStateAnswer = PrStateRead | PrStateUnavailable | PrStateUnchanged;

const UNAVAILABLE: PrStateUnavailable = { _tag: "unavailable" };
const UNCHANGED: PrStateUnchanged = { _tag: "unchanged" };

/** What one lookup needs. */
export interface PrStateLookup {
  /** The origin to ask. Overridden by a test; production uses the default. */
  readonly apiOrigin?: string;
  /** The validator from the last answer, or null to ask unconditionally. */
  readonly etag: string | null;
  /** The card's `pr_url`, in whatever shape somebody wrote it. */
  readonly prUrl: string;
}

/** The `If-None-Match` header, or nothing when there is no validator to send. */
const conditionalHeaders = (etag: string | null) =>
  etag === null ? {} : { "if-none-match": etag };

/**
 * The pull request this URL names, as a request against GitHub's REST API.
 *
 * `Accept: application/vnd.github+json` and the version header are what pin the
 * body's shape; the conditional header is what makes the answer free when
 * nothing has changed.
 */
const lookupRequest = (options: {
  readonly apiOrigin: string;
  readonly etag: string | null;
  readonly ref: PullRequestRef;
  readonly token: Redacted.Redacted;
}) =>
  HttpClientRequest.get(
    `${options.apiOrigin}/repos/${options.ref.owner}/${options.ref.repo}/pulls/${options.ref.number}`
  ).pipe(
    HttpClientRequest.bearerToken(Redacted.value(options.token)),
    HttpClientRequest.acceptJson,
    HttpClientRequest.setHeaders({
      ...conditionalHeaders(options.etag),
      "user-agent": USER_AGENT,
      "x-github-api-version": API_VERSION,
    })
  );

/**
 * What the state of this pull request is, or that it has not changed, or that
 * it could not be read.
 *
 * Provides its own HTTP client rather than asking for one, matching
 * `./pull-request`: the caller is a refresh loop, and a requirement added here
 * would reach the composition root of every process that can hold a task.
 */
export const readPrState = (
  lookup: PrStateLookup
): Effect.Effect<PrStateAnswer> =>
  Effect.gen(function* () {
    const ref = parsePrUrl(lookup.prUrl);
    if (ref === null || ref.host !== GITHUB_HOST) {
      return UNAVAILABLE;
    }
    // No credential is no answer, and asking anonymously would spend the shared
    // rate limit to be told so on a private repository.
    const token = yield* readGithubToken;
    if (token === null) {
      return UNAVAILABLE;
    }

    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      lookupRequest({
        apiOrigin: lookup.apiOrigin ?? GITHUB_API_ORIGIN,
        etag: lookup.etag,
        ref,
        token,
      })
    );

    if (response.status === NOT_MODIFIED) {
      return UNCHANGED;
    }
    if (response.status >= FIRST_ERROR_STATUS) {
      // The remaining allowance is logged rather than acted on: there is
      // nothing useful to do with a refusal here beyond leaving the card as it
      // was, and this is the line that tells an operator which refusal it was.
      yield* Effect.logInfo("sandbox: github pull request state refused", {
        pullRequest: ref.slug,
        rateLimitRemaining: Option.getOrNull(
          Headers.get(response.headers, RATE_LIMIT_REMAINING_HEADER)
        ),
        status: response.status,
      });
      return UNAVAILABLE;
    }

    const body = yield* response.json;
    const decoded = decodePullRequestState(body);
    if (Option.isNone(decoded)) {
      return UNAVAILABLE;
    }
    return {
      _tag: "state",
      etag: Option.getOrNull(Headers.get(response.headers, "etag")),
      state: prStateOf(decoded.value),
    } satisfies PrStateRead;
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOOKUP_TIMEOUT,
      orElse: () =>
        Effect.logInfo("sandbox: github pull request state timed out").pipe(
          Effect.as(UNAVAILABLE)
        ),
    }),
    Effect.catchCause((cause) =>
      Effect.logInfo(
        "sandbox: github pull request state lookup failed",
        cause
      ).pipe(Effect.as(UNAVAILABLE))
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("Github.readPrState")
  );
