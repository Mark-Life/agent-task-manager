/**
 * Every skill a run should see, gathered from the levels of its tree into one
 * directory of the run's own, so that the provider which cannot walk the tree is
 * handed the result of the walk.
 *
 * **Why one provider gets a copy and the other does not.** Codex collects
 * `.agents/skills` at every level of the tree already, because its root markers
 * point at the top of it — a person who drops a skill in the workspace folder
 * has given it to every Codex run with nothing else to do. Claude's project scan
 * runs from its working directory up to the *repository root* and stops there;
 * the working directory is the checkout, so every scope directory sits above the
 * stop and is never read. Its personal scan has no such stop: it reads
 * `$CLAUDE_CONFIG_DIR/skills`, which is `/agent-home/skills` in our containers,
 * whatever the working directory is. So the tree is walked here, on the host,
 * and the answer is put where the personal scan will find it.
 *
 * **Copied, never linked.** A symlink written on the host names a host path, and
 * the container's view of that path is different or absent — so the link dangles
 * exactly where it is supposed to work. Copying also leaves the composition
 * inspectable after the fact: the directory says what the run was really given,
 * rather than what a re-walk of the sources would say today.
 *
 * **Narrowest wins.** Sources are read broadest first — the agent home's own
 * skills, the operator's shared directory, then each scope from the workspace
 * down — and a name defined more than once resolves to the narrowest, which is
 * the direction every other rule in this tree resolves. A shadowed name is
 * logged, because a skill silently replaced by another of the same name is the
 * failure a person cannot see from either the source or the result.
 *
 * **Both spellings of a scope's skills are read.** The real files live at
 * `<scope>/{@link AGENT_SKILLS_DIR}/<name>` with a relative link beside them at
 * `<scope>/{@link CLAUDE_SKILLS_DIR}/<name>`, and a person may have written
 * either. Both are searched at the same level and the first spelling wins, so
 * the pair that is one skill is copied once rather than counted twice.
 *
 * **It cannot fail a run.** A scope with no skills, a directory that cannot be
 * read, a link with nothing behind it and a directory that is not a skill all
 * mean fewer skills. There is no error channel: the worst outcome is a run with
 * the skills it would have had before this existed.
 *
 * **It dies with the run.** The composition is derived and the sources are
 * durable, so it is released with the checkout rather than kept.
 *
 * **It is a sibling of the run directory and not a child of it**, which is the
 * one thing about its location that is load-bearing. The run directory is bound
 * read-write at `/run`, so a composition underneath it would be reachable in
 * writable form at `/run/skills` — and a run that can write there can hand
 * itself a skill mid-turn through a mount whose whole point is that it is
 * read-only. A sibling under the data root is bound nowhere else, so the only
 * view of it a container has is the read-only one.
 */

import { dirname, join } from "node:path";
import type { RunId } from "@workspace/domain";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { AGENT_HOME_SKILLS_SEGMENT } from "./mounts";
import { AGENT_SKILLS_DIR, CLAUDE_SKILLS_DIR, SKILL_FILE } from "./skills";

/**
 * Directory under the data root holding one composition per run.
 *
 * A sibling of `runs` and `workspaces` rather than a child of either, so that
 * nothing else in the mount set offers a writable view of it.
 */
export const COMPOSED_SKILLS_SEGMENT = "composed-skills";

/** Mode for the composed directory, matching every other directory a run is handed. */
export const COMPOSED_SKILLS_DIR_MODE = 0o755;

/**
 * The largest composition, across every skill in it.
 *
 * Skills are documents, and the largest single one this system will install is
 * four mebibytes — so sixteen holds a deep tree of them and still refuses a
 * directory somebody pointed at a dataset. Past it the remaining skills are
 * skipped with a warning rather than copied, because a run that quietly fills
 * the disk costs every later run on the host.
 */
export const COMPOSED_SKILLS_MAX_BYTES = 16_777_216;

