/**
 * Whose name a run's commits carry, read off the credential the system already
 * holds.
 *
 * Nothing configures this. `ATM_GITHUB_TOKEN` belongs to a person — the
 * operator's own `gh` login in every install today — and `GET /user` turns it
 * into that account's login, numeric id and display name. Attributing a run to
 * the human who asked for it therefore costs no second credential, no OAuth
 * flow and no column: the token that pushes the branch is the token that says
 * whose branch it is.
 *
 * **The address is the account's no-reply, never its mailbox.** GitHub resolves
 * `{id}+{login}@users.noreply.github.com` back to the account, so the commit
 * links to a profile and counts toward that person's contributions — which is
 * the whole point, and is what an `agent@atm.invalid` can never do. It also
 * needs nothing the token does not already have: a profile email may be private,
 * and `/user/emails` wants a `user` scope that a `gh` login does not carry.
 * Writing a real mailbox into every commit of every public repo would publish
 * an address its owner never offered, and the no-reply form is the identity
 * without the address.
 *
 * **This says who asked, not who wrote.** The commits are still an agent's
 * work, recorded by the model's own `Co-Authored-By` trailer and by a body that
 * names the task. What the author field carries now is the account answerable
 * for the branch — the one that pushes it, opens the pull request and merges it.
 *
 * **One person per board, for now.** The token is workspace-wide, so this
 * attributes to whoever owns it rather than to whichever member filed the card.
 * That is the same answer for every task while one human runs the board. Real
 * per-requester attribution needs a GitHub identity per user, which nothing in
 * the schema holds — a requester survives only as `audit_entry.actor_user_id`,
 * and that is a login email, not a GitHub account.
 *
 * Total, on purpose. Every failure here — no token, a 401, an endpoint that is
 * down, a body that changed shape — lands on {@link DEFAULT_COMMITTER}. A run
 * whose author is the agent is a run; a run with no checkout is not.
 */

import { Effect, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { readGithubToken } from "./github";
import { type Committer, DEFAULT_COMMITTER } from "./repo";

/** The account behind a token, and the only call this module makes. */
export const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * Sent because GitHub rejects a request without one, and stated here rather
 * than left to whatever the runtime's `fetch` puts there by default.
 */
const USER_AGENT = "agent-task-manager";

/** The REST version this shape was read against. */
const API_VERSION = "2022-11-28";

/**
 * How long the lookup gets. It runs once, while the loop builds its layers, so
 * a GitHub that is not answering costs one boot this much delay and a process
 * that then commits as the agent — rather than a loop that will not start.
 */
const LOOKUP_TIMEOUT = "10 seconds";

/**
 * As much of `GET /user` as an identity needs. `name` is the display name and
 * is absent or null on an account that never set one.
 */
const GithubUser = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/** Total: a body that is not a user reads as none rather than throwing. */
const decodeUser = Schema.decodeUnknownOption(GithubUser);

/** What a decoded account looks like. */
type GithubUser = typeof GithubUser.Type;

/**
 * The address GitHub maps back to an account without being told a mailbox. The
 * id is what makes it stable — a login can be renamed and the old address stops
 * resolving, while the numeric prefix is the account for as long as it exists.
 */
export const noReplyEmailFor = (
  user: Pick<GithubUser, "id" | "login">
): string => `${user.id}+${user.login}@users.noreply.github.com`;

/**
 * The identity an account commits under, or null when the body was not one.
 * Pure, so the shape assumption is testable without a network.
 *
 * The display name is preferred and the login is the fallback, because a commit
 * shows the name and "Andrey Markin" reads as a person where a handle reads as
 * a bot. An id that is not a whole number or a login that is blank means the
 * body is not the one this was written against, and a guess would put a
 * nonsense address on every commit the loop makes.
 */
export const committerFromUser = (body: unknown): Committer | null => {
  const user = Option.getOrNull(decodeUser(body));
  if (user === null || !Number.isInteger(user.id) || user.login.length === 0) {
    return null;
  }
  const name = user.name?.trim();
  return {
    email: noReplyEmailFor(user),
    name: name === undefined || name.length === 0 ? user.login : name,
  };
};

/** Overrides, all of them for a test. */
export interface ResolveCommitterOptions {
  readonly url?: string;
}

/**
 * The identity every checkout this process makes is configured with.
 *
 * Provides its own HTTP client rather than asking for one, matching the clone
 * in `./repo`: the caller is a layer build in the composition root, and adding
 * a requirement there would put an HTTP client in the environment of everything
 * that materializes a workspace.
 *
 * Call it once, at layer build. A per-run call would put an API request on the
 * dispatch path for an answer that cannot change while the process runs.
 */
export const resolveCommitter = (
  options?: ResolveCommitterOptions
): Effect.Effect<Committer> =>
  Effect.gen(function* () {
    const token = yield* readGithubToken;
    if (token === null) {
      return DEFAULT_COMMITTER;
    }
    const http = yield* HttpClient.HttpClient;
    const body = yield* http
      .execute(
        HttpClientRequest.get(options?.url ?? GITHUB_USER_URL).pipe(
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

    const committer = committerFromUser(body);
    if (committer === null) {
      yield* Effect.logInfo(
        "sandbox: github identity lookup returned an unreadable body"
      );
      return DEFAULT_COMMITTER;
    }
    // At info and once per boot, because "why do the commits say that" is the
    // question this answers, and the answer is decided before any run exists to
    // carry it on a span.
    yield* Effect.logInfo(
      `sandbox: run commits are authored as ${committer.name} <${committer.email}>`
    );
    return committer;
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOOKUP_TIMEOUT,
      orElse: () =>
        Effect.logInfo("sandbox: github identity lookup timed out").pipe(
          Effect.as(DEFAULT_COMMITTER)
        ),
    }),
    // Carrying the cause: a 401 on a rotated token and an endpoint that is down
    // read the same from the commits, and only this line tells them apart.
    Effect.catchCause((cause) =>
      Effect.logInfo("sandbox: github identity lookup failed", cause).pipe(
        Effect.as(DEFAULT_COMMITTER)
      )
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("Committer.resolve")
  );
