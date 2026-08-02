/**
 * Giving a run its own copy of a provider's config directory, holding nothing
 * but the credential.
 *
 * Both harnesses treat one directory as their whole world: `~/.claude` and
 * `~/.codex` hold the login, the settings, and every transcript of every
 * project the operator has ever opened. Pointing a sandboxed run at that
 * directory would mount an operator's entire history into a container an agent
 * controls, so each run gets a private one instead — created here, seeded with
 * the credential and nothing else, and removed when the run is over.
 *
 * The seed is an allow-list, and that is the load-bearing part. A deny-list of
 * "everything except the transcripts" is one vendor release away from copying a
 * directory nobody thought about; naming the two or three files that are
 * actually the login means a new file is absent from the run home by default.
 *
 * Known risk, deliberately accepted: both providers refresh their subscription
 * tokens in place, and several runs each holding a copy of the same rotating
 * credential can invalidate one another — the last refresh wins and the other
 * copies become stale mid-run. The alternative is a shared config directory,
 * which trades an occasional re-auth for a permanent cross-run leak, so the
 * copy stays. A run that dies on {@link Harness.Unauthenticated} shortly after
 * a sibling refreshed is this, not a broken seed.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SessionProvider } from "@workspace/domain";
import { Config, Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { claudeKeychainCredential } from "./keychain";
import {
  AGENT_HOME_ENV_VAR,
  agentHomeEnv,
  agentHomeOf,
  type RunLayout,
} from "./paths";

/** Claude's account identity and onboarding flags, wherever it is keeping them. */
const CLAUDE_CONFIG_FILE = ".claude.json";

/** The run home is the operator's alone: no group, no other. */
export const AGENT_HOME_MODE = 0o700;

/** A credential file is readable by its owner and nobody else, copy included. */
export const CREDENTIAL_MODE = 0o600;

/**
 * The keys of Claude's `.claude.json` that survive into a run home. Everything
 * omitted is the reason the file is pruned rather than copied: `projects` alone
 * holds every directory the operator has opened, its prompt history, and its
 * pasted content.
 *
 * None of these is the credential — that is `.credentials.json`. They are the
 * account identity and the onboarding flags, without which the CLI treats a
 * fresh config directory as a first run and stops to ask.
 */
const CLAUDE_CONFIG_KEYS = [
  "hasAvailableSubscription",
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "oauthAccount",
  "userID",
] as const;

/** Whether a parsed JSON value is a plain object, which a config file is. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reduces Claude's config file to {@link CLAUDE_CONFIG_KEYS}. Pure, and total
 * over a file that is unparseable or not an object — an empty config is a
 * harmless seed, while refusing to start a run over a corrupt preferences file
 * would not be.
 */
export const pruneClaudeConfig = (raw: string): string => {
  const parsed = ((): Readonly<Record<string, unknown>> | null => {
    try {
      const value: unknown = JSON.parse(raw);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  })();

  if (parsed === null) {
    return "{}";
  }
  const kept = Object.fromEntries(
    CLAUDE_CONFIG_KEYS.filter((key) => parsed[key] !== undefined).map((key) => [
      key,
      parsed[key],
    ])
  );
  return JSON.stringify(kept);
};

/** One file copied into a run home. */
interface CredentialFile {
  /**
   * Where else this file's contents live when the source directory does not
   * hold them. Null means the directory is the only place to look.
   *
   * Both harnesses document one config directory and then keep part of the
   * login somewhere else on some hosts, so a seeder that reads only the
   * directory silently produces an unauthenticated run on a machine where
   * interactive use works. An alternate is how that stays an allow-list: it
   * names the other place for one named file, rather than widening what gets
   * copied.
   */
  readonly alternate: ((source: string) => AlternateSource) | null;
  /** Its name in both the source and the run home; the layout is the vendor's. */
  readonly name: string;
  /** Whether a run can start without it. */
  readonly required: boolean;
  /** Rewrites the file on the way in. Null copies it byte for byte. */
  readonly transform: ((raw: string) => string) | null;
}

/**
 * A second place one credential file's contents can come from: the body to
 * write, or nothing when this host does not keep it there either.
 */
type AlternateSource = Effect.Effect<
  Option.Option<string>,
  AgentHomeFailed,
  FileSystem
>;

/**
 * Claude's `.claude.json` as the CLI actually places it: inside the config
 * directory when that directory has been relocated, and beside it — at
 * `~/.claude.json`, a sibling of `~/.claude` — when it has not. The default
 * layout is the one an operator who has never set `CLAUDE_CONFIG_DIR` has, so
 * looking only inside finds nothing on the ordinary host.
 */
const claudeConfigBesideDir = (source: string): AlternateSource =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const beside = join(dirname(source), CLAUDE_CONFIG_FILE);
    const present = yield* fs.exists(beside).pipe(failingAt(beside));
    return present
      ? Option.some(yield* fs.readFileString(beside).pipe(failingAt(beside)))
      : Option.none();
  });

