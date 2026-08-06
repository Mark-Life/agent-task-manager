/**
 * What the GitHub credential is allowed to do, read off the credential itself.
 *
 * `./github` decides how the token reaches a turn. This decides whether the
 * token is worth handing over, because the two failures it catches are the same
 * failure a year apart: a credential that clones and pushes and then refuses
 * the one thing a task needed.
 *
 * The refusal that prompted this is exact. GitHub answers a push that touches
 * `.github/workflows/` with *"refusing to allow an OAuth App to create or
 * update workflow … without `workflow` scope"* — and the `gh auth login` token
 * most installs paste into {@link AGENT_TOKEN_ENV_VAR} carries `repo` and not
 * `workflow`, because that is the set the CLI asks consent for. So an agent
 * could implement a release change, push everything except the workflow half of
 * it, and open a pull request that reviews as complete and is not. Nothing in
 * the loop knew, because nothing had ever asked the token what it was good for.
 *
 * Asking is one request. A classic or OAuth token's scopes come back on every
 * response as `x-oauth-scopes`, so `GET /user` at boot answers "what can this
 * do" for the same price the identity lookup in `./committer` already pays for
 * "whose is it". A fine-grained token and an App installation token answer
 * nothing — their permissions live on the token's own settings page or on the
 * App, and there is no header for them. That is a real difference and this
 * module reports it as one rather than guessing: {@link GithubCredential} has a
 * case for "scoped, and here they are" and a case for "not readable from here,
 * and this is where to look".
 *
 * **Nothing here fails a boot.** A missing scope is a warning naming the scope
 * and the command that widens it, because the alternative is a loop that will
 * not start over a repository nobody is going to push to. The point is that the
 * sentence exists at all: the cost of the narrow token was paid by a run that
 * worked around it quietly, and a warning at boot is what turns that into
 * something an operator reads once and fixes.
 */

import { Effect, Option, Redacted } from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
// The same endpoint the identity lookup calls, spelled once. `GET /user` is
// both "whose token is this" and — in its response headers — "what may it do".
import { GITHUB_USER_URL } from "./committer";
import { AGENT_TOKEN_ENV_VAR, readGithubToken } from "./github";

/**
 * The header a classic or OAuth token's scopes arrive on. Present on every
 * response to such a token and absent for every other kind, which is what makes
 * it a classifier as well as a list.
 */
export const SCOPE_HEADER = "x-oauth-scopes";

/** Sent because GitHub rejects a request without one. */
const USER_AGENT = "agent-task-manager";

/** The REST version these headers were read against. */
const API_VERSION = "2022-11-28";

/**
 * How long the probe gets. It runs once, at boot, so a GitHub that is not
 * answering costs this much delay and a loop that says it could not read the
 * credential — never a loop that will not start.
 */
const PROBE_TIMEOUT = "10 seconds";

/**
 * The two answers that mean the credential itself is the problem: a token
 * GitHub does not know, and one it knows and will not act on. Neither names a
 * scope, so neither is reported as one.
 */
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const REFUSING_STATUSES: readonly number[] = [UNAUTHORIZED, FORBIDDEN];

/** Where the error range starts. Anything above is GitHub, not the token. */
const FIRST_ERROR_STATUS = 400;

/**
 * The prefixes GitHub mints, longest first so `github_pat_` is matched before
 * anything shorter could.
 *
 * The kind decides the remedy and nothing else. Scopes on an OAuth token were
 * fixed when somebody clicked approve, so widening one is a re-consent; a
 * classic token is re-minted from a settings page; a fine-grained token's
 * permissions are edited on the token; an App's are edited on the App and then
 * re-approved on the installation, and until that approval every existing
 * installation token keeps the old set. Four different answers to one question,
 * which is why the message is built from this rather than written once.
 */
const TOKEN_PREFIXES = [
  ["github_pat_", "fine-grained-pat"],
  ["ghp_", "classic-pat"],
  ["gho_", "oauth"],
  ["ghu_", "app-user"],
  ["ghs_", "app-installation"],
] as const satisfies readonly (readonly [string, string])[];

/** Which kind of credential the board was given. */
export type GithubTokenKind = (typeof TOKEN_PREFIXES)[number][1] | "unknown";

/**
 * How each kind is named in a sentence a person reads, article included — the
 * article is not always "a", and a message that assembles one is a message that
 * gets it wrong for the two kinds beginning with a vowel.
 */
