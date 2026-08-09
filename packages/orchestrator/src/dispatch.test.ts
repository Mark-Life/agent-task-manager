/**
 * The claim, against a real database.
 *
 * Nothing here is mocked, because there is nothing worth mocking: the three
 * rules this file exists to prove — one run per task, rank order, a pinned
 * session spent by the run that used it — are enforced by a partial unique
 * index, an ordered index, and a transaction. A fake would be asserting that
 * the fake behaves the way the fake was written.
 *
 * The workspace is the auth library's `organization` row and is not created
 * here; `bun run db:seed` owns that, and a test that made one would be testing
 * somebody else's setup. Every task these tests create is deleted afterwards,
 * and everything hanging off it cascades. The audit rows stay, as they do
 * everywhere: the trail is append-only, which is the whole claim it makes.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  AgentSessionRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { ensureFixtureWorkspace } from "@workspace/db/testing";
import {
  Actor,
  NextSession,
  type Task,
  type TaskId,
  UserId,
} from "@workspace/domain";
import { DateTime, Effect, Layer, ManagedRuntime } from "effect";
import { attemptAfter, Dispatch, isParked, type Skipped } from "./dispatch";
import { type DispatchContext, resumeSessionIdOf } from "./dispatch-context";
import { openRun } from "./open-run";
import { workerAttachment } from "./subject";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "orchestrator-dispatch-test";

/** Which loop instance the orchestrator actor claims to be. */
const LOOP_INSTANCE = "dispatch-test";

/** Long enough to be in the future for the whole of a test run. */
const PARK_AHEAD = "1 hour";

/** More than the column will ever hold here, so a queue read is not truncated. */
const WHOLE_COLUMN = 200;

const runtime = ManagedRuntime.make(
  Dispatch.layer.pipe(
    Layer.provideMerge(storeLayer({ applicationName: APPLICATION_NAME }))
  )
);

const human = Actor.cases.human.make({
  userId: UserId.make("dispatch-test-human"),
});

const loop = Actor.cases.orchestrator.make({ loopInstance: LOOP_INSTANCE });

const asHuman = withActor(human);
const asLoop = withActor(loop);

const workspaceId = await runtime.runPromise(
  Effect.gen(function* () {
    const { workspace } = yield* ensureFixtureWorkspace({
      suite: APPLICATION_NAME,
    });
    return workspace.id;
  })
);

/** Every task these tests filed, so the same list can erase them at the end. */
const filed: TaskId[] = [];

/**
 * The one seeded card in the repository that is deliberately *not* flagged
 * `FIXTURE_METADATA`: the queue below is a column listing, and a listing does
 * not show a fixture. A test of what the dispatcher picks up cannot be written
 * with rows the dispatcher is built to ignore. What keeps these off a board is
 * the two walls underneath — the test database and this suite's own workspace.
 */
const fileTask = (title: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    const task = yield* asHuman(
      tasks.create({ status: "in_progress", title, workspaceId })
    );
    filed.push(task.id);
    return task;
  });

/**
 * The two halves of a claim, as the loop performs them: a plan that writes
 * nothing, and the open that turns it into rows. Tested together because the
 * questions below — which session runs, which attempt this is, whether a second
 * run is refused — are only answered once both have happened.
 */
const claim = (task: Task) =>
  Effect.gen(function* () {
    const dispatch = yield* Dispatch;
    const decision = yield* dispatch.plan({ attached: workerAttachment(task) });
    return decision.kind === "skipped"
      ? decision
      : yield* openRun(decision.claim);
  });

/** The task a claimed context is attached to, which every case here is. */
const taskOf = (context: DispatchContext) => {
  if (context.attached.role !== "worker") {
    throw new Error("this claim is a worker run");
  }
  return context.attached.task;
};

/** The context of a claim, or a failure naming the reason it was skipped. */
const claimedOf = (decision: DispatchContext | Skipped) => {
  if ("kind" in decision) {
    throw new Error(`expected a claim, was skipped as ${decision.reason}`);
  }
  return decision;
};