/**
 * What each provider's login actually consists of.
 *
 * Claude splits it across two files and two hosts: the tokens are
 * `.credentials.json` on Linux and the login keychain on macOS, while the
 * account identity and onboarding flags are `.claude.json`, which sits inside
 * the config directory only when that directory has been moved. Each file names
 * the other place it lives, so one seeder covers both kinds of host.
 *
 * Neither is required. A run seeded from a host that has genuinely never logged
 * in fails as unauthenticated inside the container, which is the honest
 * outcome — the alternative is refusing to start on a machine where an
 * interactive run works fine.
 *
 * Codex keeps everything in `auth.json`, and a run without it cannot do
 * anything, so its absence is a failure rather than a report. `config.toml` is
 * deliberately not copied: it is preferences plus the operator's per-directory
 * trust decisions, and a sandbox states its own on the command line.
 */
const CREDENTIAL_FILES = {
  claude: [
    {
      alternate: () => claudeKeychainCredential(),
      name: ".credentials.json",
      required: false,
      transform: null,
    },
    {
      alternate: claudeConfigBesideDir,
      name: CLAUDE_CONFIG_FILE,
      required: false,
      transform: pruneClaudeConfig,
    },
  ],
  codex: [
    { alternate: null, name: "auth.json", required: true, transform: null },
  ],
} as const satisfies Record<SessionProvider, readonly CredentialFile[]>;

/** Where each provider keeps its config directory under a home directory. */
const DEFAULT_SOURCE_DIR = {
  claude: ".claude",
  codex: ".codex",
} as const satisfies Record<SessionProvider, string>;

/**
 * The host directory a run's credentials are copied from. The same environment
 * variable that relocates a provider inside the container relocates the source
 * outside it, so an operator who already runs with a moved config directory is
 * read from the moved one rather than from an empty default.
 */
export const agentHomeSourceDir = (provider: SessionProvider) =>
  Effect.gen(function* () {
    const configured = yield* Config.option(
      Config.string(AGENT_HOME_ENV_VAR[provider])
    );
    return Option.isSome(configured)
      ? configured.value
      : join(homedir(), DEFAULT_SOURCE_DIR[provider]);
  });

/**
 * A file the provider cannot run without was not on the host. Raised before the
 * container starts, because the alternative is a run that boots, fails its
 * first request, and reports an auth error indistinguishable from an expired
 * token.
 */
export class CredentialsMissing extends Schema.TaggedErrorClass<CredentialsMissing>()(
  "Harness.CredentialsMissing",
  { file: Schema.String, provider: SessionProvider, sourceDir: Schema.String }
) {}

/** The run home could not be created, seeded, or removed. */
export class AgentHomeFailed extends Schema.TaggedErrorClass<AgentHomeFailed>()(
  "Harness.AgentHomeFailed",
  { cause: Schema.Unknown, path: Schema.String }
) {}

/** Names the path a filesystem failure was about, so the error says which one. */
const failingAt = (path: string) =>
  Effect.mapError((cause: unknown) => new AgentHomeFailed({ cause, path }));

/** What one seeded run home ended up holding. */
export interface AgentHomeReport {
  /** The provider's config directory inside the run, ready to be mounted. */
  readonly agentHomeDir: string;
  /** The one variable that points the provider at it. */
  readonly env: Readonly<Record<string, string>>;
  /** Optional files that were not on the host. Empty is the healthy case. */
  readonly missing: readonly string[];
  readonly provider: SessionProvider;
  /** Files actually written, by name. Never their contents. */
  readonly seeded: readonly string[];
}

/** Which run home to build, for which provider, from where. */
export interface PrepareAgentHomeInput {
  readonly layout: RunLayout;
  readonly provider: SessionProvider;
  /** Null reads the host's own agent home through {@link agentHomeSourceDir}. */
  readonly sourceDir: string | null;
}