const KIND_LABEL = {
  "app-installation": "a GitHub App installation",
  "app-user": "a GitHub App user-to-server",
  "classic-pat": "a classic personal access token",
  "fine-grained-pat": "a fine-grained personal access token",
  oauth: "an OAuth (`gh auth login`)",
  unknown: "an unrecognized",
} as const satisfies Record<GithubTokenKind, string>;

/**
 * What kind of credential a token is, by its prefix.
 *
 * The prefix is GitHub's own and is the only thing about a token that can be
 * read without spending a request. `unknown` is an honest answer rather than a
 * guess: an enterprise host, a token minted before the prefixes existed, or a
 * value that is not a token at all all land there, and every message built from
 * it stays true by naming no settings page in particular.
 */
export const tokenKindOf = (token: Redacted.Redacted): GithubTokenKind => {
  const value = Redacted.value(token);
  const matched = TOKEN_PREFIXES.find(([prefix]) => value.startsWith(prefix));
  return matched === undefined ? "unknown" : matched[1];
};

/**
 * What a turn cannot work without.
 *
 * `repo` is the clone, the push and the pull request. `workflow` is the file
 * under `.github/workflows/` — a separate scope on purpose, because GitHub
 * treats "may write code" and "may write the thing that runs on every push to
 * that code" as different powers, and a token holding only the first is exactly
 * the credential this module exists for.
 */
export const REQUIRED_SCOPES = ["repo", "workflow"] as const;

/**
 * The rest of what the owner of a board asked their agents to hold: repository
 * settings and webhooks, the org-owned repositories, and the destructive end of
 * repository administration.
 *
 * Wanted rather than required, and the split is the whole policy. A run with
 * `repo` and `workflow` can do the work; a run without these can do the work
 * and then fail at the one task that was about a repository's settings rather
 * than its contents. So their absence is reported and is never an error.
 *
 * `read:org` earns its place by being the difference between seeing an
 * organisation's repositories and not seeing them at all, which is a
 * confusing failure rather than a refused one.
 */
export const OWNER_SCOPES = [
  "admin:repo_hook",
  "read:org",
  "delete_repo",
] as const;

/**
 * The scopes a granted scope carries with it, as GitHub's own hierarchy has
 * them. Read transitively by {@link expandScopes}, so `admin:org` covers
 * `read:org` through `write:org` without that pair being listed here.
 *
 * Without this a token granted `admin:repo_hook` would be reported as missing
 * `write:repo_hook`, and an operator would go and add a scope the settings page
 * will not even show them as separate. A checker that reports work that cannot
 * be done is a checker people learn to skip.
 */
const IMPLIED_SCOPES: Readonly<Record<string, readonly string[]>> = {
  "admin:org": ["write:org"],
  "admin:public_key": ["write:public_key"],
  "admin:repo_hook": ["write:repo_hook"],
  repo: [
    "public_repo",
    "repo:invite",
    "repo:status",
    "repo_deployment",
    "security_events",
  ],
  "write:org": ["read:org"],
  "write:public_key": ["read:public_key"],
  "write:repo_hook": ["read:repo_hook"],
};

/**
 * The scopes on a response header, in the order GitHub listed them. Total: a
 * header that is empty, or absent and defaulted, is no scopes rather than one
 * blank one.
 */
export const parseScopeHeader = (header: string): readonly string[] =>
  header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

/**
 * Everything a granted set covers, including what it covers through the
 * hierarchy. A worklist rather than one pass, so a chain of any depth resolves
 * and a hierarchy that gains a level later needs no change here.
 */
export const expandScopes = (
  granted: readonly string[]
): ReadonlySet<string> => {
  const covered = new Set<string>();
  const pending = [...granted];
  while (pending.length > 0) {
    const scope = pending.pop();
    if (scope === undefined || covered.has(scope)) {
      continue;
    }
    covered.add(scope);
    pending.push(...(IMPLIED_SCOPES[scope] ?? []));
  }
  return covered;
};

/** What a wanted set asks for and a granted set does not cover. */
export const missingScopes = (input: {
  readonly granted: readonly string[];
  readonly wanted: readonly string[];
}): readonly string[] => {
  const covered = expandScopes(input.granted);
  return input.wanted.filter((scope) => !covered.has(scope));
};

/**
 * What the board's credential turned out to be. Five cases, and each one is a
 * different sentence to an operator: nothing configured, a token GitHub does
 * not accept, a token GitHub did not get to answer about, a token whose powers
 * are not readable from here, and a token whose scopes are these.
 */
