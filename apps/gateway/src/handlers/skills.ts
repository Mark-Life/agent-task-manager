/**
 * Installing a skill, which is to say writing files into a scope and recording
 * where they came from.
 *
 * **Nothing here is a new way into a directory.** Every path this writes goes
 * through the same resolver the file routes use — the string is contained
 * against the scope's real root, the deepest existing ancestor is resolved
 * through its links, and a last segment that is a symbolic link is refused
 * rather than followed. A second containment written for skills would be a
 * second chance to get it subtly wrong, and this one is already the answer for
 * six other operations.
 *
 * **One copy, two names, and the link is relative.** The real files land under
 * `.agents/skills/<name>` and `.claude/skills/<name>` is a link holding
 * `../../.agents/skills/<name>`. Both directories sit at the same scope inside
 * the same bind mount, so a relative link resolves inside a container while an
 * absolute one would name a host path no container can see.
 *
 * **Codex reads them; Claude does not.** Claude's project-skill scan runs from
 * the working directory up to the repository root and stops, and the working
 * directory is the checkout — so every scope directory is above the stop, and
 * Claude keeps getting the operator's personal skills from the `/agent-home`
 * mount. The layout is still the right one, because Claude follows symlinked
 * skill directories and deduplicates by target, so the day a per-run skills
 * directory is composed nothing written here has to move.
 *
 * **A worker run cannot reach any of this**, and the reason is about the run
 * rather than about skills. A run installing a skill mid-task is one run
 * changing what every later run on the board is given, with no author and
 * nobody's agreement; a person installs whatever they like. Admin is how the
 * token machinery states that, since an agent credential's ceiling is
 * `task-write`.
 *
 * The fetch, the hash, the lock format and the comparison are
 * `@workspace/sandbox`'s. What is decided here is who may call them, how their
 * failures reach the wire, and the order the disk is touched in.
 */

import { join } from "node:path";
import {
  Api,
  type InstalledSkill,
  InvalidInput,
  NotFound,
  Principal,
  type SkillUpdate,
} from "@workspace/api";
import type { ProjectRepo, TaskRepo } from "@workspace/db";
import {
  relativePathRefusalOf,
  type SkillLockEntry,
  SkillName,
  type SkillSourcePath,
} from "@workspace/domain";
import {
  compareSkillFiles,
  EMPTY_SKILLS_LOCK,
  fetchSkillFiles,
  parseSkillsLock,
  type ScopeHistory,
  SKILLS_LOCK_FILE,
  type SkillFile,
  type SkillSourceUnreadable,
  type SkillsLock,
  serializeSkillsLock,
  skillPathsOf,
  withoutSkill,
  withSkill,
} from "@workspace/sandbox";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { atBuild } from "./at-build";
import { commitEdit, dataRootConfig, editorOf } from "./files";
import {
  makeParent,
  refuseLink,
  resolveInScope,
  type ScopeRequest,
  scopeRootOf,
} from "./scope-paths";

/** The clone URL a lock row's `owner/repo` names. The lock stores no URL, so this rebuilds one. */
const repoUrlOf = (source: string) => `https://github.com/${source}`;

/** One skill in one scope: everything but the source, which the lock holds. */
interface SkillRequest extends ScopeRequest {
  /** Overridden by a test; production talks to GitHub. */
  readonly apiOrigin?: string;
  readonly name: SkillName;
}

/**
 * The source's refusal, as an answer.
 *
 * A GitHub that did not answer dies rather than becoming a 422: the caller did
 * nothing wrong and there is nothing to correct in the request, so it belongs in
 * the ledger as a fault of this process's dependencies. Everything else is
 * about what was asked for and says so.
 */
const asWireFailure = (
  failure: SkillSourceUnreadable
): Effect.Effect<never, InvalidInput | NotFound> => {
  if (failure.reason === "not_found") {
    return Effect.fail(
      new NotFound({ entity: "skill source", id: failure.detail })
    );
  }
  return failure.reason === "unreachable"
    ? Effect.die(failure)
    : Effect.fail(
        new InvalidInput({ detail: failure.detail, entity: "skill" })
      );
};

