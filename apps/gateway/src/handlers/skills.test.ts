/**
 * Installing a skill, against a real directory and a real HTTP server, because
 * every claim these routes make is about bytes on a disk that came off a
 * network.
 *
 * Four claims are defended here.
 *
 * **The layout is one copy under two names, and the link is relative.** A skill
 * is real files at `.agents/skills/<name>` and a symbolic link at
 * `.claude/skills/<name>` holding `../../.agents/skills/<name>`. The link text
 * is asserted, not only that the link resolves: an absolute host path resolves
 * perfectly well on this machine and names nothing inside a container, which is
 * a failure no test on the host would otherwise see.
 *
 * **The lock is the four fields the repository's own `skills-lock.json`
 * carries.** Exactly four, so the two files stay one format.
 *
 * **An update is a comparison somebody reads.** A source that changed reports a
 * new hash and names the files, and applying with a hash from an older review
 * is refused rather than written.
 *
 * **Nothing a source says decides where bytes land.** A name that is a path and
 * a `SKILL.md` above the repository root are both refused — the first two at
 * the contract's own schemas, which is where a rule no route can forget lives.
 *
 * **Nothing the scope's own disk says does either.** A run holds its scopes
 * read-write and the gateway holds the host's reach, so a skills directory
 * replaced by a link out of the scope is the one escape no string check can see.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import type { PrincipalShape } from "@workspace/api";
import {
  CurrentActor,
  storeLayer,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import type { FileScope, SkillName, WorkspaceId } from "@workspace/domain";
import {
  Actor,
  SkillName as SkillNameSchema,
  SkillSourcePath,
  UserId,
} from "@workspace/domain";
import { fileScopeDirOf, ScopeHistory } from "@workspace/sandbox";
import { serve } from "bun";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import {
  applySkillUpdate,
  checkSkillUpdate,
  installSkill,
  listSkills,
  uninstallSkill,
} from "./skills";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-skills-test";

/** The database has never been seeded, so there is no workspace to scope a principal to. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "SkillsTest.NoWorkspace",
  { detail: Schema.String }
) {}

const seeder = Actor.cases.system.make({ reason: APPLICATION_NAME });

/** The person installing. Only a person reaches these routes at all. */
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
let principal: PrincipalShape;
let server: ReturnType<typeof serve> | null = null;

/** The house rules directory, which is the scope every one of these installs into. */
const workspace: FileScope = { scope: "workspace" };

/** The repository the fake contents API answers for. */
const REPO_URL = "https://github.com/acme/skills";

/** Where the `SKILL.md` sits in it. */
const SKILL_PATH = "skills/writing/SKILL.md";

/** A path the schema has already accepted, as a route hands one to a handler. */
const sourcePath = (path: string) =>
  Schema.decodeUnknownSync(SkillSourcePath)(path);

/** A name the schema has already accepted. */
const skillName = (name: string) =>
  Schema.decodeUnknownSync(SkillNameSchema)(name);

/** A value the schema would never accept, forced past it, to prove the handler refuses it too. */
const forcedPath = (path: string) => path as ReturnType<typeof sourcePath>;

const scopeDir = () => fileScopeDirOf({ dataRoot, scope: workspace });

/**
 * A repository, as the contents API answers for it: a listing per directory and
 * raw bytes per file, which is exactly the two shapes the fetch asks for.
 */
const serveSkillRepo = (files: Record<string, string>) => {
  server?.stop(true);
  const prefix = "/repos/acme/skills/contents/";
  server = serve({
    fetch: (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(prefix)) {
        return new Response("not found", { status: 404 });
      }
      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("raw")) {
        const body = files[path];
        return body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(body);
      }
      const seen = new Map<string, unknown>();
      for (const [held, body] of Object.entries(files)) {
        if (!held.startsWith(`${path}/`)) {
          continue;
        }
        const rest = held.slice(path.length + 1);
        const at = rest.indexOf("/");
        if (at === -1) {
          seen.set(rest, {
            name: rest,
            path: held,
            size: Buffer.byteLength(body),
            type: "file",
          });
          continue;
        }
        const directory = rest.slice(0, at);
        seen.set(directory, {
          name: directory,
          path: `${path}/${directory}`,
          type: "dir",
        });
      }
      return seen.size === 0
        ? new Response("not found", { status: 404 })
        : Response.json([...seen.values()]);
    },
    port: 0,
  });
  return `http://127.0.0.1:${server.port}`;
};

const installing = (input: {
  readonly apiOrigin: string;
  readonly name?: SkillName;
  readonly path?: ReturnType<typeof sourcePath>;
}) =>
  installSkill({
    apiOrigin: input.apiOrigin,
    dataRoot,
    name: input.name,
    path: input.path ?? sourcePath(SKILL_PATH),
    principal,
    repoUrl: REPO_URL,
    scope: workspace,
  });

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "gateway-skills-"));
  workspaceId = await runtime.runPromise(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepo;
      const [first] = yield* workspaces.list();
      return first === undefined
        ? yield* Effect.fail(
            new NoWorkspace({ detail: "run `bun run db:seed` first" })
          )
        : first.id;
    }).pipe(withActor(seeder))
  );
  principal = { actor: person, scope: "admin", workspaceId };
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(scopeDir(), { force: true, recursive: true });
});

