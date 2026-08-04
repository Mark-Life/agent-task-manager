/**
 * The selection, which is the only thing about the two implementations a caller
 * is allowed to see. What each of them does is tested next door against a real
 * process and a real daemon; what matters here is that an unset variable means
 * isolation and a misspelt one is a startup failure rather than a quiet default.
 */

import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import { dockerSandboxLayer } from "./docker";
import { localSandboxLayer } from "./local";
import {
  DEFAULT_SANDBOX_KIND,
  SANDBOX_MODE_ENV_VAR,
  sandboxKindConfig,
  sandboxLayerFor,
} from "./mode";

/** Reads the configured kind against one environment. */
const kindWith = (env: Readonly<Record<string, string>>) =>
  Effect.runPromise(
    Effect.result(
      sandboxKindConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
      )
    )
  );

describe("sandboxKindConfig", () => {
  test("an unset variable is a container, not the absence of one", async () => {
    const kind = await kindWith({});
    expect(kind._tag).toBe("Success");
    expect(DEFAULT_SANDBOX_KIND).toBe("docker");
  });

  test("either implementation can be named", async () => {
    const named = await Promise.all(
      (["docker", "local"] as const).map((kind) =>
        kindWith({ [SANDBOX_MODE_ENV_VAR]: kind })
      )
    );
    expect(
      named.map((kind) => kind._tag === "Success" && kind.success)
    ).toEqual(["docker", "local"]);
  });

  test("a value that is neither is refused rather than defaulted", async () => {
    // The dangerous shape of this mistake is a typo for `local` that silently
    // starts containers, or a typo for `docker` that silently does not.
    const kind = await kindWith({ [SANDBOX_MODE_ENV_VAR]: "loc4l" });
    expect(kind._tag).toBe("Failure");
  });
});

describe("sandboxLayerFor", () => {
  test("each kind resolves to its own implementation", () => {
    expect(sandboxLayerFor("docker")).toBe(dockerSandboxLayer);
    expect(sandboxLayerFor("local")).toBe(localSandboxLayer);
  });
});
