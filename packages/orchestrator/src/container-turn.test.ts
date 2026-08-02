/**
 * What a run does when its turn happens inside a real container.
 *
 * Everything here is real except the model: a real daemon, the real
 * `atm.local/base` image, the real mount set, real Postgres, and the loop's own
 * lifecycle from the claim to the closed row. What stands in for the provider is
 * a bundled entrypoint of a few lines, written where the orchestrator mounts the
 * real one from — so the container is handed a spec through the mount, writes
 * its normalized events and its `atm.turn` row back through the same mount, and
 * the host reads all of it exactly as it reads a real turn's. Faking the model
 * and nothing else is the point: a fake sandbox would only ever prove the fake.
 *
 * The claims are the seams a container crosses.
 *
 * **The timeline fills while the container is alive.** The stub writes its first
 * events, then waits for a file the host creates only after those rows are in
 * `run_events` — so the test cannot pass by tailing the file at teardown. The
 * ordinals are the file's line numbers, which is what makes the re-ingest after
 * the run collide row for row instead of writing a shifted second copy.
 *
 * **The run closes on the container's own account of itself.** The result file
 * is read after teardown, the exit code lands on the row, and a container that
 * exits with no terminal event is `lost` through the ending the loop already
 * has rather than a second vocabulary invented for docker.
 *
 * **The `atm.turn` row written inside the container joins the run outside it.**
 * The container has no database handle and never will; the row travels out as a
 * JSON line on the event mount and `./ingest` folds it in on `runId`.
 *
 * **A turn is given the credentials it needs and none of the host's own, and
 * what it wrote in its agent home is read before that home is removed.** The
 * stub reports back the *names* of the variables it was started with — never a
 * value — and writes a transcript where a real provider writes one, so the
 * close hook reading it back is the same crossing a real run makes.
 *
 * Skipped, loudly, when the daemon is unreachable or the image has not been
 * built. It is not skipped for anything else — a failure here is a real one.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { BunFileSystem } from "@effect/platform-bun";
import {
  AgentSessionRepo,
  Auth,
  RunEventRepo,
  RunRepo,
  storeLayer,
  TaskRepo,
  WorkspaceRepo,
  withActor,
} from "@workspace/db";
import {
  Actor,
  type AgentSessionId,
  type Task,
  type TaskId,
  UserId,
  type WorkspaceId,
} from "@workspace/domain";
import {
  type AgentEvent,
  AgentEventRecord,
  type AgentProvider,
  containerRunLayout,
  EXECUTOR_KEY_ENV_VAR,
  EXECUTOR_URL_ENV_VAR,
  entrypointBundlePathOf,
  makeProviderRegistry,
  ProviderRegistry,
  runDirOf,
  TURN_ENV_VARS,
  TURN_EVENT_MARKER,
  TurnEvent,
  turnResultPathOf,
  turnSpecPathOf,
} from "@workspace/harness";
import {
  DEFAULT_SANDBOX_IMAGE,
  dockerSandboxLayer,
  localWorkspaceLayer,
} from "@workspace/sandbox";
import { Telemetry } from "@workspace/telemetry";
import { DateTime, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { ingestRunEvents, ingestTurnLedger } from "./ingest";
import { openRun, type RunClaim } from "./open-run";
import { performRun, runOpened } from "./run";
import { loadRootEnv } from "./testing/root-env";
import {
  ingestTranscript,
  TRANSCRIPT_SEQ_BASE,
  type TranscriptIngestReport,
} from "./transcript-ingest";

loadRootEnv();

/** Names this process in `pg_stat_activity`, as every process that connects does. */
const APPLICATION_NAME = "orchestrator-container-test";

/** Which loop the audit rows are attributed to. */
const LOOP_INSTANCE = "orchestrator-container-test";

const WORKSPACE_SLUG = "personal";
const WORKSPACE_NAME = "Personal";
const OWNER_EMAIL = "owner@agent-task-manager.local";
const OWNER_NAME = "Owner";

