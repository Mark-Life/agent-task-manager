/**
 * The file routes against a real directory, because every claim they make is
 * about a filesystem and a fake one would agree with whatever the code did.
 *
 * Two claims are being defended here and they pull in opposite directions.
 *
 * **The listing tells the truth about the tree.** A skill is one real directory
 * and one relative symlink pointing at it, so an answer that flattened the two
 * would show a person two copies of one thing and no way to know which an edit
 * lands in. A symlink lists as a symlink and says where it points.
 *
 * **Nothing reaches outside the scope it named.** The gateway runs on the host
 * as the loop user, which owns the whole data root, and a container with a
 * scope mounted read-write can plant a symlink in it at any time. So the
 * attacks are the real ones and each has its own test: `..`, an absolute path, a
 * NUL byte, a link planted inside the scope pointing out of it, and — the one a
 * check of the parent directory misses — a link whose target is only created
 * after everything has been checked.
 *
 * The first three are refused by the contract's own path schema rather than by
 * a handler, and the tests say so by decoding them: a rule the type carries is
 * a rule no route can forget, and a test that only exercised the handler would
 * not notice if the brand were ever dropped from a route.
 *
 * **A link a person makes is relative, and it points at one real file.** The
 * text on disk is read back with `readlink` rather than trusted from the
 * answer, because an absolute host path is the failure that would pass every
 * assertion about behaviour in the browser and reach nothing inside a
 * container. The refusals around it — a target outside the scope, a target in
 * the object store, a target that is not there, a target that is itself a link
 * — each have their own test.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { MAX_FILE_BYTES, type PrincipalShape } from "@workspace/api";
import {
  CurrentActor,
  ProjectRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { ensureFixtureWorkspace } from "@workspace/db/testing";
import type {
  FileScope,
  Project,
  ScopePath,
  Task,
  WorkspaceId,
} from "@workspace/domain";
import {
  Actor,
  newAgentSessionId,
  newRunId,
  ScopePath as ScopePathSchema,
  UserId,
} from "@workspace/domain";
import {
  fileScopeDirOf,
  ScopeHistory,
  taskArtifactsDirOf,
} from "@workspace/sandbox";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import {
  createScopeDirectory,
  deleteScopePath,
  linkScopePath,
  listScopeFiles,
  moveScopeFile,
  readScopeFile,
  writeScopeFile,
} from "./files";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-files-test";

const seeder = Actor.cases.system.make({ reason: APPLICATION_NAME });

/** The person browsing. Only a person reaches these routes at all. */
const person = {
  kind: "human",
  userId: UserId.make(APPLICATION_NAME),
} as const;

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    storeLayer({ applicationName: APPLICATION_NAME }),
    BunFileSystem.layer,
    ScopeHistory.editsLayer,
    CurrentActor.layer(seeder)
  )
);

let dataRoot: string;
let workspaceId: WorkspaceId;
let project: Project;
let task: Task;
let principal: PrincipalShape;

/** The workspace scope: the house rules every run of both roles walks past. */
const workspace: FileScope = { scope: "workspace" };

/** A path the schema has already accepted, as a route hands one to a handler. */
const at = (path: string) => Schema.decodeUnknownSync(ScopePathSchema)(path);

/**
 * A path the schema would never accept, forced past it.
 *
 * Only the symlink tests use this, and they have to: the attack is a path built
 * entirely of ordinary segments that lands outside the scope anyway, so there
 * is nothing for the schema to object to and the refusal has to come from the
 * handler resolving it through the disk.
 */
const forced = (path: string) => path as ScopePath;

const scopeDirOf = (scope: FileScope) => fileScopeDirOf({ dataRoot, scope });

