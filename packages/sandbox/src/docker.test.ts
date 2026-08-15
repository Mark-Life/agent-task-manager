/**
 * One real container, against `alpine:3` — seconds, not the minutes an agent
 * image build costs, and it is the only claim in this package that cannot be
 * made without a daemon: that a file the container writes to a mount is on the
 * host after teardown, that the exit code survives, that the correlation
 * environment the harness reads is actually inside, and that the run leaves one
 * `atm.sandbox` row in the ledger.
 *
 * Skipped, with a reason, when the daemon is unreachable. A test that fails
 * because docker is not running teaches everyone to ignore a red suite.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  newAgentSessionId,
  newRunId,
  newTaskId,
  WorkspaceId,
} from "@workspace/domain";
import { Telemetry } from "@workspace/telemetry";
import { ConfigProvider, Effect, Layer, Ref, Schema } from "effect";
import { dockerSandboxLayer } from "./docker";
import { defaultHardening } from "./hardening";
import {
  CONTAINER_EVENT_LOG_DIR,
  eventLogDirOf,
  mountsFor,
  nestedMountPointsOf,
  type RunLabels,
  runTreeOf,
} from "./mounts";
import { SANDBOX_EVENT_MARKER, SandboxEvent } from "./sandbox-event";
import { Sandbox, type SandboxSpec } from "./spec";

/** The names this smoke test's container paths are spelled with. */
const LABELS: RunLabels = {
  project: null,
  repo: "mark-life/atlas",
  task: "Smoke",
};

/** Where the container works, and where its scopes are, container-side. */
const TREE = runTreeOf(LABELS);

const IMAGE = "alpine:3";
const SMOKE_TIMEOUT_MS = 120_000;
const CONTAINER_EXIT_CODE = 7;
const SERVICE = "sandbox-smoke";

/** One docker command, run to completion, for the checks around the run itself. */
const docker = (args: readonly string[]) =>
  spawnSync("docker", [...args], { encoding: "utf8" });

/** Whether a daemon answered at all. Cheap, synchronous, once per file. */
const daemonReachable = () =>
  docker(["version", "--format", "{{.Server.Version}}"]).status === 0;

const reachable = daemonReachable();
if (!reachable) {
  console.warn(
    "docker daemon unreachable — skipping the sandbox container smoke test"
  );
}

/** The host directories one run gets, made for the test and removed after it. */
interface Fixture {
  readonly agentHomeDir: string;
  readonly artifactsDir: string;
  /** The shared package store, which every run on a host mounts. */
  readonly cacheDir: string;
  readonly globalDir: string;
  /** The host's own ledger, which is not a mount and not the container's. */
  readonly ledgerDir: string;
  readonly root: string;
  readonly runDir: string;
  readonly workspaceDir: string;
}

let fixture: Fixture;

/** The run's mount set, built from the fixture's directories. */
const mountsForFixture = (input: Fixture) =>
  mountsFor({
    agentHomeDir: input.agentHomeDir,
    cacheDir: input.cacheDir,
    composedSkillsDir: null,
    globalArtifactsDir: input.globalDir,
    labels: LABELS,
    projectArtifactsDir: null,
    runDir: input.runDir,
    taskArtifactsDir: input.artifactsDir,
    workspaceDir: input.workspaceDir,
  });

const makeDirs = async (root: string) => {
  const dirs = {
    agentHomeDir: join(root, "agent-home"),
    artifactsDir: join(root, "task-artifacts"),
    cacheDir: join(root, "caches"),
    globalDir: join(root, "global-artifacts"),
    ledgerDir: join(root, "host-events"),
    root,
    runDir: join(root, "run"),
    workspaceDir: join(root, "workspace"),
  } satisfies Fixture;
  await Promise.all(
    [
      dirs.agentHomeDir,
      dirs.artifactsDir,
      dirs.cacheDir,
      dirs.globalDir,
      dirs.ledgerDir,
      eventLogDirOf(dirs.runDir),
      dirs.workspaceDir,
    ].map((path) => mkdir(path, { recursive: true }))
  );
  // The scopes nest, so each bind's destination has to exist inside its
  // parent's host directory before the daemon is asked — and the workspace
  // scope is read-only, so the daemon cannot make them itself. `materialize`
  // does this on a real run; a fixture with no materializer does it here.
  await Promise.all(
    nestedMountPointsOf(mountsForFixture(dirs)).map((point) =>
      mkdir(point.path, { recursive: true })
    )
  );
  return dirs;
};

beforeAll(async () => {
  fixture = await makeDirs(await mkdtemp(join(tmpdir(), "atm-sandbox-")));
});

afterAll(async () => {
  if (fixture !== undefined) {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

const identity = {
  runId: newRunId(),
  sessionId: newAgentSessionId(),
  taskId: newTaskId(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  workspaceId: WorkspaceId.make("ws-smoke"),
};

/**
 * The container prints the ids it was handed, writes a file into the task
 * artifacts mount, and exits non-zero. Between them those are the three
 * questions: does the correlation environment arrive, does a write land on the
 * host, and is the exit code reported rather than raised.
 *
 * It also outlives a memory sample, which is the part that is not decoration. A
 * container that exits inside a second never gives the sampler anything to
 * interrupt, and a teardown that only works because nothing was running is a
 * teardown that passes here and leaks every real run.
 */
const script = [
  'echo "run=$ATM_RUN_ID"',
  'echo "ledger=$EVENT_LOG_DIR"',
  'echo "trace=$TRACEPARENT"',
  `echo hello > ${TREE.taskScope}/written.txt`,
  "echo to-stderr 1>&2",
  "sleep 8",
  `exit ${CONTAINER_EXIT_CODE}`,
].join("\n");

/**
 * The sandbox over a real ledger, written into the fixture's own directory. The
 * `atm.sandbox` row is the deliverable of this module as much as the exit code
 * is, so the test provides the emitter rather than stubbing it out.
 */
const sandboxLayer = (ledgerDir: string) =>
  dockerSandboxLayer.pipe(
    Layer.provide(Telemetry.layer({ serviceName: SERVICE })),
    Layer.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ EVENT_LOG_DIR: ledgerDir })
        )
      )
    )
  );

