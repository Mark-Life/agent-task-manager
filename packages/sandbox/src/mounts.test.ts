/**
 * The mount set is the sandbox's security boundary, so the claims worth testing
 * are the ones a refactor would quietly break: that a worker cannot write the
 * workspace scope, that the tree nests in the order the scopes do, that the
 * container's view of the run directory is the same layout the harness computes,
 * and that nothing else is ever in the set.
 */

import { describe, expect, test } from "bun:test";
import {
  CONTAINER_AGENT_MCP_PATH,
  CONTAINER_ENTRYPOINT_PATH,
  containerRunLayout,
} from "@workspace/harness";
import {
  CONTAINER_AGENT_HOME_DIR,
  CONTAINER_CACHE_DIR,
  CONTAINER_EVENT_LOG_DIR,
  CONTAINER_MANAGER_DIR,
  CONTAINER_MANAGER_SCRATCH_DIR,
  CONTAINER_SKILLS_DIR,
  CONTAINER_WORKER_DIR,
  CONTAINER_WORKSPACE_DIR,
  FALLBACK_SLUG,
  type ManagerMountSources,
  type Mount,
  type MountSources,
  managerMountsFor,
  mountArg,
  mountArgs,
  mountsFor,
  nestedMountPointsOf,
  packageCacheEnv,
  type RunLabels,
  runTreeOf,
  SLUG_MAX_LENGTH,
  slugOf,
} from "./mounts";

const labels: RunLabels = {
  project: "Atlas Rewrite",
  repo: "mark-life/atlas",
  task: "Ship the CSV export",
};

const sources: MountSources = {
  agentHomeDir: "/home/op/.claude-task-management",
  cacheDir: "/data/caches",
  globalArtifactsDir: "/data/artifacts/global",
  labels,
  projectArtifactsDir: "/data/artifacts/projects/p1",
  runDir: "/data/runs/r1",
  taskArtifactsDir: "/data/tasks/t1/artifacts",
  workspaceDir: "/data/runs/r1/workspace",
};

const byPurpose = (mounts: readonly Mount[], purpose: Mount["purpose"]) =>
  mounts.find((mount) => mount.purpose === purpose);

/**
 * The tree is what every other claim in this file is measured against: the
 * prompt names these paths, the mounts land on them, and both providers walk up
 * through them. All four shapes, because the two nulls are independent.
 */
describe("runTreeOf", () => {
  test("puts the clone under the task, the task under the project, and both under the workspace", () => {
    expect(runTreeOf(labels)).toEqual({
      cwd: "/workspace/worker/atlas-rewrite/ship-the-csv-export/mark-life-atlas",
      projectScope: "/workspace/worker/atlas-rewrite",
      taskScope: "/workspace/worker/atlas-rewrite/ship-the-csv-export",
      workspaceScope: "/workspace",
    });
  });

  test("says a run with no repo works in a scratch directory at the clone's depth", () => {
    // Same depth on purpose: the walk an agent's tooling performs has to be the
    // same walk whether or not there was anything to check out.
    const tree = runTreeOf({ ...labels, repo: null });
    expect(tree.cwd).toBe(
      "/workspace/worker/atlas-rewrite/ship-the-csv-export/scratch"
    );
    expect(tree.taskScope).toBe(
      "/workspace/worker/atlas-rewrite/ship-the-csv-export"
    );
  });

  test("skips the project level for a task that belongs to no project", () => {
    // A `_` placeholder would be an empty directory the agent can open, which
    // is a lie it can read. A shallower path says the same thing honestly.
    const tree = runTreeOf({ ...labels, project: null });
    expect(tree.projectScope).toBe(null);
    expect(tree.taskScope).toBe("/workspace/worker/ship-the-csv-export");
    expect(tree.cwd).toBe(
      "/workspace/worker/ship-the-csv-export/mark-life-atlas"
    );
  });

  test("a task with neither a project nor a repo is three levels down, not four", () => {
    const tree = runTreeOf({
      project: null,
      repo: null,
      task: "Plan Budapest",
    });
    expect(tree.cwd).toBe("/workspace/worker/plan-budapest/scratch");
    expect(tree.projectScope).toBe(null);
  });

  test("names no id at any level, whatever it is handed", () => {
    const tree = runTreeOf({
      project: "p_01JQ",
      repo: "r_01JQ",
      task: "t_01JQ",
    });
    // Slugs of ids are still ids; the claim is about the levels the tree adds,
    // which are the constant segments.
    expect(tree.taskScope.startsWith(CONTAINER_WORKER_DIR)).toBe(true);
    expect(tree.workspaceScope).toBe(CONTAINER_WORKSPACE_DIR);
  });
});