export type GithubCredential =
  | { readonly _tag: "absent" }
  | {
      readonly _tag: "rejected";
      readonly kind: GithubTokenKind;
      readonly status: number;
    }
  | {
      readonly _tag: "unreadable";
      readonly kind: GithubTokenKind;
      readonly reason: string;
    }
  | { readonly _tag: "opaque"; readonly kind: GithubTokenKind }
  | {
      readonly _tag: "scoped";
      readonly granted: readonly string[];
      readonly kind: GithubTokenKind;
      /** Of {@link REQUIRED_SCOPES}. Non-empty means work will be refused. */
      readonly missing: readonly string[];
      /** Of {@link OWNER_SCOPES}. Non-empty means settings work will be. */
      readonly missingOwner: readonly string[];
    };

/** The scopes to ask for, as a token settings page and `gh` both spell them. */
const WANTED_SCOPE_LIST = [...REQUIRED_SCOPES, ...OWNER_SCOPES].join(",");

/**
 * The repository permissions that mean the same thing on a fine-grained token
 * or a GitHub App, where scopes do not exist. `Workflows: write` is listed
 * because it is the one people miss — `Contents: write` does not imply it, in
 * the same way `repo` does not imply `workflow`.
 */
const WANTED_PERMISSIONS =
  "Contents, Workflows, Pull requests, Issues and Administration at write";

/** How to widen each kind of credential, in the words of its own settings. */
const remedyFor = (kind: GithubTokenKind): string => {
  if (kind === "oauth") {
    return `its scopes were fixed when the login was approved, so widening is a re-consent: run \`gh auth refresh -h github.com -s ${WANTED_SCOPE_LIST}\` on the host, then put \`gh auth token\` into ${AGENT_TOKEN_ENV_VAR} and restart the loop`;
  }
  if (kind === "classic-pat") {
    return `re-mint it at https://github.com/settings/tokens with ${WANTED_SCOPE_LIST}, then put it into ${AGENT_TOKEN_ENV_VAR} and restart the loop`;
  }
  if (kind === "fine-grained-pat") {
    return `edit it at https://github.com/settings/personal-access-tokens and give it ${WANTED_PERMISSIONS} on the repositories the board works on`;
  }
  if (kind === "app-installation" || kind === "app-user") {
    return `widen the App's permissions to ${WANTED_PERMISSIONS} and re-approve the installation — until that approval, every token it mints carries the old set`;
  }
  return `re-mint it with ${WANTED_SCOPE_LIST}, or the equivalent permissions on whatever issued it`;
};

/**
 * What a missing required scope costs, named as the refusal an agent will hit
 * rather than as the scope it lacks. "Missing `workflow`" is a fact about a
 * settings page; "a push touching `.github/workflows/` is rejected" is the run
 * that will fail this afternoon.
 */
const consequenceOf = (missing: readonly string[]): string => {
  const consequences = [
    missing.includes("repo")
      ? "a private repository cannot be cloned and no branch can be pushed"
      : null,
    missing.includes("workflow")
      ? "a push touching `.github/workflows/` is rejected by GitHub, so an agent cannot finish a change that includes CI"
      : null,
  ].filter((consequence) => consequence !== null);
  return consequences.length === 0
    ? "some of what a run does will be refused"
    : consequences.join("; ");
};

/** A line for the boot log, at the level its content deserves. */
export interface CredentialNote {
  readonly level: "info" | "warning";
  readonly message: string;
}

/**
 * What to say about a credential, as lines rather than as one paragraph: a
 * token can be good enough to work with and short of what the board was told to
 * give it, and those are an info line and a warning, not one of either.
 *
 * Pure, so every sentence an operator will ever read out of this is asserted in
 * a test rather than produced only by a live token that is missing something.
 */
