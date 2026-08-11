/**
 * What the lease is worth is decided on a real filesystem, so that is what
 * these run against: a temp data root, files written by hand where a dead
 * process would have left them, and the store asked what it makes of them.
 *
 * The reconcile half needs a real database for the same reason the store's own
 * checks do — closing a run out is a decision the repository makes inside its
 * transaction — and it is skipped where none is configured, which is any run
 * that did not load the repo's `.env`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import {
  AgentSessionRepo,
  type Auth,
  RunRepo,
  storeLayer,
  TaskRepo,
  type WorkspaceRepo,
  withActor,
} from "@workspace/db";
import { ensureFixtureWorkspace } from "@workspace/db/testing";
import {
  Actor,
  newRunId,
  newTaskId,
  newThreadId,
  type RunSubject,
  type TaskId,
  UserId,
} from "@workspace/domain";
import { hostRunLayout } from "@workspace/harness";
import { ConfigProvider, Effect, Fiber, Latch, Layer, Schedule } from "effect";
import type { FileSystem } from "effect/FileSystem";
import {
  type LeaseRecord,
  LeaseStore,
  leasePathOf,
  leasesDirOf,
  PidAlive,
  reconcileLostRuns,
} from "./lease";
import { subjectKeyOf, subjectOfRow } from "./subject";

/** Short enough that a doctored beat is plainly outside it, long enough to be a real window. */
const STALE_MS = 400;

/** Fast enough that the forked beat lands while a test is still watching. */
const HEARTBEAT_MS = 5;

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "lease-"));
});

afterEach(() => {
  rmSync(dataRoot, { force: true, recursive: true });
});

const configLayer = () =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DATA_ROOT: dataRoot,
      ORCHESTRATOR_LEASE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      ORCHESTRATOR_LEASE_STALE_MS: String(STALE_MS),
    })
  );

/**
 * A store over the temp root. Built per call rather than shared, which is how a
 * test gets a second loop: a fresh build mints a fresh instance id, so the two
 * only agree through the files they leave each other.
 */
const leaseLayer = () =>
  LeaseStore.layer.pipe(
    Layer.provideMerge(BunFileSystem.layer),
    Layer.provide(configLayer())
  );

const run = <A, E>(program: Effect.Effect<A, E, LeaseStore>) =>
  Effect.runPromise(program.pipe(Effect.provide(leaseLayer())));

/** A task, as the thing a lease is on. Threads take the same shape. */
const taskSubject = (id: TaskId): RunSubject => ({ id, kind: "task" });

const leaseFileOf = (subject: RunSubject) => leasePathOf({ dataRoot, subject });

/** A lease exactly where a previous process would have left one. */
const writeLeaseFile = (record: LeaseRecord) => {
  mkdirSync(leasesDirOf(dataRoot), { recursive: true });
  writeFileSync(leaseFileOf(record.subject), JSON.stringify(record));
};

const readLeaseFile = (subject: RunSubject) =>
  JSON.parse(readFileSync(leaseFileOf(subject), "utf8")) as LeaseRecord;

/** A lease held by somebody else, `agedMs` since its last beat. */
const foreignLease = (input: {
  readonly agedMs: number;
  readonly runId?: LeaseRecord["runId"];
  readonly subject: RunSubject;
}): LeaseRecord => {
  const now = Date.now();
  return {
    claimedAtMs: now - input.agedMs,
    heartbeatAtMs: now - input.agedMs,
    instanceId: "another-loop",
    pid: process.pid,
    runId: input.runId ?? null,
    subject: input.subject,
  };
};

