/**
 * Reading Claude's subscription login out of the macOS keychain.
 *
 * On Linux the CLI keeps its tokens in `<config dir>/.credentials.json`, which
 * a run home can copy like any other file. On macOS it keeps the same tokens in
 * the login keychain and writes no such file at all, so an operator whose
 * interactive sessions work fine has nothing on disk to seed a run with — the
 * copy finds an empty directory and the container starts unauthenticated.
 *
 * This is the bridge: read the item the CLI stores, keep the part that is the
 * Claude login, and hand back the body of the file the Linux CLI would have
 * written. The container then reads an ordinary credentials file and neither
 * side has to know the host was a Mac.
 *
 * `security` prompts for keychain access the first time and remembers the
 * decision, so a run dispatched by a background loop can block on a dialog
 * exactly once per machine. That is worth knowing before the first dispatch on
 * a fresh host; it is not worth engineering around.
 */

import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Layer, Option, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

/** The keychain item the Claude CLI writes its OAuth tokens into. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The one key of that item worth copying into a run.
 *
 * The same item also holds `mcpOAuth`, which is every MCP server the operator
 * has ever authorized from their own machine. A run needs the Claude login and
 * nothing else, so the extraction is an allow-list of one — the same discipline
 * the config-file prune follows, for the same reason.
 */
const CLAUDE_OAUTH_KEY = "claudeAiOauth";

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

/** Reads one generic password out of the login keychain, or nothing. */
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
    // The binary is absent on every non-macOS host, and an operator on Linux
    // has the credentials file this exists to substitute for.
    Effect.orElseSucceed(() => Option.none<string>())
  );

/**
 * Claude's login as the file body a run home wants, or nothing when this host
 * keeps it elsewhere.
 *
 * The span carries whether an item was found and never what was in it. The
 * token itself is written straight to the run home at mode 600 and is not
 * logged, annotated, or returned anywhere it could be.
 */
export const claudeKeychainCredential = (): Effect.Effect<
  Option.Option<string>
> =>
  Effect.gen(function* () {
    const item = yield* readKeychainItem(CLAUDE_KEYCHAIN_SERVICE);
    const body = Option.flatMap(item, (raw) =>
      Option.fromNullOr(claudeCredentialBody(raw))
    );
    yield* Effect.annotateCurrentSpan({ found: Option.isSome(body) });
    return body;
  }).pipe(Effect.withSpan("Keychain.claude"));