/** Where a scope's files really live, made before the test plants anything in it. */
const madeScopeDir = (scope: FileScope) => {
  const dir = scopeDirOf(scope);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const listing = (input: { readonly path?: ScopePath; scope: FileScope }) =>
  runtime.runPromise(
    listScopeFiles({
      dataRoot,
      path: input.path,
      principal,
      scope: input.scope,
    })
  );

const reading = (input: { readonly path: ScopePath; scope: FileScope }) =>
  readScopeFile({ dataRoot, path: input.path, principal, scope: input.scope });

const writing = (input: {
  readonly content: string;
  readonly encoding?: "base64" | "utf8";
  readonly path: ScopePath;
  readonly scope: FileScope;
}) =>
  writeScopeFile({
    content: input.content,
    dataRoot,
    encoding: input.encoding ?? "utf8",
    path: input.path,
    principal,
    scope: input.scope,
  });

const linking = (input: {
  readonly path: ScopePath;
  readonly scope: FileScope;
  readonly target: ScopePath;
}) =>
  linkScopePath({
    dataRoot,
    path: input.path,
    principal,
    scope: input.scope,
    target: input.target,
  });

/**
 * Whether a name is there at all, a link pointing at nothing included.
 * `existsSync` follows the link and answers no, which is the wrong answer when
 * the question is whether a dangling link was left behind.
 */
const lstatExists = (path: string) =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** What `git log` says about the newest commit in a scope, or null where there is none. */
const lastCommit = (dir: string) => {
  const shown = spawnSync("git", ["log", "-1", "--format=%an%n%ae%n%s"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (shown.status !== 0) {
    return null;
  }
  const [name, email, subject] = shown.stdout.trim().split("\n");
  return { email, name, subject };
};

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "gateway-files-"));

  const built = await runtime.runPromise(
    Effect.gen(function* () {
      const fixture = yield* ensureFixtureWorkspace({
        suite: APPLICATION_NAME,
      });
      const scope = fixture.workspace.id;
      const projects = yield* ProjectRepo;
      const tasks = yield* TaskRepo;
      const made = yield* projects.create({
        name: "files: the endpoints",
        workspaceId: scope,
      });
      const card = yield* tasks.create({
        projectId: made.id,
        title: "files: browse and edit",
        workspaceId: scope,
      });
      return { card, made, workspaceId: scope };
    }).pipe(withActor(seeder))
  );

  ({ workspaceId } = built);
  project = built.made;
  task = built.card;
  principal = { actor: person, scope: "admin", workspaceId };
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const projects = yield* ProjectRepo;
      yield* tasks.delete({ id: task.id, workspaceId });
      yield* projects.delete({ id: project.id, workspaceId });
    }).pipe(withActor(person))
  );
  await runtime.dispose();
  rmSync(dataRoot, { force: true, recursive: true });
});

/**
 * The three string attacks, refused by the contract rather than by a handler.
 * Every route spells its path as this schema, so the refusal covers all six at
 * once and cannot be forgotten in one of them.
 */
test("the contract refuses a path that climbs, starts at the root, or carries a NUL", () => {
  const accepts = (path: string) =>
    Option.isSome(Schema.decodeUnknownOption(ScopePathSchema)(path));

  expect(accepts("../escaped.md")).toBe(false);
  expect(accepts("/etc/passwd")).toBe(false);
  expect(accepts("rules\u0000.md")).toBe(false);
  expect(accepts(".git/config")).toBe(false);
  expect(accepts("skills/writing/SKILL.md")).toBe(true);
});

test("a write lands in the scope it named and nowhere else", async () => {
  const body = "# House style\n\nPrefer a short comment with a link.\n";
  const entry = await runtime.runPromise(
    writing({ content: body, path: at("CLAUDE.md"), scope: workspace })
  );

  expect(entry.kind).toBe("file");
  expect(entry.bytes).toBe(Buffer.byteLength(body));
  expect(readFileSync(join(scopeDirOf(workspace), "CLAUDE.md"), "utf8")).toBe(
    body
  );
  expect(
    existsSync(
      join(taskArtifactsDirOf({ dataRoot, taskId: task.id }), "CLAUDE.md")
    )
  ).toBe(false);
});

/**
 * The claim requirement five makes: a person's edit is attributed the way a
 * run's is. The scope directories are git repositories whose history is the
 * audit trail, and an edit that left no commit would be the one change in the
 * folder nothing can attribute — or worse, would be folded into the next run's
 * snapshot and read as something that run did.
 */
