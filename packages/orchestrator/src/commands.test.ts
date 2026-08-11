/**
 * Against a real Postgres, because everything under test here is a decision the
 * repositories make inside the transaction they write in: whether a second
 * identical intent collides, whether claiming a command consumes it, whether a
 * rejection lands on the row somebody can read. Checking any of that against a
 * fake would be checking the fake.
 *
 * Only the two container operations are stubbed, and they are stubbed because
 * they are the seam this module is defined against — `RunControl` is what the
 * dispatcher implements, and starting a container to prove a stop command was
 * consumed would be testing docker.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  AgentSessionRepo,
  type CurrentActor,
  RunCommandRepo,
  RunEventRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { ensureFixtureWorkspace } from "@workspace/db/testing";
import type {
  RunSubject,
  Task,
  TaskId,
  TaskStatus,
  WorkspaceId,
} from "@workspace/domain";
import { Actor, parseTraceparent, UserId } from "@workspace/domain";
import { DateTime, Effect, Layer, Tracer } from "effect";
import {
  type DispatchRequest,
  RunCommands,
  RunControl,
  STOPPED_SEQ,
  type StopRequest,
} from "./commands";

/** A caller's trace context, as a `traceparent` header would carry it. */
const CALLER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN_ID = "00f067aa0ba902b7";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "orchestrator-commands-test";

/** Everything the stubbed run control was asked to do. */
interface ControlCalls {
  readonly dispatched: DispatchRequest[];
  readonly stopped: StopRequest[];
}

/** How the stub answers, per test. */
interface ControlBehaviour {
  /** False stands for a container that was already gone. */
  readonly containerFound?: boolean;
  /** True makes the dispatcher fail the way a real one can. */
  readonly dispatchFails?: boolean;
}

const controlLayer = (calls: ControlCalls, behaviour: ControlBehaviour = {}) =>
  Layer.succeed(RunControl, {
    dispatch: (input: DispatchRequest) => {
      calls.dispatched.push(input);
      return behaviour.dispatchFails === true
        ? Effect.fail(new Error("the dispatcher refused"))
        : Effect.void;
    },
    stop: (input: StopRequest) => {
      calls.stopped.push(input);
      return Effect.succeed(behaviour.containerFound ?? true);
    },
  });

/** The loop, as this test runs it. */
const actor = Actor.cases.orchestrator.make({ loopInstance: APPLICATION_NAME });

/** Whoever wrote the intent. `system` so no user row has to exist for the test. */
const asker = Actor.cases.system.make({ reason: APPLICATION_NAME });

/**
 * Who tears the fixtures down. Erasing a task is owner-only, so the teardown
 * asks as a person rather than as the loop that made them.
 */
const remover = Actor.cases.human.make({
  userId: UserId.make(APPLICATION_NAME),
});

/** A task, as the thing a command names. A thread takes the same shape. */
const taskSubject = (id: TaskId): RunSubject => ({ id, kind: "task" });

const store = storeLayer({ applicationName: APPLICATION_NAME });

/** What the store gives a program, plus the actor the helpers provide with it. */
type StoreServices = CurrentActor | Layer.Success<typeof store>;

/** The same, plus the consumer under test. */
type ConsumerServices = RunCommands | StoreServices;

const runWith = <A, E>(
  calls: ControlCalls,
  behaviour: ControlBehaviour,
  program: Effect.Effect<A, E, ConsumerServices>
) =>
  Effect.runPromise(
    program.pipe(
      withActor(actor),
      Effect.provide(RunCommands.layer),
      Effect.provide(controlLayer(calls, behaviour)),
      Effect.provide(store)
    )
  );

const emptyCalls = (): ControlCalls => ({ dispatched: [], stopped: [] });

/** Runs a program that needs only the store and the loop's actor. */
const runStore = <A, E>(program: Effect.Effect<A, E, StoreServices>) =>
  Effect.runPromise(program.pipe(withActor(actor), Effect.provide(store)));

let workspaceId: WorkspaceId;
const createdTaskIds: Task["id"][] = [];

beforeAll(async () => {
  workspaceId = await runStore(
    Effect.gen(function* () {
      const fixture = yield* ensureFixtureWorkspace({
        suite: APPLICATION_NAME,
      });
      return fixture.workspace.id;
    })
  );
});