/** The lock a scope holds, or the 422 for a file that is not one. */
const readLock = Effect.fnUntraced(function* (root: string) {
  const target = yield* resolveInScope({ path: SKILLS_LOCK_FILE, root });
  yield* refuseLink(target);
  if (target.real === null) {
    return EMPTY_SKILLS_LOCK;
  }
  const fs = yield* FileSystem;
  const text = yield* fs.readFileString(target.absolute).pipe(Effect.orDie);
  const lock = parseSkillsLock(text);
  if (lock === null) {
    // Refused rather than replaced. Overwriting it would erase the record of
    // every skill the scope has, and the file is editable through the file
    // routes by whoever is being told this.
    return yield* Effect.fail(
      new InvalidInput({
        detail: `${SKILLS_LOCK_FILE} in this scope is not a skills lock`,
        entity: "skill",
      })
    );
  }
  return lock;
});

/** Writes the lock back, sorted, through the same containment every other path uses. */
const writeLock = Effect.fnUntraced(function* (input: {
  readonly lock: SkillsLock;
  readonly root: string;
}) {
  const target = yield* resolveInScope({
    path: SKILLS_LOCK_FILE,
    root: input.root,
  });
  yield* refuseLink(target);
  const fs = yield* FileSystem;
  yield* fs
    .writeFileString(target.absolute, serializeSkillsLock(input.lock))
    .pipe(Effect.orDie);
});

/**
 * The real files a skill's directory holds now, named the way the source names
 * them.
 *
 * Symbolic links are skipped rather than read. A link planted inside a skill's
 * directory points wherever a run wanted it to, and this process reads with the
 * host's reach — so what it would put in an update's diff is whatever that link
 * names. A directory that is not there reads as no files, which is what an
 * install into a fresh scope is.
 */
const installedFilesOf = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem;
  const names = yield* fs
    .readDirectory(directory, { recursive: true })
    .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
  const files: SkillFile[] = [];
  for (const name of names) {
    const absolute = join(directory, name);
    const link = yield* fs.readLink(absolute).pipe(Effect.option);
    if (link._tag === "Some") {
      continue;
    }
    const info = yield* fs.stat(absolute).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") {
      continue;
    }
    const bytes = yield* fs.readFile(absolute).pipe(Effect.orDie);
    files.push({ bytes, path: name });
  }
  return files as readonly SkillFile[];
});

/**
 * The skill's own directory on disk, proved to be inside the scope before
 * anything reads it.
 *
 * The name is branded and cannot climb, which contains the string — but
 * `.agents` or `.agents/skills` could itself be a link a run planted, and this
 * process reads with the host's reach. So the deepest existing ancestor is
 * resolved through its links like every other path here, and a skills directory
 * that *is* a link is refused rather than followed: reading through one would
 * put whatever it names into an update's diff.
 */
const skillDirectoryOf = Effect.fnUntraced(function* (input: {
  /** Scope-relative, as {@link skillPathsOf} spells it. */
  readonly directory: string;
  readonly root: string;
}) {
  const target = yield* resolveInScope({
    path: input.directory,
    root: input.root,
  });
  yield* refuseLink(target);
  return target.absolute;
});

/** One file of a skill, written where the layout says it goes. */
const writeSkillFile = Effect.fnUntraced(function* (input: {
  readonly directory: string;
  readonly file: SkillFile;
  readonly root: string;
}) {
  // The path came off somebody else's repository, so it is checked here as well
  // as by the resolver below: `..` or a `.git` segment in a remote listing is a
  // repository asking to be written outside the directory it was fetched into.
  if (relativePathRefusalOf(input.file.path) !== null) {
    return yield* Effect.fail(
      new InvalidInput({
        detail: `the source holds a file this cannot write: ${input.file.path}`,
        entity: "skill",
      })
    );
  }
  const target = yield* resolveInScope({
    path: join(input.directory, input.file.path),
    root: input.root,
  });
  yield* refuseLink(target);
  yield* makeParent({ absolute: target.absolute, root: input.root });
  const fs = yield* FileSystem;
  yield* fs.writeFile(target.absolute, input.file.bytes).pipe(Effect.orDie);
});

/**
 * Removes what the source no longer has.
 *
 * An update that only wrote would leave a document a skill no longer refers to
 * sitting beside the one that replaced it, and a reader — a model, following
 * the `SKILL.md` — has no way to tell which is current. Only real files are
 * pruned: a link somebody planted is left where it is, visible in the file
 * browser, rather than followed or deleted by this. A directory the last file
 * left is kept too — git records files, so an empty directory is nothing the
 * scope's history would show anybody, and removing one is a walk this does not
 * need to do.
 */
