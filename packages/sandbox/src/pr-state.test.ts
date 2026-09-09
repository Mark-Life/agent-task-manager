import { afterEach, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { ConfigProvider, Effect } from "effect";
import { AGENT_TOKEN_ENV_VAR } from "./github";
import { readPrState } from "./pr-state";

/** The pull request resource, with the three fields the state is read off. */
const pull = (input: {
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly state?: string;
}) => ({
  draft: input.draft ?? false,
  html_url: "https://github.com/acme/widgets/pull/7",
  merged: input.merged ?? false,
  number: 7,
  state: input.state ?? "open",
  title: "Do the thing",
});

const PR_URL = "https://github.com/acme/widgets/pull/7";

/** What the request carried, captured off a real server rather than a stub client. */
interface Capture {
  readonly authorization: string | null;
  readonly ifNoneMatch: string | null;
  readonly path: string;
}

let server: ReturnType<typeof serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Serves one canned answer and records what was asked for. */
const servePull = (respond: (request: Request) => Response) => {
  const seen: Capture[] = [];
  server = serve({
    fetch: (request) => {
      seen.push({
        authorization: request.headers.get("authorization"),
        ifNoneMatch: request.headers.get("if-none-match"),
        path: new URL(request.url).pathname,
      });
      return respond(request);
    },
    port: 0,
  });
  return { apiOrigin: `http://127.0.0.1:${server.port}`, seen };
};

const lookup = (input: {
  readonly apiOrigin?: string;
  readonly env?: Record<string, string>;
  readonly etag?: string | null;
  readonly prUrl?: string;
}) =>
  Effect.runPromise(
    readPrState({
      apiOrigin: input.apiOrigin,
      etag: input.etag ?? null,
      prUrl: input.prUrl ?? PR_URL,
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

describe("readPrState", () => {
  test("asks GitHub for the one pull request the URL names", async () => {
    const { apiOrigin, seen } = servePull(() =>
      Response.json(pull({}), { headers: { etag: 'W/"abc"' } })
    );

    expect(await lookup({ apiOrigin })).toEqual({
      _tag: "state",
      etag: 'W/"abc"',
      state: "open",
    });
    // By number, not a filtered page: `merged` is only on this resource, and
    // without it a merged pull request and an abandoned one are both "closed".
    expect(seen[0]?.path).toBe("/repos/acme/widgets/pulls/7");
    expect(seen[0]?.authorization).toBe("Bearer a-live-token");
    expect(seen[0]?.ifNoneMatch).toBeNull();
  });

  test("reads each of the four states off the same resource", async () => {
    // One server for the four, keyed on a header the lookup passes through
    // untouched, so the whole table is one round of concurrent requests rather
    // than four servers started and stopped in sequence.
    const bodies: Record<string, unknown> = {
      "/repos/acme/widgets/pulls/1": pull({ draft: true }),
      "/repos/acme/widgets/pulls/2": pull({}),
      "/repos/acme/widgets/pulls/3": pull({ merged: true, state: "closed" }),
      "/repos/acme/widgets/pulls/4": pull({ state: "closed" }),
    };
    const { apiOrigin } = servePull((request) =>
      Response.json(bodies[new URL(request.url).pathname])
    );

    const read = await Promise.all(
      [1, 2, 3, 4].map((number) =>
        lookup({
          apiOrigin,
          prUrl: `https://github.com/acme/widgets/pull/${number}`,
        })
      )
    );

    expect(read).toEqual([
      { _tag: "state", etag: null, state: "draft" },
      { _tag: "state", etag: null, state: "open" },
      { _tag: "state", etag: null, state: "merged" },
      { _tag: "state", etag: null, state: "closed" },
    ]);
  });

  /**
   * The whole reason this endpoint is affordable. GitHub does not charge a
   * conditional request that comes back `304` against the primary rate limit,
   * so a board of unchanged pull requests refreshes for nothing — and the
   * caller has to be able to tell that answer apart from both a state and a
   * failure, or it would either rewrite a row for no reason or forget what it
   * knew.
   */
  test("sends the stored validator and reports an unchanged pull request", async () => {
    const { apiOrigin, seen } = servePull((request) =>
      request.headers.get("if-none-match") === 'W/"abc"'
        ? new Response(null, { status: 304 })
        : Response.json(pull({}))
    );

    expect(await lookup({ apiOrigin, etag: 'W/"abc"' })).toEqual({
      _tag: "unchanged",
    });
    expect(seen[0]?.ifNoneMatch).toBe('W/"abc"');
  });

  /**
   * A repository this credential cannot see, a rate limit, or GitHub being
   * down. Each leaves the card drawing the state it already had rather than
   * becoming an error on a board that has already rendered.
   */
  test("answers unavailable for every way GitHub can refuse", async () => {
    // The status is asked for in the path, so one server answers all five.
    const { apiOrigin } = servePull(
      (request) =>
        new Response("{}", {
          headers: { "x-ratelimit-remaining": "0" },
          status: Number(new URL(request.url).pathname.split("/").at(-1)),
        })
    );

    const read = await Promise.all(
      [401, 403, 404, 422, 500].map((status) =>
        lookup({
          apiOrigin,
          prUrl: `https://github.com/acme/widgets/pull/${status}`,
        })
      )
    );

    expect(read).toEqual([
      { _tag: "unavailable" },
      { _tag: "unavailable" },
      { _tag: "unavailable" },
      { _tag: "unavailable" },
      { _tag: "unavailable" },
    ]);
  });

  /** A body this was not written against is not a state to draw. */
  test("answers unavailable for a body that is not a pull request", async () => {
    const { apiOrigin } = servePull(() => Response.json({ message: "Moved" }));

    expect(await lookup({ apiOrigin })).toEqual({ _tag: "unavailable" });
  });

  /**
   * `api.github.com` answers for GitHub and nothing else, and `pr_url` is free
   * text — so a link to an issue, to another forge, or to somebody's notes must
   * cost no request at all rather than a 404 each refresh.
   */
  test("does not call out for a URL it cannot ask GitHub about", async () => {
    const { apiOrigin, seen } = servePull(() => Response.json(pull({})));

    const read = await Promise.all(
      [
        "https://gitlab.com/acme/widgets/pull/7",
        "https://github.com/acme/widgets/issues/7",
        "https://github.com/acme/widgets",
        "notes about the change",
      ].map((prUrl) => lookup({ apiOrigin, prUrl }))
    );

    expect(read).toEqual([
      { _tag: "unavailable" },
      { _tag: "unavailable" },
      { _tag: "unavailable" },
      { _tag: "unavailable" },
    ]);
    expect(seen).toHaveLength(0);
  });

  /** Asking anonymously would spend the shared limit to be refused. */
  test("does not call out when no credential is configured", async () => {
    const { apiOrigin, seen } = servePull(() => Response.json(pull({})));

    expect(await lookup({ apiOrigin, env: {} })).toEqual({
      _tag: "unavailable",
    });
    expect(seen).toHaveLength(0);
  });
});
