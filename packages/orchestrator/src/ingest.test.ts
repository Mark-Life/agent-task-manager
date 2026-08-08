/**
 * What a run leaves on disk, read back against a real database and a real
 * filesystem.
 *
 * Nothing here is mocked, because nothing here would mean anything mocked. The
 * claims are all about two systems agreeing: that a second ingest of the same
 * file collides on `(run_id, seq)` in Postgres rather than writing the run
 * twice, that a file deleted on disk stops being a row, that the numbers a
 * container wrote to a mount reach the run row on the host. A fake filesystem
 * or a fake index would be asserting the fake.
 *
 * The fixtures are two real tasks with real sessions and runs, and they are
 * deleted afterwards — a task delete cascades to its comments, sessions, runs,
 * run events and artifact index rows, so the tree goes with it. The audit rows
 * stay, which is what append-only means.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
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
  AgentSessionUsageRepo,
  ArtifactRepo,
  CurrentActor,
  RunEventRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import type {
  AgentSession,
  Run,
  RunSubject,
  Task,
  WorkspaceId,
} from "@workspace/domain";
import { Actor, CostUsd, PRICE_TABLE_VERSION, UserId } from "@workspace/domain";
import type { AgentEvent } from "@workspace/harness";
import {
  AgentEventRecord,
  hostRunLayout,
  TURN_EVENT_MARKER,
  TurnEvent,
} from "@workspace/harness";
import { taskArtifactsDirOf } from "@workspace/sandbox";
import { DateTime, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { rescanTaskArtifacts } from "./artifacts";
import type { DispatchContext } from "./dispatch-context";
import { lostTerminus } from "./dispatch-context";
import { ingestRunEvents, ingestTurnLedger } from "./ingest";
import { workerAttachment } from "./subject";
import {
  durableTranscriptPathOf,
  ingestTranscript,
  preserveTranscript,
  TRANSCRIPT_SEQ_BASE,
} from "./transcript-ingest";
import { runEconomicsOf } from "./turn-rollup";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "orchestrator-ingest-test";

/** The provider session id the transcript fixture declares. */
const PROVIDER_SESSION = "b3144824-0ff3-4ded-bf94-fa5dd51f9f10";

const SANDBOX_IMAGE = "ghcr.io/test/base:latest";

/** The database has never been seeded, so there is no workspace to hang a task on. */
class NoWorkspace extends Schema.TaggedErrorClass<NoWorkspace>()(
  "IngestTest.NoWorkspace",
  { detail: Schema.String }
) {}

const loop = Actor.cases.orchestrator.make({ loopInstance: APPLICATION_NAME });
const seeder = Actor.cases.system.make({ reason: "ingest-test" });

/**
 * Who tears the fixtures down. Erasing a task is owner-only, so the teardown
 * asks as a person rather than as the loop or the seeder.
 */
const remover = Actor.cases.human.make({
  userId: UserId.make(APPLICATION_NAME),
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    storeLayer({ applicationName: APPLICATION_NAME }),
    BunFileSystem.layer,
    CurrentActor.layer(loop)
  )
);

const at = (iso: string) => DateTime.fromDateUnsafe(new Date(iso));

const encodeRecord = Schema.encodeSync(AgentEventRecord);

/** One line of the normalized event file, exactly as a container appends it. */
const eventLine = (event: AgentEvent, iso: string) =>
  JSON.stringify(encodeRecord({ event, occurredAt: at(iso) }));

/** One `atm.turn` row: the unit's fields, then the stamp the emitter adds. */
const turnLine = (
  overrides: Partial<Parameters<typeof TurnEvent.encode>[0]> & {
    readonly runId: string;
    readonly ts: string;
  }
) => {
  const { ts, ...fields } = overrides;
  return JSON.stringify({
    ts,
    ...TurnEvent.encode({
      agentHomeSet: true,
      assistantChars: 12,
      assistantMessages: 1,
      costUsd: null,
      durationMs: null,
      effort: null,
      errorClass: null,
      errorEvents: 0,
      errorMessage: null,
      eventsSeen: 3,
      inputTokens: null,
      model: "claude-opus-5",
      outcome: "done",
      outputTokens: null,
      phase: "end",
      promptChars: 120,
      provider: "claude",
      providerSessionId: PROVIDER_SESSION,
      queueWaitMs: null,
      rateLimitPeakPct: null,
      rateLimitStatus: null,
      rateLimitType: null,
      reasoningChars: 0,
      resumed: false,
      sessionId: null,
      spanId: null,
      subagents: 0,
      taskId: null,
      toolCalls: 1,
      toolErrors: 0,
      totalTokens: null,
      traceId: null,
      turns: null,
      workspaceId: null,
      ...fields,
    }),
    event: TURN_EVENT_MARKER,
    gitSha: "abc1234",
    host: "test-host",
    version: "0.0.1",
  });
};

