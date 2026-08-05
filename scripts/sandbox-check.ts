#!/usr/bin/env bun

/**
 * Proves the seven things the orchestrator is allowed to assume about a
 * container: that what a run writes to the artifacts mount is on the host after
 * the container is gone, that the shared artifact folders reject its writes,
 * that the container cannot read the operator's home directory, that it *can*
 * read the login out of the agent home and that a token it refreshes there is
 * on the host afterwards, that the shared package store is writable from inside
 * and keeps what a run put in it, that a wide-event row written *inside* the
 * container reaches the host carrying the `runId` the host minted, and that the
 * container itself left exactly one `atm.sandbox` row.
 *
 * It is a script rather than a test because every one of those claims is about
 * a real daemon, a real bind mount and a real kernel. Checking them against a
 * fake would be checking the fake. The claims that are provable without a daemon
 * — the argv, the mount set, the classification, the row's shape on each exit
 * path — are unit tests in `packages/sandbox/src`.
 *
 * Two modes, and the difference is which image:
 *
 *   bun run sandbox:check           `alpine:3`, a few megabytes and seconds.
 *                                   Proves the plumbing, which is all five
 *                                   claims above plus the confinement flags, the
 *                                   correlation environment, the teardown, and
 *                                   that the host's OTLP credential does not
 *                                   cross. Everything here is about the sandbox,
 *                                   and none of it is about the image.
 *
 *   bun run sandbox:check --agent   the same script against the real base image
 *                                   (`atm.local/base:latest`, or `--image X`).
 *                                   Adds the one thing alpine cannot say: that
 *                                   the image `bun run images:build` produced
 *                                   exists on this host, starts under the
 *                                   confinement, and has the tools a run reaches
 *                                   for — bun, node, git, gh, ripgrep and both
 *                                   agent CLIs — on its PATH. Minutes if the
 *                                   image has to be built first; this script
 *                                   never builds one.
 *
 * The docker implementation is pinned deliberately: `SANDBOX_MODE` does not
 * affect this script, because a check meaning to prove that containers work must
 * not quietly pass on the host.
 *
 * One deviation from a dispatched run, and it is stated on the row: the
 * container runs as the operator's own uid rather than the image's 1000:1000. A
 * bind mount carries host ownership straight through, so on a host whose uid is
 * not 1000 — every mac — the run would boot and then be unable to write its own
 * mounts. Everything else in `defaultHardening` is untouched.
 *
 * The run directory is left behind so its ledger can be read afterwards.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunFileSystem, BunRuntime } from "@effect/platform-bun";
import {
  newAgentSessionId,
  newRunId,
  newTaskId,
  ProjectId,
  WorkspaceId,
} from "@workspace/domain";
import {
  CONTAINER_RUN_DIR,
  TURN_ENV_VARS,
  TURN_EVENT_MARKER,
} from "@workspace/harness";
import {
  CONTAINER_AGENT_HOME_DIR,
  CONTAINER_ARTIFACT_DIR,
  CONTAINER_CACHE_DIR,
  CONTAINER_WORKSPACE_DIR,
  DEFAULT_SANDBOX_IMAGE,
  defaultHardening,
  dockerSandboxLayer,
  eventLogDirOf,
  hostUser,
  mountsFor,
  type RunIdentity,
  SANDBOX_EVENT_MARKER,
  Sandbox,
  type SandboxSpec,
  Workspace,
  workspaceLayer,
} from "@workspace/sandbox";
import { EventLog, telemetryLayer } from "@workspace/telemetry";
import { Config, Effect, Layer, Schema } from "effect";

/** Names the ledger file and the OTLP resource, as every service does. */
const SERVICE = "sandbox-check";

/** Where on-disk state lives when `DATA_ROOT` is unset, as the telemetry ledger has it. */
const DEFAULT_DATA_ROOT = ".data";

/**
 * The cheap image. Public, tiny, and on every host that has ever pulled
 * anything — the point of this mode is that the whole check runs in seconds, so
 * it is the one an operator actually runs after touching a mount or a flag.
 */
const CHEAP_IMAGE = "alpine:3";

/** Wall-clock cap. Generous for alpine, tight enough that a hung daemon is not a hung terminal. */
const TIMEOUT_MS = 180_000;

/** The exit code the container's script ends on, so a code that survives is visibly *this* code. */
const CONTAINER_EXIT_CODE = 9;