describe("claiming a subject", () => {
  test("writes a lease naming this process", async () => {
    const subject = taskSubject(newTaskId());
    const claimed = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        return yield* leases.claim({ subject });
      })
    );

    const onDisk = readLeaseFile(subject);
    expect(onDisk.subject).toEqual(subject);
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.instanceId).toBe(claimed.instanceId);
    expect(onDisk.runId).toBeNull();
  });

  test("gives a conversation a durable claim of its own", async () => {
    const subject: RunSubject = { id: newThreadId(), kind: "thread" };
    const { held, refusal } = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        yield* leases.claim({ subject });
        return {
          held: yield* leases.held,
          refusal: yield* Effect.flip(leases.claim({ subject })),
        };
      })
    );

    // The whole point of keying by subject: a chat turn is claimed exactly the
    // way a worker run is, across processes and across a restart.
    expect(refusal._tag).toBe("Orchestrator.AlreadyLive");
    expect(held.has(subjectKeyOf(subject))).toBe(true);
    expect(readLeaseFile(subject).subject).toEqual(subject);
  });

  test("refuses a subject this process is already on, and names the run", async () => {
    const subject = taskSubject(newTaskId());
    const runId = newRunId();
    const refusal = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        yield* leases.claim({ subject });
        yield* leases.attach({ runId, subject });
        return yield* Effect.flip(leases.claim({ subject }));
      })
    );

    expect(refusal._tag).toBe("Orchestrator.AlreadyLive");
    expect(readLeaseFile(subject).runId).toBe(runId);
  });

  test("refuses a subject another loop is still heartbeating", async () => {
    const subject = taskSubject(newTaskId());
    const runId = newRunId();
    writeLeaseFile(foreignLease({ agedMs: 0, runId, subject }));

    const refusal = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        return yield* Effect.flip(leases.claim({ subject }));
      })
    );

    expect(refusal._tag).toBe("Orchestrator.AlreadyLive");
    // The refusal came off the file, so it can say which run is on the subject.
    expect((refusal as { readonly runId: unknown }).runId).toBe(runId);
  });

  test("gives the subject back on release", async () => {
    const subject = taskSubject(newTaskId());
    const held = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        yield* leases.claim({ subject });
        yield* leases.release({ subject });
        yield* leases.claim({ subject });
        return yield* leases.held;
      })
    );

    expect(held.has(subjectKeyOf(subject))).toBe(true);
    expect(existsSync(leaseFileOf(subject))).toBe(true);
  });
});

describe("reclaiming after a crash", () => {
  test("takes back a lease that stopped heartbeating", async () => {
    const subject = taskSubject(newTaskId());
    writeLeaseFile(foreignLease({ agedMs: STALE_MS * 3, subject }));

    const { claimed, reclaimed } = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        const stale = yield* leases.reclaimStale;
        return { claimed: yield* leases.claim({ subject }), reclaimed: stale };
      })
    );

    expect(reclaimed.map((lease) => lease.subject)).toEqual([subject]);
    expect(claimed.subject).toEqual(subject);
  });

  test("takes back a fresh lease whose process is gone", async () => {
    const subject = taskSubject(newTaskId());
    writeLeaseFile(foreignLease({ agedMs: 0, subject }));

    const reclaimed = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        return yield* leases.reclaimStale;
      }).pipe(Effect.provideService(PidAlive, () => false))
    );

    expect(reclaimed.map((lease) => lease.subject)).toEqual([subject]);
    expect(existsSync(leaseFileOf(subject))).toBe(false);
  });

  test("leaves a lease another live loop is holding", async () => {
    const subject = taskSubject(newTaskId());
    writeLeaseFile(foreignLease({ agedMs: 0, subject }));

    const { live, reclaimed } = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        const stale = yield* leases.reclaimStale;
        return { live: yield* leases.liveLeases, reclaimed: stale };
      })
    );

    expect(reclaimed).toEqual([]);
    expect(live.map((lease) => lease.subject)).toEqual([subject]);
    expect(existsSync(leaseFileOf(subject))).toBe(true);
  });

  test("ignores a half-written lease rather than believing it", async () => {
    const subject = taskSubject(newTaskId());
    mkdirSync(leasesDirOf(dataRoot), { recursive: true });
    writeFileSync(leaseFileOf(subject), '{"subject":"');

    const { claimed, live } = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        const found = yield* leases.liveLeases;
        return { claimed: yield* leases.claim({ subject }), live: found };
      })
    );

    expect(live).toEqual([]);
    expect(claimed.subject).toEqual(subject);
  });
});