/**
 * A slug is what keeps ids out of a path a transcript can leak. It is safe
 * because exactly one project and one task is ever mounted into a container, so
 * these tests are about the segment being usable rather than about it being
 * unique.
 */
describe("slugOf", () => {
  test("lowercases, and collapses everything that is not a letter or a digit", () => {
    expect(slugOf("Ship the CSV export")).toBe("ship-the-csv-export");
    expect(slugOf("mark-life/atlas")).toBe("mark-life-atlas");
    expect(slugOf("v2.0  (final)")).toBe("v2-0-final");
  });

  test("leaves no dash at either edge, before or after the cap", () => {
    expect(slugOf("  spaced  ")).toBe("spaced");
    expect(slugOf("!!!bang!!!")).toBe("bang");
    const capped = slugOf(`${"a".repeat(SLUG_MAX_LENGTH)} tail`);
    expect(capped.endsWith("-")).toBe(false);
    expect(capped.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  test("falls back rather than producing an empty segment", () => {
    // A name in a non-Latin script slugs to nothing, and an empty segment is a
    // path that means something else entirely.
    expect(slugOf("日本語")).toBe(FALLBACK_SLUG);
    expect(slugOf("")).toBe(FALLBACK_SLUG);
    expect(slugOf("---")).toBe(FALLBACK_SLUG);
  });
});

describe("mountsFor", () => {
  test("mounts exactly the seven directories a run may see", () => {
    const purposes = mountsFor(sources).map((mount) => mount.purpose);
    expect(purposes).toEqual([
      "run",
      "agent_home",
      "global_artifacts",
      "project_artifacts",
      "task_artifacts",
      "workspace",
      "cache",
    ]);
  });

  test("binds each scope where the tree says, deepest last", () => {
    const tree = runTreeOf(labels);
    const mounts = mountsFor(sources);
    expect(byPurpose(mounts, "global_artifacts")?.containerPath).toBe(
      tree.workspaceScope
    );
    expect(byPurpose(mounts, "project_artifacts")?.containerPath).toBe(
      String(tree.projectScope)
    );
    expect(byPurpose(mounts, "task_artifacts")?.containerPath).toBe(
      tree.taskScope
    );
    expect(byPurpose(mounts, "workspace")?.containerPath).toBe(tree.cwd);
  });

  test("the host layout is untouched: nesting is a remapping of destinations", () => {
    const mounts = mountsFor(sources);
    expect(byPurpose(mounts, "global_artifacts")?.hostPath).toBe(
      sources.globalArtifactsDir
    );
    expect(byPurpose(mounts, "project_artifacts")?.hostPath).toBe(
      String(sources.projectArtifactsDir)
    );
    expect(byPurpose(mounts, "task_artifacts")?.hostPath).toBe(
      sources.taskArtifactsDir
    );
    expect(byPurpose(mounts, "workspace")?.hostPath).toBe(sources.workspaceDir);
  });

  test("a worker may write every scope except the workspace one", () => {
    // The one flag that enforces the governance rule: a worker clones untrusted
    // repositories, so a write above its own task scope has to be a proposal
    // rather than an edit, and only the mount can make that true.
    const mounts = mountsFor(sources);
    expect(byPurpose(mounts, "global_artifacts")?.readOnly).toBe(true);
    expect(byPurpose(mounts, "project_artifacts")?.readOnly).toBe(false);
    expect(byPurpose(mounts, "task_artifacts")?.readOnly).toBe(false);
    expect(byPurpose(mounts, "workspace")?.readOnly).toBe(false);
  });

  test("a task with no project gets no project mount, not an empty one", () => {
    const mounts = mountsFor({
      ...sources,
      labels: { ...labels, project: null },
      projectArtifactsDir: null,
    });
    expect(byPurpose(mounts, "project_artifacts")).toBeUndefined();
    expect(byPurpose(mounts, "task_artifacts")?.containerPath).toBe(
      "/workspace/worker/ship-the-csv-export"
    );
  });

  test("a project folder without a project scope to hold it is not mounted either", () => {
    // The two nulls state one fact. A caller that passed only one would
    // otherwise get a promoted folder bound at a path nothing walks through.
    const mounts = mountsFor({
      ...sources,
      labels: { ...labels, project: null },
    });
    expect(byPurpose(mounts, "project_artifacts")).toBeUndefined();
  });

  test("the entrypoint bundle is mounted read-only, and only when there is one", () => {
    expect(byPurpose(mountsFor(sources), "entrypoint")).toBeUndefined();

    const mounts = mountsFor(sources, {
      agentMcpPath: null,
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

  test("the board tools are one shared file, mounted read-only, and only when there are any", () => {
    expect(byPurpose(mountsFor(sources), "agent_mcp")).toBeUndefined();

    const mounts = mountsFor(sources, {
      agentMcpPath: "/data/bin/agent-mcp.js",
      entrypointPath: null,
      skillsDir: null,
    });
    const bundle = byPurpose(mounts, "agent_mcp");
    expect(bundle?.hostPath).toBe("/data/bin/agent-mcp.js");
    expect(bundle?.containerPath).toBe(CONTAINER_AGENT_MCP_PATH);
    // One file on the host serves every container, so a run that could write it
    // would be rewriting the tools every other run on the box is running.
    expect(bundle?.readOnly).toBe(true);
  });

  test("the board tools are mounted, never copied into the run directory", () => {
    // The copy is what this replaced: 1.7 MB per run, kept for as long as the
    // run directory is, and 77% of `runs/` on the host that was measured. A
    // destination under the run mount would put it back, one turn at a time.
    const bundle = byPurpose(
      mountsFor(sources, {
        agentMcpPath: "/data/bin/agent-mcp.js",
        entrypointPath: null,
        skillsDir: null,
      }),
      "agent_mcp"
    );
    expect(bundle?.containerPath.startsWith(containerRunLayout.runDir)).toBe(
      false
    );
    expect(bundle?.hostPath.startsWith(sources.runDir)).toBe(false);
  });

  test("the operator's skills are mounted read-only, and only when shared", () => {
    expect(byPurpose(mountsFor(sources), "skills")).toBeUndefined();

    const mounts = mountsFor(sources, {
      agentMcpPath: null,
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
    const args = mountArgs(
      mountsFor(sources, {
        agentMcpPath: null,
        entrypointPath: "/data/bin/turn.js",
        skillsDir: "/home/op/.agents/skills",
      })
    ).join(" ");
    expect(args).not.toContain("docker.sock");
    expect(args).not.toContain("/var/run/docker");
  });

  test("container paths carry names, never ids, so a transcript leaks neither", () => {
    const mounts = mountsFor(sources);
    for (const mount of mounts) {
      expect(mount.containerPath).not.toContain("r1");
      expect(mount.containerPath).not.toContain("t1");
      expect(mount.containerPath).not.toContain("p1");
    }
  });

  test("a worker never walks into the manager's directory, because nothing is bound there", () => {
    const inManager = mountsFor(sources).filter((mount) =>
      mount.containerPath.startsWith(`${CONTAINER_MANAGER_DIR}/`)
    );
    expect(inManager).toEqual([]);
  });
});

/**
 * The nested destinations are what make a read-only parent work at all: docker
 * looks a bind's destination up inside the parent bind's host directory, and
 * cannot create it through a read-only mount.
 */
describe("nestedMountPointsOf", () => {
  test("names each nested destination inside its own parent's host directory", () => {
    expect(nestedMountPointsOf(mountsFor(sources))).toEqual([
      {
        path: "/data/artifacts/global/worker/atlas-rewrite",
        purpose: "project_artifacts",
      },
      {
        path: "/data/artifacts/projects/p1/ship-the-csv-export",
        purpose: "task_artifacts",
      },
      {
        path: "/data/tasks/t1/artifacts/mark-life-atlas",
        purpose: "workspace",
      },
    ]);
  });

  test("picks the deepest covering mount, not the shallowest", () => {
    // The task's directory belongs inside the project's host folder. Taking the
    // first match would put it inside the global one, where nothing looks.
    const [, taskPoint] = nestedMountPointsOf(mountsFor(sources));
    expect(
      taskPoint?.path.startsWith(String(sources.projectArtifactsDir))
    ).toBe(true);
  });

  test("says nothing about a mount that sits under no other", () => {
    const points = nestedMountPointsOf(mountsFor(sources)).map(
      (point) => point.purpose
    );
    expect(points).not.toContain("run");
    expect(points).not.toContain("cache");
    expect(points).not.toContain("agent_home");
  });

  test("matches on segment boundaries, not on a shared string prefix", () => {
    const points = nestedMountPointsOf([
      {
        containerPath: "/workspace",
        hostPath: "/data/global",
        purpose: "global_artifacts",
        readOnly: true,
      },
      {
        containerPath: "/workspace-scratch",
        hostPath: "/data/scratch",
        purpose: "workspace",
        readOnly: false,
      },
    ]);
    expect(points).toEqual([]);
  });

  test("covers a bind inside a bind wherever it is, not only inside the tree", () => {
    const points = nestedMountPointsOf(
      mountsFor(sources, {
        agentMcpPath: null,
        entrypointPath: "/data/bin/turn.js",
        skillsDir: "/home/op/.agents/skills",
      })
    );
    expect(points).toContainEqual({
      path: `${sources.agentHomeDir}/skills`,
      purpose: "skills",
    });
    // The entrypoint is the one bind of a file, and it is under no other mount,
    // so it never turns up in a list of directories to create.
    expect(points.map((point) => point.purpose)).not.toContain("entrypoint");
  });

  test("gives a manager's scratch directory a home inside the workspace scope", () => {
    expect(
      nestedMountPointsOf(
        managerMountsFor({
          agentHomeDir: "/home/op/.claude-task-management",
          globalArtifactsDir: "/data/artifacts/global",
          runDir: "/data/threads/th1/run",
          workspaceDir: "/data/threads/th1/workspace",
        })
      )
    ).toEqual([
      {
        path: "/data/artifacts/global/manager/scratch",
        purpose: "workspace",
      },
    ]);
  });
});

describe("the package cache", () => {
  test("is one writable bind at a fixed path, shared by every run", () => {
    const cache = byPurpose(mountsFor(sources), "cache");
    expect(cache?.hostPath).toBe(sources.cacheDir);
    expect(cache?.containerPath).toBe(CONTAINER_CACHE_DIR);
    // Read-only would warm nothing for the next run, which is the point of it.
    expect(cache?.readOnly).toBe(false);
  });

  test("is not offered to a conversation, which installs nothing", () => {
    expect(byPurpose(managerMountsFor(sources), "cache")).toBeUndefined();
  });

  test("every manager is pointed at it, and none is detected", () => {
    const env = packageCacheEnv(CONTAINER_CACHE_DIR);
    expect(env).toEqual({
      BUN_INSTALL_CACHE_DIR: "/cache/bun",
      npm_config_cache: "/cache/npm",
      npm_config_store_dir: "/cache/pnpm",
      PNPM_CONFIG_STORE_DIR: "/cache/pnpm",
      YARN_ENABLE_GLOBAL_CACHE: "true",
      YARN_GLOBAL_FOLDER: "/cache/yarn",
    });
  });

  test("names the pnpm store under both spellings, one per pnpm generation", () => {
    // pnpm 11 ignores the npm-shaped name and reads its own; pnpm 10 does the
    // opposite. A repo picks the version, so both have to name one directory.
    const env = packageCacheEnv(CONTAINER_CACHE_DIR);
    expect(env.PNPM_CONFIG_STORE_DIR).toBe(env.npm_config_store_dir);
  });

  test("names the store the run actually sees, container or host", () => {
    // The local sandbox runs the same turn against host paths, so the variables
    // have to name the host directory or every install writes somewhere it
    // cannot create.
    expect(packageCacheEnv("/data/caches").BUN_INSTALL_CACHE_DIR).toBe(
      "/data/caches/bun"
    );
  });

  test("every store is under the one mount, so one bind covers them all", () => {
    for (const value of Object.values(packageCacheEnv(CONTAINER_CACHE_DIR))) {
      expect(
        value === "true" || value.startsWith(`${CONTAINER_CACHE_DIR}/`)
      ).toBe(true);
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
      "global_artifacts",
      "workspace",
    ]);
  });

  test("reaches no task's artifacts and no project's, whatever it is handed", () => {
    // The type forbids naming them; this is the claim that no other code path
    // reintroduces one, which is what a reviewer of the security boundary asks.
    const purposes = managerMountsFor(managerSources, {
      agentMcpPath: null,
      entrypointPath: "/data/bin/turn.js",
      skillsDir: null,
    }).map((mount) => mount.purpose);
    expect(purposes).not.toContain("task_artifacts");
    expect(purposes).not.toContain("project_artifacts");
  });

  test("writes the workspace scope, which is the one flag a worker does not get", () => {
    // The manager is the role a human is talking to, it reads no untrusted
    // repository, and the house rules it is asked to edit live in that folder.
    const mounts = managerMountsFor(managerSources);
    const workspaceScope = byPurpose(mounts, "global_artifacts");
    expect(workspaceScope?.containerPath).toBe(CONTAINER_WORKSPACE_DIR);
    expect(workspaceScope?.hostPath).toBe(managerSources.globalArtifactsDir);
    expect(workspaceScope?.readOnly).toBe(false);
    expect(byPurpose(mountsFor(sources), "global_artifacts")?.readOnly).toBe(
      true
    );
  });

  test("works in a scratch directory under its own scope, and never in a project", () => {
    const scratch = byPurpose(managerMountsFor(managerSources), "workspace");
    expect(scratch?.containerPath).toBe(CONTAINER_MANAGER_SCRATCH_DIR);
    expect(scratch?.hostPath).toBe(managerSources.workspaceDir);
    expect(scratch?.readOnly).toBe(false);
    expect(scratch?.containerPath.startsWith(CONTAINER_WORKER_DIR)).toBe(false);
  });

  test("mounts nothing for the manager's rules, which sit inside the scope's bind", () => {
    const paths = managerMountsFor(managerSources).map(
      (mount) => mount.containerPath
    );
    expect(paths).not.toContain(CONTAINER_MANAGER_DIR);
  });

  test("the entrypoint is mounted read-only where the harness looks for it", () => {
    const mounts = managerMountsFor(managerSources, {
      agentMcpPath: null,
      entrypointPath: "/data/bin/turn.js",
      skillsDir: null,
    });
    const entrypoint = byPurpose(mounts, "entrypoint");
    expect(entrypoint?.containerPath).toBe(CONTAINER_ENTRYPOINT_PATH);
    expect(entrypoint?.readOnly).toBe(true);
  });

  test("a conversation gets the board tools, which is the role that lives on them", () => {
    const mounts = managerMountsFor(managerSources, {
      agentMcpPath: "/data/bin/agent-mcp.js",
      entrypointPath: null,
      skillsDir: null,
    });
    const bundle = byPurpose(mounts, "agent_mcp");
    expect(bundle?.containerPath).toBe(CONTAINER_AGENT_MCP_PATH);
    expect(bundle?.readOnly).toBe(true);
  });

  test("a conversation is given the operator's skills on the same terms", () => {
    const mounts = managerMountsFor(managerSources, {
      agentMcpPath: null,
      entrypointPath: null,
      skillsDir: "/home/op/.agents/skills",
    });
    const skills = byPurpose(mounts, "skills");
    expect(skills?.containerPath).toBe(CONTAINER_SKILLS_DIR);
    expect(skills?.readOnly).toBe(true);
  });

  test("the container sees its run directory where every other turn does", () => {
    expect(
      byPurpose(managerMountsFor(managerSources), "run")?.containerPath
    ).toBe(containerRunLayout.runDir);
  });
});

describe("mountArg", () => {
  test("uses --mount, which refuses a missing source instead of inventing one", () => {
    expect(
      mountArg({
        containerPath: "/workspace/worker/atlas/ship-it/atlas",
        hostPath: "/data/runs/r1/workspace",
        purpose: "workspace",
        readOnly: false,
      })
    ).toBe(
      "--mount=type=bind,src=/data/runs/r1/workspace,dst=/workspace/worker/atlas/ship-it/atlas"
    );
  });

  test("marks a read-only mount readonly", () => {
    expect(
      mountArg({
        containerPath: CONTAINER_WORKSPACE_DIR,
        hostPath: "/data/artifacts/global",
        purpose: "global_artifacts",
        readOnly: true,
      })
    ).toBe(
      "--mount=type=bind,src=/data/artifacts/global,dst=/workspace,readonly"
    );
  });
});