test("a write into a git-backed scope leaves a commit authored by the person", async () => {
  await runtime.runPromise(
    writing({
      content: "Review twice before merging.\n",
      path: at("docs/conventions.md"),
      scope: { projectId: project.id, scope: "project" },
    })
  );

  const commit = lastCommit(
    scopeDirOf({ projectId: project.id, scope: "project" })
  );

  expect(commit?.subject).toContain("docs/conventions.md");
  expect(commit?.name).toBe(person.userId);
});

test("a listing tells a file from a directory from a symlink, and says where the link points", async () => {
  const dir = madeScopeDir({ scope: "manager" });
  mkdirSync(join(dir, ".agents/skills/writing"), { recursive: true });
  mkdirSync(join(dir, ".claude/skills"), { recursive: true });
  writeFileSync(join(dir, ".agents/skills/writing/SKILL.md"), "# Writing\n");
  symlinkSync(
    "../../.agents/skills/writing",
    join(dir, ".claude/skills/writing")
  );

  const entries = await listing({
    path: at(".claude/skills"),
    scope: { scope: "manager" },
  });

  expect(entries).toHaveLength(1);
  expect(entries[0]?.kind).toBe("symlink");
  expect(entries[0]?.target).toBe("../../.agents/skills/writing");
  expect(entries[0]?.targetOutsideScope).toBe(false);
  expect(entries[0]?.path).toBe(".claude/skills/writing");

  const real = await listing({
    path: at(".agents/skills/writing"),
    scope: { scope: "manager" },
  });
  expect(real[0]?.kind).toBe("file");
  expect(real[0]?.ext).toBe("md");
});

/**
 * The object store is the audit trail, so it is not part of the tree a person
 * browses. No path can address it either — the schema refuses a `.git` segment
 * — and a listing that showed it would offer thousands of files to click on.
 */
test("a listing keeps the scope's git directory out of the answer", async () => {
  const dir = madeScopeDir(workspace);
  mkdirSync(join(dir, ".git/objects"), { recursive: true });

  const entries = await listing({ scope: workspace });

  expect(entries.some((entry) => entry.name === ".git")).toBe(false);
});

/**
 * The refusal the schema cannot make. A `.git` segment is refused in the string
 * a caller types, and a link is the way around that: a run holds its project
 * scope read-write, so it can leave a link to the object store in the folder,
 * and every question about containment then answers "inside the scope" —
 * because it is. The commits are the record of who edited the rules that run
 * reads, so this is the one place inside a scope no route may reach.
 */
test("a link to the object store carries neither a read nor a write into it", async () => {
  const scope: FileScope = { projectId: project.id, scope: "project" };
  await runtime.runPromise(
    writing({ content: "Keep it short.\n", path: at("AGENTS.md"), scope })
  );
  const dir = scopeDirOf(scope);
  symlinkSync(".git", join(dir, "history"));

  const read = await runtime.runPromise(
    Effect.flip(reading({ path: forced("history/config"), scope }))
  );
  const written = await runtime.runPromise(
    Effect.flip(
      writing({
        content: "tampered\n",
        path: forced("history/description"),
        scope,
      })
    )
  );

  expect(read._tag).toBe("Forbidden");
  expect(written._tag).toBe("Forbidden");
  expect(readFileSync(join(dir, ".git/description"), "utf8")).not.toContain(
    "tampered"
  );
});

test("listing a path that is a file is refused rather than answered as empty", async () => {
  const dir = madeScopeDir({ scope: "task", taskId: task.id });
  writeFileSync(join(dir, "single.md"), "one\n");

  const refusal = await runtime.runPromise(
    Effect.flip(
      listScopeFiles({
        dataRoot,
        path: at("single.md"),
        principal,
        scope: { scope: "task", taskId: task.id },
      })
    )
  );

  expect(refusal._tag).toBe("InvalidInput");
});