describe("heartbeating", () => {
  test("puts a lease that had drifted stale back inside the window", async () => {
    const subject = taskSubject(newTaskId());
    const { afterBeat, beforeBeat, state } = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        const claimed = yield* leases.claim({ subject });
        // Exactly what a loop that was starved for a minute leaves behind.
        writeLeaseFile({
          ...claimed,
          heartbeatAtMs: claimed.heartbeatAtMs - STALE_MS * 3,
        });
        const stale = yield* leases.isLive(readLeaseFile(subject));
        const beat = yield* leases.heartbeat({ subject });
        return {
          afterBeat: yield* leases.isLive(readLeaseFile(subject)),
          beforeBeat: stale,
          state: beat,
        };
      })
    );

    expect(beforeBeat).toBe(false);
    expect(state).toBe("held");
    expect(afterBeat).toBe(true);
  });

  test("says the lease is lost once another loop has taken it", async () => {
    const subject = taskSubject(newTaskId());
    const state = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        yield* leases.claim({ subject });
        writeLeaseFile(foreignLease({ agedMs: 0, subject }));
        return yield* leases.heartbeat({ subject });
      })
    );

    expect(state).toBe("lost");
  });

  test("keeps beating for as long as the work runs", async () => {
    const subject = taskSubject(newTaskId());
    const beats = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        return yield* leases.withLease({ subject }, (lease) =>
          // Polled on the lease's own interval rather than slept through, so a
          // heartbeat that never fires fails the test instead of passing it.
          Effect.suspend(() =>
            Effect.succeed(readLeaseFile(subject).heartbeatAtMs)
          ).pipe(
            Effect.filterOrFail((beat) => beat > lease.claimedAtMs),
            Effect.retry(Schedule.spaced(HEARTBEAT_MS))
          )
        );
      })
    );

    expect(beats).toBeGreaterThan(0);
  });
});

describe("holding a lease around work", () => {
  test("releases the claim when the run is interrupted", async () => {
    const subject = taskSubject(newTaskId());
    const { after, during } = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        const started = yield* Latch.make(false);
        const never = yield* Latch.make(false);

        const fiber = yield* Effect.forkChild(
          leases.withLease({ subject }, () =>
            Effect.gen(function* () {
              yield* started.open;
              yield* never.await;
            })
          ),
          { startImmediately: true }
        );

        yield* started.await;
        const held = yield* leases.held;
        yield* Fiber.interrupt(fiber);
        return { after: yield* leases.held, during: held };
      })
    );

    expect(during.has(subjectKeyOf(subject))).toBe(true);
    expect(after.has(subjectKeyOf(subject))).toBe(false);
    expect(existsSync(leaseFileOf(subject))).toBe(false);
  });

  test("releases the claim when the work fails", async () => {
    const subject = taskSubject(newTaskId());
    const held = await run(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        yield* leases
          .withLease({ subject }, () => Effect.fail("the container died"))
          .pipe(Effect.ignore);
        return yield* leases.held;
      })
    );

    expect(held.has(subjectKeyOf(subject))).toBe(false);
    expect(existsSync(leaseFileOf(subject))).toBe(false);
  });
});

/**
 * The reconcile writes rows, so it wants the database the rest of the store is
 * checked against. Skipped rather than failed where none is configured: a
 * package-scoped run has not loaded the repo's `.env`.
 */
const databaseUrl = process.env.DATABASE_URL;

/** Names this process in `pg_stat_activity`, and its fixture workspace. */
const LEASE_SUITE = "orchestrator-lease-test";