/**
 * The loop's cap for these runs. Generous, because it is the outermost of three
 * and everything inside it — the container's cap, the turn's cap — is derived
 * from it by giving up headroom; a tight one here would leave the container
 * none.
 */
const RUN_TIMEOUT_MS = 120_000;

/** How long the host waits for the container's first rows to reach the database. */
const LIVE_TIMEOUT_MS = 60_000;

/** How often it asks. */
const POLL = "100 millis";

/** How long the stub waits inside the container for the host's acknowledgement. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** The file the host creates once it has seen the container's first rows. */
const HANDSHAKE_FILE = "host-saw-the-events";

/** Where the container writes the names of the variables it was started with. */
const ENV_REPORT_FILE = "env-received.json";

/**
 * The variables the report is asked about: the two halves of the Executor
 * credential, and one of the run's own ids to show the report is reading a real
 * environment rather than an empty one. Every `OTEL_*` name is reported too,
 * whatever it is called — the claim is that none of them crosses at all.
 */
const WATCHED_ENV_NAMES = [
  EXECUTOR_KEY_ENV_VAR,
  EXECUTOR_URL_ENV_VAR,
  TURN_ENV_VARS.runId,
] as const;

/** The conversation id the transcript written inside the container names itself with. */
const TRANSCRIPT_SESSION_ID = "container-transcript-session";

/** The line a restored row can be recognized by. */
const TRANSCRIPT_TEXT = "what the container wrote inside its own agent home";

/** A Claude transcript, in the layout the CLI writes one in. */
const TRANSCRIPT_LINES = [
  JSON.stringify({
    message: { content: "the brief", role: "user" },
    sessionId: TRANSCRIPT_SESSION_ID,
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "user",
  }),
  JSON.stringify({
    message: {
      content: [{ text: TRANSCRIPT_TEXT, type: "text" }],
      role: "assistant",
    },
    sessionId: TRANSCRIPT_SESSION_ID,
    timestamp: "2026-08-01T10:00:04.000Z",
    type: "assistant",
  }),
];

/**
 * What the loop hands a turn, plus what it must never hand one. The OTLP
 * endpoint and its bearer token are the host's own: the container writes its
 * wide events to a file on the mount and the loop forwards them, so a token for
 * the operator's backend has no business inside a sandbox an agent controls.
 */
const TURN_ENV = {
  [EXECUTOR_KEY_ENV_VAR]: "executor-key-that-never-leaves-the-host",
  [EXECUTOR_URL_ENV_VAR]: "https://executor.invalid/org_test/mcp",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.invalid",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer must-not-cross",
} as const;

/** What the silent container exits with, so a code that survives is visibly this one. */
const SILENT_EXIT_CODE = 4;

/** Everything this test writes to disk, thrown away at the end. */
const dataRoot = mkdtempSync(join(tmpdir(), "atm-container-test-"));
process.env.DATA_ROOT = dataRoot;
process.env.EVENT_LOG_DIR = join(dataRoot, "events");

/** Whether there is a daemon holding the image these runs need. */
const imageReady = () => {
  const probe = spawnSync("docker", [
    "image",
    "inspect",
    "--format={{.Id}}",
    DEFAULT_SANDBOX_IMAGE,
  ]);
  return probe.status === 0;
};

const containerized = imageReady();
if (!containerized) {
  process.stderr.write(
    `container-turn.test: skipped — no docker daemon holding ${DEFAULT_SANDBOX_IMAGE}. Run \`bun run images:build\`.\n`
  );
}

const encodeRecord = Schema.encodeSync(AgentEventRecord);

/** One line of the event file, as the container would have written it. */
const eventLine = (event: AgentEvent) =>
  JSON.stringify(encodeRecord({ event, occurredAt: DateTime.nowUnsafe() }));

const PROVIDER_SESSION_ID = "container-test-session";

const SESSION_INIT: AgentEvent = {
  kind: "session_init",
  model: "stub-1",
  provider: "claude",
  providerSessionId: PROVIDER_SESSION_ID,
};

