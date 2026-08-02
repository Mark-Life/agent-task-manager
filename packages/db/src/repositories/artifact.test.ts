/**
 * Promotion, against a real database, because the claim is that two writes land
 * together and a third never lands twice.
 *
 * The half nobody sees is the one worth testing. Stamping the task's own row is
 * visible to whoever asked for it; the row in the shared folder is what every
 * later task in the project reads, and a promotion that recorded a decision
 * without indexing the copy would look like a success at the call site and like
 * an absence everywhere else. So each test asserts both rows, and the upsert is
 * asserted by counting rows rather than by trusting an id.
 *
 * No filesystem here: the copy is the sandbox's, and its own tests cover it.
 * What is checked is what the index says happened.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PgClient } from "@effect/sql-pg";
import type {
  ArtifactStat,
  Project,
  Task,
  TaskId,
  WorkspaceId,
} from "@workspace/domain";
import { Actor } from "@workspace/domain";
import { DateTime, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { CurrentActor, withActor } from "../actor";
import { storeLayer } from "../store";
import { ArtifactRepo } from "./artifact";
import { ProjectRepo } from "./project";
import { TaskRepo } from "./task";
import { WorkspaceRepo } from "./workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "db-artifact-test";

/** The digest a promotion records, algorithm prefix and all. */
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

/** The database has never been seeded, so there is no workspace to hang a task on. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "ArtifactRepoTest.NoWorkspace",
  { detail: Schema.String }
) {}

const caller = Actor.cases.system.make({ reason: APPLICATION_NAME });

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    storeLayer({ applicationName: APPLICATION_NAME }),
    CurrentActor.layer(caller)
  )
);

/**
 * The path the global-scoped rows are written at, unique per run.
 *
 * A project's folder dies with the project, but the global folder is the
 * workspace's and outlives every fixture — so the one row this file leaves
 * there is named after this run and deleted by name.
 */
const globalPath = `db-artifact-test/${randomUUID()}.md`;

let workspaceId: WorkspaceId;
let project: Project;
let taskA: Task;
let taskB: Task;

/** A stat the way a scan of a task's folder would have read it. */
const statOf = (input: { readonly bytes: number; readonly path: string }) =>
  Effect.map(
    DateTime.now,
    (modifiedAt) =>
      ({
        bytes: input.bytes,
        ext: "md",
        modifiedAt,
        path: input.path,
      }) satisfies ArtifactStat
  );

/**
 * What each task's folder holds so far.
 *
 * A rescan replaces the whole index for a task, which is what makes it a cache
 * of a directory — so a test adding a second file has to hand over both, the
 * way the directory would.
 */
const indexed = new Map<TaskId, ArtifactStat[]>();

/** Indexes one more file into a task's folder and hands back its row. */
const indexFile = Effect.fnUntraced(function* (input: {
  readonly bytes: number;
  readonly path: string;
  readonly task: Task;
}) {
  const artifacts = yield* ArtifactRepo;
  const stat = yield* statOf(input);
  const stats = [...(indexed.get(input.task.id) ?? []), stat];
  indexed.set(input.task.id, stats);
  const rows = yield* artifacts.replaceTaskIndex({
    lastRunId: null,
    stats,
    taskId: input.task.id,
    workspaceId,
  });
  const row = rows.find((candidate) => candidate.path === input.path);
  if (row === undefined) {
    return yield* Effect.die(`nothing indexed at ${input.path}`);
  }
  return row;
});

/** The copy the sandbox would have made, as the store is told about it. */
const copyOf = (input: { readonly bytes: number; readonly path: string }) =>
  Effect.map(statOf(input), (stat) => ({
    ...stat,
    contentHash: `sha256:${randomUUID().replaceAll("-", "").repeat(2)}`,
  }));

/** How many rows the shared folder holds at one path. The upsert claim, counted. */
const rowsAt = Effect.fnUntraced(function* (path: string) {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql`
    select id from artifact
    where workspace_id = ${workspaceId} and path = ${path} and scope <> 'task'
  `;
  return rows.length;
});

beforeAll(async () => {
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
        name: "artifacts: promotion",
        workspaceId: first.id,
      });
      const producer = yield* tasks.create({
        projectId: made.id,
        title: "artifacts: the file that gets promoted",
        workspaceId: first.id,
      });
      const successor = yield* tasks.create({
        projectId: made.id,
        title: "artifacts: the file that replaces it",
        workspaceId: first.id,
      });
      return {
        project: made,
        taskA: producer,
        taskB: successor,
        workspaceId: first.id,
      };
    }).pipe(withActor(caller))
  );

  ({ project, taskA, taskB, workspaceId } = built);
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const projects = yield* ProjectRepo;
      // The global row is nobody's child: no task and no project cascades to
      // it, which is exactly why a promoted file survives the task that made it.
      const sql = yield* PgClient.PgClient;
      yield* sql`delete from artifact where workspace_id = ${workspaceId} and path = ${globalPath}`;
      yield* tasks.delete({ id: taskA.id, workspaceId });
      yield* tasks.delete({ id: taskB.id, workspaceId });
      yield* projects.delete({ id: project.id, workspaceId });
    }).pipe(withActor(caller))
  );
  await runtime.dispose();
});

