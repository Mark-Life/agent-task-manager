/**
 * The run-event stream, against a real database and the trigger that feeds it.
 *
 * Three things can be wrong here and none of them shows up in a type. The
 * channel name can drift from the one the migration publishes on, and a stream
 * that listens forever and never wakes looks exactly like a run with nothing to
 * say. A reconnecting client can be handed the beginning of a timeline it
 * already has, or the middle of one it does not. And a browser tab that goes
 * away can leave its listener behind, which is the failure that arrives as a
 * database out of connections rather than as a bug in this file.
 *
 * So the live path is asserted through an actual `NOTIFY` rather than through
 * the tick that also covers it: the subscriber is proved attached by an event
 * written before it started, and only then are the events it must hear over the
 * channel appended. The tick is ten seconds away, so anything that arrives in
 * the second after an insert arrived because Postgres said so.
 */

import { afterAll, expect, test } from "bun:test";
import { PgClient } from "@effect/sql-pg";
import {
  AgentSessionRepo,
  RunEventRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  withActor,
} from "@workspace/db";
import { ensureFixtureWorkspace } from "@workspace/db/testing";
import type { RunEvent, RunEventPayload } from "@workspace/domain";
import {
  Actor,
  newRunEventId,
  newRunId,
  newTaskId,
  type RunId,
  type TaskId,
  UserId,
} from "@workspace/domain";
import {
  DateTime,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { RUN_EVENT_CHANNEL, RunEventNotices, runEventStream } from "./sse";

/** Reported as `application_name`, which is how the listener is found below. */
const APPLICATION_NAME = "gateway-sse-test";

/** How often a probe is republished while waiting for `LISTEN` to take effect. */
const NUDGE_INTERVAL_MS = 50;

/** How often the connection count is re-read while waiting for it to settle. */
const SETTLE_INTERVAL_MS = 50;

/** Long enough for a local database, short enough to fail rather than hang. */
const WAIT_TIMEOUT = "10 seconds";

/** Enough for a whole test to finish twice over on a laptop. */
const TEST_TIMEOUT_MS = 30_000;

/** The listener count is not what it will be yet. Retried, never reported. */
class NotSettled extends Schema.TaggedErrorClass<NotSettled>()(
  "SseTest.NotSettled",
  { expected: Schema.Number, found: Schema.Number }
) {}

const runtime = ManagedRuntime.make(
  RunEventNotices.layer.pipe(
    Layer.provideMerge(storeLayer({ applicationName: APPLICATION_NAME }))
  )
);

const human = Actor.cases.human.make({
  userId: UserId.make("sse-test-human"),
});

const orchestrator = Actor.cases.orchestrator.make({
  loopInstance: "sse-test",
});

const asHuman = withActor(human);
const asOrchestrator = withActor(orchestrator);

const workspaceId = await runtime.runPromise(
  Effect.gen(function* () {
    const { workspace } = yield* ensureFixtureWorkspace({
      suite: APPLICATION_NAME,
    });
    return workspace.id;
  })
);

const filed: TaskId[] = [];

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

/** A task with a live run on it, which is the least a timeline needs to exist. */
const fileRun = (title: string) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepo;
    const sessions = yield* AgentSessionRepo;
    const runs = yield* RunRepo;

    const task = yield* asHuman(
      tasks.create({ status: "backlog", title, workspaceId })
    );
    filed.push(task.id);

    const session = yield* asOrchestrator(
      sessions.open({
        provider: "claude",
        subject: { id: task.id, kind: "task" },
        workspaceId,
      })
    );
    const run = yield* asOrchestrator(
      runs.create({
        agentSessionId: session.id,
        provider: "claude",
        subject: { id: task.id, kind: "task" },
        trigger: "status_change",
        workspaceId,
      })
    );

    return { runId: run.id, taskId: task.id };
  });

/** One line of a timeline. The insert is what fires the trigger under test. */
const appendEvent = (input: {
  readonly payload: RunEventPayload;
  readonly runId: RunId;
  readonly seq: number;
  readonly taskId: TaskId;
}) =>
  Effect.gen(function* () {
    const events = yield* RunEventRepo;
    const occurredAt = yield* DateTime.now;
    return yield* events.append({
      occurredAt,
      payload: input.payload,
      runId: input.runId,
      seq: input.seq,
      subject: { id: input.taskId, kind: "task" },
      workspaceId,
    });
  });

/** A line the agent said, which is the cheapest event that is not a terminus. */
const logPayload = (message: string): RunEventPayload => ({
  kind: "log",
  level: "info",
  message,
});

/** The clean terminus, which is what a subscriber stops on. */
const finishedPayload: RunEventPayload = {
  costUsd: null,
  durationMs: 1,
  kind: "finished",
  outcome: "done",
  totalTokens: 0,
  turns: 1,
};

/**
 * The backends holding a `LISTEN` for this test's application name.
 *
 * `pg_stat_activity` reports the last statement an idle backend ran, and the
 * listening connection's last statement is its `LISTEN` — so this counts the
 * thing whose leak the design is meant to prevent, not a proxy for it.
 */
const listeningBackends = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql`
    select pid from pg_stat_activity
    where application_name = ${APPLICATION_NAME} and query like 'LISTEN%'
  `;
  return rows.length;
});