const ASSISTANT: AgentEvent = {
  kind: "assistant_text",
  text: "the container said this",
};

const TERMINUS: AgentEvent = {
  costUsd: null,
  durationMs: 1234,
  errorClass: null,
  errorMessage: null,
  kind: "result",
  outcome: "done",
  providerSessionId: PROVIDER_SESSION_ID,
  text: "the container said this",
  totalTokens: 321,
  turns: 2,
};

/**
 * The `atm.turn` row the stub writes from inside, with the ids left null for the
 * container to fill from its own environment. Encoded through the harness's own
 * schema, so a row this test writes is a row the harness would have written —
 * and the fold on the host is reading the real shape rather than a guess at it.
 */
const turnRowTemplate = {
  ...TurnEvent.encode({
    agentHomeSet: true,
    assistantChars: ASSISTANT.text.length,
    assistantMessages: 1,
    costUsd: null,
    durationMs: 4321,
    effort: null,
    errorClass: null,
    errorEvents: 0,
    errorMessage: null,
    eventsSeen: 3,
    inputTokens: 100,
    model: "stub-1",
    outcome: "done",
    outputTokens: 221,
    phase: "end",
    promptChars: 42,
    provider: "claude",
    providerSessionId: PROVIDER_SESSION_ID,
    queueWaitMs: null,
    rateLimitPeakPct: null,
    rateLimitStatus: null,
    rateLimitType: null,
    reasoningChars: 0,
    resumed: false,
    runId: null,
    sessionId: null,
    spanId: null,
    subagents: 0,
    taskId: null,
    toolCalls: 0,
    toolErrors: 0,
    totalTokens: 321,
    traceId: null,
    turns: 2,
    workspaceId: null,
  }),
  event: TURN_EVENT_MARKER,
  gitSha: "container-test",
  host: "container",
  version: "container-test",
};

/** What the container's last word says, on the run that gets one. */
const DONE_RESULT: Record<string, unknown> = {
  errorClass: null,
  errorMessage: null,
  eventsSeen: 3,
  exitReason: "completed",
  finishedAt: new Date().toISOString(),
  outcome: "done",
  providerSessionId: PROVIDER_SESSION_ID,
};

/** What one invocation of the stub entrypoint does inside the container. */
interface StubPlan {
  /** Written after the handshake. */
  readonly after: readonly string[];
  /** Written to the spec's event log path, one per line, before the handshake. */
  readonly before: readonly string[];
  /**
   * Report which of {@link WATCHED_ENV_NAMES} — and any `OTEL_*` at all — the
   * container was started with. Names, never values: the point of the claim is
   * that a credential arrives, and printing one would put it on the host's disk
   * and in this process's log.
   */
  readonly envReport: boolean;
  readonly exitCode: number;
  /** Waits for the host's acknowledgement between the two batches. */
  readonly handshake: boolean;
  /** The result file, or null for a container that died before writing one. */
  readonly result: Record<string, unknown> | null;
  /** The `atm.turn` row, or null for a container that reported nothing. */
  readonly row: Record<string, unknown> | null;
  /** A transcript to write into the run's agent home, as a real provider does. */
  readonly transcript: StubTranscript | null;
}

/** One transcript the stub leaves inside the container's agent home. */
interface StubTranscript {
  readonly lines: readonly string[];
  /** Names the file, which is how both vendors name theirs. */
  readonly sessionId: string;
}

/**
 * The bundle the container runs, written where `entrypointBundlePathOf` says the
 * real one lives.
 *
 * Every path in it comes from the harness's container layout rather than from a
 * literal, which is half of what this test proves: the host writes the spec at
 * one path and the container reads it at the same one, computed by the same
 * function against the other root.
 */