afterAll(async () => {
  await runtime.dispose();
  rmSync(dataRoot, { force: true, recursive: true });
});

test("an install writes the real files once and links them with a relative path", async () => {
  const apiOrigin = serveSkillRepo({
    "skills/writing/references/style.md": "Short sentences.\n",
    "skills/writing/SKILL.md": "# Writing\n\nSay it once.\n",
  });

  const skill = await runtime.runPromise(installing({ apiOrigin }));

  const dir = scopeDir();
  expect(skill.name).toBe(skillName("writing"));
  expect(skill.directory).toBe(".agents/skills/writing");
  expect(skill.present).toBe(true);
  expect(skill.linked).toBe(true);
  expect(
    readFileSync(join(dir, ".agents/skills/writing/SKILL.md"), "utf8")
  ).toBe("# Writing\n\nSay it once.\n");
  expect(
    readFileSync(
      join(dir, ".agents/skills/writing/references/style.md"),
      "utf8"
    )
  ).toBe("Short sentences.\n");

  // The link text itself, not only that it resolves: an absolute host path
  // resolves on this machine and names nothing a container can see.
  const link = join(dir, ".claude/skills/writing");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe("../../.agents/skills/writing");
  expect(readFileSync(join(link, "SKILL.md"), "utf8")).toBe(
    "# Writing\n\nSay it once.\n"
  );
});

