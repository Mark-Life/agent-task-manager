/**
 * The local mode is a second implementation, not a fake, so the tests run real
 * processes: the claims worth pinning are that the same spec produces the same
 * result shape, that a container path in the spec reaches the child as the host
 * path the mount pointed at, and that the two things this mode cannot do — a
 * read-only bind and a memory cap — are named rather than pretended.
 *
 * No daemon and no image are involved, so these always run.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import {
  newAgentSessionId,
  newRunId,
  newTaskId,
  WorkspaceId,
} from "@workspace/domain";
import { TURN_ENV_VARS } from "@workspace/harness";
import { Telemetry } from "@workspace/telemetry";
import { ConfigProvider, Effect, Layer, Result, Schema } from "effect";
import {
  CONTAINER_LOG_ENV,
  EVENT_LOG_DIR_ENV_VAR,
  EXPORT_ENV_PREFIX,
} from "./docker-argv";
import { defaultHardening } from "./hardening";
import {
  hostPathOf,
  localEnv,
  localSandboxLayer,
  localWorkingDir,
  unhonouredBy,
} from "./local";
import {
  CONTAINER_EVENT_LOG_DIR,
  CONTAINER_WORKSPACE_DIR,
  type Mount,
  type MountSources,
  mountsFor,
  type RunLabels,
  runTreeOf,
} from "./mounts";
import { SANDBOX_EVENT_MARKER, SandboxEvent } from "./sandbox-event";
import {
  type OutputChunk,
  Sandbox,
  type SandboxSpec,
  TRACEPARENT_ENV_VAR,
} from "./spec";

const identity = {
  runId: newRunId(),
  sessionId: newAgentSessionId(),
  taskId: newTaskId(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  workspaceId: WorkspaceId.make("org_1"),
};

/** Names the ledger file this file's rows land in. */
const SERVICE = "local-sandbox-test";

/** Where the `atm.sandbox` rows this file produces are written. */
const LEDGER_DIR = mkdtempSync(join(tmpdir(), "sandbox-local-ledger-"));

/**
 * The local sandbox over a real ledger. The row is as much this module's
 * deliverable as the exit code is — a run served without isolation is the one
 * anybody will later go looking for — so the emitter is provided rather than
 * stubbed out.
 */
const testLayer = localSandboxLayer.pipe(
  Layer.provide(Telemetry.layer({ serviceName: SERVICE })),
  Layer.provide(
    Layer.mergeAll(
      BunFileSystem.layer,
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ EVENT_LOG_DIR: LEDGER_DIR })
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
 * Every `atm.sandbox` row in the ledger, for the run this file uses, decoded
 * through the schema its readers use. The half of a row that can genuinely
 * drift is the part the emitter spells by hand — `ts`, the `event` tag, the
 * environment stamp — and that is what the decode holds.
 */
const ledgerRows = () => {
  const raw = ((): string => {
    try {
      return readFileSync(join(LEDGER_DIR, `${SERVICE}.jsonl`), "utf8");
    } catch {
      return "";
    }
  })();
  return raw
    .split("\n")
    .map(jsonOf)
    .filter(isSandboxRow)
    .map((row) => decodeRow(row));
};

/** The names this file's runs spell their container paths with. */
const labels: RunLabels = {
  project: "Atlas",
  repo: "mark-life/atlas",
  task: "Ship it",
};

/** Where a run started from these labels works, container-side. */
const { cwd } = runTreeOf(labels);

/** A real directory tree with the seven mount sources on disk. */
const makeSources = (): MountSources => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-local-"));
  const sources: MountSources = {
    agentHomeDir: join(root, "agent-home"),
    cacheDir: join(root, "caches"),
    composedSkillsDir: null,
    globalArtifactsDir: join(root, "artifacts", "global"),
    labels,
    projectArtifactsDir: join(root, "artifacts", "project"),
    runDir: join(root, "runs", "r1"),
    taskArtifactsDir: join(root, "artifacts", "task"),
    workspaceDir: join(root, "runs", "r1", "workspace"),
  };
  for (const value of Object.values(sources)) {
    if (typeof value === "string") {
      mkdirSync(value, { recursive: true });
    }
  }
  return sources;
};

/** The spec a test runs, with only the command varying. */
const specFor = (input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly mounts: readonly Mount[];
  readonly timeoutMs?: number | null;
}): SandboxSpec => ({
  args: input.args,
  command: input.command,
  env: input.env ?? {},
  hardening: defaultHardening,
  identity,
  image: "atm/base:test",
  mounts: input.mounts,
  timeoutMs: input.timeoutMs ?? null,
  workingDir: cwd,
});