/** Waits for the listener count to reach a number, or fails saying what it found. */
const awaitListeners = (expected: number) =>
  Effect.gen(function* () {
    const found = yield* listeningBackends;
    if (found !== expected) {
      return yield* Effect.fail(new NotSettled({ expected, found }));
    }
    return found;
  }).pipe(
    Effect.retry(Schedule.spaced(SETTLE_INTERVAL_MS)),
    Effect.timeout(WAIT_TIMEOUT)
  );

/**
 * Blocks until the shared listener is demonstrably on the channel.
 *
 * `LISTEN` takes effect when its statement returns and nothing observable says
 * when that was, so a notice is republished until one comes back — the same
 * removal of the race the dispatch trigger's test makes, without a fixed sleep
 * standing in for a synchronization primitive that does not exist. The notice
 * names a run nobody is subscribed to, so it wakes no drain.
 */
const awaitChannel = Effect.gen(function* () {
  const { notices } = yield* RunEventNotices;
  const sql = yield* PgClient.PgClient;
  const probe = newRunId();
  const payload = JSON.stringify({
    id: newRunEventId(),
    kind: "log",
    runId: probe,
    seq: 0,
    taskId: newTaskId(),
    workspaceId,
  });

  const heard = yield* Effect.forkChild(
    Stream.runHead(Stream.filter(notices, (notice) => notice.runId === probe)),
    { startImmediately: true }
  );

  yield* Effect.race(
    Fiber.join(heard),
    Effect.repeat(
      sql.notify(RUN_EVENT_CHANNEL, payload),
      Schedule.spaced(NUDGE_INTERVAL_MS)
    )
  ).pipe(Effect.timeout(WAIT_TIMEOUT));
});

/** Reads a stream into a queue, so a test can take from it between writes. */
const inboxOf = (stream: Stream.Stream<RunEvent>) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<RunEvent>();
    const reader = yield* Effect.forkChild(
      Stream.runForEach(stream, (event) => Queue.offer(inbox, event)),
      { startImmediately: true }
    );
    return { inbox, reader };
  });

test(
  "events written to a live run reach a subscriber over the channel, in order",
  async () => {
    const seqs = await runtime.runPromise(
      Effect.gen(function* () {
        // Held for the whole test: the multicast is torn down when its last
        // subscriber leaves, and what is being proved is that the channel was
        // already up when the writes happened.
        const { notices } = yield* RunEventNotices;
        const holder = yield* Effect.forkChild(Stream.runDrain(notices), {
          startImmediately: true,
        });
        yield* awaitChannel;

        const run = yield* fileRun("sse: live delivery");
        yield* appendEvent({ ...run, payload: logPayload("first"), seq: 0 });

        const stream = yield* runEventStream({ ...run, workspaceId });
        const { inbox, reader } = yield* inboxOf(stream);

        // The catch-up read. Receiving it is what says the subscriber is
        // attached to the channel, because both start with the stream.
        const first = yield* Queue.take(inbox).pipe(
          Effect.timeout(WAIT_TIMEOUT)
        );

        yield* appendEvent({ ...run, payload: logPayload("second"), seq: 1 });
        yield* appendEvent({ ...run, payload: logPayload("third"), seq: 2 });

        const second = yield* Queue.take(inbox).pipe(
          Effect.timeout(WAIT_TIMEOUT)
        );
        const third = yield* Queue.take(inbox).pipe(
          Effect.timeout(WAIT_TIMEOUT)
        );

        yield* Fiber.interrupt(reader);
        yield* Fiber.interrupt(holder);

        return [first, second, third].map((event) => event.seq);
      })
    );

    expect(seqs).toEqual([0, 1, 2]);
  },
  TEST_TIMEOUT_MS
);

test(
  "a subscriber resumes after a seq it already has, and stops when the run does",
  async () => {
    const events = await runtime.runPromise(
      Effect.gen(function* () {
        const run = yield* fileRun("sse: replay from a cursor");
        yield* appendEvent({ ...run, payload: logPayload("first"), seq: 0 });
        yield* appendEvent({ ...run, payload: logPayload("second"), seq: 1 });
        yield* appendEvent({ ...run, payload: finishedPayload, seq: 2 });

        // No take and no timeout: a finished run's stream ends on its own, and
        // a stream that did not would hang the test rather than pass it.
        const stream = yield* runEventStream({
          ...run,
          afterSeq: 0,
          workspaceId,
        });
        return yield* Stream.runCollect(stream).pipe(
          Effect.timeout(WAIT_TIMEOUT)
        );
      })
    );

    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.at(-1)?.payload.kind).toBe("finished");
  },
  TEST_TIMEOUT_MS
);

test(
  "subscribers share one listener, and the last one out releases it",
  async () => {
    const counts = await runtime.runPromise(
      Effect.gen(function* () {
        const { notices } = yield* RunEventNotices;
        const idle = yield* awaitListeners(0);

        const first = yield* Effect.forkChild(Stream.runDrain(notices), {
          startImmediately: true,
        });
        const second = yield* Effect.forkChild(Stream.runDrain(notices), {
          startImmediately: true,
        });
        yield* awaitChannel;
        const shared = yield* listeningBackends;

        yield* Fiber.interrupt(first);
        const remaining = yield* listeningBackends;

        yield* Fiber.interrupt(second);
        const released = yield* awaitListeners(0);

        return { idle, released, remaining, shared };
      })
    );

    expect(counts.idle).toBe(0);
    expect(counts.shared).toBe(1);
    expect(counts.remaining).toBe(1);
    expect(counts.released).toBe(0);
  },
  TEST_TIMEOUT_MS
);
