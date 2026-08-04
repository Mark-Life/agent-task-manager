import { afterEach, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { ConfigProvider, Effect } from "effect";
import {
  committerFromUser,
  noReplyEmailFor,
  resolveCommitter,
} from "./committer";
import { AGENT_TOKEN_ENV_VAR } from "./github";
import { DEFAULT_COMMITTER } from "./repo";

/** A live account, as `GET /user` answers it. Field spellings are the assumption. */
const USER_BODY = {
  id: 88_837_967,
  login: "Mark-Life",
  name: "Andrey Markin",
} as const;

describe("committerFromUser", () => {
  test("builds the no-reply address the account resolves from", () => {
    expect(committerFromUser(USER_BODY)).toEqual({
      email: "88837967+Mark-Life@users.noreply.github.com",
      name: "Andrey Markin",
    });
  });

  /** An account that never set a display name still has to commit as something. */
  test("falls back to the login when there is no display name", () => {
    expect(committerFromUser({ ...USER_BODY, name: null })?.name).toBe(
      "Mark-Life"
    );
    expect(committerFromUser({ ...USER_BODY, name: "  " })?.name).toBe(
      "Mark-Life"
    );
    const { name, ...withoutName } = USER_BODY;
    expect(committerFromUser(withoutName)?.name).toBe("Mark-Life");
  });

  /**
   * The guard that matters: a body this was not written against has to read as
   * "no identity" and take the fallback, never as an address built out of
   * whatever was there.
   */
  test("answers null for anything that is not an account", () => {
    expect(committerFromUser({ message: "Bad credentials" })).toBeNull();
    expect(committerFromUser({ ...USER_BODY, id: 1.5 })).toBeNull();
    expect(committerFromUser({ ...USER_BODY, login: "" })).toBeNull();
    expect(committerFromUser("not json at all")).toBeNull();
    expect(committerFromUser(null)).toBeNull();
  });

  /** A login can be renamed; the numeric prefix is what keeps the address resolving. */
  test("leads the address with the immutable id", () => {
    expect(noReplyEmailFor({ id: 7, login: "renamed" })).toBe(
      "7+renamed@users.noreply.github.com"
    );
  });
});

/** What the request carried, captured off a real server rather than a stub client. */
interface Capture {
  readonly authorization: string | null;
  readonly path: string;
}

let server: ReturnType<typeof serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Serves one canned answer and records what was asked for. */
const serveUser = (respond: () => Response) => {
  const seen: Capture[] = [];
  server = serve({
    fetch: (request) => {
      seen.push({
        authorization: request.headers.get("authorization"),
        path: new URL(request.url).pathname,
      });
      return respond();
    },
    port: 0,
  });
  return { seen, url: `http://127.0.0.1:${server.port}/user` };
};

const resolveWith = (input: {
  readonly env: Record<string, string>;
  readonly url: string;
}) =>
  Effect.runPromise(
    resolveCommitter({ url: input.url }).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown(input.env))
      )
    )
  );

describe("resolveCommitter", () => {
  test("commits as the account the token belongs to", async () => {
    const { seen, url } = serveUser(() => Response.json(USER_BODY));

    const committer = await resolveWith({
      env: { [AGENT_TOKEN_ENV_VAR]: "a-live-token" },
      url,
    });

    expect(committer).toEqual({
      email: "88837967+Mark-Life@users.noreply.github.com",
      name: "Andrey Markin",
    });
    // The credential reaches the request. Without it the endpoint answers for
    // nobody, and the identity would be whichever account is public.
    expect(seen[0]?.authorization).toBe("Bearer a-live-token");
  });

  /**
   * A board of public repositories needs no token, and an install that has not
   * set one gets a working checkout rather than a dispatch that fails on an
   * identity lookup it never asked for.
   */
  test("takes the fallback when no token is configured, without calling out", async () => {
    const { seen, url } = serveUser(() => Response.json(USER_BODY));

    expect(await resolveWith({ env: {}, url })).toEqual(DEFAULT_COMMITTER);
    expect(seen).toHaveLength(0);
  });

  test("takes the fallback when the token is refused", async () => {
    const { url } = serveUser(
      () => new Response('{"message":"Bad credentials"}', { status: 401 })
    );

    expect(
      await resolveWith({ env: { [AGENT_TOKEN_ENV_VAR]: "rotated" }, url })
    ).toEqual(DEFAULT_COMMITTER);
  });

  test("takes the fallback when the body is not an account", async () => {
    const { url } = serveUser(() => new Response("<html>proxy</html>"));

    expect(
      await resolveWith({ env: { [AGENT_TOKEN_ENV_VAR]: "live" }, url })
    ).toEqual(DEFAULT_COMMITTER);
  });

  /** Nothing is listening on port 1. A boot is not held up by a GitHub that is out. */
  test("takes the fallback when the endpoint cannot be reached", async () => {
    expect(
      await resolveWith({
        env: { [AGENT_TOKEN_ENV_VAR]: "live" },
        url: "http://127.0.0.1:1/user",
      })
    ).toEqual(DEFAULT_COMMITTER);
  });
});