/** Runs one spec through the local sandbox, collecting everything it printed. */
const runSpec = (spec: SandboxSpec) => {
  const chunks: OutputChunk[] = [];
  const program = Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const result = yield* Effect.result(
      sandbox.run({
        // The local sandbox starts no container, so this is never called — see
        // `runLocal`. Passed because the seam requires an answer, not because
        // there is one.
        onContainer: () => Effect.void,
        onOutput: (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        spec,
      })
    );
    return result;
  });
  return Effect.runPromise(program.pipe(Effect.provide(testLayer))).then(
    (result) => ({ chunks, result })
  );
};

/** Everything one stream printed, in arrival order. */
const textOf = (chunks: readonly OutputChunk[], stream: "stdout" | "stderr") =>
  chunks
    .filter((chunk) => chunk.stream === stream)
    .map((chunk) => chunk.text)
    .join("");

describe("hostPathOf", () => {
  const mounts = mountsFor({
    agentHomeDir: "/home/op/.claude-task-management",
    cacheDir: "/data/caches",
    composedSkillsDir: null,
    globalArtifactsDir: "/data/artifacts/global",
    labels,
    projectArtifactsDir: "/data/artifacts/projects/p1",
    runDir: "/data/runs/r1",
    taskArtifactsDir: "/data/tasks/t1",
    workspaceDir: "/data/runs/r1/workspace",
  });

  test("translates a mount root and a path under it", () => {
    expect(hostPathOf({ containerPath: cwd, mounts })).toBe(
      "/data/runs/r1/workspace"
    );
    expect(hostPathOf({ containerPath: CONTAINER_EVENT_LOG_DIR, mounts })).toBe(
      "/data/runs/r1/events"
    );
  });

  test("the deepest covering mount wins over every scope above it", () => {
    // Four binds nest inside each other now, so this is what stops a path under
    // the task scope resolving into the global folder.
    expect(
      hostPathOf({ containerPath: runTreeOf(labels).taskScope, mounts })
    ).toBe("/data/tasks/t1");
    expect(hostPathOf({ containerPath: CONTAINER_WORKSPACE_DIR, mounts })).toBe(
      "/data/artifacts/global"
    );
  });

  test("a prefix that does not end on a segment boundary does not match", () => {
    expect(hostPathOf({ containerPath: "/workspace-scratch", mounts })).toBe(
      null
    );
  });

  test("an unmounted path has no host path at all", () => {
    expect(hostPathOf({ containerPath: "/etc/passwd", mounts })).toBe(null);
  });
});