test("a promotion stamps the file and indexes the copy the project will read", async () => {
  const path = "reports/findings.md";
  const { copy, destination, source } = await runtime.runPromise(
    Effect.gen(function* () {
      const artifacts = yield* ArtifactRepo;
      const row = yield* indexFile({ bytes: 11, path, task: taskA });
      const made = yield* copyOf({ bytes: 11, path });
      const promoted = yield* artifacts.promote({
        copy: made,
        id: row.id,
        to: { projectId: project.id, scope: "project" },
        workspaceId,
      });
      return { copy: made, ...promoted };
    })
  );

  expect(source.promotedAt).not.toBeNull();
  expect(source.contentHash).toBe(copy.contentHash);
  expect(source.scope).toBe("task");

  expect(destination.id).not.toBe(source.id);
  expect(destination.scope).toBe("project");
  expect(destination.projectId).toBe(project.id);
  // No task, so it outlives the one that made it.
  expect(destination.taskId).toBeNull();
  expect(destination.path).toBe(path);
  expect(destination.bytes).toBe(11);
  expect(destination.contentHash).toMatch(CONTENT_HASH);
  expect(destination.contentHash).toBe(copy.contentHash);
  expect(destination.promotedAt).not.toBeNull();
  // Provenance, not a pointer: the bytes are the copy's own.
  expect(destination.sourceArtifactId).toBe(source.id);
});

test("a second promotion of the same file is refused, and nothing is copied twice", async () => {
  const path = "reports/refused.md";
  const failure = await runtime.runPromise(
    Effect.gen(function* () {
      const artifacts = yield* ArtifactRepo;
      const row = yield* indexFile({ bytes: 7, path, task: taskA });
      const to = { projectId: project.id, scope: "project" } as const;
      yield* artifacts.promote({
        copy: yield* copyOf({ bytes: 7, path }),
        id: row.id,
        to,
        workspaceId,
      });
      return yield* Effect.flip(
        artifacts.promote({
          copy: yield* copyOf({ bytes: 7, path }),
          id: row.id,
          to,
          workspaceId,
        })
      );
    })
  );

  expect(failure._tag).toBe("ArtifactRepo.AlreadyPromoted");
  expect(await runtime.runPromise(rowsAt(path))).toBe(1);
});

test("promoting over a path the folder already holds replaces the row rather than adding one", async () => {
  const path = "reports/shared.md";
  const { first, second } = await runtime.runPromise(
    Effect.gen(function* () {
      const artifacts = yield* ArtifactRepo;
      const to = { projectId: project.id, scope: "project" } as const;
      const rowA = yield* indexFile({ bytes: 4, path, task: taskA });
      const one = yield* artifacts.promote({
        copy: yield* copyOf({ bytes: 4, path }),
        id: rowA.id,
        to,
        workspaceId,
      });
      const rowB = yield* indexFile({ bytes: 9, path, task: taskB });
      const two = yield* artifacts.promote({
        copy: yield* copyOf({ bytes: 9, path }),
        id: rowB.id,
        to,
        workspaceId,
      });
      return { first: one, second: two };
    })
  );

  expect(await runtime.runPromise(rowsAt(path))).toBe(1);
  // The row keeps its id: whatever already referred to it referred to the path.
  expect(second.destination.id).toBe(first.destination.id);
  expect(second.destination.bytes).toBe(9);
  expect(second.destination.contentHash).toBe(second.source.contentHash);
  expect(second.destination.sourceArtifactId).toBe(second.source.id);
});

test("a global promotion is keyed on the workspace and carries no project", async () => {
  const { destination } = await runtime.runPromise(
    Effect.gen(function* () {
      const artifacts = yield* ArtifactRepo;
      const row = yield* indexFile({
        bytes: 5,
        path: globalPath,
        task: taskB,
      });
      return yield* artifacts.promote({
        copy: yield* copyOf({ bytes: 5, path: globalPath }),
        id: row.id,
        to: { scope: "global" },
        workspaceId,
      });
    })
  );

  expect(destination.scope).toBe("global");
  expect(destination.projectId).toBeNull();
  expect(destination.taskId).toBeNull();
  expect(destination.path).toBe(globalPath);
  expect(await runtime.runPromise(rowsAt(globalPath))).toBe(1);
});
