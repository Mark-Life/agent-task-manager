/**
 * What this file defends: the promise that putting a skill in a folder gives it
 * to every agent that folder covers, on the provider that cannot walk the tree
 * itself.
 *
 * Three of these go wrong silently rather than loudly. A name defined twice
 * resolving the wrong way gives a run somebody else's instructions under the
 * name it asked for; a broken link or an unreadable folder taking the run down
 * with it turns a typo into a dead dispatch; and a composition that outlives its
 * run leaves the next one reading a copy of something a person has since
 * changed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { newRunId } from "@workspace/domain";
import { Effect } from "effect";
import {
  COMPOSED_SKILLS_MAX_BYTES,
  type ComposedSkills,
  composedSkillsDirOf,
  composeSkills,
  composeSkillsScoped,
  type SkillCompositionInput,
  skillSearchDirsOf,
} from "./composed-skills";
import { type MountSources, mountsFor } from "./mounts";
import { AGENT_SKILLS_DIR, CLAUDE_SKILLS_DIR, SKILL_FILE } from "./skills";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** A host directory under the temporary root, made on demand. */
const dir = (...names: readonly string[]) => {
  const path = join(root, ...names);
  mkdirSync(path, { recursive: true });
  return path;
};

/** Writes a real skill into a scope's `.agents/skills`, and answers with its directory. */
const writeSkill = (input: {
  readonly body?: string;
  readonly name: string;
  readonly scope: string;
}) => {
  const path = join(input.scope, AGENT_SKILLS_DIR, input.name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, SKILL_FILE), input.body ?? `# ${input.name}\n`);
  return path;
};

/** Writes a skill into a plain directory of skills — the operator's, or the agent home's. */
const writeLooseSkill = (input: {
  readonly dir: string;
  readonly name: string;
}) => {
  const path = join(input.dir, input.name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, SKILL_FILE), `# ${input.name}\n`);
  return path;
};

/** The relative link a scope carries beside a skill, exactly as the routes write it. */
const linkSkill = (input: {
  readonly name: string;
  readonly scope: string;
}) => {
  const links = join(input.scope, CLAUDE_SKILLS_DIR);
  mkdirSync(links, { recursive: true });
  symlinkSync(
    `../../${AGENT_SKILLS_DIR}/${input.name}`,
    join(links, input.name)
  );
};

/** One id for the composition under test, so its directory is nameable twice. */
const runId = newRunId();

/** The four levels of a worker run, over real directories. */
const inputOf = (): SkillCompositionInput => ({
  agentHomeDir: dir("agent-home"),
  dataRoot: dir("data"),
  runId,
  scopes: [
    { dir: dir("global"), level: "workspace" },
    { dir: dir("project"), level: "project" },
    { dir: dir("task"), level: "task" },
  ],
  sharedSkillsDir: dir("operator-skills"),
});

const compose = (input: SkillCompositionInput) =>
  Effect.runPromise(
    composeSkills(input).pipe(Effect.provide(BunFileSystem.layer))
  );

/** The scope at one level, as the input records it. */
const scopeAt = (input: SkillCompositionInput, level: string) => {
  const found = input.scopes.find((scope) => scope.level === level);
  if (found === undefined) {
    throw new Error(`no ${level} scope`);
  }
  return found.dir;
};

/** What one composed skill's `SKILL.md` says, which is how a level is told apart. */
const bodyOf = (composed: ComposedSkills, name: string) =>
  readFileSync(join(composed.dir as string, name, SKILL_FILE), "utf8");

describe("where the composition looks", () => {
  test("reads broadest first, and both spellings of every scope", () => {
    const input = inputOf();

    const dirs = skillSearchDirsOf(input).map((source) => source.level);

    expect(dirs).toEqual([
      "home",
      "shared",
      "workspace",
      "workspace",
      "project",
      "project",
      "task",
      "task",
    ]);
  });

  test("reads a scope's real files before the links beside them", () => {
    const input = inputOf();
    const workspace = scopeAt(input, "workspace");

    const [real, link] = skillSearchDirsOf(input).filter(
      (source) => source.level === "workspace"
    );

    expect(real?.dir).toBe(join(workspace, AGENT_SKILLS_DIR));
    expect(link?.dir).toBe(join(workspace, CLAUDE_SKILLS_DIR));
  });
});

