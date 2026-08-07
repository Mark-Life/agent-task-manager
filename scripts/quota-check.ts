#!/usr/bin/env bun

/**
 * Reads both providers' remaining allowance from this host, and prints it.
 *
 * The gate in front of dispatch reads two undocumented endpoints with the
 * credentials in the *agent home* — the login directory the containers are
 * handed, which is where the subscription being spent actually lives, and not
 * `~/.claude` or `~/.codex`. Both reads degrade to "could not tell" on anything
 * unexpected, which is the right behaviour in a dispatch path and the wrong one
 * to find out about by watching a dashboard stay blank for a day. This is the
 * command that says which it is, in one place, before any of that:
 *
 *   bun run quota:check
 *
 * It reads the same files and hits the same URLs the loop does, so a reading
 * here is a reading the loop will get. Both are passive GETs against the
 * subscription — they report the windows and generate nothing, so running this
 * as often as you like spends none of what it reports.
 *
 * It exits non-zero when neither provider could be read, because that is an
 * install that will dispatch blind. One provider readable is a normal state —
 * plenty of hosts only ever log into one — and prints a warning.
 */

import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import type { SessionProvider } from "@workspace/domain";
import {
  AGENT_HOME_DIR_ENV_VAR,
  agentHomeLoginHint,
  defaultAgentHomeDirOf,
} from "@workspace/harness";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  type ProviderUsage,
  providerReport,
} from "@workspace/orchestrator";
import { Config, DateTime, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

/** The one ending that exits non-zero: nothing on this host could be read. */
class NothingReadable extends Schema.TaggedErrorClass<NothingReadable>()(
  "QuotaCheck.NothingReadable",
  { providers: Schema.Array(Schema.String) }
) {}

/** How a reset time reads to a person: the clock, and how far off it is. */
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const untilText = (resetsAtMs: number, nowMs: number) => {
  const remaining = Math.max(0, resetsAtMs - nowMs);
  const hours = Math.floor(remaining / HOUR_MS);
  const minutes = Math.round((remaining % HOUR_MS) / MINUTE_MS);
  return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
};

/**
 * Where this provider's login lives on the host, honouring the same override
 * the loop reads. Resolved the way `harness:check` resolves it, so the two
 * commands cannot disagree about which account is being talked about.
 */
const agentHomeDirOf = (provider: SessionProvider) =>
  Config.string(AGENT_HOME_DIR_ENV_VAR[provider]).pipe(
    Config.withDefault(defaultAgentHomeDirOf(provider))
  );

/** One provider's reading, printed the way the dashboard will render it. */
const report = (input: {
  readonly agentHomeDir: string;
  readonly nowMs: number;
  readonly provider: SessionProvider;
  readonly usage: ProviderUsage;
}) =>
  Effect.gen(function* () {
    const published = providerReport({
      enforced: true,
      pausedUntilMs: null,
      pauseReason: null,
      provider: input.provider,
      readAtMs: input.nowMs,
      reading: true,
      usage: input.usage,
    });

    if (!input.usage.available) {
      yield* Effect.logWarning(
        `${input.provider}: no signal from ${input.agentHomeDir} — no login there, an expired token, or a body whose shape moved. The gate will dispatch without it. If it is the login: ${agentHomeLoginHint(input.provider, input.agentHomeDir)}.`
      );
      return false;
    }

    yield* Effect.logInfo(
      `${input.provider}: ${published.state}${published.windows.length === 0 ? " (the body carried no windows)" : ""}`
    );
    for (const window of published.windows) {
      const resets =
        window.resetsAt === null
          ? "no reset stated"
          : // The document keeps the instant; this is the one place it reads
            // better as a duration.
            untilText(DateTime.toEpochMillis(window.resetsAt), input.nowMs);
      yield* Effect.logInfo(
        `  ${window.label} window (${window.kind}): ${window.remainingPercent}% left, ${window.usedPercent}% used, ${resets}`
      );
    }
    return true;
  });

const quotaCheck = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const http = yield* HttpClient.HttpClient;
  const nowMs = Date.now();

  yield* Effect.logInfo(
    "reading both providers' subscription windows — passive GETs, nothing is spent"
  );

  const claudeHome = yield* agentHomeDirOf("claude");
  const claude = yield* fetchClaudeUsage({
    agentHomeDir: claudeHome,
    fs,
    http,
  });
  const claudeRead = yield* report({
    agentHomeDir: claudeHome,
    nowMs,
    provider: "claude",
    usage: claude,
  });

  const codexHome = yield* agentHomeDirOf("codex");
  const codex = yield* fetchCodexUsage({ agentHomeDir: codexHome, fs, http });
  const codexRead = yield* report({
    agentHomeDir: codexHome,
    nowMs,
    provider: "codex",
    usage: codex,
  });

  if (claudeRead && codexRead) {
    return;
  }
  if (claudeRead || codexRead) {
    return yield* Effect.logWarning(
      "one provider is readable and one is not: runs on the unreadable one dispatch without a check, and the dashboard will show it as unavailable"
    );
  }
  return yield* Effect.fail(
    new NothingReadable({ providers: ["claude", "codex"] })
  );
});

BunRuntime.runMain(
  quotaCheck.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(BunFileSystem.layer)
  )
);