/**
 * The levels a skill can come from, broadest first. Named rather than counted,
 * because the only thing anyone does with a level is read it in the line that
 * says which copy of a name won.
 */
export const SKILL_LEVELS = [
  "home",
  "shared",
  "workspace",
  "manager",
  "project",
  "task",
] as const;

/** Which level one skill came from. */
export type SkillLevel = (typeof SKILL_LEVELS)[number];

/** One scope of a run's tree, as a place to look for skills. */
export interface SkillScope {
  /** The scope's host directory — the one holding its instruction files. */
  readonly dir: string;
  readonly level: SkillLevel;
}

/** What one run's composition is built from. */
export interface SkillCompositionInput {
  /**
   * The provider's login directory on the host. Its own `skills` directory is
   * the broadest level, so an operator who kept skills where the vendor puts
   * them does not lose them the first time a scope defines one — the composed
   * mount lands on exactly that path.
   */
  readonly agentHomeDir: string;
  readonly dataRoot: string;
  /** Names this run's composition. It is made under the data root and dies with the run. */
  readonly runId: RunId;
  /** The scopes of the run's tree, broadest first. */
  readonly scopes: readonly SkillScope[];
  /** The skills directory the install shares with every run, or null when it names none. */
  readonly sharedSkillsDir: string | null;
}

/** One skill as it was composed. */
export interface ComposedSkill {
  readonly bytes: number;
  readonly level: SkillLevel;
  readonly name: string;
  /** The host directory it was copied from, with any link already resolved. */
  readonly source: string;
}

/** One name that was defined at more than one level, and how it resolved. */
export interface ShadowedSkill {
  /** The level that won, which is always the narrower one. */
  readonly by: SkillLevel;
  readonly name: string;
  /** The level whose copy is not in the composition. */
  readonly over: SkillLevel;
}

/** What one run was given, and where. */
export interface ComposedSkills {
  /**
   * The directory to mount, or null when the run was given no skills at all.
   *
   * Null exactly when {@link ComposedSkills.skills} is empty, and the two are
   * one decision rather than two: mounting an empty directory over the agent
   * home's own `skills` would hide the operator's skills behind nothing.
   */
  readonly dir: string | null;
  readonly shadowed: readonly ShadowedSkill[];
  /** In name order, which is the order they were copied in. */
  readonly skills: readonly ComposedSkill[];
  readonly totalBytes: number;
}

/** A run that composed nothing. What every failed lookup adds up to. */
const NOTHING_COMPOSED: ComposedSkills = {
  dir: null,
  shadowed: [],
  skills: [],
  totalBytes: 0,
};

/** Which run's composition, on the host. */
export interface ComposedSkillsDirInput {
  readonly dataRoot: string;
  readonly runId: RunId;
}

/**
 * The directory every composition is a child of. Read by `./sweep`: a
 * composition is scoped to its run exactly as a checkout is, so it is stranded
 * by the same ending and reclaimed by the same pass.
 */
export const composedSkillsRootOf = (dataRoot: string) =>
  join(dataRoot, COMPOSED_SKILLS_SEGMENT);

/** Where the composition is made: a sibling of the run's own directory, never a child. */
export const composedSkillsDirOf = (input: ComposedSkillsDirInput) =>
  join(composedSkillsRootOf(input.dataRoot), input.runId);

/**
 * The directories searched, in the order they are read: broadest first, and
 * both spellings of each scope's skills.
 *
 * Exported so a test can assert the order without a filesystem — the order is
 * the whole of the shadowing rule, and it is the thing a refactor would reverse
 * without any single case failing.
 */
export const skillSearchDirsOf = (
  input: SkillCompositionInput
): readonly SkillScope[] => [
  {
    dir: join(input.agentHomeDir, AGENT_HOME_SKILLS_SEGMENT),
    level: "home",
  },
  ...(input.sharedSkillsDir === null
    ? []
    : [{ dir: input.sharedSkillsDir, level: "shared" as const }]),
  ...input.scopes.flatMap((scope) => [
    { dir: join(scope.dir, AGENT_SKILLS_DIR), level: scope.level },
    { dir: join(scope.dir, CLAUDE_SKILLS_DIR), level: scope.level },
  ]),
];

