#!/usr/bin/env bun

/**
 * Proves the store does the three things the rest of the system is allowed to
 * assume: a task moves only where the status machine says it may, an actor who
 * may not make a move is refused, and every mutation left a row saying who made
 * it.
 *
 * It is a script rather than a test because it needs a real database. The
 * repositories decide legality inside the transaction they write in, so
 * checking any of it against a fake would be checking the fake.
 *
 * Four actors take part, which is the point: a human drags cards, the manager
 * agent is refused the one move that spends a worker slot, the orchestrator
 * opens the session and claims the attempt, and the worker run reports back
 * from inside the container. Each leaves its own kind of audit row.
 *
 * Rows are left behind on purpose — the audit log is append-only and the whole
 * claim is that the trail survives. Usage: `bun run db:store-check`.
 */

import { BunRuntime } from "@effect/platform-bun";
import {
  AgentSessionRepo,
  AuditLogRepo,
  ProjectRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { Actor, type AuditEntry } from "@workspace/domain";
import { Effect, Schema } from "effect";
import { ensureWorkspace } from "./store/workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "store-check";

/** Which loop instance the orchestrator actor claims to be. */
const LOOP_INSTANCE = "store-check";

/**
 * The legal path through the board, in the order it is walked. Every entry is a
 * row in the status machine; the audit log is expected to hold exactly these
 * and nothing else, which is how the refused move is proved to have written
 * nothing.
 */
const EXPECTED_MOVES = [
  "ideas -> backlog",
  "backlog -> in_progress",
  "in_progress -> review",
  "review -> done",
] as const;

/**
 * The rows the walk creates that hang off the task. The project is not among
 * them: its audit row names no task, which is the case the last check covers.
 */
const EXPECTED_CREATES = [
  "agent_session",
  "run",
  "task",
] as const satisfies readonly AuditEntry["entityType"][];

/** One thing the store was supposed to do and did not. */
class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()(
  "StoreCheck.Failed",
  { detail: Schema.String, step: Schema.String }
) {}

/**
 * Asserts one claim, naming what was expected when it does not hold. Failing as
 * a value rather than throwing is what makes the whole check one effect that
 * stops at the first broken claim and exits non-zero.
 */
const check = (options: {
  readonly detail: string;
  readonly ok: boolean;
  readonly step: string;
}) =>
  options.ok
    ? Effect.logInfo(`ok    ${options.step}`)
    : Effect.fail(
        new CheckFailed({ detail: options.detail, step: options.step })
      );

/** Whether an entry says enough about its actor to answer "who did this". */
const namesItsActor = (entry: AuditEntry) => {
  if (entry.actorKind === "human" || entry.actorKind === "manager") {
    return entry.actorUserId !== null;
  }
  if (entry.actorKind === "worker_run") {
    return entry.actorRunId !== null && entry.actorSessionId !== null;
  }
  return true;
};

const movesOf = (entries: readonly AuditEntry[]) =>
  entries
    .filter((entry) => entry.action === "transition")
    .map((entry) => `${entry.fromStatus} -> ${entry.toStatus}`)
    // The log reads newest first; the walk happened the other way round. The
    // array being reversed was just built by `map`, so nothing else sees it.
    .reverse();

const createdTypes = (entries: readonly AuditEntry[]) =>
  new Set(
    entries
      .filter((entry) => entry.action === "create")
      .map((entry) => entry.entityType)
  );

const storeCheck = Effect.gen(function* () {
  const { owner, workspace } = yield* ensureWorkspace();
  const workspaceId = workspace.id;

  const human = Actor.cases.human.make({ userId: owner });
  const manager = Actor.cases.manager.make({ userId: owner });
  const orchestrator = Actor.cases.orchestrator.make({
    loopInstance: LOOP_INSTANCE,
  });

  const auditLog = yield* AuditLogRepo;
  const projects = yield* ProjectRepo;
  const runs = yield* RunRepo;
  const sessions = yield* AgentSessionRepo;
  const tasks = yield* TaskRepo;

  const asHuman = withActor(human);

  const project = yield* asHuman(
    projects.create({ name: "Store check", workspaceId })
  );
  yield* check({
    detail: "a created project should carry the workspace it was created in",
    ok: project.workspaceId === workspaceId,
    step: "a human creates a project",
  });

  const task = yield* asHuman(
    tasks.create({
      brief: "Walk the board and check the trail behind it.",
      projectId: project.id,
      title: "Store check",
      workspaceId,
    })
  );
  const taskRef = { id: task.id, workspaceId } as const;
  yield* check({
    detail: `a task with no status named starts in ideas, not ${task.status}`,
    ok: task.status === "ideas",
    step: "a human creates a task",
  });

  const backlogged = yield* asHuman(
    tasks.transition({ ...taskRef, to: "backlog" })
  );
  yield* check({
    detail: `expected backlog, found ${backlogged.status}`,
    ok: backlogged.status === "backlog",
    step: "ideas -> backlog, which a human may make",
  });

  // The orchestrator may only close a run out — `in_progress -> review` is its
  // one move. It is the restricted actor here, not the manager: the manager is
  // a second interface onto what a person can do, and this is one of them.
  const refused = yield* tasks
    .transition({ ...taskRef, to: "in_progress" })
    .pipe(
      withActor(orchestrator),
      Effect.as("moved" as const),
      Effect.catchTag("TaskRepo.IllegalTransition", () =>
        Effect.succeed("refused" as const)
      )
    );
  yield* check({
    detail: `the orchestrator was ${refused} into in_progress`,
    ok: refused === "refused",
    step: "backlog -> in_progress is refused to the orchestrator",
  });

  const started = yield* tasks
    .transition({ ...taskRef, to: "in_progress" })
    .pipe(withActor(manager));
  yield* check({
    detail: `expected in_progress, found ${started.status}`,
    ok: started.status === "in_progress",
    step: "backlog -> in_progress, which the manager may make as a person can",
  });

  const asOrchestrator = withActor(orchestrator);

  const session = yield* asOrchestrator(
    sessions.open({
      provider: "claude",
      taskId: task.id,
      workspaceId,
    })
  );
  const run = yield* asOrchestrator(
    runs.create({
      agentSessionId: session.id,
      provider: "claude",
      taskId: task.id,
      trigger: "status_change",
      workspaceId,
    })
  );

  const worker = Actor.cases.worker_run.make({
    runId: run.id,
    sessionId: session.id,
    taskId: task.id,
  });

  const reviewed = yield* tasks
    .transition({ ...taskRef, to: "review" })
    .pipe(withActor(worker));
  yield* check({
    detail: `expected review, found ${reviewed.status}`,
    ok: reviewed.status === "review",
    step: "in_progress -> review, the worker run's only move",
  });

  const done = yield* asHuman(tasks.transition({ ...taskRef, to: "done" }));
  yield* check({
    detail: `expected done, found ${done.status}`,
    ok: done.status === "done",
    step: "review -> done, the human gate",
  });

  const entries = yield* auditLog.forTask({ taskId: task.id, workspaceId });
  const moves = movesOf(entries);

  yield* check({
    detail: `expected ${EXPECTED_MOVES.join(", ")}; found ${moves.join(", ")}`,
    ok: JSON.stringify(moves) === JSON.stringify([...EXPECTED_MOVES]),
    step: "every legal move left a transition row, and the refused one left none",
  });

  const written = createdTypes(entries);
  yield* check({
    detail: `found create rows for ${[...written].join(", ")}`,
    ok: EXPECTED_CREATES.every((entity) => written.has(entity)),
    step: "the task, its session and its run each recorded their creation",
  });

  yield* check({
    detail: "an entry left every actor column null",
    ok: entries.every(namesItsActor),
    step: "every row on the task names the actor behind it",
  });

  const reviewRow = entries.find(
    (entry) => entry.action === "transition" && entry.toStatus === "review"
  );
  yield* check({
    detail: `the move into review is attributed to ${reviewRow?.actorKind}`,
    ok:
      reviewRow?.actorKind === "worker_run" &&
      reviewRow.actorRunId === run.id &&
      reviewRow.actorSessionId === session.id,
    step: "the worker run's move names its run and its session",
  });

  const intoProgress = entries.filter(
    (entry) => entry.action === "transition" && entry.toStatus === "in_progress"
  );
  yield* check({
    detail: `${intoProgress.length} rows move this task into in_progress, by ${intoProgress
      .map((entry) => entry.actorKind)
      .join(", ")}`,
    ok: intoProgress.length === 1 && intoProgress[0]?.actorKind === "manager",
    step: "the refused move rolled its audit row back, the allowed one kept its",
  });

  const projectHistory = yield* auditLog.forEntity({
    entityId: project.id,
    workspaceId,
  });
  yield* check({
    detail: "the project's own creation is missing from its history",
    ok: projectHistory.some(
      (entry) => entry.action === "create" && entry.actorUserId === owner
    ),
    step: "a mutation on no particular task is still on the log",
  });

  yield* Effect.logInfo(`task ${task.id} left ${entries.length} audit rows`);
});

BunRuntime.runMain(
  storeCheck.pipe(
    Effect.provide(storeLayer({ applicationName: APPLICATION_NAME }))
  )
);