describe.skipIf(databaseUrl === undefined)("reconciling lost runs", () => {
  const storeAndLeases = () =>
    Layer.mergeAll(leaseLayer(), storeLayer({ applicationName: LEASE_SUITE }));

  const runWithStore = <A, E>(
    program: Effect.Effect<
      A,
      E,
      | AgentSessionRepo
      | Auth
      | FileSystem
      | LeaseStore
      | RunRepo
      | TaskRepo
      | WorkspaceRepo
    >
  ) => Effect.runPromise(program.pipe(Effect.provide(storeAndLeases())));

  // This suite's own workspace, made on first use. Every row below is created
  // inside it and deleted again, and the cascade takes the session and the run
  // with the task.
  const seededWorkspace = Effect.map(
    ensureFixtureWorkspace({ suite: LEASE_SUITE }),
    (fixture) => fixture.workspace
  );

  const actor = Actor.cases.system.make({ reason: "lease test" });

  /** Erasing a task is owner-only, so the teardown asks as a person. */
  const remover = Actor.cases.human.make({ userId: UserId.make("lease-test") });

  test("closes a run nobody holds as lost, and spares one that is held", async () => {
    const result = await runWithStore(
      Effect.gen(function* () {
        const leases = yield* LeaseStore;
        const runs = yield* RunRepo;
        const sessions = yield* AgentSessionRepo;
        const tasks = yield* TaskRepo;
        const workspace = yield* seededWorkspace;
        const workspaceId = workspace.id;

        const openRun = Effect.fnUntraced(function* (title: string) {
          const task = yield* tasks.create({
            brief: "A run the loop lost track of.",
            title,
            workspaceId,
          });
          const subject = taskSubject(task.id);
          const session = yield* sessions.open({
            provider: "claude",
            subject,
            workspaceId,
          });
          const attempt = yield* runs.create({
            agentSessionId: session.id,
            provider: "claude",
            subject,
            trigger: "status_change",
            workspaceId,
          });
          return { run: attempt, task };
        });

        const abandoned = yield* openRun("lease test — abandoned").pipe(
          withActor(actor)
        );
        const guarded = yield* openRun("lease test — still held").pipe(
          withActor(actor)
        );

        // Two lines the container appended before it went quiet: the count is
        // what tells a run that never started from one that died halfway.
        const eventLog = hostRunLayout({
          dataRoot,
          runId: abandoned.run.id,
        }).eventLogPath;
        mkdirSync(join(eventLog, ".."), { recursive: true });
        writeFileSync(eventLog, '{"kind":"log"}\n{"kind":"log"}\n');

        // Every other live run in this workspace is somebody else's fixture, so
        // it is leased before the sweep and left exactly as it was found.
        for (const live of yield* runs.listLive({ workspaceId })) {
          const held = subjectOfRow(live);
          if (live.id !== abandoned.run.id && held !== null) {
            yield* leases.claim({ subject: held });
          }
        }

        const lost = yield* reconcileLostRuns({ dataRoot, workspaceId });

        const closed = yield* runs.byId({
          id: abandoned.run.id,
          workspaceId,
        });
        const spared = yield* runs.byId({ id: guarded.run.id, workspaceId });

        yield* tasks
          .delete({ id: abandoned.task.id, workspaceId })
          .pipe(withActor(remover));
        yield* tasks
          .delete({ id: guarded.task.id, workspaceId })
          .pipe(withActor(remover));

        return { closed, lost, spared };
      })
    );

    const { closed, lost, spared } = result;
    expect(lost.map((entry) => entry.run.id)).toEqual([closed.id]);
    expect(lost[0]?.terminus.eventsSeen).toBe(2);
    expect(closed.outcome).toBe("lost");
    expect(closed.status).toBe("failed");
    expect(closed.errorClass).toBe("NoTerminalEvent");
    expect(closed.costUsd).toBeNull();
    expect(closed.durationMs).toBeNull();
    expect(spared.outcome).toBeNull();
  });
});