const decodeRow = Schema.decodeUnknownSync(SandboxEvent.rowSchema);

/** One ledger line, or null where the line is not JSON at all. */
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Whether a parsed line is a sandbox row, read off the parsed `event` field
 * rather than the line's text: the marker also occurs inside field values, and
 * matching one of those would hand a foreign row to the decoder.
 */
const isSandboxRow = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "event" in value &&
  value.event === SANDBOX_EVENT_MARKER;

/**
 * Every `atm.sandbox` row the ledger holds, decoded through the schema its
 * readers use — the one half of a row that can drift is what the emitter
 * spells by hand, `ts` and the `event` tag and the environment stamp.
 */
const ledgerRows = async (ledgerDir: string) => {
  const raw = await readFile(join(ledgerDir, `${SERVICE}.jsonl`), "utf8");
  return raw
    .split("\n")
    .map(jsonOf)
    .filter(isSandboxRow)
    .map((row) => decodeRow(row));
};

const specFor = (input: Fixture): SandboxSpec => ({
  args: ["-c", script],
  command: "sh",
  env: { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer sk-must-not-cross" },
  hardening: defaultHardening,
  identity,
  image: IMAGE,
  mounts: mountsForFixture(input),
  timeoutMs: SMOKE_TIMEOUT_MS,
  workingDir: TREE.cwd,
});

describe.skipIf(!reachable)("dockerSandbox", () => {
  test(
    "runs a container, reports its exit code, and leaves its writes on the host",
    async () => {
      const program = Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        const chunks = yield* Ref.make<string[]>([]);
        const named = yield* Ref.make<string[]>([]);
        const result = yield* sandbox.run({
          onContainer: ({ name }) =>
            Ref.update(named, (seen) => [...seen, name]),
          onOutput: (chunk) =>
            Ref.update(chunks, (seen) => [
              ...seen,
              `${chunk.stream}:${chunk.text}`,
            ]),
          spec: specFor(fixture),
        });
        return {
          named: yield* Ref.get(named),
          output: (yield* Ref.get(chunks)).join(""),
          result,
        };
      }).pipe(Effect.provide(sandboxLayer(fixture.ledgerDir)));

      const { named, output, result } = await Effect.runPromise(program);

      // The handle reaches the caller once, and it names this run — which is
      // what makes it recordable before the container has an id of its own.
      expect(named).toHaveLength(1);
      expect(named[0]).toStartWith(`atm-${identity.runId}-`);
      expect(result.exitCode).toBe(CONTAINER_EXIT_CODE);
      expect(result.kind).toBe("docker");
      expect(result.oomKilled).toBe(false);
      expect(result.teardown).toBe("removed");
      expect(result.containerId).not.toBeNull();
      expect(result.mountCount).toBe(6);
      expect(result.wallClockMs).toBeGreaterThan(0);
      expect(result.peakMemoryBytes).not.toBeNull();

      // The correlation environment the harness reads back, inside.
      expect(output).toContain(`run=${identity.runId}`);
      expect(output).toContain(`ledger=${CONTAINER_EVENT_LOG_DIR}`);
      expect(output).toContain(`trace=${identity.traceparent}`);
      expect(output).toContain("to-stderr");

      // The write, on the host, after the container is gone.
      const written = await readFile(
        join(fixture.artifactsDir, "written.txt"),
        "utf8"
      );
      expect(written.trim()).toBe("hello");

      // The container itself, gone — asked by label rather than by the id the
      // result reported, so a run that leaked a container it never named is
      // caught too.
      const remaining = docker([
        "ps",
        "--all",
        `--filter=label=atm.run=${identity.runId}`,
        "--format={{.Names}}",
      ]);
      expect(remaining.stdout.trim()).toBe("");

      // Exactly one row, carrying the run it describes and what the container did.
      const rows = await ledgerRows(fixture.ledgerDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        containerId: result.containerId,
        exitCode: CONTAINER_EXIT_CODE,
        kind: "docker",
        oomKilled: false,
        outcome: "done",
        runAsRoot: false,
        runId: identity.runId,
        taskId: identity.taskId,
        teardown: "removed",
      });
    },
    SMOKE_TIMEOUT_MS
  );

  test(
    "refuses to start when a mount source is not on the host",
    async () => {
      const spec = specFor({ ...fixture, artifactsDir: "/no/such/directory" });
      const failure = await Effect.runPromise(
        Effect.flip(
          Sandbox.pipe(
            Effect.flatMap((sandbox) =>
              sandbox.run({
                onContainer: () => Effect.void,
                onOutput: () => Effect.void,
                spec,
              })
            ),
            Effect.provide(sandboxLayer(fixture.ledgerDir))
          )
        )
      );
      expect(failure._tag).toBe("Sandbox.MountSourceMissing");
    },
    SMOKE_TIMEOUT_MS
  );
});