/** A file shaped like the one Claude Code writes into the run's agent home. */
const TRANSCRIPT_LINES = [
  JSON.stringify({
    message: { content: "build the reader", role: "user" },
    sessionId: PROVIDER_SESSION,
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "user",
  }),
  JSON.stringify({
    message: {
      content: [
        { signature: "sig", thinking: "weigh the options", type: "thinking" },
        { text: "Looking at it now.", type: "text" },
        {
          id: "toolu_01",
          input: { command: "gh auth token", description: "list" },
          name: "Bash",
          type: "tool_use",
        },
      ],
      model: "claude-opus-5",
      role: "assistant",
      // Every real assistant line carries one of these, and it is where the
      // session's economics come from.
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: 400,
          ephemeral_5m_input_tokens: 0,
        },
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 1200,
        input_tokens: 100,
        output_tokens: 50,
        speed: "standard",
      },
    },
    sessionId: PROVIDER_SESSION,
    timestamp: "2026-08-01T10:00:04.000Z",
    type: "assistant",
  }),
  JSON.stringify({
    message: {
      content: [
        {
          content: "permission denied",
          is_error: true,
          tool_use_id: "toolu_01",
          type: "tool_result",
        },
      ],
      role: "user",
    },
    sessionId: PROVIDER_SESSION,
    timestamp: "2026-08-01T10:00:05.000Z",
    type: "user",
  }),
];

const writeAt = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

/** One dispatch context over an already-written run row. */
const contextOf = (input: {
  readonly dataRoot: string;
  readonly run: Run;
  readonly session: AgentSession;
  readonly task: Task;
}): DispatchContext => ({
  actor: loop,
  attached: workerAttachment(input.task),
  attempt: 1,
  image: SANDBOX_IMAGE,
  layout: hostRunLayout({ dataRoot: input.dataRoot, runId: input.run.id }),
  project: null,
  provider: "claude",
  queueWaitMs: 0,
  repoUrl: null,
  runId: input.run.id,
  session: { mode: "fresh", selected: "new", session: input.session },
  spanId: null,
  traceId: null,
  traceparent: null,
  trigger: "status_change",
});

/** A task with a fresh session and a queued run on it. */
const fixture = Effect.fnUntraced(function* (input: {
  readonly title: string;
  readonly workspaceId: WorkspaceId;
}) {
  const tasks = yield* TaskRepo;
  const sessions = yield* AgentSessionRepo;
  const runs = yield* RunRepo;

  const task = yield* withActor(seeder)(
    tasks.create({ title: input.title, workspaceId: input.workspaceId })
  );
  const subject: RunSubject = { id: task.id, kind: "task" };
  const session = yield* sessions.open({
    provider: "claude",
    subject,
    workspaceId: input.workspaceId,
  });
  const run = yield* runs.create({
    agentSessionId: session.id,
    provider: "claude",
    subject,
    trigger: "status_change",
    workspaceId: input.workspaceId,
  });
  return { run, session, task };
});

let dataRoot: string;
let agentHomeDir: string;
let workspaceId: WorkspaceId;
let streamed: DispatchContext;
let restored: DispatchContext;

/**
 * The task a fixture context is attached to. The union makes the narrowing
 * explicit, which is the point of it — every reader has to say which role it
 * means.
 */
const taskOf = (context: DispatchContext): Task => {
  if (context.attached.role !== "worker") {
    throw new Error("this fixture is a worker run");
  }
  return context.attached.task;
};