/**
 * What is in one search directory, and nothing at all where there is no
 * directory to read.
 *
 * Silent about a directory that is not there, because that is the ordinary
 * case: most scopes define no skills, and a warning per level per run would be
 * noise around the one line that matters.
 */
const childrenOf = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem;
  return yield* fs
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
});

/** One skill's files, measured, before anything is copied. */
interface SkillContent {
  readonly bytes: number;
  /** Relative to the skill's own directory. Directories are not in it. */
  readonly files: readonly string[];
  /** The real directory the files are in, with any link resolved. */
  readonly source: string;
}

/**
 * One candidate directory read as a skill, or null when it is not one.
 *
 * `realPath` first, and it is doing two jobs: it follows the relative link a
 * scope may hold the skill under, and it is what fails on a link with nothing
 * behind it — which is the case that has to cost this run nothing but the skill
 * itself. A recursive listing does not descend into a symlinked directory, so
 * resolving here is also what makes the linked spelling readable at all.
 *
 * A directory with no {@link SKILL_FILE} is not a skill and is not copied. That
 * is the provider's own rule, and applying it here is what keeps the count and
 * the byte budget about skills rather than about whatever else somebody left in
 * the folder.
 */
const readSkill = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  const real = yield* fs.realPath(path).pipe(Effect.option);
  if (Option.isNone(real)) {
    yield* Effect.logWarning("skill not composed: nothing behind the path", {
      path,
    });
    return null;
  }
  const info = yield* fs.stat(real.value).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory") {
    return null;
  }
  const entries = yield* fs
    .readDirectory(real.value, { recursive: true })
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  const files: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const stat = yield* fs.stat(join(real.value, entry)).pipe(Effect.option);
    if (Option.isSome(stat) && stat.value.type === "File") {
      files.push(entry);
      bytes += Number(stat.value.size);
    }
  }
  return files.includes(SKILL_FILE)
    ? ({ bytes, files, source: real.value } satisfies SkillContent)
    : null;
});

/** One skill, chosen at a level, waiting to be copied. */
interface Candidate extends SkillContent {
  readonly level: SkillLevel;
}

/**
 * Every skill the sources hold, keyed by name and already resolved to the
 * narrowest level that defines it.
 *
 * Resolved before anything is copied, so the budget is spent on the skills the
 * run will actually be given rather than on copies a narrower level replaces a
 * moment later. Within one level the first spelling wins, which is what stops
 * the link beside a skill from counting as a second definition of it.
 */
const gatherSkills = Effect.fnUntraced(function* (
  input: SkillCompositionInput
) {
  const chosen = new Map<string, Candidate>();
  const shadowed: ShadowedSkill[] = [];
  for (const source of skillSearchDirsOf(input)) {
    for (const name of yield* childrenOf(source.dir)) {
      const previous = chosen.get(name);
      if (previous !== undefined && previous.level === source.level) {
        continue;
      }
      const content = yield* readSkill(join(source.dir, name));
      if (content === null) {
        continue;
      }
      if (previous !== undefined) {
        shadowed.push({ by: source.level, name, over: previous.level });
      }
      chosen.set(name, { ...content, level: source.level });
    }
  }
  return { chosen, shadowed };
});

/**
 * Copies one skill's files into the composition.
 *
 * Every file is best-effort: a file that cannot be read leaves a skill missing
 * a reference, which is worse than a whole skill and still better than a run
 * that will not start. The parent directory is made per file rather than from
 * the listing, because the listing carries no directories once the non-files
 * are dropped.
 */