/** What `git log` says about the newest commit in a scope, or null where there is none. */
const lastCommit = (dir: string) => {
  const shown = spawnSync("git", ["log", "-1", "--format=%an%n%s"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (shown.status !== 0) {
    return null;
  }
  const [name, subject] = shown.stdout.trim().split("\n");
  return { name, subject };
};

test("the lock records the four fields, and the list reads them back", async () => {
  const apiOrigin = serveSkillRepo({
    "skills/writing/SKILL.md": "# Writing\n",
  });

  const installed = await runtime.runPromise(installing({ apiOrigin }));
  const written = JSON.parse(
    readFileSync(join(scopeDir(), "skills-lock.json"), "utf8")
  );
  const listed = await runtime.runPromise(
    listSkills({ dataRoot, principal, scope: workspace })
  );

  expect(written.version).toBe(1);
  expect(Object.keys(written.skills.writing).sort()).toEqual([
    "computedHash",
    "skillPath",
    "source",
    "sourceType",
  ]);
  expect(written.skills.writing.source).toBe("acme/skills");
  expect(written.skills.writing.skillPath).toBe(SKILL_PATH);
  expect(written.skills.writing.sourceType).toBe("github");
  expect(listed).toHaveLength(1);
  expect(listed[0]?.computedHash).toBe(installed.computedHash);
  expect(listed[0]?.linked).toBe(true);

  // The scope is a git repository whose history is the audit trail, so an
  // install is attributed the way a hand edit and a run's write are.
  const commit = lastCommit(scopeDir());
  expect(commit?.subject).toBe("install skill writing");
  expect(commit?.name).toBe(person.userId);
});

test("an update reports the changed hash, and applying a stale one is refused", async () => {
  const apiOrigin = serveSkillRepo({
    "skills/writing/references/style.md": "Short sentences.\n",
    "skills/writing/SKILL.md": "# Writing\n",
  });
  const installed = await runtime.runPromise(installing({ apiOrigin }));

  // The source moves: one file rewritten, one dropped.
  const moved = serveSkillRepo({
    "skills/writing/SKILL.md": "# Writing\n\nSay it once.\n",
  });
  const name = skillName("writing");
  const update = await runtime.runPromise(
    checkSkillUpdate({
      apiOrigin: moved,
      dataRoot,
      name,
      principal,
      scope: workspace,
    })
  );

  expect(update.changed).toBe(true);
  expect(update.currentHash).toBe(installed.computedHash);
  expect(update.latestHash).not.toBe(installed.computedHash);
  expect(update.files.find((file) => file.path === "SKILL.md")).toMatchObject({
    content: "# Writing\n\nSay it once.\n",
    status: "changed",
  });
  expect(
    update.files.find((file) => file.path === "references/style.md")?.status
  ).toBe("removed");

  const stale = await runtime.runPromise(
    Effect.flip(
      applySkillUpdate({
        apiOrigin: moved,
        dataRoot,
        expectedHash: installed.computedHash,
        name,
        principal,
        scope: workspace,
      })
    )
  );
  expect(stale._tag).toBe("InvalidInput");

  const applied = await runtime.runPromise(
    applySkillUpdate({
      apiOrigin: moved,
      dataRoot,
      expectedHash: update.latestHash,
      name,
      principal,
      scope: workspace,
    })
  );

  expect(applied.computedHash).toBe(update.latestHash);
  const dir = scopeDir();
  expect(
    readFileSync(join(dir, ".agents/skills/writing/SKILL.md"), "utf8")
  ).toBe("# Writing\n\nSay it once.\n");
  // Pruned, because the source no longer has it and the review said so.
  expect(
    existsSync(join(dir, ".agents/skills/writing/references/style.md"))
  ).toBe(false);
});

/**
 * The rule that keeps one skill's files inside one skill's directory. It is
 * carried by the type every route spells its name with, so no route can forget
 * it — and a source offering a name that is not one is refused rather than
 * having a directory invented for it.
 */
test("a skill name that is a path, or a hidden directory, is not a name", async () => {
  const accepts = (name: string) =>
    Option.isSome(Schema.decodeUnknownOption(SkillNameSchema)(name));

  expect(accepts("../evil")).toBe(false);
  expect(accepts("nested/skill")).toBe(false);
  expect(accepts(".git")).toBe(false);
  expect(accepts("")).toBe(false);
  expect(accepts("quality-code")).toBe(true);

  const apiOrigin = serveSkillRepo({
    "skills/not a name!/SKILL.md": "# Nameless\n",
  });
  const refusal = await runtime.runPromise(
    Effect.flip(
      installing({
        apiOrigin,
        path: sourcePath("skills/not a name!/SKILL.md"),
      })
    )
  );

  expect(refusal._tag).toBe("InvalidInput");
});

/**
 * A path is joined to somebody else's repository, so it is refused by the
 * contract and again by the fetch — the second one matters because a path that
 * climbs would otherwise be sent to GitHub with this system's own credential on
 * it.
 */
test("a SKILL.md path that leaves the repository it named is refused twice", async () => {
  const accepts = (path: string) =>
    Option.isSome(Schema.decodeUnknownOption(SkillSourcePath)(path));

  expect(accepts("../../secrets/SKILL.md")).toBe(false);
  expect(accepts("/etc/passwd")).toBe(false);
  expect(accepts("skills/writing/SKILL.md")).toBe(true);

  const apiOrigin = serveSkillRepo({
    "skills/writing/SKILL.md": "# Writing\n",
  });
  const refusal = await runtime.runPromise(
    Effect.flip(
      installing({
        apiOrigin,
        path: forcedPath("../../secrets/SKILL.md"),
      })
    )
  );

  expect(refusal._tag).toBe("InvalidInput");
  expect(existsSync(join(scopeDir(), ".agents/skills"))).toBe(false);
});

/**
 * The one destructive case worth a test of its own: a skill somebody wrote by
 * hand has bytes that exist nowhere else, and an install that silently replaced
 * it would destroy them with no history to recover from.
 */
test("an install refuses a directory the lock does not know about", async () => {
  const dir = scopeDir();
  mkdirSync(join(dir, ".agents/skills/writing"), { recursive: true });
  const apiOrigin = serveSkillRepo({
    "skills/writing/SKILL.md": "# Writing\n",
  });

  const refusal = await runtime.runPromise(
    Effect.flip(installing({ apiOrigin }))
  );

  expect(refusal._tag).toBe("InvalidInput");
});

/**
 * The attack the source cannot mount and the disk can. A worker holds its task
 * and project scopes read-write, so it can leave `.agents/skills -> /somewhere`
 * in one and every string this route composes still reads as a path inside the
 * scope. The gateway runs on the host with the whole data root's reach, so an
 * install that followed that link would write a skill wherever the run chose —
 * and then hand it to every later run as house rules.
 */
test("an install refuses a scope whose skills directory is a link out", async () => {
  const outside = mkdtempSync(join(tmpdir(), "gateway-skills-out-"));
  const dir = scopeDir();
  mkdirSync(join(dir, ".agents"), { recursive: true });
  symlinkSync(outside, join(dir, ".agents/skills"));
  const apiOrigin = serveSkillRepo({
    "skills/writing/SKILL.md": "# Writing\n",
  });

  const refusal = await runtime.runPromise(
    Effect.flip(installing({ apiOrigin }))
  );

  expect(refusal._tag).toBe("Forbidden");
  expect(existsSync(join(outside, "writing"))).toBe(false);
  rmSync(outside, { force: true, recursive: true });
});

test("uninstalling removes the files, the link and the lock row together", async () => {
  const apiOrigin = serveSkillRepo({
    "skills/writing/SKILL.md": "# Writing\n",
  });
  await runtime.runPromise(installing({ apiOrigin }));

  await runtime.runPromise(
    uninstallSkill({
      dataRoot,
      name: skillName("writing"),
      principal,
      scope: workspace,
    })
  );

  const dir = scopeDir();
  expect(existsSync(join(dir, ".agents/skills/writing"))).toBe(false);
  expect(existsSync(join(dir, ".claude/skills/writing"))).toBe(false);
  const lock = JSON.parse(readFileSync(join(dir, "skills-lock.json"), "utf8"));
  expect(lock.skills).toEqual({});
});