beforeAll(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "ingest-"));
  // The host's shared login for the provider, standing in for
  // `~/.claude-task-management`: every run on the box writes its transcript
  // into this one tree, and the ingest is narrowed to a session id for exactly
  // that reason.
  agentHomeDir = join(dataRoot, "agent-home", "claude");

  const built = await runtime.runPromise(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceRepo;
      const [first] = yield* workspaces.list();
      if (first === undefined) {
        return yield* Effect.fail(
          new NoWorkspace({ detail: "run `bun run db:seed` first" })
        );
      }
      const one = yield* fixture({
        title: "ingest: a run that streamed its events",
        workspaceId: first.id,
      });
      const two = yield* fixture({
        title: "ingest: a run whose events never came back",
        workspaceId: first.id,
      });
      return { one, two, workspaceId: first.id };
    })
  );

  ({ workspaceId } = built);
  streamed = contextOf({ dataRoot, ...built.one });
  restored = contextOf({ dataRoot, ...built.two });

  writeAt(
    streamed.layout.eventLogPath,
    `${[
      eventLine(
        {
          kind: "session_init",
          model: "claude-opus-5",
          provider: "claude",
          providerSessionId: PROVIDER_SESSION,
        },
        "2026-08-01T10:00:00.000Z"
      ),
      eventLine(
        { kind: "assistant_text", text: "Looking at it now." },
        "2026-08-01T10:00:04.000Z"
      ),
      eventLine(
        {
          costUsd: CostUsd.make("0.030000"),
          durationMs: 6000,
          errorClass: null,
          errorMessage: null,
          kind: "result",
          outcome: "done",
          providerSessionId: PROVIDER_SESSION,
          text: "done",
          totalTokens: 600,
          turns: 6,
        },
        "2026-08-01T10:00:06.000Z"
      ),
    ].join("\n")}\n`
  );

  // The ledger the container wrote through the event mount: three turns, and a
  // line from another service's file that has to be ignored.
  writeAt(
    join(streamed.layout.runDir, "events", "harness.jsonl"),
    `${[
      turnLine({
        costUsd: 0.01,
        durationMs: 1000,
        runId: streamed.runId,
        totalTokens: 100,
        ts: "2026-08-01T10:00:01.000Z",
        turns: 1,
      }),
      turnLine({
        costUsd: 0.02,
        durationMs: 2000,
        runId: streamed.runId,
        totalTokens: 200,
        ts: "2026-08-01T10:00:03.000Z",
        turns: 2,
      }),
      turnLine({
        costUsd: 0.03,
        durationMs: 3000,
        runId: streamed.runId,
        totalTokens: 300,
        ts: "2026-08-01T10:00:05.000Z",
        turns: 3,
      }),
      JSON.stringify({ event: "atm.sandbox", exitCode: 0 }),
    ].join("\n")}\n`
  );

  // The run that never streamed still has a run directory: the loop creates it
  // before the container starts, and the durable transcript copy lands in it.
  mkdirSync(restored.layout.runDir, { recursive: true });

  const transcriptDir = join(agentHomeDir, "projects", "-workspace");
  writeAt(
    join(transcriptDir, `${PROVIDER_SESSION}.jsonl`),
    `${TRANSCRIPT_LINES.join("\n")}\n`
  );

  const artifacts = taskArtifactsDirOf({
    dataRoot,
    taskId: taskOf(streamed).id,
  });
  writeAt(join(artifacts, "notes.md"), "# notes\n");
  writeAt(join(artifacts, "out", "report.txt"), "report\n");
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      yield* withActor(remover)(
        Effect.all([
          tasks.delete({ id: taskOf(streamed).id, workspaceId }),
          tasks.delete({ id: taskOf(restored).id, workspaceId }),
        ])
      );
    })
  );
  await runtime.dispose();
  rmSync(dataRoot, { force: true, recursive: true });
});

test("a run's event file becomes its timeline, one row per line", async () => {
  const report = await runtime.runPromise(
    ingestRunEvents({ context: streamed, exitCode: 0, promptChars: 120 })
  );

  expect(report).toEqual({ appended: 3, lines: 3, unreadable: 0 });
});

test("re-ingesting the same file changes nothing", async () => {
  const { report, rows } = await runtime.runPromise(
    Effect.gen(function* () {
      const again = yield* ingestRunEvents({
        context: streamed,
        exitCode: 0,
        promptChars: 120,
      });
      const events = yield* RunEventRepo;
      const stored = yield* events.listByRun({
        runId: streamed.runId,
        workspaceId,
      });
      return { report: again, rows: stored };
    })
  );

  expect(report.appended).toBe(0);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => row.seq)).toEqual([0, 1, 2]);
  expect(rows.map((row) => row.payload.kind)).toEqual([
    "started",
    "assistant_message",
    "finished",
  ]);
});