const copySkill = Effect.fnUntraced(function* (input: {
  readonly content: SkillContent;
  readonly to: string;
}) {
  const fs = yield* FileSystem;
  yield* Effect.forEach(
    input.content.files,
    (file) => {
      const target = join(input.to, file);
      return fs
        .makeDirectory(dirname(target), {
          mode: COMPOSED_SKILLS_DIR_MODE,
          recursive: true,
        })
        .pipe(
          Effect.andThen(fs.copyFile(join(input.content.source, file), target)),
          Effect.tapError((cause) =>
            Effect.logWarning("skill file not composed", {
              cause,
              path: target,
            })
          ),
          Effect.ignore
        );
    },
    { discard: true }
  );
});

/**
 * Builds the run's skills directory and answers with what went into it.
 *
 * Total: the failure channel is `never`, because this is a run's skills and not
 * its work. Every source that cannot be read is one fewer skill and a line in
 * the log.
 *
 * The copy order is name order, so a composition that overruns the cap drops
 * the same skills on a rerun rather than whichever the filesystem listed last.
 */
export const composeSkills = Effect.fn("Skills.compose")(function* (
  input: SkillCompositionInput
) {
  const fs = yield* FileSystem;
  const { chosen, shadowed } = yield* gatherSkills(input);
  if (chosen.size === 0) {
    return NOTHING_COMPOSED;
  }

  const dir = composedSkillsDirOf({
    dataRoot: input.dataRoot,
    runId: input.runId,
  });
  const made = yield* fs
    .makeDirectory(dir, { mode: COMPOSED_SKILLS_DIR_MODE, recursive: true })
    .pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("skills not composed: no directory to compose into", {
          cause,
          path: dir,
        })
      ),
      Effect.option
    );
  if (Option.isNone(made)) {
    return NOTHING_COMPOSED;
  }

  const skills: ComposedSkill[] = [];
  let totalBytes = 0;
  for (const name of [...chosen.keys()].sort()) {
    const candidate = chosen.get(name);
    if (candidate === undefined) {
      continue;
    }
    if (totalBytes + candidate.bytes > COMPOSED_SKILLS_MAX_BYTES) {
      yield* Effect.logWarning(
        "skill left out of the composition: the run's skills are over the cap",
        {
          capBytes: COMPOSED_SKILLS_MAX_BYTES,
          name,
          skillBytes: candidate.bytes,
          totalBytes,
        }
      );
      continue;
    }
    yield* copySkill({ content: candidate, to: join(dir, name) });
    totalBytes += candidate.bytes;
    skills.push({
      bytes: candidate.bytes,
      level: candidate.level,
      name,
      source: candidate.source,
    });
  }

  if (shadowed.length > 0) {
    yield* Effect.logInfo("a skill of the same name is defined twice", {
      shadowed: shadowed.map(
        (entry) => `${entry.name}: ${entry.by} won over ${entry.over}`
      ),
    });
  }
  yield* Effect.annotateCurrentSpan({
    skillBytes: totalBytes,
    skillCount: skills.length,
  });
  return { dir, shadowed, skills, totalBytes } satisfies ComposedSkills;
});

/**
 * Removes the composition. Logged and swallowed on failure, like every teardown
 * of something derived: the sources are durable, so a directory left behind is
 * disk to reclaim rather than anything about how the run went.
 */
export const releaseComposedSkills = Effect.fnUntraced(function* (
  composed: ComposedSkills
) {
  const { dir } = composed;
  if (dir === null) {
    return;
  }
  const fs = yield* FileSystem;
  yield* fs.remove(dir, { force: true, recursive: true }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("composed skills not removed", { cause, path: dir })
    ),
    Effect.ignore
  );
});

/**
 * The composition, released when the caller's scope closes.
 *
 * The one shape a materializer should use: the directory is derived from
 * durable sources, so it belongs to the run exactly as the checkout does, and
 * pairing the two here is what stops a caller from keeping one and not the
 * other.
 */
export const composeSkillsScoped = (input: SkillCompositionInput) =>
  Effect.acquireRelease(composeSkills(input), releaseComposedSkills);
