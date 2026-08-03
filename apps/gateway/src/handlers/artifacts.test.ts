/**
 * The artifact endpoints, against a real database and a real directory.
 *
 * Nothing here is mocked, because everything claimed is about two systems
 * agreeing. That an upload is on disk and in the index, that a read gives back
 * the bytes that were written, that a promotion puts a copy in the project's
 * folder where every later task in that project will see it, and that a path
 * pointing out of the task's folder is refused — a fake filesystem or a fake
 * index would be asserting the fake.
 *
 * The fixture is a real project and two real tasks in it — promotion exists so
 * that the second reads what the first produced, which one task cannot claim —
 * all deleted afterwards. Deleting a task cascades to its artifact index rows
 * and deleting the project cascades to the promoted ones; the audit rows stay,
 * which is what append-only means.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
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
import type { PrincipalShape } from "@workspace/api";
import {
  CurrentActor,
  ProjectRepo,
  storeLayer,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import type { Project, Task, WorkspaceId } from "@workspace/domain";
import { Actor, UserId } from "@workspace/domain";
import { projectArtifactsDirOf, taskArtifactsDirOf } from "@workspace/sandbox";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import {
  listTaskArtifacts,
  promoteTaskArtifact,
  readTaskArtifact,
  uploadTaskArtifact,
} from "./artifacts";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-artifacts-test";

/** The database has never been seeded, so there is no workspace to hang a task on. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "ArtifactsTest.NoWorkspace",
  { detail: Schema.String }
) {}

/** The digest {@link promoteTaskArtifact} records, algorithm prefix and all. */
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

const caller = Actor.cases.system.make({ reason: APPLICATION_NAME });

/**
 * Who tears the fixtures down. Erasing a task is owner-only, so the cleanup
 * asks as a person even though everything else here writes as the system.
 */
const remover = {
  kind: "human",
  userId: UserId.make(APPLICATION_NAME),
} as const;

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    storeLayer({ applicationName: APPLICATION_NAME }),
    BunFileSystem.layer,
    CurrentActor.layer(caller)
  )
);

let dataRoot: string;
let uploadDir: string;
let workspaceId: WorkspaceId;
let project: Project;
let task: Task;
let later: Task;
let principal: PrincipalShape;

/** Where the multipart parser would have left an upload, as this test writes it by hand. */
const persistFile = (name: string, body: string) => {
  const path = join(uploadDir, name);
  writeFileSync(path, body);
  return { path };
};

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "gateway-artifacts-"));
  uploadDir = mkdtempSync(join(tmpdir(), "gateway-uploads-"));

  const built = await runtime.runPromise(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepo;
      const [first] = yield* workspaces.list();
      if (first === undefined) {
        return yield* Effect.fail(
          new NoWorkspace({ detail: "run `bun run db:seed` first" })
        );
      }
      const projects = yield* ProjectRepo;
      const tasks = yield* TaskRepo;
      const made = yield* projects.create({
        name: "artifacts: the endpoints",
        workspaceId: first.id,
      });
      const card = yield* tasks.create({
        projectId: made.id,
        title: "artifacts: upload, read and promote",
        workspaceId: first.id,
      });
      // The task that comes after. Promotion exists so that this one reads what
      // the first one produced, which needs two tasks in one project to claim.
      const next = yield* tasks.create({
        projectId: made.id,
        title: "artifacts: the task that comes after",
        workspaceId: first.id,
      });
      return { card, made, next, workspaceId: first.id };
    }).pipe(withActor(caller))
  );

  ({ workspaceId } = built);
  project = built.made;
  task = built.card;
  later = built.next;
  principal = { actor: caller, scope: "task-write", workspaceId };
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const projects = yield* ProjectRepo;
      yield* tasks.delete({ id: task.id, workspaceId });
      yield* tasks.delete({ id: later.id, workspaceId });
      yield* projects.delete({ id: project.id, workspaceId });
    }).pipe(withActor(remover))
  );
  await runtime.dispose();
  rmSync(dataRoot, { force: true, recursive: true });
  rmSync(uploadDir, { force: true, recursive: true });
});

const request = () => ({ dataRoot, principal, taskId: task.id });

test("an upload lands in the task's folder and in the index", async () => {
  const row = await runtime.runPromise(
    uploadTaskArtifact({
      ...request(),
      file: persistFile("report.md", "# findings\n"),
      path: "reports/report.md",
    })
  );

  expect(row.path).toBe(join("reports", "report.md"));
  expect(row.scope).toBe("task");
  expect(row.taskId).toBe(task.id);
  expect(row.ext).toBe("md");
  expect(row.bytes).toBe("# findings\n".length);

  const onDisk = readFileSync(
    join(taskArtifactsDirOf({ dataRoot, taskId: task.id }), row.path),
    "utf8"
  );
  expect(onDisk).toBe("# findings\n");

  const listed = await runtime.runPromise(listTaskArtifacts(request()));
  expect(listed.map((entry) => entry.path)).toContain(row.path);
});