describe("localEnv", () => {
  const mounts = mountsFor({
    agentHomeDir: "/home/op/.claude-task-management",
    cacheDir: "/data/caches",
    composedSkillsDir: null,
    globalArtifactsDir: "/data/artifacts/global",
    labels,
    projectArtifactsDir: "/data/artifacts/projects/p1",
    runDir: "/data/runs/r1",
    taskArtifactsDir: "/data/tasks/t1",
    workspaceDir: "/data/runs/r1/workspace",
  });

  test("rewrites container paths and leaves everything else alone", () => {
    const env = localEnv(
      specFor({
        args: [],
        command: "true",
        env: {
          CLAUDE_CONFIG_DIR: "/run/agent-home/claude",
          NO_COLOR: "1",
          PATH: "/usr/local/bin:/usr/bin",
        },
        mounts,
      })
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/runs/r1/agent-home/claude");
    expect(env.NO_COLOR).toBe("1");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
  });

  test("points the ledger at the run's own directory", () => {
    const env = localEnv(specFor({ args: [], command: "true", mounts }));
    expect(env[EVENT_LOG_DIR_ENV_VAR]).toBe("/data/runs/r1/events");
    expect(env.LOG_FORMAT).toBe(CONTAINER_LOG_ENV.LOG_FORMAT);
  });

  test("a caller cannot redirect the ledger somewhere else", () => {
    const env = localEnv(
      specFor({
        args: [],
        command: "true",
        env: { [EVENT_LOG_DIR_ENV_VAR]: runTreeOf(labels).taskScope },
        mounts,
      })
    );
    expect(env[EVENT_LOG_DIR_ENV_VAR]).toBe("/data/runs/r1/events");
  });

  test("the caller's export credentials do not reach the child", () => {
    const env = localEnv(
      specFor({
        args: [],
        command: "true",
        env: { [`${EXPORT_ENV_PREFIX}EXPORTER_OTLP_HEADERS`]: "Bearer secret" },
        mounts,
      })
    );
    expect(
      Object.keys(env).some((name) => name.startsWith(EXPORT_ENV_PREFIX))
    ).toBe(false);
  });

  test("the identity variables win over the spec's own", () => {
    const env = localEnv(
      specFor({
        args: [],
        command: "true",
        env: { [TURN_ENV_VARS.runId]: "someone-elses-run" },
        mounts,
      })
    );
    expect(env[TURN_ENV_VARS.runId]).toBe(identity.runId);
    expect(env[TRACEPARENT_ENV_VAR]).toBe(identity.traceparent);
  });
});

describe("localWorkingDir", () => {
  test("is the host side of the mount the spec pointed at", () => {
    const mounts = mountsFor({
      agentHomeDir: "/home/op/.claude-task-management",
      cacheDir: "/data/caches",
      composedSkillsDir: null,
      globalArtifactsDir: "/data/artifacts/global",
      labels,
      projectArtifactsDir: "/data/artifacts/projects/p1",
      runDir: "/data/runs/r1",
      taskArtifactsDir: "/data/tasks/t1",
      workspaceDir: "/data/runs/r1/workspace",
    });
    expect(
      localWorkingDir(specFor({ args: [], command: "true", mounts }))
    ).toBe("/data/runs/r1/workspace");
  });
});

describe("unhonouredBy", () => {
  const mounts = mountsFor({
    agentHomeDir: "/home/op/.claude-task-management",
    cacheDir: "/data/caches",
    composedSkillsDir: null,
    globalArtifactsDir: "/data/artifacts/global",
    labels,
    projectArtifactsDir: "/data/artifacts/projects/p1",
    runDir: "/data/runs/r1",
    taskArtifactsDir: "/data/tasks/t1",
    workspaceDir: "/data/runs/r1/workspace",
  });

  test("names every confinement the default spec asked for", () => {
    expect(
      unhonouredBy(specFor({ args: [], command: "true", mounts }))
    ).toEqual([
      "capabilities",
      "cpu",
      "env_isolation",
      "filesystem_confinement",
      "memory",
      "network",
      "no_new_privileges",
      "pids",
      "read_only_mounts",
      "tmpfs",
      "user",
    ]);
  });

  test("says nothing about a confinement the spec never asked for", () => {
    const spec = specFor({ args: [], command: "true", mounts: [] });
    const dropped = unhonouredBy({
      ...spec,
      hardening: {
        ...defaultHardening,
        capDrop: [],
        noNewPrivileges: false,
        tmpfs: [],
      },
    });
    expect(dropped).not.toContain("read_only_mounts");
    expect(dropped).not.toContain("capabilities");
    expect(dropped).not.toContain("tmpfs");
    // The four that are true of any host process stay, always.
    expect(dropped).toContain("filesystem_confinement");
    expect(dropped).toContain("memory");
  });
});

describe("localSandboxLayer", () => {
  test("streams both pipes, reports the exit code, and writes into the workspace", async () => {
    const sources = makeSources();
    const { chunks, result } = await runSpec(
      specFor({
        args: ["-c", "echo hello; echo trouble 1>&2; printf ok > written.txt"],
        command: "sh",
        mounts: mountsFor(sources),
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) {
      return;
    }
    expect(textOf(chunks, "stdout")).toBe("hello\n");
    expect(textOf(chunks, "stderr")).toBe("trouble\n");
    expect(result.success.exitCode).toBe(0);
    expect(result.success.kind).toBe("local");
    expect(result.success.containerId).toBe(null);
    expect(result.success.imagePulled).toBe(false);
    expect(result.success.mountCount).toBe(7);
    expect(result.success.oomKilled).toBe(false);
    expect(result.success.peakMemoryBytes).toBe(null);
    expect(result.success.teardown).toBe("skipped");
    expect(result.success.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(
      readFileSync(join(sources.workspaceDir, "written.txt"), "utf8")
    ).toBe("ok");
  });

  test("the child sees the identity ids and the run's own ledger directory", async () => {
    const sources = makeSources();
    const { chunks, result } = await runSpec(
      specFor({
        args: [
          "-c",
          `printenv ${TURN_ENV_VARS.runId}; printenv ${EVENT_LOG_DIR_ENV_VAR}; printenv CLAUDE_CONFIG_DIR`,
        ],
        command: "sh",
        env: { CLAUDE_CONFIG_DIR: "/run/agent-home/claude" },
        mounts: mountsFor(sources),
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(textOf(chunks, "stdout").trim().split("\n")).toEqual([
      identity.runId,
      join(sources.runDir, "events"),
      join(sources.runDir, "agent-home", "claude"),
    ]);
  });

  test("the read-only workspace scope really is writable here", async () => {
    // Not an endorsement: the assertion is the point. Under docker the same
    // write is refused by the kernel, and this pins the difference the mode
    // reports through `unhonouredBy` instead of leaving it to a comment.
    const sources = makeSources();
    const { result } = await runSpec(
      specFor({
        args: ["-c", 'printf leaked > "$GLOBAL_DIR"/promoted.md'],
        command: "sh",
        env: { GLOBAL_DIR: CONTAINER_WORKSPACE_DIR },
        mounts: mountsFor(sources),
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    expect(existsSync(join(sources.globalArtifactsDir, "promoted.md"))).toBe(
      true
    );
    expect(
      unhonouredBy(
        specFor({ args: [], command: "sh", mounts: mountsFor(sources) })
      )
    ).toContain("read_only_mounts");
  });

  test("the host's own export credentials are unset for the child", async () => {
    const name = `${EXPORT_ENV_PREFIX}EXPORTER_OTLP_HEADERS`;
    process.env[name] = "Bearer host-secret";
    try {
      const sources = makeSources();
      const { chunks } = await runSpec(
        specFor({
          args: ["-c", `echo "[\${${name}}]"`],
          command: "sh",
          mounts: mountsFor(sources),
        })
      );
      expect(textOf(chunks, "stdout")).toBe("[]\n");
    } finally {
      process.env[name] = undefined;
    }
  });

  test("a non-zero exit is data on the result, not a failure", async () => {
    const sources = makeSources();
    const { result } = await runSpec(
      specFor({
        args: ["-c", "exit 3"],
        command: "sh",
        mounts: mountsFor(sources),
      })
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.exitCode).toBe(3);
    }
  });

  test("a missing mount source fails before anything is spawned", async () => {
    const sources = makeSources();
    const mounts = mountsFor({
      ...sources,
      taskArtifactsDir: join(sources.taskArtifactsDir, "typo"),
    });
    const { chunks, result } = await runSpec(
      specFor({ args: ["-c", "echo ran"], command: "sh", mounts })
    );

    expect(chunks).toHaveLength(0);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("Sandbox.MountSourceMissing");
    }
  });

  test("a command that does not exist is a start failure", async () => {
    const sources = makeSources();
    const { result } = await runSpec(
      specFor({
        args: [],
        command: "atm-definitely-not-installed",
        mounts: mountsFor(sources),
      })
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("Sandbox.ContainerStartFailed");
    }
  });

  test("the wall-clock cap stops a run that outlives it", async () => {
    const sources = makeSources();
    const { result } = await runSpec(
      specFor({
        args: ["-c", "sleep 30"],
        command: "sh",
        mounts: mountsFor(sources),
        timeoutMs: 150,
      })
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("Sandbox.TimedOut");
    }
  });

  test("an unisolated run leaves the same atm.sandbox row a container does", async () => {
    const before = ledgerRows().length;
    const sources = makeSources();
    await runSpec(
      specFor({
        args: ["-c", "exit 4"],
        command: "sh",
        mounts: mountsFor(sources),
      })
    );

    const rows = ledgerRows();
    expect(rows.length).toBe(before + 1);
    const row = rows.at(-1);
    // `kind` is the whole reason the row matters here: it is what stops a run
    // that had no isolation from being counted beside the ones that did.
    expect(row?.kind).toBe("local");
    expect(row?.outcome).toBe("done");
    expect(row?.exitCode).toBe(4);
    // Nothing existed to remove, and nothing is invented about a kernel that
    // was never asked.
    expect(row?.teardown).toBe("skipped");
    expect(row?.containerId).toBe(null);
    expect(row?.peakMemoryBytes).toBe(null);
    expect(row?.runId).toBe(identity.runId);
  });

  test("a run that never started still leaves a row", async () => {
    const before = ledgerRows().length;
    const sources = makeSources();
    await runSpec(
      specFor({
        args: ["-c", "echo ran"],
        command: "sh",
        mounts: mountsFor({
          ...sources,
          taskArtifactsDir: join(sources.taskArtifactsDir, "typo"),
        }),
      })
    );

    const row = ledgerRows().at(-1);
    expect(ledgerRows().length).toBe(before + 1);
    expect(row?.outcome).toBe("start_failed");
    expect(row?.errorClass).toBe("MountSourceMissing");
    expect(row?.kind).toBe("local");
  });
});