/**
 * Empties the queue without acting on anything. `claimNext` is workspace-wide,
 * so a command left pending by an earlier run would otherwise be the one this
 * test's `consumeNext` picked up.
 */
const clearQueue = () =>
  runStore(
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      for (let taken = 0; taken < 100; taken += 1) {
        const command = yield* commands.claimNext({ workspaceId });
        if (command === null) {
          return;
        }
        yield* commands.reject({
          id: command.id,
          reason: "cleared by the test fixture",
          workspaceId,
        });
      }
    })
  );

beforeEach(clearQueue);

afterAll(async () => {
  await runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      for (const id of createdTaskIds.splice(0)) {
        // Messages, sessions, runs, run events and commands all hang off the
        // task by a cascading key, so one delete takes the whole fixture.
        yield* tasks
          .delete({ id, workspaceId })
          .pipe(withActor(remover), Effect.ignore);
      }
    })
  );
});

/** A task in a named column, remembered so the teardown can erase it. */
const makeTask = (status: TaskStatus) =>
  runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const task = yield* withActor(asker)(
        tasks.create({ status, title: `commands test ${status}`, workspaceId })
      );
      createdTaskIds.push(task.id);
      return task;
    })
  );

/** A live run on a task, with the session every run belongs to. */
const makeLiveRun = (taskId: Task["id"]) =>
  runStore(
    Effect.gen(function* () {
      const sessions = yield* AgentSessionRepo;
      const runs = yield* RunRepo;
      const subject = taskSubject(taskId);
      const session = yield* sessions.open({
        provider: "claude",
        subject,
        workspaceId,
      });
      return yield* runs.create({
        agentSessionId: session.id,
        provider: "claude",
        subject,
        trigger: "status_change",
        workspaceId,
      });
    })
  );

test("a stop kills the container, marks the run interrupted and names who asked", async () => {
  const task = await makeTask("in_progress");
  const run = await makeLiveRun(task.id);
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "stop" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("acted");
  expect(outcome?.command.status).toBe("consumed");
  expect(calls.stopped).toEqual([
    { runId: run.id, subject: taskSubject(task.id), workspaceId },
  ]);

  const [closed, events] = await runStore(
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      const runEvents = yield* RunEventRepo;
      return [
        yield* runs.byId({ id: run.id, workspaceId }),
        yield* runEvents.listByRun({ runId: run.id, workspaceId }),
      ] as const;
    })
  );

  expect(closed.status).toBe("interrupted");
  expect(closed.outcome).toBe("interrupted");

  const [stopped] = events;
  expect(events).toHaveLength(1);
  expect(stopped?.seq).toBe(STOPPED_SEQ);
  expect(stopped?.payload).toMatchObject({
    commandId: outcome?.command.id,
    kind: "stopped",
    requestedByKind: "system",
  });
});

test("a stop with nothing running is rejected with the reason on the row", async () => {
  const task = await makeTask("in_progress");
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "stop" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("rejected");
  expect(outcome?.command.status).toBe("rejected");
  expect(outcome?.command.rejectedReason).toBe(
    "there is no live run on this task to stop"
  );
  expect(calls.stopped).toHaveLength(0);
});

test("a stop whose container is already gone still closes the row out", async () => {
  const task = await makeTask("in_progress");
  const run = await makeLiveRun(task.id);
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    { containerFound: false },
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "stop" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("acted");
  const closed = await runStore(
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      return yield* runs.byId({ id: run.id, workspaceId });
    })
  );
  expect(closed.outcome).toBe("interrupted");
});

test("a rerun starts a run, clears the park, and says so on the trigger", async () => {
  const task = await makeTask("in_progress");
  // Parked as the retry ladder would leave it: an explicit rerun is the same
  // "somebody has decided this should run" that un-parks it.
  await runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      const now = yield* DateTime.now;
      yield* tasks.update({
        fields: { parkedUntil: DateTime.addDuration(now, "1 hour") },
        id: task.id,
        workspaceId,
      });
    })
  );
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "rerun" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("acted");
  // The trace is whatever the write ran under, and there is always one: every
  // repository method opens a span of its own. Its value is the next test.
  expect(calls.dispatched).toEqual([
    {
      subject: taskSubject(task.id),
      traceparent: expect.any(String),
      trigger: "rerun",
      workspaceId,
    },
  ]);

  const unparked = await runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      return yield* tasks.byId({ id: task.id, workspaceId });
    })
  );
  expect(unparked.parkedUntil).toBeNull();
});