const writeStubEntrypoint = (plan: StubPlan) => {
  const bundle = entrypointBundlePathOf(dataRoot);
  mkdirSync(dirname(bundle), { recursive: true });
  writeFileSync(
    bundle,
    `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const plan = ${JSON.stringify(plan)};
const spec = JSON.parse(readFileSync(${JSON.stringify(turnSpecPathOf(containerRunLayout))}, "utf8"));

const say = (lines) => {
  for (const line of lines) {
    appendFileSync(spec.eventLogPath, line + "\\n");
  }
};

if (plan.envReport) {
  const watched = ${JSON.stringify(WATCHED_ENV_NAMES)};
  const received = Object.keys(process.env)
    .filter((name) => watched.includes(name) || name.startsWith("OTEL_"))
    .sort();
  console.log("env received: " + received.join(","));
  writeFileSync(${JSON.stringify(join(containerRunLayout.runDir, ENV_REPORT_FILE))}, JSON.stringify(received) + "\\n");
}

if (plan.transcript !== null) {
  const directory = spec.agentHomeDir + "/projects/-workspace";
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    directory + "/" + plan.transcript.sessionId + ".jsonl",
    plan.transcript.lines.join("\\n") + "\\n"
  );
}

say(plan.before);

if (plan.handshake) {
  const marker = ${JSON.stringify(join(containerRunLayout.runDir, HANDSHAKE_FILE))};
  const deadline = Date.now() + ${HANDSHAKE_TIMEOUT_MS};
  while (!existsSync(marker) && Date.now() < deadline) {
    Bun.sleepSync(50);
  }
}

say(plan.after);

if (plan.row !== null) {
  const row = {
    ...plan.row,
    runId: process.env[${JSON.stringify(TURN_ENV_VARS.runId)}] ?? null,
    sessionId: process.env[${JSON.stringify(TURN_ENV_VARS.sessionId)}] ?? null,
    taskId: process.env[${JSON.stringify(TURN_ENV_VARS.taskId)}] ?? null,
    ts: new Date().toISOString(),
    workspaceId: process.env[${JSON.stringify(TURN_ENV_VARS.workspaceId)}] ?? null,
  };
  appendFileSync(process.env.EVENT_LOG_DIR + "/turn.jsonl", JSON.stringify(row) + "\\n");
}

if (plan.result !== null) {
  writeFileSync(${JSON.stringify(turnResultPathOf(containerRunLayout))}, JSON.stringify(plan.result) + "\\n");
}

process.exit(plan.exitCode);
`
  );
};

/**
 * A provider that dies if anything reaches it. The container path must never
 * start a harness in this process, and a defect is how that shows up loudly
 * rather than as a run that quietly succeeded on the host.
 */
const forbiddenProvider: AgentProvider = {
  capabilities: {
    cost: false,
    hooks: false,
    rateLimitSignal: false,
    reasoning: false,
    resume: true,
    subagents: false,
  },
  defaultEffort: null,
  displayName: "must not run",
  efforts: [],
  id: "claude",
  models: [],
  run: () =>
    Stream.fromEffect(
      Effect.die("a container run started a provider on the host")
    ),
};

const registryLayer = Layer.succeed(
  ProviderRegistry,
  makeProviderRegistry({ claude: forbiddenProvider, codex: forbiddenProvider })
);

const telemetry = Telemetry.layer({ serviceName: APPLICATION_NAME });

/**
 * Docker, named rather than selected. `SANDBOX_MODE` must not be able to make a
 * test about containers pass without one.
 */
const baseLayer = Layer.mergeAll(
  storeLayer({ applicationName: APPLICATION_NAME }),
  telemetry,
  localWorkspaceLayer({ clone: () => Effect.void }),
  dockerSandboxLayer.pipe(Layer.provide(telemetry)),
  registryLayer
).pipe(Layer.provideMerge(BunFileSystem.layer));

