#!/usr/bin/env bun

/**
 * Proves the harness does the four things the orchestrator is allowed to assume:
 * a prompt handed to a provider comes back as normalized events, the provider
 * writes its transcript where the reader looks for it, the stop hook refuses a
 * turn that has posted no comment, and the invocation leaves exactly one
 * `atm.turn` row on disk where the host can find it.
 *
 * It is a script rather than a test because three of those four claims are about
 * a real subprocess, a real directory and a real vendor CLI. Checking them
 * against a fake would be checking the fake. The one claim that is provable
 * without a provider — one row per turn, on every exit path — is a unit test in
 * `packages/harness/src/registry.test.ts`.
 *
 * **Nothing here creates or seeds an agent home.** There is one system-owned
 * directory per provider on the host, the human logs into it once by hand, and
 * every container mounts it read-write so a refreshed token survives. So the
 * two claims this script makes about it are ownership and content, and both
 * fail by printing the one-time login line rather than by fixing anything: an
 * auto-created empty home is a container that boots and reports an auth error
 * nobody can tell from an expired token.
 *
 * Two modes, and the difference is a model call:
 *
 *   bun run harness:check          the agent homes, the layout, the transcript
 *                                  address, the registry, and the stop hook run
 *                                  as a real process. No API call, no charge.
 *                                  Credentials are checked for existence and
 *                                  never read.
 *
 *   bun run harness:check --live   the above, plus one real turn on each
 *                                  provider: events streamed as they arrive, the
 *                                  transcript found by this turn's own session
 *                                  id in the shared tree, the stop hook forcing
 *                                  a second turn, and the `atm.turn` rows
 *                                  counted in the ledger. Set
 *                                  `HARNESS_CHECK_LIVE=1` instead of the flag
 *                                  where a flag is awkward to pass, and add
 *                                  `--provider codex` to check one harness on a
 *                                  host where only one is logged in.
 *
 * The run directory is left behind so its ledger can be read. The agent home is
 * not touched: it is the operator's, it holds the only copy of the login, and
 * this script has no business writing to it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import { newRunId, type SessionProvider } from "@workspace/domain";
import {
  AGENT_HOME_DIR_ENV_VAR,
  type AgentEvent,
  agentHomeLoginHint,
  COMMENT_MARKER_ENV_VAR,
  commentMarkerPathOf,
  defaultAgentHomeDirOf,
  findTranscript,
  hostRunLayout,
  NO_COMMENT_REFUSAL,
  ProviderRegistry,
  providerRegistryLayer,
  readTranscript,
  STOP_HOOK_COMMAND_ENV_VAR,
  TURN_EVENT_MARKER,
  transcriptDirOf,
} from "@workspace/harness";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { spawn } from "bun";
import { Config, Effect, Layer, Schema, Stream } from "effect";

/** Names the ledger file and the OTLP resource, as every service does. */
const SERVICE = "harness-check";

/** Where on-disk state lives when `DATA_ROOT` is unset, as the telemetry ledger has it. */
const DEFAULT_DATA_ROOT = ".data";

/** The hook executable, resolved from this file so the cwd does not matter. */
const STOP_HOOK_SCRIPT = new URL(
  "../packages/harness/scripts/stop-hook.ts",
  import.meta.url
).pathname;

/**
 * The prompt. Deliberately trivial and tool-free: the claims under test are
 * about the plumbing around a turn, and a prompt that sends the agent off to
 * read a repository costs minutes and proves nothing extra.
 */
const PROMPT =
  "Reply with one short sentence naming the file you can see in this directory. Do not use any tools beyond reading it.";

/** Characters of the final message printed, so a live run is legible without carrying content anywhere durable. */
const FINAL_MESSAGE_CHARS = 160;

/**
 * The phrase a refused ending puts in front of the model. Finding it in a
 * transcript is how a forced second turn is told from a talkative one.
 */
const ANCHOR_CHARS = 48;
const REFUSAL_ANCHOR = NO_COMMENT_REFUSAL.slice(0, ANCHOR_CHARS);

/** Width of the provider column in the capability table. */
const PROVIDER_COLUMN = 6;

/** One thing the harness was supposed to do and did not. */
class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()(
  "HarnessCheck.Failed",
  { detail: Schema.String, step: Schema.String }
) {
  /** What the operator reads. The fields are not printed by the default reporter. */
  override get message() {
    return `${this.step} — ${this.detail}`;
  }
}