test("text comes back as text and bytes that are not text come back base64", async () => {
  const dir = madeScopeDir({ scope: "task", taskId: task.id });
  writeFileSync(join(dir, "notes.md"), "plain\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  const scope: FileScope = { scope: "task", taskId: task.id };

  const text = await runtime.runPromise(
    reading({ path: at("notes.md"), scope })
  );
  const binary = await runtime.runPromise(
    reading({ path: at("blob.bin"), scope })
  );

  expect(text.encoding).toBe("utf8");
  expect(text.content).toBe("plain\n");
  expect(binary.encoding).toBe("base64");
  expect(binary.bytes).toBe(4);
  expect(Buffer.from(binary.content, "base64")).toEqual(
    Buffer.from([0xff, 0xfe, 0x00, 0x41])
  );
});

test("a file over the cap is refused rather than half-read", async () => {
  const dir = madeScopeDir({ scope: "task", taskId: task.id });
  writeFileSync(join(dir, "huge.log"), Buffer.alloc(MAX_FILE_BYTES + 1));

  const refusal = await runtime.runPromise(
    Effect.flip(
      reading({
        path: at("huge.log"),
        scope: { scope: "task", taskId: task.id },
      })
    )
  );

  expect(refusal._tag).toBe("PayloadTooLarge");
});

/**
 * The check a rule about strings cannot make. A path of ordinary segments still
 * lands outside the directory when one of them is a link, so the parent is
 * resolved through its links before anything is read or written.
 */
test("a symlink planted in the scope carries neither a read nor a write out of it", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-files-outside-"));
  writeFileSync(join(outside, "secret.env"), "TOKEN=hunter2\n");
  const dir = madeScopeDir(workspace);
  symlinkSync(outside, join(dir, "elsewhere"));

  const read = await runtime.runPromise(
    Effect.flip(
      reading({ path: forced("elsewhere/secret.env"), scope: workspace })
    )
  );
  const written = await runtime.runPromise(
    Effect.flip(
      writing({
        content: "planted",
        path: forced("elsewhere/rules.md"),
        scope: workspace,
      })
    )
  );

  expect(read._tag).toBe("Forbidden");
  expect(written._tag).toBe("Forbidden");
  expect(existsSync(join(outside, "rules.md"))).toBe(false);
  rmSync(outside, { force: true, recursive: true });
});

/**
 * The same attack one segment shorter, which a check of the parent alone lets
 * straight through: the link is the file being read, so its parent is the scope
 * root and every question about the parent answers "inside".
 */
test("a link that is itself the file does not carry a read out of the scope", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-files-direct-"));
  writeFileSync(join(outside, "secret.env"), "TOKEN=hunter2\n");
  const dir = madeScopeDir({ scope: "manager" });
  symlinkSync(join(outside, "secret.env"), join(dir, "pointer.env"));

  const refusal = await runtime.runPromise(
    Effect.flip(
      reading({ path: forced("pointer.env"), scope: { scope: "manager" } })
    )
  );

  expect(refusal._tag).toBe("Forbidden");
  rmSync(outside, { force: true, recursive: true });
});

/**
 * The attack a check of the parent directory misses entirely.
 *
 * The link's own parent is the scope root, so every question about where the
 * parent is answers "inside". The link itself is what leaves, and its target
 * does not exist when the check runs — so nothing about the disk is wrong until
 * the moment the target appears and the write follows it. The refusal cannot
 * depend on the target existing: these routes never write through a link.
 */
test("a symlink whose target appears after the check still does not carry a write out", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-files-late-"));
  const dir = madeScopeDir(workspace);
  symlinkSync(join(outside, "late.md"), join(dir, "late.md"));

  const dangling = await runtime.runPromise(
    Effect.flip(
      writing({ content: "first", path: forced("late.md"), scope: workspace })
    )
  );

  // The race the attacker is running: the target arrives between the check and
  // the write. Refusing the link itself is what makes the ordering irrelevant.
  writeFileSync(join(outside, "late.md"), "");
  const landed = await runtime.runPromise(
    Effect.flip(
      writing({ content: "second", path: forced("late.md"), scope: workspace })
    )
  );

  expect(dangling._tag).toBe("Forbidden");
  expect(landed._tag).toBe("Forbidden");
  expect(readFileSync(join(outside, "late.md"), "utf8")).toBe("");
  rmSync(outside, { force: true, recursive: true });
});