test("the container's three turn rows fold into the run row", async () => {
  const closed = await runtime.runPromise(
    Effect.gen(function* () {
      const rollup = yield* ingestTurnLedger({ context: streamed });
      // The host heard nothing: only the container's own rows can answer for
      // what this run cost, which is the join the mount exists for.
      const terminus = lostTerminus({
        eventsSeen: 0,
        exitCode: null,
        finalText: "",
        providerSessionId: null,
      });
      const economics = runEconomicsOf({ rollup, terminus });
      const runs = yield* RunRepo;
      return yield* runs.close({
        costUsd: economics.costUsd ?? undefined,
        durationMs: economics.durationMs ?? undefined,
        id: streamed.runId,
        outcome: "lost",
        totalTokens: economics.totalTokens ?? undefined,
        turns: economics.turns ?? undefined,
        workspaceId,
      });
    })
  );

  expect(closed.costUsd).toBe(CostUsd.make("0.060000"));
  expect(closed.durationMs).toBe(6000);
  expect(closed.totalTokens).toBe(600);
  expect(closed.turns).toBe(6);
});

test("a rescan indexes what is in the task's folder", async () => {
  const report = await runtime.runPromise(
    rescanTaskArtifacts({
      dataRoot,
      runId: streamed.runId,
      taskId: taskOf(streamed).id,
      workspaceId,
    })
  );

  expect(report.indexed).toBe(2);
});

test("a rescan after a file is deleted removes its index row", async () => {
  rmSync(
    join(
      taskArtifactsDirOf({ dataRoot, taskId: taskOf(streamed).id }),
      "out",
      "report.txt"
    )
  );

  const paths = await runtime.runPromise(
    Effect.gen(function* () {
      yield* rescanTaskArtifacts({
        dataRoot,
        runId: streamed.runId,
        taskId: taskOf(streamed).id,
        workspaceId,
      });
      const artifacts = yield* ArtifactRepo;
      const rows = yield* artifacts.listByTask({
        taskId: taskOf(streamed).id,
        workspaceId,
      });
      return rows.map((row) => row.path);
    })
  );

  expect(paths).toEqual(["notes.md"]);
});

test("a run with no event stream gets its timeline back from the transcript", async () => {
  const { report, rows, session } = await runtime.runPromise(
    Effect.gen(function* () {
      const ingested = yield* ingestTranscript({
        agentHomeDir,
        context: restored,
        providerSessionId: PROVIDER_SESSION,
      });
      const events = yield* RunEventRepo;
      const stored = yield* events.listByRun({
        runId: restored.runId,
        workspaceId,
      });
      const sessions = yield* AgentSessionRepo;
      const row = yield* sessions.byId({
        id: restored.session.session.id,
        workspaceId,
      });
      return { report: ingested, rows: stored, session: row };
    })
  );

  expect(report.found).toBe(true);
  expect(report.restored).toBe(true);
  expect(report.appended).toBe(report.entries);
  expect(report.chars).toBeGreaterThan(0);
  expect(rows.length).toBe(report.entries);
  expect(rows.every((row) => row.seq >= TRANSCRIPT_SEQ_BASE)).toBe(true);
  // The provider's own id lands on the session row, which is what a resume is
  // pointed at — the one durable place a transcript's identity fits today.
  expect(session.providerSessionId).toBe(PROVIDER_SESSION);
});

