#!/usr/bin/env bun

/**
 * Puts a provider's login into the system-owned agent home, once, by hand.
 *
 * Every container mounts one directory per provider read-write and writes its
 * refreshed token straight back into it. Nothing on the run path ever creates
 * or seeds that directory, and this script is why it does not have to: it is
 * run once per host, by the human, and never again.
 *
 * **It must not be run per turn, and this is the failure it would cause.**
 * Claude's credential store deletes the plaintext `.credentials.json` the
 * moment a keychain write succeeds, so a re-export on every turn would drop the
 * host's older token over one a container had just refreshed — which is exactly
 * the staleness the shared home exists to end, reintroduced on a schedule.
 *
 * Two paths, and the difference is where the vendor keeps the login.
 *
 * On Linux, and for Codex anywhere, the CLI writes a file inside its config
 * directory, so the whole job is `CLAUDE_CONFIG_DIR=<dir> claude` and `/login`.
 * This script creates the directory at `0700` and prints that line.
 *
 * On macOS, Claude keeps its tokens in the login keychain and writes no file at
 * all — and the keychain item is named after the config directory, so logging
 * in with `CLAUDE_CONFIG_DIR` set stores the token under a name derived from
 * that path and still leaves the directory empty. The container is Linux, has
 * no `security` binary, and falls back to the plaintext file, so a refresh
 * inside it works and persists; only the *first* credential has to get in.
 * That is the export below: read the item the ordinary Claude CLI already
 * wrote, keep the one key that is the Claude login, and write the body a Linux
 * CLI would have written.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { BunRuntime } from "@effect/platform-bun";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { SESSION_PROVIDERS, type SessionProvider } from "@workspace/domain";
import {
  AGENT_HOME_DIR_ENV_VAR,
  agentHomeLoginHint,
  defaultAgentHomeDirOf,
} from "@workspace/harness";
import { Config, Effect, Layer, Option, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/** The keychain item the Claude CLI writes its OAuth tokens into. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The one key of that item worth copying.
 *
 * The same item also holds `mcpOAuth`, which is every MCP server the operator
 * has ever authorized from their own machine. A run needs the Claude login and
 * nothing else, so the extraction is an allow-list of one.
 */
const CLAUDE_OAUTH_KEY = "claudeAiOauth";

/** The file a Linux Claude CLI keeps its tokens in, inside its config directory. */
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";

/** The home is the operator's alone: no group, no other. */
const AGENT_HOME_MODE = 0o700;

/** A credential file is readable by its owner and nobody else. */
const CREDENTIAL_MODE = 0o600;

/** Whether a parsed JSON value is a plain object, which a keychain item is. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Turns the raw keychain payload into the body of a `.credentials.json`.
 *
 * Pure, and total over anything the keychain hands back: an item that is not
 * JSON, not an object, or holds no Claude login is `null` rather than an empty
 * credentials file, because a file that exists and authenticates nothing is
 * indistinguishable at the far end from an expired token.
 */
export const claudeCredentialBody = (raw: string): string | null => {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  if (!isRecord(parsed)) {
    return null;
  }
  const oauth = parsed[CLAUDE_OAUTH_KEY];
  return isRecord(oauth) ? JSON.stringify({ [CLAUDE_OAUTH_KEY]: oauth }) : null;
};

/**
 * Bun's process spawner and the two services it is built from. Named
 * explicitly rather than taken from the aggregate platform layer, which would
 * also construct a terminal and claim the host's stdin.
 */
const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))
);

/**
 * Reads one generic password out of the login keychain, or nothing.
 *
 * `security` prompts for access the first time and remembers the decision, so
 * the human running this answers one dialog. That is the whole reason it lives
 * in a script a person runs rather than on a dispatch path nobody is watching.
 */
const readKeychainItem = (service: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      // `-w` prints the password alone; without it the output is the item's
      // attributes and the secret is not in it.
      ChildProcess.make("security", [
        "find-generic-password",
        "-s",
        service,
        "-w",
      ])
    );
    const [stdout, exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
      { concurrency: "unbounded" }
    );
    // A missing item exits non-zero, which is the ordinary answer on a host
    // that has never logged in — not a failure to report.
    return Number(exitCode) === 0 ? Option.some(stdout.trim()) : Option.none();
  }).pipe(
    Effect.scoped,
    Effect.provide(spawnerLayer),
    // The binary is absent on every non-macOS host, where the CLI writes the
    // credentials file this exists to substitute for.
    Effect.orElseSucceed(() => Option.none<string>())
  );

/** The provider named on the command line, or null when none was. */
const namedProvider = (): SessionProvider | null => {
  const named = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  return SESSION_PROVIDERS.find((provider) => provider === named) ?? null;
};

/** Where this provider's home is, honouring the override the loop reads. */
const agentHomeDirOf = (provider: SessionProvider) =>
  Config.string(AGENT_HOME_DIR_ENV_VAR[provider]).pipe(
    Config.withDefault(defaultAgentHomeDirOf(provider))
  );

/**
 * The macOS one-shot: the keychain item the ordinary CLI wrote, reduced to the
 * Claude login, written where a Linux CLI would look for it.
 *
 * Refuses to overwrite. A file already there is a token a container may have
 * refreshed since, and this script's whole reason for existing is that the
 * host's copy is the stale one.
 */
const exportClaudeKeychain = Effect.fnUntraced(function* (
  agentHomeDir: string
) {
  const target = join(agentHomeDir, CLAUDE_CREDENTIALS_FILE);
  if (existsSync(target)) {
    yield* Effect.logInfo(
      `      ${target} already exists; leaving it alone — a container may have refreshed it`
    );
    return true;
  }
  const item = yield* readKeychainItem(CLAUDE_KEYCHAIN_SERVICE);
  const body = Option.flatMap(item, (raw) =>
    Option.fromNullOr(claudeCredentialBody(raw))
  );
  if (Option.isNone(body)) {
    return false;
  }
  yield* Effect.sync(() => {
    writeFileSync(target, body.value, { mode: CREDENTIAL_MODE });
    chmodSync(target, CREDENTIAL_MODE);
  });
  yield* Effect.logInfo(`ok    exported the login keychain item to ${target}`);
  return true;
});

/** One provider: its directory made, and its login put there or asked for. */
const setUp = Effect.fnUntraced(function* (provider: SessionProvider) {
  const agentHomeDir = yield* agentHomeDirOf(provider);
  yield* Effect.sync(() => {
    mkdirSync(agentHomeDir, { mode: AGENT_HOME_MODE, recursive: true });
    chmodSync(agentHomeDir, AGENT_HOME_MODE);
  });
  yield* Effect.logInfo(`${provider}\n      home ${agentHomeDir}`);

  const exported =
    provider === "claude" ? yield* exportClaudeKeychain(agentHomeDir) : false;
  if (!exported) {
    yield* Effect.logInfo(
      `      no credential exported. Log in by hand, once:\n        ${agentHomeLoginHint(provider, agentHomeDir)}`
    );
  }
  yield* Effect.logInfo(
    `      override the path with ${AGENT_HOME_DIR_ENV_VAR[provider]}`
  );
});

const agentHomeLogin = Effect.gen(function* () {
  const only = namedProvider();
  const providers = SESSION_PROVIDERS.filter(
    (provider) => only === null || provider === only
  );
  yield* Effect.logInfo(
    "The agent home is created here and never on a run path. A container writes its refreshed token straight back into it, so nothing re-seeds it afterwards."
  );
  for (const provider of providers) {
    yield* setUp(provider);
  }
});

BunRuntime.runMain(agentHomeLogin);