/**
 * The file the ledger inside the container is written to. The name a harness
 * would use is its service name; nothing here needs it to match, because what is
 * being checked is that the *directory* is a mount and the ids in the row are
 * the host's.
 */
const CONTAINER_LEDGER_FILE = "harness.jsonl";

/** What the container writes into the task's artifacts folder. */
const ARTIFACT_FILE = "written-by-the-run.txt";

/**
 * What the container writes into the shared package store. Removed by this
 * script afterwards: the store is the one mount a check shares with every real
 * run on the host, so it leaves nothing in it.
 */
const CACHE_PROBE_FILE = "written-by-the-check.txt";

/**
 * The credential-shaped file the throwaway agent home is seeded with, named as
 * Claude names its own so the path under test is the real one.
 */
const CREDENTIAL_FILE = ".credentials.json";

/**
 * What the container writes back into the agent home, standing in for the token
 * both vendors refresh in place. Its arrival on the host is the whole claim: a
 * refresh that lands in a throwaway copy is discarded with the container, and
 * this is the evidence that it no longer is.
 */
const REFRESHED_FILE = "refreshed-inside.json";

/**
 * Which provider's home the materializer is told about. Only names the login
 * line a missing home is reported with; nothing else in this check reads it.
 */
const CHECK_PROVIDER = "claude" as const;

/**
 * What the container tries, and must fail, to write into each shared artifacts
 * folder. Named so a file by this name appearing on the host is unambiguous
 * evidence rather than something an operator has to reason about.
 */
const RO_PROBE_FILE = "must-not-be-writable.txt";

/**
 * The project whose promoted folder this check mounts read-only. Fixed rather
 * than minted, for the same reason the workspace id is: a fresh id every run
 * would leave one empty folder per invocation in the artifacts tree, and the
 * check never writes there — that is the claim. A literal, so it is trusted
 * construction and not a decode.
 */
const CHECK_PROJECT_ID = ProjectId.make("019fbfd0-0000-7000-8000-000000000001");

/** The tools the real image promises. Checked only in `--agent` mode. */
const AGENT_IMAGE_TOOLS = [
  "bun",
  "node",
  "git",
  "gh",
  "rg",
  "claude",
  "codex",
] as const;