test("the ingest leaves what the session spent, and it outlives the file", async () => {
  const stored = await runtime.runPromise(
    Effect.gen(function* () {
      yield* ingestTranscript({
        agentHomeDir,
        context: restored,
        providerSessionId: PROVIDER_SESSION,
      });
      const usage = yield* AgentSessionUsageRepo;
      return yield* usage.byId({
        sessionId: restored.session.session.id,
        workspaceId,
      });
    })
  );

  // 100 fresh input + 1,200 read from cache + 400 written to it is what the
  // one request in the fixture put in front of the model.
  expect(stored?.usage.peakContextTokens).toBe(1700);
  expect(stored?.usage.requests).toBe(1);
  expect(stored?.usage.totals.outputTokens).toBe(50);
  expect(stored?.usage.toolCalls).toEqual([
    { calls: 1, errors: 1, name: "Bash" },
  ]);
  // The window is not in the file: Claude records none, so it is looked up and
  // marked as looked up.
  expect(stored?.usage.contextWindowSource).toBe("inferred");
  expect(stored?.usage.cost?.priceTableVersion).toBe(PRICE_TABLE_VERSION);

  // The row is the record from here on. Removing every trace of the transcript
  // leaves the figures standing, which is the whole reason they are stored
  // rather than parsed when somebody opens the panel.
  rmSync(durableTranscriptPathOf(restored.layout), { force: true });
  const survived = await runtime.runPromise(
    Effect.gen(function* () {
      const usage = yield* AgentSessionUsageRepo;
      return yield* usage.byId({
        sessionId: restored.session.session.id,
        workspaceId,
      });
    })
  );
  expect(survived?.usage.peakContextTokens).toBe(1700);
});

test("the restored timeline is not written twice", async () => {
  const { report, rows } = await runtime.runPromise(
    Effect.gen(function* () {
      const again = yield* ingestTranscript({
        agentHomeDir,
        context: restored,
        providerSessionId: PROVIDER_SESSION,
      });
      const events = yield* RunEventRepo;
      const stored = yield* events.listByRun({
        runId: restored.runId,
        workspaceId,
      });
      return { report: again, rows: stored };
    })
  );

  expect(report.appended).toBe(0);
  expect(rows.length).toBe(report.entries);
});

test("a tool call's arguments are redacted before they reach a row", async () => {
  const summaries = await runtime.runPromise(
    Effect.gen(function* () {
      const events = yield* RunEventRepo;
      const rows = yield* events.listByRun({
        runId: restored.runId,
        workspaceId,
      });
      return rows
        .map((row) => row.payload)
        .filter((payload) => payload.kind === "tool_call")
        .map((payload) => payload.summary);
    })
  );

  expect(summaries.length).toBeGreaterThan(0);
  expect(summaries.every((summary) => summary.length <= 240)).toBe(true);
});

test("a run that never named a session gets no transcript rather than a neighbour's", async () => {
  const preserved = await runtime.runPromise(
    preserveTranscript({
      agentHomeDir,
      context: restored,
      providerSessionId: null,
    })
  );

  // The shared home holds every run's conversation, so the newest file in it
  // belongs to whoever wrote last. Copying that into this run's directory and
  // ingesting it as this run's timeline is the failure the id filter prevents.
  expect(preserved.copied).toBe(false);
  expect(preserved.path).toBeNull();
});

test("the durable copy is the record, and is what a later ingest reads", async () => {
  const preserved = await runtime.runPromise(
    preserveTranscript({
      agentHomeDir,
      context: restored,
      providerSessionId: PROVIDER_SESSION,
    })
  );
  const durable = durableTranscriptPathOf(restored.layout);

  expect(preserved.copied).toBe(true);
  expect(preserved.path).toBe(durable);
  // The provider's own file and the copy hold the same bytes: nothing is
  // clipped, summarized or re-encoded on the way out.
  expect(readFileSync(durable, "utf8")).toBe(
    readFileSync(preserved.source ?? "", "utf8")
  );

  // The shared home is the operator's and is never torn down, but the file in
  // it is the vendor's to prune. The copy is what makes a re-ingest weeks later
  // read the same bytes the first one did.
  rmSync(preserved.source ?? "", { force: true });

  const again = await runtime.runPromise(
    Effect.gen(function* () {
      const report = yield* ingestTranscript({
        agentHomeDir,
        context: restored,
        providerSessionId: PROVIDER_SESSION,
      });
      const events = yield* RunEventRepo;
      const rows = yield* events.listByRun({
        runId: restored.runId,
        workspaceId,
      });
      return { report, rows };
    })
  );

  // Read out of the run directory rather than out of a directory that is no
  // longer there — and the same conversation, at the same length, as before.
  expect(again.report.path).toBe(durable);
  expect(again.report.found).toBe(true);
  expect(again.report.entries).toBeGreaterThan(TRANSCRIPT_LINES.length);
  expect(again.report.appended).toBe(0);
  expect(again.rows.length).toBe(again.report.entries);
});