/** The workspace every row hangs off, created through the auth library if absent. */
const ensureWorkspace = Effect.gen(function* () {
  const workspaces = yield* WorkspaceRepo;
  const auth = yield* Auth;

  const owner = yield* Effect.tryPromise(async () => {
    const context = await auth.$context;
    const found = await context.internalAdapter.findUserByEmail(OWNER_EMAIL);
    return (
      found?.user ??
      (await context.internalAdapter.createUser(
        { email: OWNER_EMAIL, name: OWNER_NAME },
        { method: "admin" }
      ))
    );
  });
  const ownerId = UserId.make(owner.id);

  const existing = (yield* workspaces.list()).find(
    (found) => found.slug === WORKSPACE_SLUG
  );
  if (existing !== undefined) {
    return { owner: ownerId, workspace: existing };
  }
  yield* Effect.tryPromise(() =>
    auth.api.createOrganization({
      body: { name: WORKSPACE_NAME, slug: WORKSPACE_SLUG, userId: ownerId },
    })
  );
  const created = (yield* workspaces.list()).find(
    (found) => found.slug === WORKSPACE_SLUG
  );
  return { owner: ownerId, workspace: created as NonNullable<typeof created> };
});

/** Tasks this file created, deleted at the end whatever happened in between. */
const created: { id: TaskId; workspaceId: WorkspaceId }[] = [];

const seedTask = (input: { readonly owner: UserId; readonly title: string }) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const tasks = yield* TaskRepo;
    const [workspace] = yield* workspaces.list();
    const task = yield* withActor(
      Actor.cases.human.make({ userId: input.owner })
    )(
      tasks.create({
        brief: "A brief the stub entrypoint never reads.",
        status: "in_progress",
        title: input.title,
        workspaceId: (workspace as NonNullable<typeof workspace>).id,
      })
    );
    created.push({ id: task.id, workspaceId: task.workspaceId });
    return task;
  });

const claimOf = (task: Task): RunClaim => ({
  attempt: 1,
  dataRoot,
  defaultProvider: "claude",
  loopInstance: LOOP_INSTANCE,
  project: null,
  queueWaitMs: 0,
  spanId: null,
  task,
  traceId: null,
  traceparent: null,
  trigger: "status_change",
});

/**
 * Waits until the container's first rows are in `run_events` with the run still
 * live, then tells the container to finish. The acknowledgement is the whole
 * assertion: a tail that only read the file at teardown would never write it,
 * and the container would give up and exit having said nothing more.
 */
const acknowledgeLiveRows = (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const runs = yield* RunRepo;
    const events = yield* RunEventRepo;
    const live = yield* Effect.gen(function* () {
      const found = yield* runs.liveForTask(input);
      if (found === null) {
        return yield* Effect.fail("no run row yet" as const);
      }
      const rows = yield* events.listByRun({
        runId: found.id,
        workspaceId: input.workspaceId,
      });
      return rows.length >= 2
        ? found
        : yield* Effect.fail("the container's events are not in yet" as const);
    }).pipe(
      Effect.retry(Schedule.spaced(POLL)),
      Effect.timeoutOrElse({
        duration: LIVE_TIMEOUT_MS,
        orElse: () =>
          Effect.die(
            "the container's events never reached run_events while it was running"
          ),
      })
    );
    yield* Effect.sync(() =>
      writeFileSync(
        join(runDirOf({ dataRoot, runId: live.id }), HANDSHAKE_FILE),
        ""
      )
    );
    return live;
  });

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(Effect.scoped(effect) as Effect.Effect<A, E, never>);

const provide = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof baseLayer>>
) => run(effect.pipe(Effect.provide(baseLayer)));

beforeAll(() => {
  expect(process.env.DATABASE_URL).toBeDefined();
});

afterAll(async () => {
  if (created.length > 0) {
    await provide(
      Effect.gen(function* () {
        const tasks = yield* TaskRepo;
        yield* Effect.forEach(created, (ref) =>
          withActor(
            Actor.cases.orchestrator.make({ loopInstance: LOOP_INSTANCE })
          )(tasks.delete(ref)).pipe(Effect.ignore)
        );
      })
    );
  }
  rmSync(dataRoot, { force: true, recursive: true });
});

