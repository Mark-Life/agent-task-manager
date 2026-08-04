import { describe, expect, test } from "bun:test";
import { redactRemote } from "./git";

describe("redactRemote", () => {
  test("strips the userinfo of a clone url", () => {
    expect(
      redactRemote(
        "fatal: could not read from https://x-access-token:ghs_secretsecret@github.com/o/n.git"
      )
    ).toBe("fatal: could not read from https://[redacted]@github.com/o/n.git");
  });

  test("strips a bare github token", () => {
    expect(
      redactRemote("remote: Bad credentials ghp_aaaaaaaaaaaaaaaaaaaaaaaa")
    ).toBe("remote: Bad credentials [redacted]");
    expect(
      redactRemote("token github_pat_11ABCDEFG0aaaaaaaaaaaaaa rejected")
    ).toBe("token [redacted] rejected");
  });

  test("leaves an ordinary message alone", () => {
    const message = "fatal: invalid reference: origin/main";
    expect(redactRemote(message)).toBe(message);
  });
});