describe("what a run is given", () => {
  test("gathers every level into one directory", async () => {
    const input = inputOf();
    writeSkill({ name: "house-style", scope: scopeAt(input, "workspace") });
    writeSkill({ name: "deploy", scope: scopeAt(input, "project") });
    writeSkill({ name: "csv-export", scope: scopeAt(input, "task") });
    writeLooseSkill({ dir: input.sharedSkillsDir as string, name: "review" });

    const composed = await compose(input);

    expect(composed.dir).toBe(composedSkillsDirOf(input));
    expect(composed.skills.map((skill) => skill.name)).toEqual([
      "csv-export",
      "deploy",
      "house-style",
      "review",
    ]);
    expect(readdirSync(composed.dir as string).sort()).toEqual([
      "csv-export",
      "deploy",
      "house-style",
      "review",
    ]);
  });

  test("resolves a name defined twice to the narrowest level, and says so", async () => {
    const input = inputOf();
    writeSkill({
      body: "# from the workspace\n",
      name: "review",
      scope: scopeAt(input, "workspace"),
    });
    writeSkill({
      body: "# from the task\n",
      name: "review",
      scope: scopeAt(input, "task"),
    });

    const composed = await compose(input);

    expect(bodyOf(composed, "review")).toBe("# from the task\n");
    expect(composed.skills.map((skill) => [skill.name, skill.level])).toEqual([
      ["review", "task"],
    ]);
    // The source is named so a person can open the folder the bytes came from.
    // Compared by tail, because the real path a link resolves to is the host's
    // canonical one and the temporary root is behind a symlink on macOS.
    expect(
      composed.skills[0]?.source.endsWith("/task/.agents/skills/review")
    ).toBe(true);
    // The line a person needs when a skill they wrote is not the one that ran.
    expect(composed.shadowed).toEqual([
      { by: "task", name: "review", over: "workspace" },
    ]);
  });

  test("counts the link beside a skill as the skill it points at, not as a second one", async () => {
    const input = inputOf();
    const workspace = scopeAt(input, "workspace");
    writeSkill({ name: "house-style", scope: workspace });
    linkSkill({ name: "house-style", scope: workspace });

    const composed = await compose(input);

    expect(composed.skills.map((skill) => skill.name)).toEqual(["house-style"]);
    expect(composed.shadowed).toEqual([]);
  });

  test("reads a skill a scope holds only under the link's name", async () => {
    const input = inputOf();
    const project = scopeAt(input, "project");
    const elsewhere = join(root, "elsewhere", "handover");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, SKILL_FILE), "# handover\n");
    mkdirSync(join(project, CLAUDE_SKILLS_DIR), { recursive: true });
    symlinkSync(elsewhere, join(project, CLAUDE_SKILLS_DIR, "handover"));

    const composed = await compose(input);

    expect(composed.skills.map((skill) => skill.name)).toEqual(["handover"]);
    expect(bodyOf(composed, "handover")).toBe("# handover\n");
  });

  test("copies the whole skill, not only its SKILL.md", async () => {
    const input = inputOf();
    const skill = writeSkill({
      name: "research",
      scope: scopeAt(input, "task"),
    });
    mkdirSync(join(skill, "references"), { recursive: true });
    writeFileSync(join(skill, "references", "sources.md"), "one\n");

    const composed = await compose(input);

    expect(
      readFileSync(
        join(composed.dir as string, "research", "references", "sources.md"),
        "utf8"
      )
    ).toBe("one\n");
  });

  /**
   * A link on the host names a host path, and the container's view of that path
   * is different or absent — so a composition of links would dangle exactly
   * where it is meant to work.
   */
  test("copies rather than links, so the container can follow what it is given", async () => {
    const input = inputOf();
    const source = writeSkill({
      name: "house-style",
      scope: scopeAt(input, "workspace"),
    });

    const composed = await compose(input);
    rmSync(source, { force: true, recursive: true });

    expect(bodyOf(composed, "house-style")).toBe("# house-style\n");
  });
});