test("a read streams back the bytes that were written", async () => {
  const row = await runtime.runPromise(
    uploadTaskArtifact({
      ...request(),
      file: persistFile("notes.txt", "second draft"),
      path: "notes.txt",
    })
  );

  const decoder = new TextDecoder();
  const bytes = await runtime.runPromise(
    Effect.flatMap(
      readTaskArtifact({ ...request(), artifactId: row.id }),
      (stream) =>
        Stream.runFold(
          stream,
          () => "",
          (text, chunk) => text + decoder.decode(chunk)
        )
    )
  );

  expect(bytes).toBe("second draft");
});

test("promotion copies the file into the project's folder and stamps the row", async () => {
  const row = await runtime.runPromise(
    uploadTaskArtifact({
      ...request(),
      file: persistFile("shared.md", "worth keeping"),
      path: "shared.md",
    })
  );

  const promoted = await runtime.runPromise(
    promoteTaskArtifact({
      ...request(),
      artifactId: row.id,
      scope: "project",
    })
  );

  expect(promoted.promotedAt).not.toBeNull();
  expect(promoted.contentHash).toMatch(CONTENT_HASH);

  const copy = join(
    projectArtifactsDirOf({ dataRoot, projectId: project.id }),
    "shared.md"
  );
  expect(readFileSync(copy, "utf8")).toBe("worth keeping");

  // A second promotion would claim a decision nobody made.
  const again = await runtime.runPromise(
    Effect.flip(
      promoteTaskArtifact({
        ...request(),
        artifactId: row.id,
        scope: "project",
      })
    )
  );
  expect(again._tag).toBe("ArtifactAlreadyPromoted");
});

test("a later task promotes over the same path without leaving two files", async () => {
  const revised = "revised, by the task that came after";
  const row = await runtime.runPromise(
    uploadTaskArtifact({
      dataRoot,
      file: persistFile("revised.md", revised),
      path: "shared.md",
      principal,
      taskId: later.id,
    })
  );

  const promoted = await runtime.runPromise(
    promoteTaskArtifact({
      artifactId: row.id,
      dataRoot,
      principal,
      scope: "project",
      taskId: later.id,
    })
  );
  expect(promoted.promotedAt).not.toBeNull();

  const shared = projectArtifactsDirOf({ dataRoot, projectId: project.id });
  expect(readdirSync(shared)).toEqual(["shared.md"]);
  expect(readFileSync(join(shared, "shared.md"), "utf8")).toBe(revised);

  // The first task's own file is untouched. Reuse is a copy, so its record of
  // what it worked from cannot be rewritten by somebody else's promotion.
  expect(
    readFileSync(
      join(taskArtifactsDirOf({ dataRoot, taskId: task.id }), "shared.md"),
      "utf8"
    )
  ).toBe("worth keeping");
});

test("a path that leaves the task's folder is refused, and writes nothing", async () => {
  const escapes = ["../escaped.md", "a/../../escaped.md", "/etc/passwd"];

  const refused = await Promise.all(
    escapes.map((path) =>
      runtime.runPromise(
        Effect.flip(
          uploadTaskArtifact({
            ...request(),
            file: persistFile("payload.md", "should not land"),
            path,
          })
        )
      )
    )
  );
  expect(refused.map((failure) => failure._tag)).toEqual([
    "InvalidInput",
    "InvalidInput",
    "InvalidInput",
  ]);

  expect(existsSync(join(dataRoot, "artifacts", "escaped.md"))).toBe(false);
  expect(existsSync(join(dataRoot, "artifacts", "tasks", "escaped.md"))).toBe(
    false
  );
});

test("a symlink out of the folder is not served", async () => {
  const secret = join(uploadDir, "secret.txt");
  writeFileSync(secret, "not yours");

  const row = await runtime.runPromise(
    uploadTaskArtifact({
      ...request(),
      file: persistFile("placeholder.txt", "placeholder"),
      path: "link.txt",
    })
  );

  // Replace the indexed file with a link out of the folder, the way a container
  // with write access to its own mount could.
  const linked = join(
    taskArtifactsDirOf({ dataRoot, taskId: task.id }),
    "link.txt"
  );
  rmSync(linked);
  symlinkSync(secret, linked);

  const refused = await runtime.runPromise(
    Effect.flip(readTaskArtifact({ ...request(), artifactId: row.id }))
  );
  expect(refused._tag).toBe("NotFound");

  rmSync(linked);
});

test("a row whose file is gone reads as missing, not as a crash", async () => {
  const row = await runtime.runPromise(
    uploadTaskArtifact({
      ...request(),
      file: persistFile("transient.md", "here for now"),
      path: "transient.md",
    })
  );

  rmSync(
    join(taskArtifactsDirOf({ dataRoot, taskId: task.id }), "transient.md")
  );

  const missing = await runtime.runPromise(
    Effect.flip(readTaskArtifact({ ...request(), artifactId: row.id }))
  );
  expect(missing._tag).toBe("NotFound");
});