export const credentialNotes = (
  credential: GithubCredential
): readonly CredentialNote[] => {
  if (credential._tag === "absent") {
    return [
      {
        level: "warning",
        message: `turns have no GitHub credential: set ${AGENT_TOKEN_ENV_VAR} to clone a private repository or let an agent open a pull request`,
      },
    ];
  }
  const kind = KIND_LABEL[credential.kind];
  if (credential._tag === "rejected") {
    return [
      {
        level: "warning",
        message: `${kind} GitHub credential was refused by GitHub with ${credential.status}: it is expired, revoked or not a token. Every private clone and every push will fail until ${AGENT_TOKEN_ENV_VAR} is replaced`,
      },
    ];
  }
  if (credential._tag === "unreadable") {
    return [
      {
        level: "warning",
        message: `the permissions of ${kind} GitHub credential could not be read (${credential.reason}): turns still carry it, and \`bun run github:check\` says what it can do once GitHub answers`,
      },
    ];
  }
  if (credential._tag === "opaque") {
    return [
      {
        level: "info",
        message: `turns carry ${kind} GitHub credential: \`gh\` is logged in and git can push. Its permissions are not readable from a token — check where they were granted that it has ${WANTED_PERMISSIONS}, and note that Contents does not imply Workflows`,
      },
    ];
  }
  const { granted, missing, missingOwner } = credential;
  const held: CredentialNote = {
    level: "info",
    message: `turns carry ${kind} GitHub credential scoped ${granted.join(", ")}: \`gh\` is logged in and git can push`,
  };
  const notes = [held];
  if (missing.length > 0) {
    notes.push({
      level: "warning",
      message: `that credential is missing the ${missing.join(", ")} scope${missing.length === 1 ? "" : "s"}: ${consequenceOf(missing)}. To fix it, ${remedyFor(credential.kind)}`,
    });
  }
  if (missingOwner.length > 0) {
    notes.push({
      level: "warning",
      message: `that credential is also missing ${missingOwner.join(", ")}: a task about a repository's settings — visibility, webhooks, deleting a repository, reading an org's repositories — will be refused rather than done. To fix it, ${remedyFor(credential.kind)}`,
    });
  }
  return notes;
};

/** Overrides, all of them for a test. */
export interface ProbeOptions {
  readonly url?: string;
}

/**
 * What the configured credential can do, as one request that cannot fail.
 *
 * Total for the same reason `./committer` is: this runs while the loop is
 * assembling itself, and a GitHub that is down or a proxy that eats the
 * response is not a reason for a board to stay off. Every such ending lands on
 * `unreadable`, which says so in as many words.
 *
 * Call it once, at boot. The token is read once per process by everything else
 * here, so a per-run probe would spend a request on an answer that cannot have
 * changed — and would still not see a token widened underneath a running loop,
 * because that value was read when the layer was built.
 */
export const probeGithubCredential = (
  options?: ProbeOptions
): Effect.Effect<GithubCredential> =>
  Effect.gen(function* () {
    const token = yield* readGithubToken;
    if (token === null) {
      return { _tag: "absent" } satisfies GithubCredential;
    }
    const kind = tokenKindOf(token);
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(options?.url ?? GITHUB_USER_URL).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders({
          "user-agent": USER_AGENT,
          "x-github-api-version": API_VERSION,
        })
      )
    );
    // 401 is a token GitHub does not know; 403 is one it knows and will not act
    // on. Both are "replace this", and neither is a scope this can name.
    if (REFUSING_STATUSES.includes(response.status)) {
      return {
        _tag: "rejected",
        kind,
        status: response.status,
      } satisfies GithubCredential;
    }
    if (response.status >= FIRST_ERROR_STATUS) {
      return {
        _tag: "unreadable",
        kind,
        reason: `GitHub answered ${response.status}`,
      } satisfies GithubCredential;
    }
    const header = Headers.get(response.headers, SCOPE_HEADER);
    // Absent, not empty: a classic token with every scope revoked answers with
    // the header and an empty value, which is a token that can do nothing and
    // must not read as one whose powers live somewhere else.
    if (Option.isNone(header)) {
      return { _tag: "opaque", kind } satisfies GithubCredential;
    }
    const granted = parseScopeHeader(header.value);
    return {
      _tag: "scoped",
      granted,
      kind,
      missing: missingScopes({ granted, wanted: REQUIRED_SCOPES }),
      missingOwner: missingScopes({ granted, wanted: OWNER_SCOPES }),
    } satisfies GithubCredential;
  }).pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () =>
        Effect.succeed<GithubCredential>({
          _tag: "unreadable",
          kind: "unknown",
          reason: `no answer in ${PROBE_TIMEOUT}`,
        }),
    }),
    Effect.catchCause((cause) =>
      Effect.logDebug("sandbox: github credential probe failed", cause).pipe(
        Effect.as<GithubCredential>({
          _tag: "unreadable",
          kind: "unknown",
          reason: "the request failed",
        })
      )
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.withSpan("Github.probeCredential")
  );