const pruneSkillDir = Effect.fnUntraced(function* (input: {
  readonly directory: string;
  readonly incoming: readonly SkillFile[];
  readonly root: string;
}) {
  const directory = yield* skillDirectoryOf({
    directory: input.directory,
    root: input.root,
  });
  const installed = yield* installedFilesOf(directory);
  const keep = new Set(input.incoming.map((file) => file.path));
  const fs = yield* FileSystem;
  for (const file of installed) {
    if (keep.has(file.path)) {
      continue;
    }
    const target = yield* resolveInScope({
      path: join(input.directory, file.path),
      root: input.root,
    });
    yield* fs.remove(target.absolute, { force: true }).pipe(Effect.orDie);
  }
});

/**
 * Points `.claude/skills/<name>` at the real directory, with a relative link.
 *
 * A link already holding the right target is left alone, so a reinstall makes
 * no change for the scope's history to record. A link holding something else is
 * replaced — the link itself is removed, never followed. Anything that is not a
 * link is refused: a real directory under that name is somebody's own file, and
 * deleting it to make room for ours would destroy work no history holds.
 */
const linkSkill = Effect.fnUntraced(function* (input: {
  readonly name: SkillName;
  readonly root: string;
}) {
  const paths = skillPathsOf(input.name);
  const target = yield* resolveInScope({ path: paths.link, root: input.root });
  if (target.link === paths.linkTarget) {
    return;
  }
  const fs = yield* FileSystem;
  if (target.link === null && target.real !== null) {
    return yield* Effect.fail(
      new InvalidInput({
        detail: `${paths.link} already exists and is not a link`,
        entity: "skill",
      })
    );
  }
  if (target.link !== null) {
    yield* fs.remove(target.absolute, { force: true }).pipe(Effect.orDie);
  }
  yield* makeParent({ absolute: target.absolute, root: input.root });
  yield* fs.symlink(paths.linkTarget, target.absolute).pipe(Effect.orDie);
});

/** What a skill looks like to a caller: the lock's four fields, plus where it really is. */
const describeSkill = Effect.fnUntraced(function* (input: {
  readonly entry: SkillLockEntry;
  readonly name: SkillName;
  readonly root: string;
}) {
  const paths = skillPathsOf(input.name);
  const fs = yield* FileSystem;
  const directory = yield* fs
    .stat(join(input.root, paths.directory))
    .pipe(Effect.option);
  const link = yield* fs
    .readLink(join(input.root, paths.link))
    .pipe(Effect.option);
  return {
    ...input.entry,
    directory: paths.directory,
    link: paths.link,
    linked: link._tag === "Some" && link.value === paths.linkTarget,
    name: input.name,
    present: directory._tag === "Some" && directory.value.type === "Directory",
  } satisfies InstalledSkill;
});

/**
 * Writes one skill's files, prunes what the source dropped, links it, and
 * records it in the lock.
 *
 * Files first and the lock last, on the same reasoning a promotion writes bytes
 * before it writes a row: a lock naming a skill whose files are not there is a
 * claim about the scope that is false, while files with no lock row are visible
 * in the tree and are recorded by the next write.
 */
const materializeSkill = Effect.fnUntraced(function* (input: {
  readonly entry: SkillLockEntry;
  readonly files: readonly SkillFile[];
  readonly lock: SkillsLock;
  readonly name: SkillName;
  readonly root: string;
}) {
  const paths = skillPathsOf(input.name);
  for (const file of input.files) {
    yield* writeSkillFile({
      directory: paths.directory,
      file,
      root: input.root,
    });
  }
  yield* pruneSkillDir({
    directory: paths.directory,
    incoming: input.files,
    root: input.root,
  });
  yield* linkSkill({ name: input.name, root: input.root });
  yield* writeLock({
    lock: withSkill({ entry: input.entry, lock: input.lock, name: input.name }),
    root: input.root,
  });
  return yield* describeSkill({
    entry: input.entry,
    name: input.name,
    root: input.root,
  });
});

/** The lock's row for one skill, or the 404 for a name nothing installed. */
const lockedSkill = (input: {
  readonly lock: SkillsLock;
  readonly name: SkillName;
}) => {
  const entry = input.lock.skills[input.name];
  return entry === undefined
    ? Effect.fail(new NotFound({ entity: "skill", id: input.name }))
    : Effect.succeed(entry);
};

/** The name a source suggests, decoded — or the 422 asking for one that works. */
const nameOf = (suggested: string) =>
  Schema.decodeEffect(SkillName)(suggested).pipe(
    Effect.mapError(
      () =>
        new InvalidInput({
          detail: `the directory holding the skill is named ${suggested}, which is not a usable skill name — give one`,
          entity: "skill",
        })
    )
  );

