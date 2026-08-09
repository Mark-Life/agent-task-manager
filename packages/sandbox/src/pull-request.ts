/**
 * The pull request a run's branch has, asked of GitHub rather than of the agent.
 *
 * A worker that opens a pull request says so in its message, and that message is
 * the detail — what it did, what it decided, what it could not do. What it is
 * not is a structured field: the link lives inside prose, so the board cannot
 * render it, sort on it, or tell a card with a change waiting from a card with a
 * document. `task.pr_url` is that field, and this module is how it gets filled.
 *
 * **Asked, not told.** The alternative was a line in the worker's prompt telling
 * it to call `tasks_edit` with the URL after opening the pull request. That is
 * one more step at the end of a long turn, in the same paragraph as the message
 * rule the stop hook exists to enforce — and the one thing already known about
 * that paragraph is that models drop the end of it, which is why the hook and
 * the fallback message are both there. So the loop asks instead. The branch a
 * task's runs push is `branchForTask`, decided by this system and keyed on the
 * task alone, so "is there a pull request for this task" is a question with an
 * exact answer that no model has to remember to give.
 *
 * **Only a real one.** GitHub answers with the pull requests that exist on that
 * branch and no others, so a run that produced a document, an artifact or an
 * answer gets an empty list and the task's field is left alone. There is no
 * shape this can put in the column that is not a pull request GitHub confirmed.
 *
 * **More than one is normal, and the open one wins.** Reruns and follow-ups push
 * the same branch, so they usually update one pull request; but a merged one
 * followed by more work on the same task leaves two, and a closed-unmerged one
 * followed by a second attempt leaves two more. The field holds the one review
 * happens on now — the open one, or the most recent when none is open — because
 * that is the question a person clicking the link is asking. The others are not
 * lost: every run's message carries the link it opened, so the thread keeps the
 * whole history and the column keeps the current answer.
 *
 * Total, like `./committer` and `./scopes`. Every failure — no credential, a
 * repository on another host, a rate limit, a body that changed shape — answers
 * "no pull request", because the caller is a run that has already finished and
 * an unanswered lookup must not become a run that failed to close.
 */

import { parseRepoUrl } from "@workspace/domain";
import { Effect, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { readGithubToken } from "./github";

/** Where the REST API lives. A test points the lookup at its own server. */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/**
 * The one host `api.github.com` can answer for.
 *
 * `parseRepoUrl` accepts every host on purpose — a mirror, an enterprise
 * install, a plain git server all clone fine — so the check belongs here, where
 * the endpoint is. A GitLab project asked of GitHub's API is a 404 at best and
 * somebody else's repository at worst.
 */
const GITHUB_HOST = "github.com";

/** Sent because GitHub rejects a request without one. */
const USER_AGENT = "agent-task-manager";

/** The REST version this shape was read against. */
const API_VERSION = "2022-11-28";

/**
 * How long the lookup gets. It runs once per worker run that had a checkout, on
 * the closing path, so a GitHub that is not answering costs the run this much
 * delay and a task whose field stays null — never a run that does not close. The
 * message is already posted by then, so the link is on the card either way.
 */
const LOOKUP_TIMEOUT = "10 seconds";

/**
 * How many pull requests on one branch are worth reading. One is the ordinary
 * answer and a handful is a task that has been through several rounds; a page of
 * twenty is far past either, and asking for more would be paging for rows that
 * only exist on a branch somebody has been reopening for a year.
 */
const PAGE_SIZE = 20;

/**
 * As much of a pull request as a link needs. `html_url` is the page a person
 * opens — not `url`, which is the API resource and renders as JSON in a browser.
 */
const PullRequest = Schema.Struct({
  html_url: Schema.String,
  state: Schema.String,
});

/** The list endpoint's body. Total: anything else reads as no pull requests. */
const decodePullRequests = Schema.decodeUnknownOption(
  Schema.Array(PullRequest)
);

/** The state GitHub gives a pull request that is still being reviewed. */
const OPEN = "open";

/**
 * Which of a branch's pull requests the task's field should hold, given a body
 * listed newest first.
 *
 * Pure, so the policy — the open one, else the most recent — is asserted without
 * a network. A merged pull request is `closed` with a merge timestamp, so a task
 * whose work has shipped keeps pointing at the request it shipped through, which
 * is where the review of it is.
 */
export const choosePullRequest = (body: unknown): string | null => {
  const listed = Option.getOrNull(decodePullRequests(body));
  if (listed === null) {
    return null;
  }
  const usable = listed.filter((pull) => pull.html_url.trim().length > 0);
  const open = usable.find((pull) => pull.state === OPEN);
  return (open ?? usable[0])?.html_url ?? null;
};

/** What the lookup needs, as the closing path already holds it. */
export interface PullRequestLookup {
  /** The origin to ask. Overridden by a test; production uses the default. */
  readonly apiOrigin?: string;
  /** The branch the run pushed. Null for a run with no repo, and no lookup. */
  readonly branch: string | null;
  /** The project's repository URL, which may carry a credential and never leaves here. */
  readonly repoUrl: string | null;
}

/**
 * The pull request open on this branch, or the most recent one it ever had, or
 * null.
 *
 * Provides its own HTTP client rather than asking for one, matching
 * `./committer`: the caller is the orchestrator's terminal path, which is a
 * finalizer, and a requirement added there would reach every close in the
 * system for a lookup only a worker run with a repository ever makes.
 */
export const pullRequestForBranch = (
  input: PullRequestLookup
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const { branch, repoUrl } = input;
    if (branch === null || repoUrl === null) {
      return null;
    }
    const repo = parseRepoUrl(repoUrl);
    if (repo === null || repo.host !== GITHUB_HOST) {
      return null;
    }
    // No credential is no push, so it is also no pull request — and asking
    // anonymously would spend the shared rate limit to be told so.
    const token = yield* readGithubToken;
    if (token === null) {
      return null;
    }

    const http = yield* HttpClient.HttpClient;
    const body = yield* http
      .execute(
        HttpClientRequest.get(
          `${input.apiOrigin ?? GITHUB_API_ORIGIN}/repos/${repo.slug}/pulls`
        ).pipe(
          // `head` is `owner:branch` and the owner is the repository's own,
          // because this system pushes the branch to `origin` rather than to a
          // fork. `state=all` so a task whose pull request was merged or closed
          // still resolves to the request it had, newest first so the fallback
          // below is the most recent one.
          HttpClientRequest.setUrlParams({
            direction: "desc",
            head: `${repo.owner}:${branch}`,
            per_page: PAGE_SIZE,
            sort: "created",
            state: "all",
          }),
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({
            "user-agent": USER_AGENT,
            "x-github-api-version": API_VERSION,
          })
        )
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json)
      );

    return choosePullRequest(body);
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOOKUP_TIMEOUT,
      orElse: () =>
        Effect.logInfo("sandbox: github pull request lookup timed out").pipe(
          Effect.as(null)
        ),
    }),
    // Carrying the cause, because a 404 on a repository the token cannot see and
    // a rate limit read the same from the empty column this produces.
    Effect.catchCause((cause) =>
      Effect.logInfo("sandbox: github pull request lookup failed", cause).pipe(
        Effect.as(null)
      )
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("Github.pullRequestForBranch")
  );