/**
 * Asserts one claim, naming what was expected when it does not hold. Failing as
 * a value rather than throwing is what makes the whole check one effect that
 * stops at the first broken claim and exits non-zero.
 */
const check = (options: {
  readonly detail: string;
  readonly ok: boolean;
  readonly step: string;
}) =>
  options.ok
    ? Effect.logInfo(`ok    ${options.step}`)
    : Effect.fail(
        new CheckFailed({ detail: options.detail, step: options.step })
      );

/** Whether the operator asked for the model calls. */
const isLive = () =>
  process.argv.includes("--live") || process.env.HARNESS_CHECK_LIVE === "1";

/**
 * The provider to check, or null for all of them. Narrowing is what makes the
 * script usable on a host where only one of the two is logged in — the other
 * would otherwise stop the run before it reached anything.
 */
const onlyProvider = () => {
  const at = process.argv.indexOf("--provider");
  if (at === -1) {
    return null;
  }
  const named = process.argv[at + 1];
  return named === undefined || named.startsWith("--") ? null : named;
};

/** The response the stop hook wrote, as much of it as the rule decides. */
interface HookResponse {
  readonly decision?: string;
  readonly reason?: string;
}

/**
 * Runs the hook the way a provider runs it: a process, one JSON payload on
 * stdin, one JSON response on stdout. Driving the real executable is the point —
 * the decision function is unit-tested next door, and what is untested until
 * here is that the file parses its input, finds the marker, and answers on the
 * stream a harness is listening to.
 */
const askStopHook = (input: {
  readonly markerPath: string;
  readonly payload: Readonly<Record<string, unknown>>;
}) =>
  Effect.promise(async () => {
    const child = spawn(["bun", STOP_HOOK_SCRIPT], {
      env: { ...process.env, [COMMENT_MARKER_ENV_VAR]: input.markerPath },
      stdin: new TextEncoder().encode(JSON.stringify(input.payload)),
      stdout: "pipe",
    });
    const answer = await new Response(child.stdout).text();
    await child.exited;
    return JSON.parse(answer) as HookResponse;
  });

/** A payload shaped like the one both harnesses send when a turn tries to end. */
const stopPayload = (options: {
  readonly cwd: string;
  readonly retried: boolean;
}) => ({
  cwd: options.cwd,
  hook_event_name: "Stop",
  last_assistant_message: "I have finished.",
  session_id: "harness-check-session",
  stop_hook_active: options.retried,
  transcript_path: null,
});

/** Every `atm.turn` row in the ledger that belongs to this run. */
const turnRows = (ledgerPath: string, runId: string) => {
  const raw = ((): string => {
    try {
      return readFileSync(ledgerPath, "utf-8");
    } catch {
      return "";
    }
  })();
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.event === TURN_EVENT_MARKER && row.runId === runId);
};

/** A one-line, content-free rendering of a normalized event. */
const describeEvent = (event: AgentEvent) => {
  switch (event.kind) {
    case "assistant_text":
      return `assistant_text  ${event.text.length} chars`;
    case "reasoning":
      return `reasoning       ${event.chars} chars`;
    case "result":
      return `result          ${event.outcome}${
        event.errorClass === null ? "" : ` (${event.errorClass})`
      }`;
    case "session_init":
      return `session_init    ${event.providerSessionId} on ${event.model ?? "the provider's default"}`;
    case "tool_call":
      return `tool_call       ${event.toolName}`;
    case "tool_result":
      return `tool_result     ${event.ok ? "ok" : "failed"}`;
    case "usage":
      return `usage           ${event.inputTokens ?? "?"} in / ${event.outputTokens ?? "?"} out`;
    default:
      return event.kind;
  }
};

/** The mode the agent home is created at, and the only one it should ever have. */
const AGENT_HOME_MODE = 0o700;

/**
 * `statSync().mode` carries the file type in its high bits. Modulo rather than
 * a mask, because the permission bits are the low three octal digits and the
 * linter reads a bitwise `&` here as a mistyped `&&`.
 */
const MODE_DIVISOR = 0o1000;

/**
 * Where this provider's login lives on the host, honouring the override the
 * loop reads. Resolved once per provider and never written to.
 */
const agentHomeDirOf = (provider: SessionProvider) =>
  Config.string(AGENT_HOME_DIR_ENV_VAR[provider]).pipe(
    Config.withDefault(defaultAgentHomeDirOf(provider))
  );