/**
 * A key of the lock, decoded — or the 422 for a lock somebody hand-edited into
 * naming a skill no path can reach.
 *
 * Loud rather than skipped. This file is written by these routes and read by
 * nobody else, so a key that is not a name means somebody edited it by hand and
 * is better told than left with a row that quietly vanished.
 */
const lockedName = (name: string) =>
  Schema.decodeEffect(SkillName)(name).pipe(
    Effect.mapError(
      () =>
        new InvalidInput({
          detail: `${SKILLS_LOCK_FILE} names a skill this cannot address: ${name}`,
          entity: "skill",
        })
    )
  );

/**
 * What one scope has installed, in name order.
 *
 * The lock is the list, and the disk is what each row is checked against: a
 * person who deleted a skill's directory through the file routes should see a
 * row saying the skill is gone rather than a row that pretends otherwise.
 */
export const listSkills = Effect.fn("Gateway.skills.list")(function* (
  input: ScopeRequest
) {
  const root = yield* scopeRootOf({ create: false, request: input });
  const lock = yield* readLock(root);
  const names = Object.keys(lock.skills).sort();
  const skills = yield* Effect.forEach(names, (name) =>
    Effect.flatMap(lockedName(name), (decoded) =>
      Effect.flatMap(lockedSkill({ lock, name: decoded }), (entry) =>
        describeSkill({ entry, name: decoded, root })
      )
    )
  );
  yield* Effect.annotateCurrentSpan({
    scope: input.scope.scope,
    skills: skills.length,
  });
  return skills;
});

/**
 * Fetches a skill and writes it into the scope.
 *
 * The network first, the disk second: a repository that cannot be read leaves
 * the scope exactly as it was, rather than half a skill and a lock row nobody
 * asked for.
 *
 * A directory the lock does not know about is refused rather than replaced.
 * That is a skill somebody wrote by hand — the file routes create the same
 * layout — and its bytes exist nowhere else.
 */
export const installSkill = Effect.fn("Gateway.skills.install")(function* (
  input: ScopeRequest & {
    readonly apiOrigin?: string;
    readonly name?: SkillName | undefined;
    readonly path: SkillSourcePath;
    readonly repoUrl: string;
  }
) {
  const committer = yield* editorOf(input.principal);
  const fetched = yield* fetchSkillFiles({
    apiOrigin: input.apiOrigin,
    path: input.path,
    repoUrl: input.repoUrl,
  }).pipe(Effect.catch(asWireFailure));
  const name = input.name ?? (yield* nameOf(fetched.name));

  const root = yield* scopeRootOf({ create: true, request: input });
  const lock = yield* readLock(root);
  const paths = skillPathsOf(name);
  if (lock.skills[name] === undefined) {
    const fs = yield* FileSystem;
    const standing = yield* fs
      .exists(join(root, paths.directory))
      .pipe(Effect.orDie);
    if (standing) {
      return yield* Effect.fail(
        new InvalidInput({
          detail: `${paths.directory} already exists and no lock row claims it`,
          entity: "skill",
        })
      );
    }
  }

  const skill = yield* materializeSkill({
    entry: {
      computedHash: fetched.hash,
      skillPath: fetched.skillPath,
      source: fetched.source,
      sourceType: "github",
    },
    files: fetched.files,
    lock,
    name,
    root,
  });
  yield* commitEdit({
    committer,
    dataRoot: input.dataRoot,
    operation: "install skill",
    path: name,
    scope: input.scope,
  });
  yield* Effect.annotateCurrentSpan({
    files: fetched.files.length,
    scope: input.scope.scope,
  });
  return skill;
});

/**
 * Asks the source what it holds now and answers with the difference. Writes
 * nothing.
 *
 * The installed side is read off the disk rather than trusted from the lock, so
 * a skill a run edited by hand shows those edits as changes about to be
 * overwritten — which is exactly what somebody accepting an update needs to
 * see.
 */
export const checkSkillUpdate = Effect.fn("Gateway.skills.checkUpdate")(
  function* (input: SkillRequest) {
    const root = yield* scopeRootOf({ create: false, request: input });
    const lock = yield* readLock(root);
    const entry = yield* lockedSkill({ lock, name: input.name });
    const fetched = yield* fetchSkillFiles({
      apiOrigin: input.apiOrigin,
      path: entry.skillPath,
      repoUrl: repoUrlOf(entry.source),
    }).pipe(Effect.catch(asWireFailure));
    const installed = yield* installedFilesOf(
      yield* skillDirectoryOf({
        directory: skillPathsOf(input.name).directory,
        root,
      })
    );
    const changed = fetched.hash !== entry.computedHash;
    yield* Effect.annotateCurrentSpan({ changed, scope: input.scope.scope });
    return {
      changed,
      currentHash: entry.computedHash,
      files: compareSkillFiles({ incoming: fetched.files, installed }),
      latestHash: fetched.hash,
      name: input.name,
    } satisfies SkillUpdate;
  }
);

