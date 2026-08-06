#!/usr/bin/env bun

/**
 * Says what the board's GitHub credential can actually do, before a run finds
 * out the hard way.
 *
 * The failure it exists for is quiet. `ATM_GITHUB_TOKEN` clones, pushes and
 * opens pull requests, so an install looks correct — and then a task needs a
 * file under `.github/workflows/`, GitHub refuses the push for want of a
 * `workflow` scope, and whatever the agent does next is worse than the refusal.
 * The scopes were readable the whole time. This is the one command that reads
 * them.
 *
 * Two things are checked, and the second is the point:
 *
 *   bun run github:check              what the credential is and what it may
 *                                     do — its kind, its scopes, what is
 *                                     missing, and the exact way to widen that
 *                                     kind of credential. One request.
 *
 *   bun run github:check owner/name   the same, plus the repository itself
 *                                     through the API: its visibility and the
 *                                     permissions the token holds on it. That
 *                                     is a settings read rather than a contents
 *                                     read, so it answers the question scopes
 *                                     alone cannot — whether `gh api` can do
 *                                     anything beyond fetching files.
 *
 * It exits non-zero when a required scope is missing, so a deploy script can
 * refuse to roll out a loop whose agents will be blocked. Everything softer —
 * an owner-level scope absent, a fine-grained token whose permissions no header
 * carries — prints and exits zero, because the board still works and the
 * operator is the one who decides how wide the credential should be.
 *
 * It reads the host's environment, which is the loop's environment: the same
 * value the containers are handed. It never prints the token.
 */

import { BunRuntime } from "@effect/platform-bun";
import {
  credentialNotes,
  probeGithubCredential,
  REQUIRED_SCOPES,
  readGithubToken,
} from "@workspace/sandbox";
import { Effect, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/**
 * The one ending that exits non-zero: a scope a run cannot work without. Named
 * as an error rather than printed as a warning so a deploy step can gate on it.
 */
class ScopeMissing extends Schema.TaggedErrorClass<ScopeMissing>()(
  "GithubCheck.ScopeMissing",
  { missing: Schema.Array(Schema.String), wanted: Schema.Array(Schema.String) }
) {
  /** What the operator reads. The fields are not printed by the default reporter. */
  override get message() {
    return `the GitHub credential is missing ${this.missing.join(", ")} — a run needs ${this.wanted.join(" and ")}`;
  }
}

/** What the repository read reports, and nothing else it returns. */
const Repository = Schema.Struct({
  full_name: Schema.String,
  permissions: Schema.optionalKey(
    Schema.Struct({
      admin: Schema.Boolean,
      push: Schema.Boolean,
    })
  ),
  visibility: Schema.String,
});

/** The repository named on the command line, or null for the credential alone. */
const repoArgument = (): string | null => {
  const named = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  return named ?? null;
};

/**
 * The settings read. `GET /repos/{owner}/{name}` answers with the visibility
 * and with the permissions the credential holds on the repository, which is the
 * demonstration that `gh api` reaches past file contents — the half of this
 * that a scope list cannot prove on its own.
 */
const checkRepository = Effect.fn("GithubCheck.repository")(function* (
  slug: string
) {
  const token = yield* readGithubToken;
  if (token === null) {
    yield* Effect.logWarning(
      `no credential to read ${slug} with: set ATM_GITHUB_TOKEN`
    );
    return;
  }
  const http = yield* HttpClient.HttpClient;
  const repository = yield* http
    .execute(
      HttpClientRequest.get(`https://api.github.com/repos/${slug}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders({
          "user-agent": "agent-task-manager",
          "x-github-api-version": "2022-11-28",
        })
      )
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Repository)),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `could not read ${slug} through the API — the credential cannot see it, or GitHub refused`,
          cause
        ).pipe(Effect.as(null))
      )
    );
  if (repository === null) {
    return;
  }
  const { full_name, permissions, visibility } = repository;
  yield* Effect.logInfo(
    `${full_name} reads as ${visibility} through \`gh api\`${
      permissions === undefined
        ? ""
        : `, with push ${permissions.push ? "yes" : "no"} and admin ${permissions.admin ? "yes" : "no"}`
    }`
  );
  yield* permissions?.admin === true
    ? Effect.logInfo(
        "admin on the repository is what a visibility change or a settings edit needs; the scopes above decide whether the credential may use it"
      )
    : Effect.logWarning(
        "the credential is not an admin on this repository: settings changes will be refused whatever its scopes say"
      );
});

const githubCheck = Effect.gen(function* () {
  const credential = yield* probeGithubCredential();
  for (const note of credentialNotes(credential)) {
    yield* note.level === "warning"
      ? Effect.logWarning(note.message)
      : Effect.logInfo(note.message);
  }

  const slug = repoArgument();
  yield* slug === null
    ? Effect.logInfo(
        "pass a repository — `bun run github:check owner/name` — to read its visibility and this credential's permissions on it"
      )
    : checkRepository(slug);

  // Non-zero only for the scopes without which a run cannot do its work. An
  // owner-level scope missing is the operator's call and prints as a warning;
  // a required one missing is an agent that will be stopped by GitHub.
  if (credential._tag === "scoped" && credential.missing.length > 0) {
    return yield* Effect.fail(
      new ScopeMissing({
        missing: [...credential.missing],
        wanted: [...REQUIRED_SCOPES],
      })
    );
  }
});

BunRuntime.runMain(githubCheck.pipe(Effect.provide(FetchHttpClient.layer)));
