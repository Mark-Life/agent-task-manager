/**
 * The mount set is the sandbox's security boundary, so the claims worth testing
 * are the ones a refactor would quietly break: that the shared artifact folders
 * are read-only, that the container's view of the run directory is the same
 * layout the harness computes, and that nothing else is ever in the set.
 */

import { describe, expect, test } from "bun:test";
import { containerRunLayout } from "@workspace/harness";
import {
  CONTAINER_AGENT_HOME_DIR,
  CONTAINER_ARTIFACT_DIR,
  CONTAINER_EVENT_LOG_DIR,
  CONTAINER_WORKSPACE_DIR,
  type Mount,
  type MountSources,
  mountArg,
  mountArgs,
  mountsFor,
} from "./mounts";

const sources: MountSources = {
  globalArtifactsDir: "/data/artifacts/global",
  projectArtifactsDir: "/data/artifacts/projects/p1",
  runDir: "/data/runs/r1",
  taskArtifactsDir: "/data/tasks/t1/artifacts",
  workspaceDir: "/data/runs/r1/workspace",
};

const byPurpose = (mounts: readonly Mount[], purpose: Mount["purpose"]) =>
  mounts.find((mount) => mount.purpose === purpose);

describe("mountsFor", () => {
  test("mounts exactly the five directories a run may see", () => {
    const purposes = mountsFor(sources).map((mount) => mount.purpose);
    expect(purposes).toEqual([
      "run",
      "workspace",
      "task_artifacts",
      "project_artifacts",
      "global_artifacts",
    ]);
  });

  test("only the run's own directories are writable", () => {
    const writable = mountsFor(sources)
      .filter((mount) => !mount.readOnly)
      .map((mount) => mount.purpose);
    expect(writable).toEqual(["run", "workspace", "task_artifacts"]);
  });

  test("the shared artifact folders are read-only, so promotion stays the audit trail", () => {
    const mounts = mountsFor(sources);
    expect(byPurpose(mounts, "project_artifacts")?.readOnly).toBe(true);
    expect(byPurpose(mounts, "global_artifacts")?.readOnly).toBe(true);
  });

  test("a task with no project gets no project mount, not an empty one", () => {
    const mounts = mountsFor({ ...sources, projectArtifactsDir: null });
    expect(byPurpose(mounts, "project_artifacts")).toBeUndefined();
    expect(byPurpose(mounts, "global_artifacts")?.hostPath).toBe(
      sources.globalArtifactsDir
    );
  });

  test("nothing resembling the docker socket is ever mounted", () => {
    const args = mountArgs(mountsFor(sources)).join(" ");
    expect(args).not.toContain("docker.sock");
    expect(args).not.toContain("/var/run/docker");
  });

  test("container paths are fixed, so a run id never leaks into the container", () => {
    const mounts = mountsFor(sources);
    expect(byPurpose(mounts, "workspace")?.containerPath).toBe(
      CONTAINER_WORKSPACE_DIR
    );
    expect(byPurpose(mounts, "task_artifacts")?.containerPath).toBe(
      CONTAINER_ARTIFACT_DIR.task
    );
    for (const mount of mounts) {
      expect(mount.containerPath).not.toContain("r1");
      expect(mount.containerPath).not.toContain("t1");
    }
  });
});

describe("the container's run directory", () => {
  test("is the layout the harness computes, not a second spelling of it", () => {
    const runMount = byPurpose(mountsFor(sources), "run");
    expect(runMount?.containerPath).toBe(containerRunLayout.runDir);
    expect(CONTAINER_AGENT_HOME_DIR).toBe(containerRunLayout.agentHomeDir);
  });

  test("holds the event ledger, so a container's rows land on the host", () => {
    expect(CONTAINER_EVENT_LOG_DIR.startsWith(containerRunLayout.runDir)).toBe(
      true
    );
    // The harness writes `events.jsonl` in the run directory; the ledger is a
    // directory beside it. Same parent, different names, one mount.
    expect(CONTAINER_EVENT_LOG_DIR).not.toBe(containerRunLayout.eventLogPath);
  });
});

describe("mountArg", () => {
  test("uses --mount, which refuses a missing source instead of inventing one", () => {
    expect(
      mountArg({
        containerPath: "/workspace",
        hostPath: "/data/runs/r1/workspace",
        purpose: "workspace",
        readOnly: false,
      })
    ).toBe("--mount=type=bind,src=/data/runs/r1/workspace,dst=/workspace");
  });

  test("marks a read-only mount readonly", () => {
    expect(
      mountArg({
        containerPath: "/artifacts/global",
        hostPath: "/data/artifacts/global",
        purpose: "global_artifacts",
        readOnly: true,
      })
    ).toBe(
      "--mount=type=bind,src=/data/artifacts/global,dst=/artifacts/global,readonly"
    );
  });
});
