/**
 * The brand, not the rule. What a path may be is `./relative-path` and is
 * tested there; what this defends is that `EnvFilePath` actually applies it —
 * a brand handed out without the check is evidence of nothing, and every writer
 * downstream trusts it instead of re-deciding.
 */

import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { EnvFilePath } from "./project-env";

const decode = Schema.decodeUnknownExit(EnvFilePath);

describe("the env file path brand", () => {
  it("refuses at the schema too, so a bad path never reaches a handler", () => {
    expect(decode("../../.ssh/authorized_keys")._tag).toBe("Failure");
  });

  it("accepts at the schema, which is where the brand comes from", () => {
    expect(decode("apps/web/.env")._tag).toBe("Success");
  });
});