test.skipIf(!containerized)(
  "a container's events reach run_events live, and its turn row is folded into the run",
  async () => {
    writeStubEntrypoint({
      after: [eventLine(TERMINUS)],
      before: [eventLine(SESSION_INIT), eventLine(ASSISTANT)],
      envReport: false,
      exitCode: 0,
      handshake: true,
      result: DONE_RESULT,
      row: turnRowTemplate,
      transcript: null,
    });

    const seen = await provide(
      Effect.gen(function* () {
        const { owner } = yield* ensureWorkspace;
        const task = yield* seedTask({ owner, title: "container run" });
        const [outcome] = yield* Effect.all(
          [
            performRun({
              claim: claimOf(task),
              sandboxKind: "docker",
              timeoutMs: RUN_TIMEOUT_MS,
            }),
            acknowledgeLiveRows({
              taskId: task.id,
              workspaceId: task.workspaceId,
            }),
          ],
          { concurrency: 2 }
        );

        const { context, terminus } = outcome;
        const runs = yield* RunRepo;
        const runEvents = yield* RunEventRepo;
        const tasks = yield* TaskRepo;
        return {
          // The re-read the loop performs after every run, here to prove it
          // adds nothing: the live tail already wrote every row.
          reingested: yield* ingestRunEvents({
            context,
            exitCode: terminus.exitCode,
            promptChars: 0,
          }),
          rollup: yield* ingestTurnLedger({ context }),
          run: yield* runs.byId({
            id: context.runId,
            workspaceId: task.workspaceId,
          }),
          task: yield* tasks.byId({
            id: task.id,
            workspaceId: task.workspaceId,
          }),
          terminus,
          timeline: yield* runEvents.listByRun({
            runId: context.runId,
            workspaceId: task.workspaceId,
          }),
        };
      })
    );

    expect(seen.terminus.kind).toBe("finished");
    expect(seen.terminus.exitCode).toBe(0);
    expect(seen.task.status).toBe("review");
    expect(seen.run.outcome).toBe("done");
    expect(seen.run.status).toBe("finished");
    expect(seen.run.model).toBe("stub-1");
    expect(seen.run.exitCode).toBe(0);

    // The line ordinal in the container's file is the row's `seq`, which is what
    // makes the re-ingest below collide instead of duplicating.
    expect(seen.timeline.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(seen.timeline.map((event) => event.payload.kind)).toEqual([
      "started",
      "assistant_message",
      "finished",
    ]);
    expect(seen.reingested.lines).toBe(3);
    expect(seen.reingested.appended).toBe(0);

    // The row the container wrote, on the host, joined on the id the host minted.
    expect(seen.rollup.turnCount).toBe(1);
    expect(seen.rollup.totalTokens).toBe(321);
    expect(seen.rollup.providerSessionId).toBe(PROVIDER_SESSION_ID);
    expect(seen.rollup.model).toBe("stub-1");
  },
  RUN_TIMEOUT_MS
);

test.skipIf(!containerized)(
  "a container that exits without a terminal event closes the run as lost",
  async () => {
    writeStubEntrypoint({
      after: [],
      before: [eventLine(SESSION_INIT)],
      envReport: false,
      exitCode: SILENT_EXIT_CODE,
      handshake: false,
      result: null,
      row: null,
      transcript: null,
    });

    const seen = await provide(
      Effect.gen(function* () {
        const { owner } = yield* ensureWorkspace;
        const task = yield* seedTask({ owner, title: "silent container" });
        const outcome = yield* performRun({
          claim: claimOf(task),
          sandboxKind: "docker",
          timeoutMs: RUN_TIMEOUT_MS,
        });
        const runs = yield* RunRepo;
        const runEvents = yield* RunEventRepo;
        const tasks = yield* TaskRepo;
        return {
          rollup: yield* ingestTurnLedger({ context: outcome.context }),
          run: yield* runs.byId({
            id: outcome.context.runId,
            workspaceId: task.workspaceId,
          }),
          task: yield* tasks.byId({
            id: task.id,
            workspaceId: task.workspaceId,
          }),
          terminus: outcome.terminus,
          timeline: yield* runEvents.listByRun({
            runId: outcome.context.runId,
            workspaceId: task.workspaceId,
          }),
        };
      })
    );

    expect(seen.terminus.kind).toBe("lost");
    // The container's own code, through the daemon and the teardown, onto the row.
    expect(seen.terminus.exitCode).toBe(SILENT_EXIT_CODE);
    expect(seen.run.exitCode).toBe(SILENT_EXIT_CODE);
    expect(seen.run.outcome).toBe("lost");
    expect(seen.run.errorClass).toBe("NoTerminalEvent");
    expect(seen.task.status).toBe("review");
    // What it did manage to say is still the timeline, at its own ordinal.
    expect(seen.timeline.map((event) => event.seq)).toEqual([0]);
    expect(seen.rollup.turnCount).toBe(0);
  },
  RUN_TIMEOUT_MS
);

test.skipIf(!containerized)(
  "the container is given the executor credentials and none of the host's export, and its transcript is read before the agent home goes",
  async () => {
    writeStubEntrypoint({
      after: [],
      // No events at all: the stream leaves no timeline, so the transcript the
      // container wrote is the only account of the run there is.
      before: [],
      envReport: true,
      exitCode: 0,
      handshake: false,
      result: null,
      row: null,
      transcript: { lines: TRANSCRIPT_LINES, sessionId: TRANSCRIPT_SESSION_ID },
    });

    const seen = await provide(
      Effect.gen(function* () {
        const { owner } = yield* ensureWorkspace;
        const task = yield* seedTask({ owner, title: "contained credentials" });
        const context = yield* openRun(claimOf(task));
        const ingested: TranscriptIngestReport[] = [];

        yield* runOpened({
          context,
          dataRoot,
          env: TURN_ENV,
          // What the loop's own close hook does, reduced to the one step these
          // claims are about.
          onClose: (closed) =>
            withActor(context.actor)(
              ingestTranscript({
                context,
                providerSessionId: closed.terminus.providerSessionId,
              })
            ).pipe(
              Effect.tap((report) =>
                Effect.sync(() => {
                  ingested.push(report);
                })
              ),
              Effect.asVoid,
              Effect.orDie
            ),
          sandboxKind: "docker",
          timeoutMs: RUN_TIMEOUT_MS,
        });

        const runEvents = yield* RunEventRepo;
        const sessions = yield* AgentSessionRepo;
        const { workspaceId } = task;
        return {
          context,
          // Names only, as the container reported them.
          envNames: JSON.parse(
            readFileSync(
              join(
                runDirOf({ dataRoot, runId: context.runId }),
                ENV_REPORT_FILE
              ),
              "utf8"
            )
          ) as readonly string[],
          report: ingested[0],
          session: yield* sessions.byId({
            id: context.session.session.id as AgentSessionId,
            workspaceId,
          }),
          timeline: yield* runEvents.listByRun({
            runId: context.runId,
            workspaceId,
          }),
        };
      })
    );

    // The credentials the connector layer needs arrived, beside the run's own
    // ids, and the host's export token did not.
    expect(seen.envNames).toEqual([...WATCHED_ENV_NAMES].sort());
    expect(seen.envNames.some((name) => name.startsWith("OTEL_"))).toBe(false);

    // The transcript the container wrote, read on the host through the mount
    // while the agent home was still there.
    expect(seen.report?.found).toBe(true);
    expect(seen.report?.entries).toBe(2);
    expect(seen.report?.restored).toBe(true);
    expect(seen.report?.providerSessionId).toBe(TRANSCRIPT_SESSION_ID);
    expect(seen.session.providerSessionId).toBe(TRANSCRIPT_SESSION_ID);
    expect(seen.timeline.map((event) => event.seq)).toEqual([
      TRANSCRIPT_SEQ_BASE,
      TRANSCRIPT_SEQ_BASE + 1,
    ]);
    expect(
      seen.timeline.find((event) => event.payload.kind === "assistant_message")
        ?.payload
    ).toMatchObject({ text: TRANSCRIPT_TEXT });

    // And the copied credentials are gone with it.
    expect(existsSync(seen.context.layout.agentHomeDir)).toBe(false);
  },
  RUN_TIMEOUT_MS
);