/** One thing the sandbox was supposed to do and did not. */
class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()(
  "SandboxCheck.Failed",
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

/** Whether the operator asked for the real image. */
const isAgentMode = () =>
  process.argv.includes("--agent") || process.env.SANDBOX_CHECK_AGENT === "1";

/** An explicitly named image, which overrides both modes. */
const namedImage = () => {
  const at = process.argv.indexOf("--image");
  if (at === -1) {
    return null;
  }
  const named = process.argv[at + 1];
  return named === undefined || named.startsWith("--") ? null : named;
};

/**
 * The one thing in the operator's home directory this check knows the contents
 * of. Written so the "cannot read the host home" claim is a real read that
 * failed rather than a path that happened not to exist.
 */
interface Sentinel {
  readonly path: string;
  readonly secret: string;
}

/**
 * A throwaway agent home with a credential-shaped file in it, at the mode a
 * real one has. Created here rather than pointed at the operator's, for the
 * reason in the module note.
 */
const makeAgentHome = (root: string) => {
  const dir = join(root, "agent-home");
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const secret = randomUUID();
  writeFileSync(join(dir, CREDENTIAL_FILE), JSON.stringify({ token: secret }), {
    mode: 0o600,
  });
  return { dir, secret };
};

const makeSentinel = (): Sentinel => {
  const secret = randomUUID();
  const path = join(homedir(), ".atm-sandbox-check-sentinel");
  writeFileSync(path, secret, { mode: 0o600 });
  return { path, secret };
};

/**
 * What the container runs. POSIX `sh`, so the same script runs under alpine's
 * busybox and the base image's Debian shell.
 *
 * Every line is one of the claims. The ids come out of the environment rather
 * than being baked in, which is the whole point: the row the container writes
 * has to carry the id the *host* minted, and a hard-coded one would prove
 * nothing.
 */
const containerScript = (sentinel: Sentinel) =>
  [
    "set -u",
    // Claim 1: a write to the task's artifacts mount.
    `printf 'written inside %s\\n' "$${TURN_ENV_VARS.runId}" > ${CONTAINER_ARTIFACT_DIR.task}/${ARTIFACT_FILE}`,
    // Claim 2: the promoted folders reject the same write. The redirect runs in
    // a subshell with its stderr closed, because a failed redirection is
    // reported by the shell rather than by the command, and the point here is
    // the exit status, not the message.
    `printf 'projectwrite:[%s]\\n' "$( (printf x > ${CONTAINER_ARTIFACT_DIR.project}/${RO_PROBE_FILE}) 2>/dev/null && echo yes || echo no )"`,
    `printf 'globalwrite:[%s]\\n' "$( (printf x > ${CONTAINER_ARTIFACT_DIR.global}/${RO_PROBE_FILE}) 2>/dev/null && echo yes || echo no )"`,
    // Claim 3: the operator's home is not reachable. Both halves are printed —
    // the host path, and whatever the container thinks HOME is.
    `printf 'sentinel:[%s]\\n' "$(cat '${sentinel.path}' 2>/dev/null || true)"`,
    `printf 'home:[%s]\\n' "$(ls '${homedir()}' 2>/dev/null | head -1 || true)"`,
    // Claim 4: the agent home is mounted, the login inside it is readable, and
    // a refresh written there is a write the host keeps.
    `printf 'credential:[%s]\\n' "$(cat ${CONTAINER_AGENT_HOME_DIR}/${CREDENTIAL_FILE} 2>/dev/null || true)"`,
    `printf 'refresh:[%s]\\n' "$( (printf '{"refreshed":"%s"}' "$${TURN_ENV_VARS.runId}" > ${CONTAINER_AGENT_HOME_DIR}/${REFRESHED_FILE}) 2>/dev/null && echo yes || echo no )"`,
    // Claim 4: an atm.turn-shaped row, written where EVENT_LOG_DIR points,
    // carrying the ids the sandbox passed in.
    `printf '{"event":"%s","runId":"%s","taskId":"%s","workspaceId":"%s","provider":"claude","phase":"end","outcome":"done","source":"container"}\\n' \\
      '${TURN_EVENT_MARKER}' "$${TURN_ENV_VARS.runId}" "$${TURN_ENV_VARS.taskId}" "$${TURN_ENV_VARS.workspaceId}" \\
      >> "$EVENT_LOG_DIR/${CONTAINER_LEDGER_FILE}"`,
    // The host's export credential must not have crossed the boundary.
    // `printenv` rather than an expansion, so an unset variable prints nothing
    // instead of aborting the script under `set -u`.
    `printf 'otlp:[%s]\\n' "$(printenv OTEL_EXPORTER_OTLP_HEADERS || true)"`,
    // Where the container thinks it is, and who it is.
    'printf \'workdir:[%s] uid:[%s]\\n\' "$(pwd)" "$(id -u)"',
    // Claim 6: the shared package store is mounted and writable, which is what
    // makes an install in a later run start warm.
    `printf 'cachewrite:[%s]\\n' "$( (printf '%s' "$${TURN_ENV_VARS.runId}" > ${CONTAINER_CACHE_DIR}/${CACHE_PROBE_FILE}) 2>/dev/null && echo yes || echo no )"`,
    // Proof the run mount is the layout the harness computes.
    `printf 'runmount:[%s]\\n' "$(test -d ${CONTAINER_RUN_DIR} && echo yes || echo no)"`,
    `exit ${CONTAINER_EXIT_CODE}`,
  ].join("\n");

/** The extra lines the real image is asked for, one per tool it promises. */
const toolScript = () =>
  AGENT_IMAGE_TOOLS.map(
    (tool) =>
      `printf 'tool:%s:[%s]\\n' '${tool}' "$(command -v ${tool} >/dev/null 2>&1 && echo yes || echo no)"`
  ).join("\n");

/**
 * One `key:[value]` line the container printed, or null where it printed none.
 *
 * The brackets are what make an empty answer readable: `sentinel:[]` is the
 * container having tried to read the host's home and got nothing, which is the
 * claim, while a bare `sentinel:` and a line that never arrived would look
 * identical.
 */
const readField = (output: string, key: string) => {
  const prefix = `${key}:[`;
  const line = output
    .split("\n")
    .find(
      (candidate) => candidate.startsWith(prefix) && candidate.endsWith("]")
    );
  return line === undefined ? null : line.slice(prefix.length, -1);
};

/** Every row in one JSONL ledger carrying one marker. */
const rowsIn = (path: string, marker: string) => {
  const raw = ((): string => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return "";
    }
  })();
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.event === marker);
};