/**
 * What each provider's login looks like on disk, as a name to test for.
 *
 * Claude keeps the tokens in `.credentials.json` on any host with no keychain,
 * which is every container — so that is the file the shared home must hold even
 * on a Mac, and `scripts/agent-home-login.ts` is what puts it there. Codex keeps
 * everything in `auth.json`. Existence only: the contents are a live
 * subscription token and this script has no reason to read one.
 */
const CREDENTIAL_FILE = {
  claude: ".credentials.json",
  codex: "auth.json",
} as const satisfies Record<SessionProvider, string>;

/** One provider's turn, streamed to stdout as it arrives. */
const streamTurn = (input: {
  readonly agentHomeDir: string;
  readonly markerPath: string;
  readonly provider: SessionProvider;
  readonly runId: string;
  readonly workspaceDir: string;
}) =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const harness = registry.get(input.provider);
    const stream = harness.run({
      agentHomeDir: input.agentHomeDir,
      effort: null,
      env: { [COMMENT_MARKER_ENV_VAR]: input.markerPath },
      mcpServers: null,
      model: null,
      prompt: PROMPT,
      resumeSessionId: null,
      runId: input.runId as never,
      signal: null,
      taskId: null,
      workspaceDir: input.workspaceDir,
    });
    return yield* Stream.runCollect(
      Stream.tap(stream, (event) =>
        Effect.logInfo(`      ${describeEvent(event)}`)
      )
    );
  });

/** What one live turn is checked against. */
interface LiveTurnInput {
  readonly agentHomeDir: string;
  readonly markerPath: string;
  readonly provider: SessionProvider;
  readonly runId: string;
  readonly workspaceDir: string;
}

/** One real turn: streamed, ended on a terminus, and written down where we look. */
const checkLiveTurn = Effect.fnUntraced(function* (input: LiveTurnInput) {
  const events = yield* Effect.exit(streamTurn(input));
  yield* check({
    detail:
      events._tag === "Failure"
        ? `the turn failed: ${String(events.cause)}`
        : "",
    ok: events._tag === "Success",
    step: `${input.provider} streamed a turn to its terminus`,
  });
  if (events._tag !== "Success") {
    return;
  }

  const terminus = [...events.value].find((event) => event.kind === "result");
  yield* check({
    detail: "the stream ended without a result event",
    ok: terminus !== undefined,
    step: `${input.provider} ended on a terminus, not on silence`,
  });
  if (terminus?.kind === "result") {
    yield* Effect.logInfo(
      `      final: ${terminus.text.slice(0, FINAL_MESSAGE_CHARS)}`
    );
  }

  const sessionId =
    terminus?.kind === "result" ? terminus.providerSessionId : null;
  yield* check({
    detail: "the turn ended without naming a provider session",
    ok: sessionId !== null,
    step: `${input.provider} named the session its transcript is filed under`,
  });
  if (sessionId === null) {
    return;
  }

  // The whole tree is shared, so this is the claim that matters: the file found
  // is the one this turn wrote, picked by id and not by whichever run finished
  // last.
  const transcript = yield* readTranscript({
    agentHomeDir: input.agentHomeDir,
    provider: input.provider,
    providerSessionId: sessionId,
  });
  yield* check({
    detail: `the transcript at ${transcript.path} does not carry ${sessionId}`,
    ok: transcript.path.includes(sessionId),
    step: `${input.provider} found this turn's own transcript in the shared tree`,
  });
  yield* Effect.logInfo(
    `      transcript ${transcript.path} (${transcript.entries.length} entries)`
  );

  // The only unambiguous evidence that the hook forced a second turn: a refusal
  // is fed back to the model as a prompt, so it is in the transcript in our own
  // words. Counting assistant messages would not do — a model that calls a tool
  // speaks twice on its own.
  const forced = transcript.entries.some((entry) =>
    entry.text.includes(REFUSAL_ANCHOR)
  );
  yield* Effect.logInfo(
    `      ${
      forced
        ? "the stop hook refused an ending and the model was sent back for another turn"
        : "no refusal in the transcript: this provider registered no stop hook, or the run posted a comment"
    }`
  );
});

/**
 * Without a provider there is no file of ours to read, so what is checkable is
 * the address and the refusal.
 *
 * The refusal is the one that earns its place. Every run and every conversation
 * on this host writes into the one shared tree, so a reader that fell back to
 * the newest file by mtime would hand a run its neighbour's conversation —
 * silently, and onward into the durable per-run copy the ingest reads. An id
 * that matches nothing has to come back empty.
 */
