/**
 * The argv is the container's confinement and the container's environment is
 * the run's correlation, so both are asserted here rather than by starting
 * something. The claims worth pinning are the ones a refactor breaks silently:
 * a value that reaches the command line, an export credential that reaches the
 * container, an event ledger pointed anywhere but the mount, and a `--rm` that
 * deletes the answer before the row is written.
 *
 * The inspect and stats fixtures below are real output, captured from
 * docker 28.3.0 on arm64 against `alpine:3`.
 */

import { describe, expect, test } from "bun:test";
import {
  newAgentSessionId,
  newRunId,
  newTaskId,
  WorkspaceId,
} from "@workspace/domain";
import { TURN_ENV_VARS } from "@workspace/harness";
import {
  CONTAINER_NEVER_STARTED,
  containerEnv,
  containerName,
  dockerRunArgs,
  EVENT_LOG_DIR_ENV_VAR,
  envArgs,
  parseInspect,
  parseMemUsage,
  stripAnsi,
} from "./docker-argv";
import { defaultHardening } from "./hardening";
import {
  CONTAINER_EVENT_LOG_DIR,
  CONTAINER_WORKSPACE_DIR,
  mountsFor,
  type RunLabels,
  runTreeOf,
} from "./mounts";
import { identityEnv, type SandboxSpec, TRACEPARENT_ENV_VAR } from "./spec";

const identity = {
  runId: newRunId(),
  sessionId: newAgentSessionId(),
  taskId: newTaskId(),
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  workspaceId: WorkspaceId.make("ws_1"),
};

const labels: RunLabels = {
  project: "Atlas",
  repo: "mark-life/atlas",
  task: "Ship it",
};

const spec: SandboxSpec = {
  args: ["-c", "echo hi"],
  command: "sh",
  env: { GH_TOKEN: "ghp_secret", LOG_LEVEL: "Debug" },
  hardening: defaultHardening,
  identity,
  image: "atm/base:2026-08-01",
  mounts: mountsFor({
    agentHomeDir: "/home/op/.claude-task-management",
    cacheDir: "/data/caches",
    globalArtifactsDir: "/data/artifacts/global",
    labels,
    projectArtifactsDir: "/data/artifacts/projects/p1",
    runDir: "/data/runs/r1",
    taskArtifactsDir: "/data/tasks/t1/artifacts",
    workspaceDir: "/data/runs/r1/workspace",
  }),
  timeoutMs: 60_000,
  workingDir: runTreeOf(labels).cwd,
};

const name = containerName({ nonce: "deadbeef", runId: identity.runId });
const args = dockerRunArgs({ containerName: name, spec });
const joined = args.join(" ");

describe("dockerRunArgs", () => {
  test("ends with the image, the command and its arguments, in that order", () => {
    expect(args.slice(-4)).toEqual([spec.image, "sh", "-c", "echo hi"]);
  });

  test("carries the hardening and every mount", () => {
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges:true");
    expect(args).toContain("--mount=type=bind,src=/data/runs/r1,dst=/run");
    expect(args).toContain(
      `--mount=type=bind,src=/data/artifacts/global,dst=${CONTAINER_WORKSPACE_DIR},readonly`
    );
  });

  test("never mounts the docker socket", () => {
    expect(joined).not.toContain("docker.sock");
  });

  test("does not remove the container on exit, so the row can still be read", () => {
    expect(args).not.toContain("--rm");
  });

  test("names the container and labels it with the run", () => {
    expect(args).toContain(`--name=${name}`);
    expect(args).toContain(`--label=atm.run=${identity.runId}`);
  });

  test("starts in the working directory it was given", () => {
    expect(args).toContain(`--workdir=${runTreeOf(labels).cwd}`);
  });

  test("carries environment names, never a value", () => {
    expect(joined).not.toContain("ghp_secret");
    expect(joined).not.toContain(identity.traceparent);
    expect(args).toContain(`--env=${TURN_ENV_VARS.runId}`);
    const valued = args.filter(
      (arg) =>
        arg.startsWith("--env=") && arg.slice("--env=".length).includes("=")
    );
    expect(valued).toEqual([]);
  });
});

describe("envArgs", () => {
  test("is one name-only flag per variable, sorted", () => {
    expect(envArgs({ A: "1", B: "2" })).toEqual(["--env=A", "--env=B"]);
  });
});