/** The ids the dispatcher would spend its next slots on, whole column. */
const queueIds = Effect.gen(function* () {
  const dispatch = yield* Dispatch;
  const ready = yield* dispatch.queue({ limit: WHOLE_COLUMN, workspaceId });
  return ready.map((task) => task.id);
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      yield* Effect.forEach(filed, (id) =>
        asHuman(tasks.delete({ id, workspaceId }))
      );
    })
  );
  await runtime.dispose();
});

describe("Dispatch.plan", () => {
  test("claims a task that entered the column and resolves its run", async () => {
    const context = await runtime.runPromise(
      Effect.gen(function* () {
        const runs = yield* RunRepo;
        const task = yield* fileTask("dispatch: claims an in-progress task");

        const claimed = claimedOf(yield* asLoop(claim(task)));
        const live = yield* runs.liveForTask({
          taskId: task.id,
          workspaceId,
        });

        return { claimed, liveRunId: live?.id ?? null };
      })
    );

    expect(context.claimed.attempt).toBe(1);
    expect(context.claimed.trigger).toBe("status_change");
    expect(context.claimed.session.mode).toBe("fresh");
    expect(context.claimed.session.selected).toBe("latest");
    expect(context.claimed.repoUrl).toBeNull();
    expect(context.claimed.project).toBeNull();
    expect(context.claimed.actor).toEqual({
      kind: "orchestrator",
      loopInstance: LOOP_INSTANCE,
      runId: context.claimed.runId,
    });
    expect(context.claimed.layout.runDir).toContain(context.claimed.runId);
    expect(context.liveRunId).toBe(context.claimed.runId);
  });

  test("leaves a parked task alone until its stamp expires", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskRepo;
        const filedTask = yield* fileTask("dispatch: parked");
        const parkedUntil = DateTime.addDuration(
          yield* DateTime.now,
          PARK_AHEAD
        );

        const parked = yield* asHuman(
          tasks.update({
            fields: { parkedUntil },
            id: filedTask.id,
            workspaceId,
          })
        );

        return {
          decision: yield* asLoop(claim(parked)),
          queued: yield* queueIds,
          taskId: parked.id,
        };
      })
    );

    expect(result.decision).toEqual({
      kind: "skipped",
      reason: "parked",
      subject: { id: result.taskId, kind: "task" },
    });
    expect(result.queued).not.toContain(result.taskId);
  });

  test("refuses a second run on a task that already has a live one", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const task = yield* fileTask("dispatch: one run at a time");

        claimedOf(yield* asLoop(claim(task)));

        return {
          decision: yield* asLoop(claim(task)),
          queued: yield* queueIds,
          taskId: task.id,
        };
      })
    );

    expect(result.decision).toEqual({
      kind: "skipped",
      reason: "live_run",
      subject: { id: result.taskId, kind: "task" },
    });
    expect(result.queued).not.toContain(result.taskId);
  });

  test("skips a task that has left the column since it was read", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskRepo;
        const task = yield* fileTask("dispatch: moved on");

        const moved = yield* asHuman(
          tasks.transition({ id: task.id, to: "review", workspaceId })
        );

        return yield* asLoop(claim(moved));
      })
    );

    expect(result).toMatchObject({
      kind: "skipped",
      reason: "not_in_progress",
    });
  });

  test("honours a pinned session and spends the pin", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* AgentSessionRepo;
        const tasks = yield* TaskRepo;
        const task = yield* fileTask("dispatch: pinned session");

        const opened = yield* asLoop(
          sessions.open({
            provider: "codex",
            subject: { id: task.id, kind: "task" },
            workspaceId,
          })
        );
        yield* asLoop(
          sessions.recordProviderSession({
            id: opened.id,
            providerSessionId: "codex-rollout-1",
            workspaceId,
          })
        );

        const pinned = yield* asHuman(
          tasks.selectNextSession({
            id: task.id,
            next: NextSession.cases.specific.make({ sessionId: opened.id }),
            workspaceId,
          })
        );

        const claimed = claimedOf(yield* asLoop(claim(pinned)));

        return {
          claimed,
          sessionId: opened.id,
          stored: yield* tasks.byId({ id: task.id, workspaceId }),
        };
      })
    );

    expect(result.claimed.session.mode).toBe("resumed");
    expect(result.claimed.session.selected).toBe("specific");
    expect(result.claimed.session.session.id).toBe(result.sessionId);
    expect(resumeSessionIdOf(result.claimed)).toBe("codex-rollout-1");
    expect(result.claimed.provider).toBe("codex");
    expect(taskOf(result.claimed).nextSessionId).toBeNull();
    expect(result.stored.nextSessionId).toBeNull();
    expect(result.stored.nextSessionNew).toBe(false);
  });

  test("starts a fresh conversation when the task asked for one", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* AgentSessionRepo;
        const tasks = yield* TaskRepo;
        const task = yield* fileTask("dispatch: fresh session");

        const earlier = yield* asLoop(
          sessions.open({
            provider: "claude",
            subject: { id: task.id, kind: "task" },
            workspaceId,
          })
        );
        yield* asLoop(
          sessions.recordProviderSession({
            id: earlier.id,
            providerSessionId: "claude-session-1",
            workspaceId,
          })
        );

        const asked = yield* asHuman(
          tasks.selectNextSession({
            id: task.id,
            next: NextSession.cases.new.make({}),
            workspaceId,
          })
        );

        const claimed = claimedOf(yield* asLoop(claim(asked)));

        return {
          claimed,
          earlierId: earlier.id,
          stored: yield* tasks.byId({ id: task.id, workspaceId }),
        };
      })
    );

    expect(result.claimed.session.mode).toBe("fresh");
    expect(result.claimed.session.selected).toBe("new");
    expect(result.claimed.session.session.id).not.toBe(result.earlierId);
    expect(result.stored.nextSessionNew).toBe(false);
  });
});