test("a directory is created with its parents, and a move renames inside the scope", async () => {
  const scope: FileScope = { scope: "task", taskId: task.id };

  const made = await runtime.runPromise(
    createScopeDirectory({
      dataRoot,
      path: at("reports/2026"),
      principal,
      scope,
    })
  );
  await runtime.runPromise(
    writing({ content: "draft\n", path: at("reports/2026/draft.md"), scope })
  );
  const moved = await runtime.runPromise(
    moveScopeFile({
      dataRoot,
      from: at("reports/2026/draft.md"),
      principal,
      scope,
      to: at("reports/2026/final.md"),
    })
  );

  expect(made.kind).toBe("directory");
  expect(moved.path).toBe("reports/2026/final.md");
  const dir = scopeDirOf(scope);
  expect(existsSync(join(dir, "reports/2026/draft.md"))).toBe(false);
  expect(readFileSync(join(dir, "reports/2026/final.md"), "utf8")).toBe(
    "draft\n"
  );
});

/**
 * The whole point of the link route, and the one thing it could get wrong
 * invisibly.
 *
 * `AGENTS.md` holds a rule and `CLAUDE.md` points at it, because neither
 * provider reads the other's name. What is on disk has to be the relative path
 * from the link's own directory — an absolute host path would resolve for the
 * person who made it in the browser and reach nothing at all inside a
 * container, where the scope is a bind mount at a different address.
 */
test("a link is written relative to its own directory and reads as the target", async () => {
  const scope: FileScope = { scope: "manager" };
  const body = "Say the thing itself.\n";
  await runtime.runPromise(
    writing({ content: body, path: at("AGENTS.md"), scope })
  );

  const entry = await runtime.runPromise(
    linking({ path: at("CLAUDE.md"), scope, target: at("AGENTS.md") })
  );

  const dir = scopeDirOf(scope);
  expect(entry.kind).toBe("symlink");
  expect(entry.target).toBe("AGENTS.md");
  expect(entry.targetOutsideScope).toBe(false);
  expect(readlinkSync(join(dir, "CLAUDE.md"))).toBe("AGENTS.md");
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe(body);
});

/** A link deeper in the tree climbs back with `..` rather than naming a root. */
test("a link two directories down points back up through the scope", async () => {
  const scope: FileScope = { scope: "manager" };
  const dir = madeScopeDir(scope);
  mkdirSync(join(dir, ".agents/skills/reviewing"), { recursive: true });
  writeFileSync(
    join(dir, ".agents/skills/reviewing/SKILL.md"),
    "# Reviewing\n"
  );

  await runtime.runPromise(
    linking({
      path: at(".claude/skills/reviewing"),
      scope,
      target: at(".agents/skills/reviewing"),
    })
  );

  expect(readlinkSync(join(dir, ".claude/skills/reviewing"))).toBe(
    "../../.agents/skills/reviewing"
  );
  expect(
    readFileSync(join(dir, ".claude/skills/reviewing/SKILL.md"), "utf8")
  ).toBe("# Reviewing\n");
});

/** A link is an edit, and an edit in a shared scope is attributed like any other. */
test("a link in a git-backed scope lands in that scope's history", async () => {
  const scope: FileScope = { projectId: project.id, scope: "project" };
  await runtime.runPromise(
    linking({ path: at("CLAUDE.md"), scope, target: at("AGENTS.md") })
  );

  const commit = lastCommit(scopeDirOf(scope));

  expect(commit?.subject).toBe("link CLAUDE.md -> AGENTS.md");
  expect(commit?.name).toBe(person.userId);
});

/**
 * The containment, asked of the target rather than of the link. A path of
 * ordinary segments still lands outside the scope when one of them is a link a
 * run planted, and a link this route wrote to it would be a permanent door.
 */
test("a link whose target resolves outside the scope is refused", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-files-link-out-"));
  writeFileSync(join(outside, "secret.env"), "TOKEN=hunter2\n");
  const scope: FileScope = { scope: "task", taskId: task.id };
  const dir = madeScopeDir(scope);
  symlinkSync(outside, join(dir, "planted"));

  const refusal = await runtime.runPromise(
    Effect.flip(
      linking({
        path: at("secrets.env"),
        scope,
        target: forced("planted/secret.env"),
      })
    )
  );

  expect(refusal._tag).toBe("Forbidden");
  expect(existsSync(join(dir, "secrets.env"))).toBe(false);
  rmSync(outside, { force: true, recursive: true });
});