/**
 * Writes the update somebody reviewed.
 *
 * The hash from that review is quoted back and the source is asked again, so a
 * repository that moved in between is refused rather than written. Without it
 * this route would be "fetch whatever is there now", which is the thing having
 * two calls exists to prevent.
 */
export const applySkillUpdate = Effect.fn("Gateway.skills.applyUpdate")(
  function* (input: SkillRequest & { readonly expectedHash: string }) {
    const committer = yield* editorOf(input.principal);
    const root = yield* scopeRootOf({ create: true, request: input });
    const lock = yield* readLock(root);
    const entry = yield* lockedSkill({ lock, name: input.name });
    const fetched = yield* fetchSkillFiles({
      apiOrigin: input.apiOrigin,
      path: entry.skillPath,
      repoUrl: repoUrlOf(entry.source),
    }).pipe(Effect.catch(asWireFailure));
    if (fetched.hash !== input.expectedHash) {
      return yield* Effect.fail(
        new InvalidInput({
          detail:
            "the source has changed since that update was reviewed — check it again",
          entity: "skill",
        })
      );
    }

    const skill = yield* materializeSkill({
      entry: { ...entry, computedHash: fetched.hash },
      files: fetched.files,
      lock,
      name: input.name,
      root,
    });
    yield* commitEdit({
      committer,
      dataRoot: input.dataRoot,
      operation: "update skill",
      path: input.name,
      scope: input.scope,
    });
    return skill;
  }
);

/**
 * Removes a skill's files, its link and its lock row in one act.
 *
 * All three, because any one of them left behind is a scope that lies: a lock
 * row with no directory, or a link pointing at nothing a provider will report
 * as a broken skill.
 */
export const uninstallSkill = Effect.fn("Gateway.skills.uninstall")(function* (
  input: SkillRequest
) {
  const committer = yield* editorOf(input.principal);
  const root = yield* scopeRootOf({ create: false, request: input });
  const lock = yield* readLock(root);
  const paths = skillPathsOf(input.name);
  const directory = yield* resolveInScope({ path: paths.directory, root });
  if (lock.skills[input.name] === undefined && directory.real === null) {
    return yield* Effect.fail(
      new NotFound({ entity: "skill", id: input.name })
    );
  }

  const fs = yield* FileSystem;
  // The link is unlinked rather than followed, and the directory is removed
  // with what is under it — which is the skill.
  yield* fs
    .remove(directory.absolute, { force: true, recursive: true })
    .pipe(Effect.orDie);
  const link = yield* resolveInScope({ path: paths.link, root });
  yield* fs.remove(link.absolute, { force: true }).pipe(Effect.orDie);
  yield* writeLock({ lock: withoutSkill({ lock, name: input.name }), root });
  yield* commitEdit({
    committer,
    dataRoot: input.dataRoot,
    operation: "uninstall skill",
    path: input.name,
    scope: input.scope,
  });
});

/** The `skills` group: five operations, a lock per scope, and a person on the other end. */
export const skillsHandlers = HttpApiBuilder.group(Api, "skills", (handlers) =>
  Effect.gen(function* () {
    const dataRoot = yield* Effect.orDie(dataRootConfig);
    const on = yield* atBuild<
      FileSystem | ProjectRepo | ScopeHistory | TaskRepo
    >();

    return handlers.handleAll({
      applyUpdate: ({ params, payload }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            applySkillUpdate({
              dataRoot,
              expectedHash: payload.expectedHash,
              name: params.name,
              principal,
              scope: params.scope,
            })
          )
        ),
      checkUpdate: ({ params }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            checkSkillUpdate({
              dataRoot,
              name: params.name,
              principal,
              scope: params.scope,
            })
          )
        ),
      install: ({ params, payload }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            installSkill({
              dataRoot,
              name: payload.name,
              path: payload.path,
              principal,
              repoUrl: payload.repoUrl,
              scope: params.scope,
            })
          )
        ),
      list: ({ params }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            listSkills({ dataRoot, principal, scope: params.scope })
          )
        ),
      uninstall: ({ params }) =>
        on(
          Effect.flatMap(Principal, (principal) =>
            uninstallSkill({
              dataRoot,
              name: params.name,
              principal,
              scope: params.scope,
            })
          )
        ),
    });
  })
);