describe("Dispatch.queue", () => {
  test("takes the column in rank order, so the top of the board runs next", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskRepo;
        const first = yield* fileTask("dispatch: rank, filed first");
        const second = yield* fileTask("dispatch: rank, filed second");

        // Dropped on the top of the column, which is the gesture the manager
        // agent and a drag on the board both end up making.
        yield* asHuman(
          tasks.place({ after: null, id: second.id, workspaceId })
        );

        return {
          firstId: first.id,
          queued: yield* queueIds,
          secondId: second.id,
        };
      })
    );

    expect(result.queued.indexOf(result.secondId)).toBeLessThan(
      result.queued.indexOf(result.firstId)
    );
  });

  test("hands back no more than the pool has slots for", async () => {
    const ready = await runtime.runPromise(
      Effect.gen(function* () {
        const dispatch = yield* Dispatch;
        yield* fileTask("dispatch: limit a");
        yield* fileTask("dispatch: limit b");
        return yield* dispatch.queue({ limit: 1, workspaceId });
      })
    );

    expect(ready).toHaveLength(1);
  });
});

const now = Effect.runSync(DateTime.now);

describe("isParked", () => {
  const parked = (parkedUntil: Task["parkedUntil"]) =>
    isParked({ now, task: { parkedUntil } });

  test("reads an unstamped task as ready", () => {
    expect(parked(null)).toBe(false);
  });

  test("holds a task whose stamp is still in the future", () => {
    expect(parked(DateTime.addDuration(now, PARK_AHEAD))).toBe(true);
  });

  test("releases a task whose stamp has passed", () => {
    expect(parked(DateTime.subtractDuration(now, PARK_AHEAD))).toBe(false);
  });
});

describe("attemptAfter", () => {
  test("calls a task with no history the first attempt", () => {
    expect(attemptAfter([])).toBe(1);
  });

  test("counts the unbroken run of failures at the head", () => {
    expect(attemptAfter([{ outcome: "errored" }, { outcome: "lost" }])).toBe(3);
  });

  test("puts the ladder back on its first rung after a clean finish", () => {
    expect(attemptAfter([{ outcome: "done" }, { outcome: "errored" }])).toBe(1);
  });

  test("does not count a run somebody stopped against the task", () => {
    expect(
      attemptAfter([{ outcome: "interrupted" }, { outcome: "errored" }])
    ).toBe(1);
  });
});
