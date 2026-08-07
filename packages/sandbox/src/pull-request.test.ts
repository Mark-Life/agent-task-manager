import { afterEach, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { ConfigProvider, Effect } from "effect";
import { AGENT_TOKEN_ENV_VAR } from "./github";
import { choosePullRequest, pullRequestForBranch } from "./pull-request";

/** One entry of the list endpoint, with the two fields this reads. */
const pull = (input: { readonly state: string; readonly url: string }) => ({
  head: { ref: "atm/task-1" },
  html_url: input.url,
  number: 7,
  state: input.state,
  url: "https://api.github.com/repos/acme/widgets/pulls/7",
});

describe("choosePullRequest", () => {
  test("takes the only pull request a branch has", () => {
    expect(
      choosePullRequest([pull({ state: "open", url: "https://pr/1" })])
    ).toBe("https://pr/1");
  });

  /**
   * The whole reason this is a choice. A task whose first pull request was
   * merged and which then got more work has two, and the field has to hold the
   * one review happens on now rather than the one it happened on last month.
   */
  test("prefers the open one over a closed one listed first", () => {
    expect(
      choosePullRequest([
        pull({ state: "closed", url: "https://pr/2" }),
        pull({ state: "open", url: "https://pr/1" }),
      ])
    ).toBe("https://pr/1");
  });

  /**
   * With nothing open there is still an answer, and it is the newest — which is
   * what the request's own ordering makes the first entry. A merged pull request
   * is `closed`, so a shipped task keeps pointing at what shipped it.
   */
  test("falls back to the most recent when none is open", () => {
    expect(
      choosePullRequest([
        pull({ state: "closed", url: "https://pr/2" }),
        pull({ state: "closed", url: "https://pr/1" }),
      ])
    ).toBe("https://pr/2");
  });

  /**
   * The guard that keeps a document-shaped run's card clean: no pull requests,
   * a body this was not written against, or an error payload all read as none
   * rather than as something PR-shaped to put in the column.
   */
  test("answers null for a branch with none, and for anything that is not a list", () => {
    expect(choosePullRequest([])).toBeNull();
    expect(choosePullRequest({ message: "Not Found" })).toBeNull();
    expect(choosePullRequest([{ number: 7 }])).toBeNull();
    expect(choosePullRequest([pull({ state: "open", url: "  " })])).toBeNull();
    expect(choosePullRequest(null)).toBeNull();
  });
});

/** What the request carried, captured off a real server rather than a stub client. */
interface Capture {
  readonly authorization: string | null;
  readonly path: string;
  readonly query: string;
}

let server: ReturnType<typeof serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Serves one canned answer and records what was asked for. */
const servePulls = (respond: () => Response) => {
  const seen: Capture[] = [];
  server = serve({
    fetch: (request) => {
      const url = new URL(request.url);
      seen.push({
        authorization: request.headers.get("authorization"),
        path: url.pathname,
        query: url.search,
      });
      return respond();
    },
    port: 0,
  });
  return { apiOrigin: `http://127.0.0.1:${server.port}`, seen };
};

const lookup = (input: {
  readonly apiOrigin?: string;
  readonly branch?: string | null;
  readonly env?: Record<string, string>;
  readonly repoUrl?: string | null;
}) =>
  Effect.runPromise(
    pullRequestForBranch({
      apiOrigin: input.apiOrigin,
      branch: input.branch === undefined ? "atm/task-1" : input.branch,
      repoUrl:
        input.repoUrl === undefined
          ? "https://github.com/acme/widgets"
          : input.repoUrl,
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown(
            input.env ?? { [AGENT_TOKEN_ENV_VAR]: "a-live-token" }
          )
        )
      )
    )
  );

describe("pullRequestForBranch", () => {
  test("asks GitHub for the pull requests on this run's branch", async () => {
    const { apiOrigin, seen } = servePulls(() =>
      Response.json([pull({ state: "open", url: "https://pr/1" })])
    );

    expect(await lookup({ apiOrigin })).toBe("https://pr/1");
    expect(seen[0]?.path).toBe("/repos/acme/widgets/pulls");
    // The branch filter is the whole claim: without it this reads whichever
    // pull requests the repository happens to have open.
    expect(seen[0]?.query).toContain("head=acme%3Aatm%2Ftask-1");
    expect(seen[0]?.query).toContain("state=all");
    expect(seen[0]?.authorization).toBe("Bearer a-live-token");
  });

  /** A run that produced a document, an artifact or an answer opened nothing. */
  test("answers null for a branch with no pull request", async () => {
    const { apiOrigin } = servePulls(() => Response.json([]));

    expect(await lookup({ apiOrigin })).toBeNull();
  });

  /** A run with no repository has no branch, and nothing to ask about. */
  test("does not call out for a run with no checkout", async () => {
    const { apiOrigin, seen } = servePulls(() =>
      Response.json([pull({ state: "open", url: "https://pr/1" })])
    );

    expect(await lookup({ apiOrigin, branch: null })).toBeNull();
    expect(await lookup({ apiOrigin, repoUrl: null })).toBeNull();
    expect(seen).toHaveLength(0);
  });

  /**
   * `api.github.com` answers for GitHub and for nothing else, so a project on
   * another host is left alone rather than asked about somewhere it does not
   * live — which would be a 404 at best and another account's repository at
   * worst.
   */
  test("does not ask GitHub about a repository that is not on GitHub", async () => {
    const { apiOrigin, seen } = servePulls(() => Response.json([]));

    expect(
      await lookup({ apiOrigin, repoUrl: "https://gitlab.com/acme/widgets" })
    ).toBeNull();
    expect(await lookup({ apiOrigin, repoUrl: "not a url" })).toBeNull();
    expect(seen).toHaveLength(0);
  });

  /** No credential is no push, so it is also no pull request to find. */
  test("does not call out when no credential is configured", async () => {
    const { apiOrigin, seen } = servePulls(() => Response.json([]));

    expect(await lookup({ apiOrigin, env: {} })).toBeNull();
    expect(seen).toHaveLength(0);
  });

  /**
   * The three ways GitHub can refuse. Each leaves the task's field null and the
   * run closing normally — the link is in the run's comment either way.
   */
  test("answers null when GitHub refuses, answers oddly, or is unreachable", async () => {
    const refused = servePulls(
      () => new Response('{"message":"Bad credentials"}', { status: 401 })
    );
    expect(await lookup({ apiOrigin: refused.apiOrigin })).toBeNull();
    refused.seen.length = 0;

    server?.stop(true);
    const odd = servePulls(() => new Response("<html>proxy</html>"));
    expect(await lookup({ apiOrigin: odd.apiOrigin })).toBeNull();

    // Nothing is listening on port 1.
    expect(await lookup({ apiOrigin: "http://127.0.0.1:1" })).toBeNull();
  });
});