const checkTranscriptAddress = Effect.fnUntraced(function* (input: {
  readonly agentHomeDir: string;
  readonly provider: SessionProvider;
}) {
  const searchDir = transcriptDirOf(input.agentHomeDir, input.provider);
  const found = yield* Effect.exit(
    findTranscript({
      agentHomeDir: input.agentHomeDir,
      provider: input.provider,
      providerSessionId: "00000000-0000-0000-0000-000000000000",
    })
  );
  yield* check({
    detail: `the reader would scan ${searchDir}, which is not under ${input.agentHomeDir}`,
    ok: searchDir.startsWith(input.agentHomeDir),
    step: `${input.provider} transcripts are looked for under the agent home`,
  });
  yield* check({
    detail:
      "a session id nothing was filed under produced a transcript anyway, which is another run's",
    ok: found._tag === "Failure",
    step: `${input.provider} refuses to hand back a transcript it cannot name`,
  });
});

/**
 * The system-owned agent home, checked and never touched.
 *
 * Two claims, and both fail by printing the login line. Ownership, because a
 * bind mount does no id translation: the container runs as the operator's uid
 * and writes straight through, so a directory owned by anyone else is a run
 * that cannot refresh its own token. And a credential, because the alternative
 * is a container that boots and reports an auth failure an operator cannot tell
 * from an expired subscription.
 */
const checkAgentHome = Effect.fnUntraced(function* (input: {
  readonly agentHomeDir: string;
  readonly provider: SessionProvider;
}) {
  const { agentHomeDir, provider } = input;
  const fix = `${agentHomeLoginHint(provider, agentHomeDir)}, or run \`bun run scripts/agent-home-login.ts ${provider}\``;
  const ours = ((): boolean => {
    try {
      const stat = statSync(agentHomeDir);
      return (
        stat.isDirectory() &&
        stat.uid === process.getuid?.() &&
        Number(stat.mode) % MODE_DIVISOR === AGENT_HOME_MODE
      );
    } catch {
      return false;
    }
  })();

  yield* check({
    detail: `${agentHomeDir} is not a directory owned by uid ${process.getuid?.() ?? "?"} at 0700 — ${fix}`,
    ok: ours,
    step: `${provider}'s agent home exists and is ours`,
  });
  yield* check({
    detail: `no ${CREDENTIAL_FILE[provider]} under ${agentHomeDir} — ${fix}`,
    ok: existsSync(join(agentHomeDir, CREDENTIAL_FILE[provider])),
    step: `${provider}'s agent home holds a credential`,
  });
  yield* Effect.logInfo(
    `      home ${agentHomeDir}, overridable with ${AGENT_HOME_DIR_ENV_VAR[provider]}`
  );
});

/** One provider: its system-owned home, and whatever a turn can be held to. */
const checkProvider = Effect.fnUntraced(function* (input: {
  readonly live: boolean;
  readonly markerPath: string;
  readonly provider: SessionProvider;
  readonly runId: string;
  readonly workspaceDir: string;
}) {
  const { live, provider } = input;
  const agentHomeDir = yield* agentHomeDirOf(provider);
  yield* checkAgentHome({ agentHomeDir, provider });

  if (live) {
    yield* checkLiveTurn({ ...input, agentHomeDir });
  } else {
    yield* checkTranscriptAddress({ agentHomeDir, provider });
  }
});

/**
 * The hook as a process, driven three times: the refusal, the retry cap, and the
 * run that has done what it was asked. Independent of any provider, so it holds
 * in check-only mode too.
 */
const checkStopHook = Effect.fnUntraced(function* (input: {
  readonly markerPath: string;
  readonly workspaceDir: string;
}) {
  const { markerPath, workspaceDir } = input;
  const refused = yield* askStopHook({
    markerPath,
    payload: stopPayload({ cwd: workspaceDir, retried: false }),
  });
  yield* check({
    detail: `the hook answered ${JSON.stringify(refused)}`,
    ok: refused.decision === "block" && (refused.reason?.length ?? 0) > 0,
    step: "the stop hook refuses a turn that has posted no comment",
  });

  const spent = yield* askStopHook({
    markerPath,
    payload: stopPayload({ cwd: workspaceDir, retried: true }),
  });
  yield* check({
    detail: `the hook answered ${JSON.stringify(spent)}`,
    ok: spent.decision === undefined,
    step: "the second refusal never comes: one retry, then the turn may end",
  });

  writeFileSync(markerPath, "");
  const allowed = yield* askStopHook({
    markerPath,
    payload: stopPayload({ cwd: workspaceDir, retried: false }),
  });
  yield* check({
    detail: `the hook answered ${JSON.stringify(allowed)}`,
    ok: allowed.decision === undefined,
    step: "a run that posted a comment ends when it wants to",
  });
  rmSync(markerPath, { force: true });
});

