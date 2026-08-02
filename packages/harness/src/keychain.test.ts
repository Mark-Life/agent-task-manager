import { describe, expect, test } from "bun:test";
import { claudeCredentialBody } from "./keychain";

describe("claudeCredentialBody", () => {
  test("keeps the Claude login and writes it as the file the CLI reads", () => {
    const body = claudeCredentialBody(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "at",
          expiresAt: 1,
          refreshToken: "rt",
          scopes: ["user:inference"],
          subscriptionType: "max",
        },
      })
    );

    expect(body).not.toBeNull();
    expect(JSON.parse(body as string)).toEqual({
      claudeAiOauth: {
        accessToken: "at",
        expiresAt: 1,
        refreshToken: "rt",
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    });
  });

  // The same keychain item holds every MCP server the operator has ever
  // authorized from their own machine. A run needs the Claude login; carrying
  // the rest into a container would hand an agent tokens for services nobody
  // asked it to touch.
  test("leaves the operator's other OAuth tokens on the host", () => {
    const body = claudeCredentialBody(
      JSON.stringify({
        claudeAiOauth: { accessToken: "at" },
        mcpOAuth: { "some-server": { accessToken: "leaked" } },
      })
    );

    expect(body).toBe(JSON.stringify({ claudeAiOauth: { accessToken: "at" } }));
    expect(body).not.toContain("leaked");
  });

  test.each([
    ["not JSON at all", "}{"],
    ["JSON that is not an object", "[1,2]"],
    ["an item holding no Claude login", JSON.stringify({ mcpOAuth: {} })],
    [
      "a Claude login that is not an object",
      JSON.stringify({ claudeAiOauth: "" }),
    ],
  ])("is nothing rather than an empty credential for %s", (_name, raw) => {
    expect(claudeCredentialBody(raw)).toBeNull();
  });
});