describe("what cannot fail a run", () => {
  test("a tree with no skills at all is no mount rather than an empty one", async () => {
    const input = inputOf();

    const composed = await compose(input);

    // Null on purpose: an empty directory bound over the agent home's own
    // `skills` would hide the operator's skills behind nothing.
    expect(composed.dir).toBe(null);
    expect(composed.skills).toEqual([]);
    expect(existsSync(composedSkillsDirOf(input))).toBe(false);
  });

  /**
   * The mount lands on the agent home's own skills directory, so an operator
   * who kept skills where the vendor puts them would lose them the first time a
   * scope defined one. The home is the broadest level instead.
   */
  test("keeps the agent home's own skills, which the mount would otherwise hide", async () => {
    const input = inputOf();
    writeLooseSkill({ dir: dir("agent-home", "skills"), name: "vendor" });
    writeSkill({ name: "csv-export", scope: scopeAt(input, "task") });

    const composed = await compose(input);

    expect(composed.skills.map((skill) => skill.level)).toEqual([
      "task",
      "home",
    ]);
  });

  test("a link with nothing behind it costs that skill and nothing else", async () => {
    const input = inputOf();
    const task = scopeAt(input, "task");
    writeSkill({ name: "csv-export", scope: task });
    mkdirSync(join(task, CLAUDE_SKILLS_DIR), { recursive: true });
    symlinkSync(
      "../../.agents/skills/deleted",
      join(task, CLAUDE_SKILLS_DIR, "deleted")
    );

    const composed = await compose(input);

    expect(composed.skills.map((skill) => skill.name)).toEqual(["csv-export"]);
  });

  test("a scope directory that is not there is simply a level with nothing in it", async () => {
    const input = inputOf();
    writeSkill({ name: "deploy", scope: scopeAt(input, "project") });
    rmSync(scopeAt(input, "task"), { force: true, recursive: true });

    const composed = await compose(input);

    expect(composed.skills.map((skill) => skill.name)).toEqual(["deploy"]);
  });

  test("a directory with no SKILL.md is not a skill and is not copied", async () => {
    const input = inputOf();
    mkdirSync(join(scopeAt(input, "task"), AGENT_SKILLS_DIR, "notes"), {
      recursive: true,
    });
    writeFileSync(
      join(scopeAt(input, "task"), AGENT_SKILLS_DIR, "notes", "README.md"),
      "not a skill\n"
    );

    const composed = await compose(input);

    expect(composed.dir).toBe(null);
  });
});

describe("the cap", () => {
  test("leaves out what does not fit rather than filling the disk", async () => {
    const input = inputOf();
    const half = Math.ceil(COMPOSED_SKILLS_MAX_BYTES / 2) + 1;
    // Two of these fit nowhere together, and neither is close to the cap alone
    // — the case a per-skill check would wave through.
    writeSkill({
      body: "x".repeat(half),
      name: "aardvark",
      scope: scopeAt(input, "workspace"),
    });
    writeSkill({
      body: "y".repeat(half),
      name: "zebra",
      scope: scopeAt(input, "task"),
    });

    const composed = await compose(input);

    // Name order, so a rerun drops the same one rather than whichever the
    // filesystem listed last.
    expect(composed.skills.map((skill) => skill.name)).toEqual(["aardvark"]);
    expect(composed.totalBytes).toBe(half);
    expect(existsSync(join(composed.dir as string, "zebra"))).toBe(false);
  });
});

describe("what the run sees", () => {
  test("mounts the composition read-only where a provider reads its own skills", () => {
    const sources: MountSources = {
      agentHomeDir: "/home/op/.claude-task-management",
      cacheDir: "/data/caches",
      composedSkillsDir: "/data/composed-skills/r1",
      globalArtifactsDir: "/data/artifacts/global",
      labels: { project: null, repo: null, task: "Ship it" },
      projectArtifactsDir: null,
      runDir: "/data/runs/r1",
      taskArtifactsDir: "/data/artifacts/tasks/t1",
      workspaceDir: "/data/workspaces/r1",
    };

    const skills = mountsFor(sources).find(
      (mount) => mount.purpose === "skills"
    );

    expect(skills?.hostPath).toBe("/data/composed-skills/r1");
    expect(skills?.readOnly).toBe(true);
    // Outside the run directory, which is the whole reason it is there: `/run`
    // is bound read-write, so a composition underneath it would be writable
    // through a second path and the read-only flag would buy nothing.
    expect(skills?.hostPath.startsWith("/data/runs/")).toBe(false);
  });

  test("is gone when the run's scope closes, because the sources are the durable copy", async () => {
    const input = inputOf();
    writeSkill({ name: "house-style", scope: scopeAt(input, "workspace") });

    const composedDir = await Effect.runPromise(
      Effect.scoped(
        Effect.map(composeSkillsScoped(input), (composed) => {
          expect(existsSync(composed.dir as string)).toBe(true);
          return composed.dir as string;
        })
      ).pipe(Effect.provide(BunFileSystem.layer))
    );

    expect(existsSync(composedDir)).toBe(false);
    // The source is untouched: what died is a copy.
    expect(
      existsSync(
        join(scopeAt(input, "workspace"), AGENT_SKILLS_DIR, "house-style")
      )
    ).toBe(true);
  });
});