/**
 * The object store is the record of who changed the rules a run reads. The
 * schema refuses the segment in a string; a link somebody planted is the way
 * around that, and pointing a second link at it would put the audit trail back
 * inside the tree a person edits.
 */
test("a link whose target resolves into the object store is refused", async () => {
  const scope: FileScope = { projectId: project.id, scope: "project" };
  const dir = scopeDirOf(scope);
  symlinkSync(".git", join(dir, "objects-link"));

  const refusal = await runtime.runPromise(
    Effect.flip(
      linking({
        path: at("head.txt"),
        scope,
        target: forced("objects-link/HEAD"),
      })
    )
  );

  expect(refusal._tag).toBe("Forbidden");
  expect(existsSync(join(dir, "head.txt"))).toBe(false);
});

/**
 * A dangling link is a rule that quietly reaches nothing, and it is also how
 * the containment above would be sidestepped: a target created after the check
 * is a target this process never resolved.
 */
test("a link whose target is not there is refused rather than left dangling", async () => {
  const scope: FileScope = { scope: "task", taskId: task.id };

  const refusal = await runtime.runPromise(
    Effect.flip(
      linking({ path: at("ghost.md"), scope, target: at("nowhere.md") })
    )
  );

  expect(refusal._tag).toBe("NotFound");
  expect(lstatExists(join(scopeDirOf(scope), "ghost.md"))).toBe(false);
});

/** One hop, so a listing always says what a name ends up at. */
test("a link cannot point at another link", async () => {
  const scope: FileScope = { scope: "task", taskId: task.id };
  await runtime.runPromise(
    writing({ content: "the rule\n", path: at("chain/real.md"), scope })
  );
  await runtime.runPromise(
    linking({ path: at("chain/first.md"), scope, target: at("chain/real.md") })
  );

  const refusal = await runtime.runPromise(
    Effect.flip(
      linking({
        path: at("chain/second.md"),
        scope,
        target: at("chain/first.md"),
      })
    )
  );

  expect(refusal._tag).toBe("InvalidInput");
  expect(existsSync(join(scopeDirOf(scope), "chain/second.md"))).toBe(false);
});

/** A read follows a link that lands back inside the scope. That is what one file under two names is. */
test("reading a link answers with the target's bytes", async () => {
  const scope: FileScope = { scope: "task", taskId: task.id };
  await runtime.runPromise(
    writing({ content: "two names\n", path: at("named/AGENTS.md"), scope })
  );
  await runtime.runPromise(
    linking({
      path: at("named/CLAUDE.md"),
      scope,
      target: at("named/AGENTS.md"),
    })
  );

  const content = await runtime.runPromise(
    reading({ path: at("named/CLAUDE.md"), scope })
  );

  expect(content.encoding).toBe("utf8");
  expect(content.content).toBe("two names\n");
});

/**
 * A link to a directory is the shape a skill is installed in, and the one where
 * a recursive delete that followed the link would take the skill with it.
 */
test("deleting a link to a directory removes the name and leaves the directory", async () => {
  const scope: FileScope = { scope: "task", taskId: task.id };
  await runtime.runPromise(
    writing({ content: "# Writing\n", path: at("kept/SKILL.md"), scope })
  );
  await runtime.runPromise(
    linking({ path: at("shortcut"), scope, target: at("kept") })
  );

  await runtime.runPromise(
    deleteScopePath({ dataRoot, path: at("shortcut"), principal, scope })
  );

  const dir = scopeDirOf(scope);
  expect(lstatExists(join(dir, "shortcut"))).toBe(false);
  expect(readFileSync(join(dir, "kept/SKILL.md"), "utf8")).toBe("# Writing\n");
});

