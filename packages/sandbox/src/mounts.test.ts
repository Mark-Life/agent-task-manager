/**
 * The mount set is the sandbox's security boundary, so the claims worth testing
 * are the ones a refactor would quietly break: that the shared artifact folders
 * are read-only, that the container's view of the run directory is the same
 * layout the harness computes, and that nothing else is ever in the set.
 */

import { describe, expect, test } from "bun:test";
import {
  CONTAINER_ENTRYPOINT_PATH,
  containerRunLayout,
} from "@workspace/harness";
import {
  CONTAINER_AGENT_HOME_DIR,
  CONTAINER_ARTIFACT_DIR,
  CONTAINER_EVENT_LOG_DIR,
  CONTAINER_SKILLS_DIR,
  CONTAINER_WORKSPACE_DIR,
  type ManagerMountSources,
  type Mount,
  type MountSources,
  managerMountsFor,
  mountArg,
  mountArgs,
  mountsFor,
} from "./mounts";

const sources: MountSources = {
  agentHomeDir: "/home/op/.claude-task-management",
  globalArtifactsDir: "/data/artifacts/global",
  projectArtifactsDir: "/data/artifacts/projects/p1",
  runDir: "/data/runs/r1",
  taskArtifactsDir: "/data/tasks/t1/artifacts",
  workspaceDir: "/data/runs/r1/workspace",
};

const byPurpose = (mounts: readonly Mount[], purpose: Mount["purpose"]) =>
  mounts.find((mount) => mount.purpose === purpose);