/** One file's fate, before the report is assembled. */
interface SeedResult {
  readonly copied: boolean;
  readonly name: string;
}

/** Copies one credential file, rewriting it on the way where the entry says so. */
const seedFile = Effect.fnUntraced(function* (input: {
  readonly file: CredentialFile;
  readonly provider: SessionProvider;
  readonly source: string;
  readonly target: string;
}) {
  const fs = yield* FileSystem;
  const from = join(input.source, input.file.name);
  const to = join(input.target, input.file.name);

  // `exists` before `read`, rather than treating any read failure as absence:
  // a credential file that is there but unreadable is a permissions problem
  // someone must fix, not a host that was never logged in.
  const present = yield* fs.exists(from).pipe(failingAt(from));
  // The directory is asked first and the alternate only answers for a file that
  // is not in it, so a host keeping the file where the vendor documents it is
  // never second-guessed by a fallback.
  const found = present
    ? Option.some(yield* fs.readFileString(from).pipe(failingAt(from)))
    : yield* input.file.alternate?.(input.source) ??
        Effect.succeed(Option.none<string>());

  if (Option.isNone(found)) {
    if (input.file.required) {
      return yield* Effect.fail(
        new CredentialsMissing({
          file: input.file.name,
          provider: input.provider,
          sourceDir: input.source,
        })
      );
    }
    return { copied: false, name: input.file.name } satisfies SeedResult;
  }

  const raw = found.value;
  const body = input.file.transform === null ? raw : input.file.transform(raw);
  yield* fs
    .writeFileString(to, body, { mode: CREDENTIAL_MODE })
    .pipe(failingAt(to));
  // The mode above only applies when the write creates the file, and a re-seed
  // into an existing run home would keep whatever mode it had.
  yield* fs.chmod(to, CREDENTIAL_MODE).pipe(failingAt(to));
  return { copied: true, name: input.file.name } satisfies SeedResult;
});

/**
 * Creates this run's config directory for one provider and seeds it with that
 * provider's credential files.
 *
 * Nothing else is copied — not settings, not history, not the transcripts of
 * other projects — so the directory that ends up mounted into a container holds
 * exactly what the provider needs to authenticate and whatever it writes itself
 * while it runs.
 */
export const prepareAgentHome = Effect.fn("AgentHome.prepare")(function* (
  input: PrepareAgentHomeInput
) {
  const fs = yield* FileSystem;
  const target = agentHomeOf(input.layout, input.provider);
  const source = input.sourceDir ?? (yield* agentHomeSourceDir(input.provider));

  yield* Effect.annotateCurrentSpan({ provider: input.provider });
  yield* fs
    .makeDirectory(target, { mode: AGENT_HOME_MODE, recursive: true })
    .pipe(failingAt(target));

  const results = yield* Effect.forEach(
    CREDENTIAL_FILES[input.provider],
    (file) => seedFile({ file, provider: input.provider, source, target })
  );

  return {
    agentHomeDir: target,
    env: agentHomeEnv(input.layout, input.provider),
    missing: results.filter((r) => !r.copied).map((r) => r.name),
    provider: input.provider,
    seeded: results.filter((r) => r.copied).map((r) => r.name),
  } satisfies AgentHomeReport;
});

/**
 * Removes a run's agent home, credential copies and provider-written state
 * alike. Called on every path a run can end on, including the failed ones: a
 * copy of a live subscription token left in the data root is the whole reason
 * the per-run copy is bounded in time as well as in content.
 */
export const teardownAgentHome = Effect.fn("AgentHome.teardown")(function* (
  layout: RunLayout
) {
  const fs = yield* FileSystem;
  yield* fs
    .remove(layout.agentHomeDir, { force: true, recursive: true })
    .pipe(failingAt(layout.agentHomeDir));
});

/**
 * The seeded home for the duration of a scope. Makes "credentials do not
 * outlive the run" structural rather than a rule someone follows, since the
 * release runs on interruption and on defect too.
 *
 * A failed teardown is logged and swallowed: the run itself succeeded or failed
 * on its own terms, and turning a leftover directory into the run's outcome
 * would misreport both. The log line is what makes the leftover visible.
 */
export const scopedAgentHome = (input: PrepareAgentHomeInput) =>
  Effect.acquireRelease(prepareAgentHome(input), () =>
    teardownAgentHome(input.layout).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("agent home not removed", error)
      ),
      Effect.ignore
    )
  );