/** The spec one check runs, over the directories the workspace materializer made. */
const specFor = (input: {
  readonly identity: RunIdentity;
  readonly image: string;
  readonly mounts: SandboxSpec["mounts"];
  readonly script: string;
}): SandboxSpec => ({
  args: ["-c", input.script],
  command: "sh",
  // Passed precisely so it can be checked absent inside: the container writes
  // its rows to a file on a mount, and the loop forwards them. An export token
  // belongs to the operator.
  env: {
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer must-not-cross",
  },
  hardening: { ...defaultHardening, user: hostUser() },
  identity: input.identity,
  image: input.image,
  mounts: input.mounts,
  timeoutMs: TIMEOUT_MS,
  workingDir: CONTAINER_WORKSPACE_DIR,
});

const sandboxCheck = Effect.gen(function* () {
  const agent = isAgentMode();
  const image = namedImage() ?? (agent ? DEFAULT_SANDBOX_IMAGE : CHEAP_IMAGE);
  const dataRoot = yield* Config.string("DATA_ROOT").pipe(
    Config.withDefault(DEFAULT_DATA_ROOT)
  );
  const ledger = yield* EventLog;
  const sandbox = yield* Sandbox;
  const workspace = yield* Workspace;

  // Named, because materialization is told which task's artifacts folder to
  // work against separately from the identity the container is started with.
  const taskId = newTaskId();
  const identity: RunIdentity = {
    runId: newRunId(),
    sessionId: newAgentSessionId(),
    taskId,
    traceparent: null,
    workspaceId: WorkspaceId.make("sandbox-check"),
  };

  yield* Effect.logInfo(
    `mode  ${agent ? "agent image" : "cheap, alpine"} — ${image}`
  );
  yield* Effect.logInfo(`run   ${identity.runId}`);
  yield* Effect.logInfo(`sandbox rows land in ${ledger.path}`);
  // Says out loud why the row will read `hardeningProfile=custom`: the user is
  // the one flag this script moves, and a reader should not have to guess which.
  yield* Effect.logInfo(
    `user  ${hostUser()} — the operator's own, not the image's ${defaultHardening.user}, because a bind mount carries host ownership through`
  );
  yield* check({
    detail:
      "every other claim here would still pass as root, and none of them would mean anything",
    ok: !hostUser().startsWith("0:"),
    step: "the check is not being run as root",
  });

  const sentinel = makeSentinel();
  const checkRoot = mkdtempSync(join(tmpdir(), "atm-sandbox-check-"));
  const agentHome = makeAgentHome(checkRoot);
  const script = agent
    ? `${containerScript(sentinel)
        .split("\n")
        .slice(0, -1)
        .join("\n")}\n${toolScript()}\nexit ${CONTAINER_EXIT_CODE}`
    : containerScript(sentinel);

  const before = rowsIn(ledger.path, SANDBOX_EVENT_MARKER).length;

  // Everything the run needs on disk, made by the same materializer a dispatch
  // uses. `repo: null` is the scratch case — a task with no repository — which
  // is what keeps this check independent of git, a mirror and a network.
  const {
    cacheDir,
    globalArtifactsDir,
    output,
    projectArtifactsDir,
    result,
    runDir,
    taskArtifactsDir,
  } = yield* Effect.scoped(
    Effect.gen(function* () {
      const made = yield* workspace.materialize({
        agentHomeDir: agentHome.dir,
        dataRoot,
        identity,
        // A project, so the conditional fifth mount is present and the
        // read-only claim has both promoted folders to be made against.
        projectId: CHECK_PROJECT_ID,
        provider: CHECK_PROVIDER,
        repo: null,
        taskId,
      });
      yield* Effect.logInfo(`dir   ${made.runDir}`);

      const lines: string[] = [];
      const ran = yield* sandbox.run({
        onOutput: (chunk) =>
          Effect.sync(() => {
            lines.push(chunk.text);
          }),
        spec: specFor({
          identity,
          image,
          mounts: mountsFor(made),
          script,
        }),
      });
      return {
        cacheDir: made.cacheDir,
        globalArtifactsDir: made.globalArtifactsDir,
        output: lines.join(""),
        projectArtifactsDir: made.projectArtifactsDir,
        result: ran,
        runDir: made.runDir,
        taskArtifactsDir: made.taskArtifactsDir,
      };
    })
  );

  rmSync(sentinel.path, { force: true });

  yield* check({
    detail: `expected ${CONTAINER_EXIT_CODE}, found ${result.exitCode}`,
    ok: result.exitCode === CONTAINER_EXIT_CODE,
    step: "the container's own exit code survives the daemon and the teardown",
  });
  yield* check({
    detail: `the container was reported ${result.teardown}`,
    ok: result.teardown === "removed",
    step: "the container is gone: teardown reported removed",
  });

  // Claim 1 — the artifacts mount round-trips, read after the container is gone.
  const artifact = ((): string | null => {
    try {
      return readFileSync(join(taskArtifactsDir, ARTIFACT_FILE), "utf-8");
    } catch {
      return null;
    }
  })();
  yield* check({
    detail: `nothing at ${join(taskArtifactsDir, ARTIFACT_FILE)}`,
    ok: artifact?.includes(identity.runId) === true,
    step: "a file the container wrote to the artifacts mount is on the host after teardown",
  });

  // Claim 2 — the promoted folders are read-only. Asked twice, because the two
  // answers fail differently: the container reporting a refused write is the
  // kernel's verdict, and the absent file on the host is the one that would
  // still catch a write that landed somewhere other than the mount.
  for (const probe of [
    { dir: projectArtifactsDir, key: "projectwrite", scope: "project" },
    { dir: globalArtifactsDir, key: "globalwrite", scope: "global" },
  ] as const) {
    yield* check({
      detail: `the container reported [${readField(output, probe.key)}] writing ${RO_PROBE_FILE}`,
      ok: readField(output, probe.key) === "no",
      step: `the ${probe.scope} artifacts mount refuses a write from inside`,
    });
    yield* check({
      detail: `a file the container was refused exists at ${probe.dir === null ? "an unmounted folder" : join(probe.dir, RO_PROBE_FILE)}`,
      ok: probe.dir !== null && !existsSync(join(probe.dir, RO_PROBE_FILE)),
      step: `nothing reached the ${probe.scope} artifacts folder on the host`,
    });
  }

  // Claim 6 — the shared package store round-trips, and the file is removed
  // again: every other run on this host mounts the same directory.
  const cacheProbePath = join(cacheDir, CACHE_PROBE_FILE);
  const cached = ((): string | null => {
    try {
      return readFileSync(cacheProbePath, "utf-8");
    } catch {
      return null;
    }
  })();
  rmSync(cacheProbePath, { force: true });
  yield* check({
    detail: `the container reported [${readField(output, "cachewrite")}] writing ${CONTAINER_CACHE_DIR}/${CACHE_PROBE_FILE}, and the host has ${cached === null ? "nothing" : cached} at ${cacheProbePath}`,
    ok: readField(output, "cachewrite") === "yes" && cached === identity.runId,
    step: "the shared package store is writable from inside and lands on the host",
  });

  // Claim 3b — the agent home is the one thing the container is *supposed* to
  // read a credential out of, and the one place its refresh has to survive.
  yield* check({
    detail: `the container read [${readField(output, "credential")}] at ${CONTAINER_AGENT_HOME_DIR}/${CREDENTIAL_FILE}`,
    ok: readField(output, "credential")?.includes(agentHome.secret) === true,
    step: "a container reads the login out of the mounted agent home",
  });
  const refreshed = ((): string | null => {
    try {
      return readFileSync(join(agentHome.dir, REFRESHED_FILE), "utf-8");
    } catch {
      return null;
    }
  })();
  yield* check({
    detail: `the container reported [${readField(output, "refresh")}] writing ${REFRESHED_FILE}, and the host has ${refreshed === null ? "nothing" : refreshed}`,
    ok:
      readField(output, "refresh") === "yes" &&
      refreshed?.includes(identity.runId) === true,
    step: "a token the container refreshed in the agent home is on the host after teardown",
  });
  // The ownership answer, measured rather than asserted: the bind mount does no
  // id translation, so a file the container created is owned by the uid the
  // container was started with, which is the operator's.
  yield* check({
    detail: `the refreshed file is owned by uid ${statSync(join(agentHome.dir, REFRESHED_FILE)).uid}, the operator is ${process.getuid?.()}`,
    ok:
      statSync(join(agentHome.dir, REFRESHED_FILE)).uid === process.getuid?.(),
    step: "that write landed as the operator, so the home stays theirs to read",
  });
  rmSync(checkRoot, { force: true, recursive: true });

  // Claim 3 — the operator's home is not reachable from inside.
  yield* check({
    detail: `the container read [${readField(output, "sentinel")}] from ${sentinel.path}`,
    ok: readField(output, "sentinel") === "",
    step: "the container cannot read a file in the host home directory",
  });
  yield* check({
    detail: `the container listed [${readField(output, "home")}] at ${homedir()}`,
    ok: readField(output, "home") === "",
    step: "the host home directory does not exist inside the container",
  });
  yield* check({
    detail: `the container found [${readField(output, "otlp")}] in its environment`,
    ok: readField(output, "otlp") === "",
    step: "the host's OTLP credential does not cross into the container",
  });
  yield* check({
    detail: `the run mount at ${CONTAINER_RUN_DIR} reported ${readField(output, "runmount")}`,
    ok: readField(output, "runmount") === "yes",
    step: "the run directory is mounted where the harness computes its layout",
  });

  // Claim 4 — a row written inside the container, on the host, joined by runId.
  const turnRows = rowsIn(
    join(eventLogDirOf(runDir), CONTAINER_LEDGER_FILE),
    TURN_EVENT_MARKER
  );
  yield* check({
    detail: `found ${turnRows.length} rows under ${eventLogDirOf(runDir)}`,
    ok: turnRows.length === 1,
    step: "the row the container wrote to the event mount is on the host",
  });
  yield* check({
    detail: `the row carries runId ${String(turnRows[0]?.runId)}, the host minted ${identity.runId}`,
    ok:
      turnRows[0]?.runId === identity.runId &&
      turnRows[0]?.taskId === identity.taskId &&
      turnRows[0]?.workspaceId === identity.workspaceId,
    step: "that row carries the host's runId, taskId and workspaceId",
  });

  // Claim 5 — the container's own row.
  const sandboxRows = rowsIn(ledger.path, SANDBOX_EVENT_MARKER).filter(
    (candidate) => candidate.runId === identity.runId
  );
  yield* check({
    detail: `found ${sandboxRows.length} rows for this run (${before} in the ledger before it)`,
    ok: sandboxRows.length === 1,
    step: "the container left exactly one atm.sandbox row",
  });
  const [row] = sandboxRows;
  yield* check({
    detail: `outcome ${String(row?.outcome)}, kind ${String(row?.kind)}, runAsRoot ${String(row?.runAsRoot)}`,
    ok:
      row?.outcome === "done" &&
      row.kind === "docker" &&
      row.runAsRoot === false &&
      row.exitCode === CONTAINER_EXIT_CODE,
    step: "that row says a container ran, as a non-root user, and exited as it did",
  });
  yield* Effect.logInfo(
    `      image ${String(row?.image)}, ${String(row?.mountCount)} mounts, ${String(row?.containerMs)}ms in the container, peak ${String(row?.peakMemoryBytes ?? "not sampled")}`
  );

  if (agent) {
    const missing = AGENT_IMAGE_TOOLS.filter(
      (tool) => readField(output, `tool:${tool}`) !== "yes"
    );
    yield* check({
      detail: `absent from the image: ${missing.join(", ")}`,
      ok: missing.length === 0,
      step: "the agent image carries every tool a run reaches for",
    });
  } else {
    yield* Effect.logInfo(
      "      no image claims without --agent: alpine proves the sandbox, not the image"
    );
  }

  yield* Effect.logInfo(`atm.sandbox rows for this run: ${ledger.path}`);
  yield* Effect.logInfo(
    `run directory kept at ${runDir}; the checkout inside it was removed with the scope, and the throwaway agent home with it`
  );
});

/**
 * The emitter the sandbox writes its row through, and the console and OTLP
 * sinks beside it. Built once and handed down, so the row the container's own
 * run produces lands in the same ledger file this script then reads.
 */
const telemetry = telemetryLayer({ serviceName: SERVICE });

BunRuntime.runMain(
  sandboxCheck.pipe(
    Effect.provide(
      Layer.mergeAll(
        telemetry,
        // A second handle on the same ledger file, so the script can read back
        // the rows it just wrote. Both append; only the emitter writes rows.
        EventLog.layer({ serviceName: SERVICE }),
        // Docker, named rather than selected: `SANDBOX_MODE` must not be able
        // to make a check about containers pass without one.
        dockerSandboxLayer.pipe(Layer.provide(telemetry)),
        workspaceLayer
      ).pipe(Layer.provideMerge(BunFileSystem.layer))
    )
  )
);