test("a rerun carries the asking request's trace across to the dispatcher", async () => {
  const task = await makeTask("in_progress");
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      // The write as a gateway handler makes it: inside the request's span,
      // which the caller's `traceparent` header is the parent of. Nothing about
      // the trace is passed as an argument — the row picks it off the span.
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "rerun" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      ).pipe(
        Effect.withSpan("POST /tasks/:taskId/commands"),
        Effect.withParentSpan(
          Tracer.externalSpan({ spanId: CALLER_SPAN_ID, traceId: CALLER_TRACE })
        )
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("acted");
  expect(outcome?.command.traceparent).not.toBeNull();
  // The command row's own column, and the request it hands the dispatcher, are
  // the same trace the caller minted — not the poll's that claimed the row.
  expect(parseTraceparent(outcome?.command.traceparent)?.traceId).toBe(
    CALLER_TRACE
  );
  expect(
    parseTraceparent(calls.dispatched[0]?.traceparent ?? null)?.traceId
  ).toBe(CALLER_TRACE);
});

test("a rerun on a task that is not in progress is refused, not silently obeyed", async () => {
  const task = await makeTask("backlog");
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "rerun" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("rejected");
  expect(outcome?.command.rejectedReason).toBe(
    "a rerun needs the task in progress, and it is in backlog"
  );
  expect(calls.dispatched).toHaveLength(0);
});

test("a rerun while a container is working is refused rather than doubling up", async () => {
  const task = await makeTask("in_progress");
  const run = await makeLiveRun(task.id);
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "rerun" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("rejected");
  expect(outcome?.command.rejectedReason).toContain(run.id);
  expect(calls.dispatched).toHaveLength(0);
});

test("a start_session spawns research from the backlog without moving the card", async () => {
  const task = await makeTask("backlog");
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "start_session", trigger: "research" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("acted");
  expect(calls.dispatched).toEqual([
    {
      subject: taskSubject(task.id),
      traceparent: expect.any(String),
      trigger: "research",
      workspaceId,
    },
  ]);

  const after = await runStore(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      return yield* tasks.byId({ id: task.id, workspaceId });
    })
  );
  expect(after.status).toBe("backlog");
});

test("a start_session cannot borrow the dispatcher's own trigger", async () => {
  const task = await makeTask("backlog");
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "start_session", trigger: "status_change" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("rejected");
  expect(outcome?.command.rejectedReason).toBe(
    "a start_session cannot claim the status_change trigger"
  );
  expect(calls.dispatched).toHaveLength(0);
});

test("a failure inside the handler still leaves a reason on the row", async () => {
  const task = await makeTask("in_progress");
  const calls = emptyCalls();

  const outcome = await runWith(
    calls,
    { dispatchFails: true },
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      yield* withActor(asker)(
        commands.enqueue({
          payload: { kind: "rerun" },
          subject: taskSubject(task.id),
          workspaceId,
        })
      );
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );

  expect(outcome?.result).toBe("rejected");
  expect(outcome?.command.status).toBe("rejected");
  expect(outcome?.command.rejectedReason).toContain("the dispatcher refused");
});

test("an empty queue answers null rather than waiting", async () => {
  const outcome = await runWith(
    emptyCalls(),
    {},
    Effect.gen(function* () {
      const consumer = yield* RunCommands;
      return yield* consumer.consumeNext({ workspaceId });
    })
  );
  expect(outcome).toBeNull();
});

test("a drain takes the queue in the order it was written and stops when it is empty", async () => {
  const first = await makeTask("backlog");
  const second = await makeTask("backlog");
  const calls = emptyCalls();

  const handled = await runWith(
    calls,
    {},
    Effect.gen(function* () {
      const commands = yield* RunCommandRepo;
      for (const task of [first, second]) {
        yield* withActor(asker)(
          commands.enqueue({
            payload: { kind: "start_session", trigger: "manual" },
            subject: taskSubject(task.id),
            workspaceId,
          })
        );
      }
      const consumer = yield* RunCommands;
      return yield* consumer.drain({ workspaceId });
    })
  );

  expect(handled).toHaveLength(2);
  expect(handled.map((outcome) => outcome.command.taskId)).toEqual([
    first.id,
    second.id,
  ]);
  expect(calls.dispatched.map((request) => request.subject)).toEqual([
    taskSubject(first.id),
    taskSubject(second.id),
  ]);
});