/** A move takes the link, not the file it names. */
test("moving a link moves the name and leaves the target where it is", async () => {
  const scope: FileScope = { scope: "task", taskId: task.id };
  await runtime.runPromise(
    writing({ content: "held\n", path: at("moved/AGENTS.md"), scope })
  );
  await runtime.runPromise(
    linking({
      path: at("moved/CLAUDE.md"),
      scope,
      target: at("moved/AGENTS.md"),
    })
  );

  const entry = await runtime.runPromise(
    moveScopeFile({
      dataRoot,
      from: at("moved/CLAUDE.md"),
      principal,
      scope,
      to: at("moved/CODEX.md"),
    })
  );

  const dir = scopeDirOf(scope);
  expect(entry.kind).toBe("symlink");
  expect(readlinkSync(join(dir, "moved/CODEX.md"))).toBe("AGENTS.md");
  expect(readFileSync(join(dir, "moved/AGENTS.md"), "utf8")).toBe("held\n");
});

test("deleting a link unlinks it and leaves what it pointed at alone", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-files-keep-"));
  writeFileSync(join(outside, "kept.md"), "kept\n");
  const dir = madeScopeDir({ scope: "task", taskId: task.id });
  symlinkSync(join(outside, "kept.md"), join(dir, "pointer.md"));

  await runtime.runPromise(
    deleteScopePath({
      dataRoot,
      path: at("pointer.md"),
      principal,
      scope: { scope: "task", taskId: task.id },
    })
  );

  expect(existsSync(join(dir, "pointer.md"))).toBe(false);
  expect(readFileSync(join(outside, "kept.md"), "utf8")).toBe("kept\n");
  rmSync(outside, { force: true, recursive: true });
});

/**
 * A scope is an address, and an address that names nothing is a 404 rather than
 * an empty folder — which would read as "this project has no files" for a
 * project id that was never in this workspace.
 */
test("a scope naming a project this workspace does not have is a 404", async () => {
  const refusal = await runtime.runPromise(
    Effect.flip(
      listScopeFiles({
        dataRoot,
        principal,
        scope: { projectId: task.id as never, scope: "project" },
      })
    )
  );

  expect(refusal._tag).toBe("NotFound");
});

/**
 * The property the whole arrangement rests on, checked past the door as well as
 * at it.
 *
 * A run's credential is minted at `task-write` and the contract asks these
 * routes for `admin`, so the middleware refuses one before a handler is
 * reached. This is the second answer to the same question: the writer itself
 * refuses an actor that is not a person, so a route wired to the wrong
 * middleware some later day still cannot let a run rewrite the rules it is
 * handed or install a skill for itself.
 */
test("a run's own credential cannot write a scope even past the middleware", async () => {
  const asRun = {
    actor: Actor.cases.worker_run.make({
      runId: newRunId(),
      sessionId: newAgentSessionId(),
      taskId: task.id,
    }),
    scope: "task-write",
    workspaceId,
  } as const satisfies PrincipalShape;

  const refusal = await runtime.runPromise(
    Effect.flip(
      writeScopeFile({
        content: "# rewritten by a run\n",
        dataRoot,
        encoding: "utf8",
        path: at("rewritten-by-a-run.md"),
        principal: asRun,
        scope: workspace,
      })
    )
  );

  expect(refusal._tag).toBe("Forbidden");
  expect(existsSync(join(scopeDirOf(workspace), "rewritten-by-a-run.md"))).toBe(
    false
  );
});

/**
 * The manager's folder is a plain subdirectory of the workspace one rather than
 * a mount of its own, so on a fresh install nothing has made it yet. A first
 * write has to create it: refusing with a 404 would tell a person the one scope
 * they are most likely to write first does not exist.
 */
test("the manager's own folder is created by the first write into it", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "gateway-files-fresh-"));
  const manager: FileScope = { scope: "manager" };

  const entry = await runtime.runPromise(
    writeScopeFile({
      content: "# Manager\n",
      dataRoot: fresh,
      encoding: "utf8",
      path: at("AGENTS.md"),
      principal,
      scope: manager,
    })
  );

  expect(entry.kind).toBe("file");
  expect(
    readFileSync(
      join(fileScopeDirOf({ dataRoot: fresh, scope: manager }), "AGENTS.md"),
      "utf8"
    )
  ).toBe("# Manager\n");
  rmSync(fresh, { force: true, recursive: true });
});
