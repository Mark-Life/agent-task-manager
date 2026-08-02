import { describe, expect, test } from "bun:test";
import { UserId, WorkspaceId } from "@workspace/domain";
import { Effect } from "effect";
import { parseAllowlist } from "./allowlist";

const ok = (raw: string) => Effect.runSync(parseAllowlist(raw));

const refused = (raw: string) =>
  Effect.runSync(Effect.flip(parseAllowlist(raw)));

describe("parseAllowlist", () => {
  test("parses one entry", () => {
    const list = ok("12345:org_a:user_a");
    expect(list.get(12_345)).toEqual({
      userId: UserId.make("user_a"),
      workspaceId: WorkspaceId.make("org_a"),
    });
  });

  test("parses several, trimming whitespace around them", () => {
    const list = ok(" 1:org_a:user_a , 2:org_b:user_b ");
    expect(list.size).toBe(2);
    expect(list.get(2)?.workspaceId).toBe(WorkspaceId.make("org_b"));
  });

  test("ignores a trailing separator", () => {
    expect(ok("1:org_a:user_a,").size).toBe(1);
  });

  test.each([
    ["empty", ""],
    ["only whitespace", "   "],
    ["two fields", "1:org_a"],
    ["four fields", "1:org_a:user_a:extra"],
    ["a non-numeric telegram id", "abc:org_a:user_a"],
    ["a negative telegram id", "-1:org_a:user_a"],
    ["a blank workspace", "1::user_a"],
    ["a blank user", "1:org_a:"],
    ["the same telegram id twice", "1:org_a:user_a,1:org_b:user_b"],
  ])("refuses %s", (_name, raw) => {
    expect(refused(raw)._tag).toBe("Bot.AllowlistInvalid");
  });

  test("names the offending entry in the failure", () => {
    const error = refused("1:org_a:user_a,nope");
    expect(error.entry).toBe("nope");
    expect(error.message).toContain("nope");
  });
});