describe("mountsFor", () => {
  test("mounts exactly the six directories a run may see", () => {
    const purposes = mountsFor(sources).map((mount) => mount.purpose);
    expect(purposes).toEqual([
      "run",
      "agent_home",
      "workspace",
      "task_artifacts",
      "project_artifacts",
      "global_artifacts",
    ]);
  });

  test("only the run's own directories and the agent home are writable", () => {
    const writable = mountsFor(sources)
      .filter((mount) => !mount.readOnly)
      .map((mount) => mount.purpose);
    expect(writable).toEqual([
      "run",
      "agent_home",
      "workspace",
      "task_artifacts",
    ]);
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

  test("the entrypoint bundle is mounted read-only, and only when there is one", () => {
    expect(byPurpose(mountsFor(sources), "entrypoint")).toBeUndefined();

    const mounts = mountsFor(sources, {
      entrypointPath: "/data/bin/turn.js",
      skillsDir: null,
    });
    const entrypoint = byPurpose(mounts, "entrypoint");
    expect(entrypoint?.hostPath).toBe("/data/bin/turn.js");
    expect(entrypoint?.containerPath).toBe(CONTAINER_ENTRYPOINT_PATH);
    // A container that could rewrite the file it is running would be rewriting
    // it for every other run on the host: one bundle serves them all.
    expect(entrypoint?.readOnly).toBe(true);
  });

  test("the operator's skills are mounted read-only, and only when shared", () => {
    expect(byPurpose(mountsFor(sources), "skills")).toBeUndefined();

    const mounts = mountsFor(sources, {
      entrypointPath: null,
      skillsDir: "/home/op/.agents/skills",
    });
    const skills = byPurpose(mounts, "skills");
    expect(skills?.hostPath).toBe("/home/op/.agents/skills");
    expect(skills?.containerPath).toBe(CONTAINER_SKILLS_DIR);
    // One directory serves every container on the host, and a run that could
    // write it would be editing the instructions every later run is given.
    expect(skills?.readOnly).toBe(true);
  });

  test("skills land inside the agent home, which is where a provider looks", () => {
    expect(CONTAINER_SKILLS_DIR).toBe(`${CONTAINER_AGENT_HOME_DIR}/skills`);
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

describe("the agent home", () => {
  test("is mounted read-write, because the vendor refreshes its token in place", () => {
    const home = byPurpose(mountsFor(sources), "agent_home");
    expect(home?.hostPath).toBe(sources.agentHomeDir);
    expect(home?.containerPath).toBe(CONTAINER_AGENT_HOME_DIR);
    expect(home?.readOnly).toBe(false);
  });

  test("is its own bind, not a directory inside the run mount", () => {
    // Nesting a second bind under `/run` is ordering-dependent and buys
    // nothing: the two directories have different owners and different
    // lifetimes.
    expect(CONTAINER_AGENT_HOME_DIR.startsWith(containerRunLayout.runDir)).toBe(
      false
    );
  });

  test("names no provider and no host path, so neither leaks into the container", () => {
    for (const mounts of [mountsFor(sources), managerMountsFor(sources)]) {
      const home = byPurpose(mounts, "agent_home");
      expect(home?.containerPath).not.toContain("claude");
      expect(home?.containerPath).not.toContain("codex");
      expect(home?.containerPath).not.toContain(sources.agentHomeDir);
    }
  });
});

describe("the container's run directory", () => {
  test("is the layout the harness computes, not a second spelling of it", () => {
    const runMount = byPurpose(mountsFor(sources), "run");
    expect(runMount?.containerPath).toBe(containerRunLayout.runDir);
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

describe("managerMountsFor", () => {
  const managerSources: ManagerMountSources = {
    agentHomeDir: "/home/op/.claude-task-management",
    globalArtifactsDir: "/data/artifacts/global",
    runDir: "/data/threads/th1/run",
    workspaceDir: "/data/threads/th1/workspace",
  };

  test("mounts exactly the four directories a conversation may see", () => {
    const purposes = managerMountsFor(managerSources).map(
      (mount) => mount.purpose
    );
    expect(purposes).toEqual([
      "run",
      "agent_home",
      "workspace",
      "global_artifacts",
    ]);
  });

  test("reaches no task's artifacts and no project's, whatever it is handed", () => {
    // The type forbids naming them; this is the claim that no other code path
    // reintroduces one, which is what a reviewer of the security boundary asks.
    const purposes = managerMountsFor(managerSources, {
      entrypointPath: "/data/bin/turn.js",
      skillsDir: null,
    }).map((mount) => mount.purpose);
    expect(purposes).not.toContain("task_artifacts");
    expect(purposes).not.toContain("project_artifacts");
  });

  test("the global folder is read-only and the conversation's own directories are not", () => {
    const mounts = managerMountsFor(managerSources);
    expect(byPurpose(mounts, "global_artifacts")?.readOnly).toBe(true);
    expect(byPurpose(mounts, "run")?.readOnly).toBe(false);
    expect(byPurpose(mounts, "workspace")?.readOnly).toBe(false);
  });

  test("the entrypoint is mounted read-only where the harness looks for it", () => {
    const mounts = managerMountsFor(managerSources, {
      entrypointPath: "/data/bin/turn.js",
      skillsDir: null,
    });
    const entrypoint = byPurpose(mounts, "entrypoint");
    expect(entrypoint?.containerPath).toBe(CONTAINER_ENTRYPOINT_PATH);
    expect(entrypoint?.readOnly).toBe(true);
  });

  test("a conversation is given the operator's skills on the same terms", () => {
    const mounts = managerMountsFor(managerSources, {
      entrypointPath: null,
      skillsDir: "/home/op/.agents/skills",
    });
    const skills = byPurpose(mounts, "skills");
    expect(skills?.containerPath).toBe(CONTAINER_SKILLS_DIR);
    expect(skills?.readOnly).toBe(true);
  });

  test("the container sees its run and workspace where every other turn does", () => {
    const mounts = managerMountsFor(managerSources);
    expect(byPurpose(mounts, "run")?.containerPath).toBe(
      containerRunLayout.runDir
    );
    expect(byPurpose(mounts, "workspace")?.containerPath).toBe(
      CONTAINER_WORKSPACE_DIR
    );
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
