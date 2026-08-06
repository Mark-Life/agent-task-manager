import { afterAll, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { ConfigProvider, Effect, Redacted } from "effect";
import { AGENT_TOKEN_ENV_VAR } from "./github";
import {
  credentialNotes,
  expandScopes,
  type GithubCredential,
  type GithubTokenKind,
  missingScopes,
  OWNER_SCOPES,
  parseScopeHeader,
  probeGithubCredential,
  REQUIRED_SCOPES,
  SCOPE_HEADER,
  tokenKindOf,
} from "./scopes";

describe("tokenKindOf", () => {
  /**
   * The prefixes are GitHub's own, and the kind is the only thing that decides
   * which remedy an operator is told to follow. `gho_` is the one that matters
   * most: it is what `gh auth login` leaves behind, it is what this install was
   * running on, and its scopes cannot be widened without a re-consent.
   */
  test.each([
    ["gho_abc", "oauth"],
    ["ghp_abc", "classic-pat"],
    ["github_pat_abc", "fine-grained-pat"],
    ["ghs_abc", "app-installation"],
    ["ghu_abc", "app-user"],
    ["not-a-token", "unknown"],
  ] as const satisfies readonly (readonly [string, GithubTokenKind])[])(
    "reads %s as %s",
    (value, kind) => {
      expect(tokenKindOf(Redacted.make(value))).toBe(kind);
    }
  );
});

describe("parseScopeHeader", () => {
  test("splits the header GitHub actually sends", () => {
    expect(parseScopeHeader("admin:public_key, gist, read:org, repo")).toEqual([
      "admin:public_key",
      "gist",
      "read:org",
      "repo",
    ]);
  });

  /** A token with every scope revoked answers with the header and nothing in it. */
  test("reads an empty header as no scopes", () => {
    expect(parseScopeHeader("")).toEqual([]);
    expect(parseScopeHeader("   ")).toEqual([]);
  });
});

describe("expandScopes", () => {
  test("covers what a scope implies", () => {
    expect(expandScopes(["repo"]).has("public_repo")).toBe(true);
  });

  /**
   * Transitively, so the checker never asks for a scope no settings page shows
   * as separate: `admin:org` reaches `read:org` through `write:org`.
   */
  test("follows the hierarchy all the way down", () => {
    expect(expandScopes(["admin:org"]).has("read:org")).toBe(true);
  });

  test("does not invent the other direction", () => {
    expect(expandScopes(["public_repo"]).has("repo")).toBe(false);
  });
});

describe("missingScopes", () => {
  /** The exact credential this whole module was written for. */
  test("names workflow as missing on a `gh auth login` token", () => {
    expect(
      missingScopes({
        granted: ["admin:public_key", "gist", "read:org", "repo"],
        wanted: REQUIRED_SCOPES,
      })
    ).toEqual(["workflow"]);
  });

  test("is empty once both are held", () => {
    expect(
      missingScopes({ granted: ["repo", "workflow"], wanted: REQUIRED_SCOPES })
    ).toEqual([]);
  });

  test("counts an implied scope as held", () => {
    expect(
      missingScopes({
        granted: ["repo", "workflow", "admin:repo_hook", "admin:org"],
        wanted: OWNER_SCOPES,
      })
    ).toEqual(["delete_repo"]);
  });
});

/** Every sentence an operator can be shown, asserted without a live token. */
describe("credentialNotes", () => {
  const messagesOf = (credential: GithubCredential) =>
    credentialNotes(credential)
      .map((note) => note.message)
      .join("\n");

  const levelsOf = (credential: GithubCredential) =>
    credentialNotes(credential).map((note) => note.level);

  test("tells an install with no token what to set", () => {
    expect(messagesOf({ _tag: "absent" })).toContain(AGENT_TOKEN_ENV_VAR);
    expect(levelsOf({ _tag: "absent" })).toEqual(["warning"]);
  });

  /**
   * The acceptance criterion this module exists to hold: what a run hits is
   * named as a scope, next to the consequence and the command that fixes it.
   */
  test("names the missing scope, its consequence and the re-consent", () => {
    const message = messagesOf({
      _tag: "scoped",
      granted: ["read:org", "repo"],
      kind: "oauth",
      missing: ["workflow"],
      missingOwner: ["admin:repo_hook", "delete_repo"],
    });
    expect(message).toContain("workflow");
    expect(message).toContain(".github/workflows/");
    expect(message).toContain("gh auth refresh");
    expect(message).toContain("admin:repo_hook");
  });

  /** What it holds is an info line; what it lacks is a warning. Never one line. */
  test("separates what a credential has from what it lacks", () => {
    expect(
      levelsOf({
        _tag: "scoped",
        granted: ["repo"],
        kind: "classic-pat",
        missing: ["workflow"],
        missingOwner: [],
      })
    ).toEqual(["info", "warning"]);
  });

  test("says nothing is missing when nothing is", () => {
    expect(
      levelsOf({
        _tag: "scoped",
        granted: [...REQUIRED_SCOPES, ...OWNER_SCOPES],
        kind: "classic-pat",
        missing: [],
        missingOwner: [],
      })
    ).toEqual(["info"]);
  });

  /**
   * A fine-grained token and an App token answer no scope header at all, and
   * the honest report says where to look rather than guessing at permissions.
   */
  test("sends an opaque credential to where its permissions live", () => {
    const message = messagesOf({ _tag: "opaque", kind: "fine-grained-pat" });
    expect(message).toContain("Workflows");
    expect(message).toContain("not readable");
  });

  test("reports a refused token as a token to replace", () => {
    const message = messagesOf({
      _tag: "rejected",
      kind: "classic-pat",
      status: 401,
    });
    expect(message).toContain("401");
    expect(message).toContain(AGENT_TOKEN_ENV_VAR);
  });

  test("keeps a probe that could not run out of the way", () => {
    expect(
      levelsOf({
        _tag: "unreadable",
        kind: "oauth",
        reason: "the request failed",
      })
    ).toEqual(["warning"]);
  });
});

/**
 * The probe against a real server rather than a stubbed client: the whole claim
 * is about one response header, and a fake that returns the header proves only
 * that the fake was written.
 */
describe("probeGithubCredential", () => {
  const servers: { stop: () => void }[] = [];

  const serving = (handler: (request: Request) => Response) => {
    const server = serve({ fetch: handler, port: 0 });
    servers.push({ stop: () => server.stop(true) });
    return `http://localhost:${server.port}/user`;
  };

  afterAll(() => {
    for (const server of servers) {
      server.stop();
    }
  });

  const probe = (input: {
    readonly env: Record<string, string>;
    url: string;
  }) =>
    Effect.runPromise(
      probeGithubCredential({ url: input.url }).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(input.env))
        )
      )
    );

  const withToken = (token: string) => ({ [AGENT_TOKEN_ENV_VAR]: token });

  test("is absent when nothing is configured", async () => {
    const url = serving(() => new Response("{}"));
    expect(await probe({ env: {}, url })).toEqual({ _tag: "absent" });
  });

  test("reads the scopes off the header", async () => {
    const url = serving(
      () =>
        new Response("{}", {
          headers: { [SCOPE_HEADER]: "read:org, repo" },
        })
    );
    expect(await probe({ env: withToken("gho_narrow"), url })).toEqual({
      _tag: "scoped",
      granted: ["read:org", "repo"],
      kind: "oauth",
      missing: ["workflow"],
      missingOwner: ["admin:repo_hook", "delete_repo"],
    });
  });

  test("sends the token as a bearer, so a server that wants one answers", async () => {
    const url = serving((request) =>
      request.headers.get("authorization") === "Bearer ghp_wide"
        ? new Response("{}", {
            headers: { [SCOPE_HEADER]: "repo, workflow" },
          })
        : new Response("{}", { status: 401 })
    );
    const credential = await probe({ env: withToken("ghp_wide"), url });
    expect(credential._tag).toBe("scoped");
    expect(credential._tag === "scoped" && credential.missing).toEqual([]);
  });

  /** No header at all is a token whose powers live somewhere this cannot read. */
  test("reads a token with no scope header as opaque", async () => {
    const url = serving(() => new Response("{}"));
    expect(await probe({ env: withToken("github_pat_abc"), url })).toEqual({
      _tag: "opaque",
      kind: "fine-grained-pat",
    });
  });

  test("reports a 401 as refused rather than as a scope problem", async () => {
    const url = serving(() => new Response("{}", { status: 401 }));
    expect(await probe({ env: withToken("ghp_dead"), url })).toEqual({
      _tag: "rejected",
      kind: "classic-pat",
      status: 401,
    });
  });

  /** A boot never fails over this: an endpoint that is not there is a report. */
  test("survives a server that is not there", async () => {
    const credential = await probe({
      env: withToken("ghp_x"),
      url: "http://localhost:1/user",
    });
    expect(credential._tag).toBe("unreadable");
  });
});
