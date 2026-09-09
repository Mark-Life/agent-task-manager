import { describe, expect, test } from "bun:test";
import { isTerminalPrState, parsePrUrl, prStateOf } from "./pull-request";

describe("parsePrUrl", () => {
  test("takes apart the URL GitHub puts in the address bar", () => {
    expect(
      parsePrUrl("https://github.com/Mark-Life/agent-task-manager/pull/75")
    ).toEqual({
      host: "github.com",
      number: 75,
      owner: "Mark-Life",
      repo: "agent-task-manager",
      slug: "Mark-Life/agent-task-manager#75",
    });
  });

  /** What a person actually pastes: the files tab, a review, a comment anchor. */
  test("ignores whatever follows the number", () => {
    expect(
      parsePrUrl("https://github.com/acme/widgets/pull/7/files#r1234")?.number
    ).toBe(7);
    expect(
      parsePrUrl("https://github.com/acme/widgets/pull/7/commits")?.slug
    ).toBe("acme/widgets#7");
  });

  /** The API's own spelling of the same thing, which an agent may well write. */
  test("reads the plural path the REST API uses", () => {
    expect(
      parsePrUrl("https://api.github.com/repos/acme/widgets/pulls/7")
    ).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/pulls/7")?.number).toBe(
      7
    );
  });

  /** A hostname is case-insensitive; a comparison against it should not be. */
  test("lowercases the host and leaves the owner alone", () => {
    const parsed = parsePrUrl("https://GitHub.com/Mark-Life/Repo/pull/1");
    expect(parsed?.host).toBe("github.com");
    expect(parsed?.owner).toBe("Mark-Life");
  });

  /**
   * `pr_url` is free text three writers put values in, so everything that is
   * not a pull request has to answer null rather than become a request for a
   * resource that does not exist.
   */
  test("answers null for anything that is not a pull request", () => {
    expect(parsePrUrl("")).toBeNull();
    expect(parsePrUrl("   ")).toBeNull();
    expect(parsePrUrl("not a url")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/issues/7")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/pull/abc")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/pull/0")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/pull/")).toBeNull();
  });

  /** Every host parses; whether the API can answer for it is decided elsewhere. */
  test("accepts a host that is not GitHub", () => {
    expect(
      parsePrUrl("https://git.example.com/acme/widgets/pull/3")?.host
    ).toBe("git.example.com");
  });
});

describe("prStateOf", () => {
  test("reads GitHub's three fields as one of the four states", () => {
    expect(prStateOf({ draft: true, merged: false, state: "open" })).toBe(
      "draft"
    );
    expect(prStateOf({ draft: false, merged: false, state: "open" })).toBe(
      "open"
    );
    expect(prStateOf({ draft: false, merged: true, state: "closed" })).toBe(
      "merged"
    );
    expect(prStateOf({ draft: false, merged: false, state: "closed" })).toBe(
      "closed"
    );
  });

  /**
   * The two orderings that would be wrong. A merged pull request is also
   * `closed`, and GitHub leaves `draft` set on a draft somebody abandoned — so
   * testing either flag before the state would draw a shipped change as
   * abandoned and an abandoned one as still being written.
   */
  test("puts merged ahead of closed and closed ahead of draft", () => {
    expect(prStateOf({ draft: true, merged: true, state: "closed" })).toBe(
      "merged"
    );
    expect(prStateOf({ draft: true, merged: false, state: "closed" })).toBe(
      "closed"
    );
  });
});

describe("isTerminalPrState", () => {
  /** Where the refresh stops, and therefore what stops costing requests. */
  test("is the two states nothing further happens from", () => {
    expect(isTerminalPrState("merged")).toBe(true);
    expect(isTerminalPrState("closed")).toBe(true);
    expect(isTerminalPrState("open")).toBe(false);
    expect(isTerminalPrState("draft")).toBe(false);
  });
});