/** The table, printed and held to the lookup a session row expects of it. */
const checkSelection = Effect.fnUntraced(function* (
  registry: typeof ProviderRegistry.Service
) {
  yield* check({
    detail: `the registry lists ${registry.list.length} providers`,
    ok: registry.list.length > 0,
    step: "every provider in the domain's union has a harness",
  });

  for (const harness of registry.list) {
    const flags = harness.capabilities;
    yield* Effect.logInfo(
      `      ${harness.id.padEnd(PROVIDER_COLUMN)} ${harness.displayName}: cost=${flags.cost} hooks=${flags.hooks} resume=${flags.resume} rate-limit-signal=${flags.rateLimitSignal}`
    );
    yield* check({
      detail: `the registry answers ${registry.get(harness.id).id} for ${harness.id}`,
      ok: registry.get(harness.id).id === harness.id,
      step: `${harness.id} is selectable by the value a session row stores`,
    });
  }

  const named = onlyProvider();
  const checked = registry.list.filter(
    (harness) => named === null || harness.id === named
  );
  yield* check({
    detail: `--provider ${named} names no harness`,
    ok: checked.length > 0,
    step: "the providers to check are known",
  });
  return checked;
});

const harnessCheck = Effect.gen(function* () {
  const live = isLive();
  const dataRoot = yield* Config.string("DATA_ROOT").pipe(
    Config.withDefault(DEFAULT_DATA_ROOT)
  );
  const ledger = yield* EventLog;
  const registry = yield* ProviderRegistry;
  const runId = newRunId();
  const layout = hostRunLayout({ dataRoot, runId });
  const workspaceDir = join(layout.runDir, "workspace");
  const markerPath = commentMarkerPathOf(layout);

  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "README.md"),
    "# harness check\n\nOne file, so the agent has something true to name.\n"
  );

  yield* Effect.logInfo(`mode  ${live ? "live" : "check-only, no model call"}`);
  yield* Effect.logInfo(`run   ${runId}`);
  yield* Effect.logInfo(`dir   ${layout.runDir}`);
  yield* Effect.logInfo(`turn rows land in ${ledger.path}`);

  // The sandbox sets this in production; here the script is the sandbox. It has
  // to be on the process environment because the provider reads it as it builds
  // the settings for a turn.
  process.env[STOP_HOOK_COMMAND_ENV_VAR] = `bun ${STOP_HOOK_SCRIPT}`;

  const checked = yield* checkSelection(registry);

  for (const harness of checked) {
    yield* checkProvider({
      live,
      markerPath,
      provider: harness.id,
      runId,
      workspaceDir,
    });
  }

  yield* checkStopHook({ markerPath, workspaceDir });

  const rows = turnRows(ledger.path, runId);
  if (live) {
    yield* check({
      detail: `found ${rows.length} rows for ${checked.length} invocations`,
      ok: rows.length === checked.length,
      step: "every invocation left exactly one atm.turn row",
    });
    for (const row of rows) {
      yield* Effect.logInfo(
        `      ${row.provider} ${row.outcome} in ${row.durationMs}ms, ${row.eventsSeen} events, cost ${row.costUsd ?? "none reported"}`
      );
    }
  } else {
    yield* Effect.logInfo(
      "      no atm.turn row without --live: a row is what a turn leaves, and no turn ran"
    );
  }

  yield* Effect.logInfo(`atm.turn rows for this run: ${ledger.path}`);
  yield* Effect.logInfo(
    `run directory kept at ${layout.runDir}; no agent home was created, seeded or removed — the one on this host is the operator's and outlives every run`
  );
});

BunRuntime.runMain(
  harnessCheck.pipe(
    Effect.provide(
      Layer.mergeAll(
        telemetryLayer({ serviceName: SERVICE }),
        // A second handle on the same ledger file, so the script can print the
        // path it just wrote to. Both append; only the emitter writes rows.
        EventLog.layer({ serviceName: SERVICE }),
        providerRegistryLayer
        // The filesystem is provided to the layers above and kept in the
        // environment, because the check itself scans for a transcript.
      ).pipe(Layer.provideMerge(BunFileSystem.layer))
    )
  )
);