describe("containerEnv", () => {
  const env = containerEnv(spec);

  test("carries the ids the harness reads back inside the container", () => {
    expect(env).toMatchObject(identityEnv(identity));
    expect(env[TURN_ENV_VARS.runId]).toBe(identity.runId);
    expect(env[TRACEPARENT_ENV_VAR]).toBe(identity.traceparent);
  });

  test("points the ledger at the mount, and the caller cannot move it", () => {
    expect(env[EVENT_LOG_DIR_ENV_VAR]).toBe(CONTAINER_EVENT_LOG_DIR);
    expect(
      containerEnv({
        ...spec,
        env: { [EVENT_LOG_DIR_ENV_VAR]: "/tmp/elsewhere" },
      })[EVENT_LOG_DIR_ENV_VAR]
    ).toBe(CONTAINER_EVENT_LOG_DIR);
  });

  test("the caller cannot overwrite the ids its own row joins on", () => {
    const forged = containerEnv({
      ...spec,
      env: { [TURN_ENV_VARS.runId]: "someone-elses-run" },
    });
    expect(forged[TURN_ENV_VARS.runId]).toBe(identity.runId);
  });

  test("never passes the host's OTLP endpoint or its credentials", () => {
    const env2 = containerEnv({
      ...spec,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer sk-live-1234",
      },
    });
    expect(Object.keys(env2).some((key) => key.startsWith("OTEL_"))).toBe(
      false
    );
  });

  test("keeps the caller's own settings and defaults the log format", () => {
    expect(env.LOG_LEVEL).toBe("Debug");
    expect(env.LOG_FORMAT).toBe("json");
    expect(
      containerEnv({ ...spec, env: { LOG_FORMAT: "logfmt" } }).LOG_FORMAT
    ).toBe("logfmt");
  });
});

describe("parseInspect", () => {
  const exited = `{"id":"73f7da47985b73c03bcdb75ead42a003bc2d8927e22d092e9211d9bd9805ca45","state":{"Dead":false,"Error":"","ExitCode":7,"FinishedAt":"2026-08-01T23:17:51.337778417Z","OOMKilled":false,"Paused":false,"Pid":0,"Restarting":false,"Running":false,"StartedAt":"2026-08-01T23:17:51.272812417Z","Status":"exited"}}`;

  test("reads the id, the exit code and the kernel's verdict", () => {
    expect(parseInspect(exited)).toEqual({
      containerId:
        "73f7da47985b73c03bcdb75ead42a003bc2d8927e22d092e9211d9bd9805ca45",
      error: "",
      exitCode: 7,
      oomKilled: false,
      started: true,
    });
  });

  test("tells a command that exited 127 from one that never ran", () => {
    const neverStarted = `{"id":"cc5bb959b33b","state":{"Error":"OCI runtime create failed: exec: \\"/no/such/binary\\": no such file or directory","ExitCode":127,"OOMKilled":false,"StartedAt":"${CONTAINER_NEVER_STARTED}","Status":"created"}}`;
    const parsed = parseInspect(neverStarted);
    expect(parsed?.started).toBe(false);
    expect(parsed?.exitCode).toBe(127);
    expect(parsed?.error).toContain("no such file");
  });

  test("reads the OOM flag, which the exit code alone cannot give", () => {
    const oom = `{"id":"abc","state":{"Error":"","ExitCode":137,"OOMKilled":true,"StartedAt":"2026-08-01T23:17:51Z","Status":"exited"}}`;
    expect(parseInspect(oom)?.oomKilled).toBe(true);
  });

  test("is null on anything it cannot read, rather than inventing a fate", () => {
    expect(parseInspect("Error: No such object: atm-missing")).toBeNull();
    expect(parseInspect("")).toBeNull();
    expect(parseInspect(`{"id":"abc"}`)).toBeNull();
  });
});

describe("parseMemUsage", () => {
  const KIB = 1024;

  test("reads a streamed line through its cursor moves", () => {
    expect(parseMemUsage(`${stripAnsi("")}540KiB / 7.654GiB`)).toBe(540 * KIB);
    expect(parseMemUsage("\u001B[H540KiB / 7.654GiB \u001B[K")).toBe(540 * KIB);
  });

  test("reads every unit the CLI prints", () => {
    expect(parseMemUsage("12MiB / 2GiB")).toBe(12 * KIB * KIB);
    expect(parseMemUsage("1.5GiB / 2GiB")).toBe(1.5 * KIB ** 3);
    expect(parseMemUsage("900B / 2GiB")).toBe(900);
  });

  test("is null for a line with no reading in it", () => {
    expect(parseMemUsage(" \u001B[K")).toBeNull();
    expect(parseMemUsage("MEM USAGE / LIMIT")).toBeNull();
    expect(parseMemUsage("-- / --")).toBeNull();
  });
});
