/**
 * What the lifecycle does to a real database, against a provider that is the
 * only fake in the room.
 *
 * The database is real because every claim here is about rows the repositories
 * write inside their own transactions — the status machine's refusal, the
 * partial unique index, the audit entry — and checking any of that against a
 * fake would be checking the fake. The model call is mocked because it is the
 * one thing that costs money and answers differently every time; the harness
 * seam is a `Stream` of normalized events, so a scripted stream is the same
 * shape a real turn produces.
 *
 * One test per claim: a clean run lands the task in *review* with a run row and
 * a timeline; a failing run posts the crash comment, fails the session, and
 * still lands in *review*; a stream that stops without a terminus is treated as
 * a failure in its own right; a provider that dies mid-stream is another; and
 * the fallback comment appears only when the run posted none of its own.
 *
 * Rows are cleaned up by deleting the task, which cascades its sessions, runs,
 * events and comments. The audit entries stay, because that table is
 * append-only by design and the whole claim of the store is that its trail
 * survives.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunFileSystem } from "@effect/platform-bun";
import {
  AgentSessionRepo,
  Auth,
  CommentRepo,
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
  CostUsd,
  type Task,
  type TaskId,
  UserId,
  type WorkspaceId,
} from "@workspace/domain";
import {
  type AgentEvent,
  type AgentProvider,
  commentMarkerPathOf,
  hostRunLayout,
  makeProviderRegistry,
  ProviderCrashed,
  ProviderRegistry,
  type ProviderTable,
} from "@workspace/harness";
import { localSandboxLayer, localWorkspaceLayer } from "@workspace/sandbox";
import { Telemetry } from "@workspace/telemetry";
import { Effect, Layer, Stream } from "effect";
import { openRun, type RunClaim } from "./open-run";
import { performRun, runOpened } from "./run";
import { workerAttachment } from "./subject";
import { loadRootEnv } from "./testing/root-env";
import {
  durableTranscriptPathOf,
  ingestTranscript,
  TRANSCRIPT_FILE,
  TRANSCRIPT_SEQ_BASE,
  type TranscriptIngestReport,
} from "./transcript-ingest";

/**
 * What a run home holds besides what the provider writes, by name. Nothing
 * carrying one of these may be left in a run directory once the run is over.
 */
const CREDENTIAL_NAMES = [".credentials.json", ".claude.json", "auth.json"];

/** What the scripted clean turn reports it cost. Trusted construction. */
const COST_USD = CostUsd.make("0.1234");

/** Names this process in `pg_stat_activity`, as every process that connects does. */
const APPLICATION_NAME = "orchestrator-test";

/** Which loop the audit rows are attributed to. */
const LOOP_INSTANCE = "orchestrator-test";

/**
 * The turn cap these runs are given. Far above a scripted stream that answers
 * immediately, so a slow machine cannot turn a clean turn into a timeout — the
 * cap's own behaviour is asserted where it is decided, not here.
 */
const TURN_TIMEOUT_MS = 60_000;

/** The workspace the seed creates and every script reuses. */
const WORKSPACE_SLUG = "personal";
const WORKSPACE_NAME = "Personal";
const OWNER_EMAIL = "owner@agent-task-manager.local";
const OWNER_NAME = "Owner";

/**
 * A second call is a no-op when the preload already ran, and the safety net for
 * a `bun test` invocation that skipped it.
 */
loadRootEnv();

/** Everything this test writes to disk, thrown away at the end. */
const dataRoot = mkdtempSync(join(tmpdir(), "atm-run-test-"));
process.env.DATA_ROOT = dataRoot;
process.env.EVENT_LOG_DIR = join(dataRoot, "events");

/**
 * The host's system-owned login for the provider, standing in for
 * `~/.claude-task-management`. Created here because nothing on the run path
 * creates it: an auto-made empty home boots a container that reports an auth
 * error nobody can tell from an expired token.
 */
const agentHomeDir = join(dataRoot, "agent-home", "claude");
mkdirSync(agentHomeDir, { recursive: true });

/** What every run in this file is given, beside its claim. */
const RUN_SETTINGS = {
  agentHomeDir,
  // No gateway, so no board tools and no token: the run path is what is under
  // test here, and `agent-token` has the credential's own claims.
  gatewayUrl: null,
  // Nothing of the operator's own is shared with a test's container.
  skillsDir: null,
  tokenTtlMs: 900_000,
} as const;

/** The conversation id the written transcript names itself with. */
const TRANSCRIPT_SESSION_ID = "transcript-session-1";

/** The one line of the written transcript a restored row can be recognized by. */
const TRANSCRIPT_TEXT = "what the provider wrote inside its own agent home";

/**
 * A transcript in the host's shared agent home, in the layout Claude Code uses:
 * `projects/<workspace>/<session>.jsonl` under the config directory.
 *
 * Written by the provider rather than by the test, because that is what makes
 * the claim real — the home is the operator's own login, shared by every run on
 * the box, and the file the ingest reads is the one this run's session named.
 */
const writeTranscript = (home: string) => {
  const directory = join(home, "projects", "-workspace");
  mkdirSync(directory, { recursive: true });
  const lines = [
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
  writeFileSync(
    join(directory, `${TRANSCRIPT_SESSION_ID}.jsonl`),
    `${lines.join("\n")}\n`
  );
};

/** One scripted turn, standing in for a provider. */
const providerOf = (input: {
  readonly events: readonly AgentEvent[];
  readonly failure: ProviderCrashed | null;
  /** Say the events and then never end, which is what a wedged provider looks like. */
  readonly hang?: boolean;
  /** Write a transcript into the agent home, as both real providers do. */
  readonly transcript?: boolean;
}): AgentProvider => ({
  capabilities: {
    cost: true,
    hooks: true,
    rateLimitSignal: false,
    reasoning: false,
    resume: true,
    subagents: false,
  },
  defaultEffort: null,
  displayName: "Scripted",
  efforts: [],
  id: "claude",
  models: [],
  run: (options) =>
    Stream.unwrap(
      Effect.sync(() => {
        if (input.transcript === true) {
          writeTranscript(options.agentHomeDir);
        }
        const said = Stream.fromIterable(input.events);
        if (input.hang === true) {
          return said.pipe(Stream.concat(Stream.never));
        }
        return input.failure === null
          ? said
          : said.pipe(Stream.concat(Stream.fail(input.failure)));
      })
    ),
});

/** The registry, with both providers answering with the same scripted turn. */
const registryLayer = (input: Parameters<typeof providerOf>[0]) => {
  const provider = providerOf(input);
  const table: ProviderTable = { claude: provider, codex: provider };
  return Layer.succeed(ProviderRegistry, makeProviderRegistry(table));
};

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

const telemetry = Telemetry.layer({ serviceName: APPLICATION_NAME });

/** The store and the disk. The provider is layered on per test. */
const baseLayer = Layer.mergeAll(
  storeLayer({ applicationName: APPLICATION_NAME }),
  telemetry,
  localWorkspaceLayer({ clone: () => Effect.void }),
  // Required by the lifecycle rather than used by these cases: every run here
  // is `sandboxKind: "local"`, which never asks the sandbox for a container.
  localSandboxLayer.pipe(Layer.provide(telemetry))
).pipe(Layer.provideMerge(BunFileSystem.layer));

/** Tasks this file created, deleted at the end whatever happened in between. */
const created: { id: TaskId; workspaceId: WorkspaceId }[] = [];

/** A task sitting in *in progress*, which is where a dispatch picks one up. */
const seedTask = (input: { readonly owner: UserId; readonly title: string }) =>
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepo;
    const tasks = yield* TaskRepo;
    const [workspace] = yield* workspaces.list();
    const task = yield* withActor(
      Actor.cases.human.make({ userId: input.owner })
    )(
      tasks.create({
        brief: "A brief the scripted provider never reads.",
        status: "in_progress",
        title: input.title,
        workspaceId: (workspace as NonNullable<typeof workspace>).id,
      })
    );
    created.push({ id: task.id, workspaceId: task.workspaceId });
    return task;
  });

const claimOf = (task: Task): RunClaim => ({
  attached: workerAttachment(task),
  attempt: 1,
  dataRoot,
  defaultProvider: "claude",
  loopInstance: LOOP_INSTANCE,
  project: null,
  queueWaitMs: 0,
  spanId: null,
  traceId: null,
  traceparent: null,
  trigger: "status_change",
});

/** Runs one scripted turn end to end and reads the rows back. */
const runOnce = (input: {
  readonly events: readonly AgentEvent[];
  readonly failure?: ProviderCrashed;
  readonly hang?: boolean;
  readonly timeoutMs?: number;
  readonly title: string;
}) =>
  Effect.gen(function* () {
    const { owner } = yield* ensureWorkspace;
    const task = yield* seedTask({ owner, title: input.title });
    const outcome = yield* performRun({
      ...RUN_SETTINGS,
      claim: claimOf(task),
      // The host path, which is what a scripted provider is: the container path
      // has a container test of its own, in `./container-turn.test`.
      sandboxKind: "local",
      timeoutMs: input.timeoutMs ?? TURN_TIMEOUT_MS,
    });

    const comments = yield* CommentRepo;
    const runEvents = yield* RunEventRepo;
    const runs = yield* RunRepo;
    const sessions = yield* AgentSessionRepo;
    const tasks = yield* TaskRepo;

    const { id: taskId, workspaceId } = task;
    return {
      comments: yield* comments.forTask({ taskId, workspaceId }),
      context: outcome.context,
      events: yield* runEvents.listByRun({
        runId: outcome.context.runId,
        workspaceId,
      }),
      report: outcome.report,
      run: yield* runs.byId({ id: outcome.context.runId, workspaceId }),
      session: yield* sessions.byId({
        id: outcome.context.session.session.id as AgentSessionId,
        workspaceId,
      }),
      task: yield* tasks.byId({ id: taskId, workspaceId }),
      terminus: outcome.terminus,
    };
  }).pipe(
    Effect.provide(
      registryLayer({
        events: input.events,
        failure: input.failure ?? null,
        hang: input.hang,
      })
    )
  );

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(Effect.scoped(effect) as Effect.Effect<A, E, never>);

const provide = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof baseLayer>>
) => run(effect.pipe(Effect.provide(baseLayer)));

const sessionInit: AgentEvent = {
  kind: "session_init",
  model: "claude-test",
  provider: "claude",
  providerSessionId: "provider-session-1",
};

const assistant = (text: string): AgentEvent => ({
  kind: "assistant_text",
  text,
});

const commentCall: AgentEvent = {
  callId: "call-1",
  inputChars: 12,
  kind: "tool_call",
  summary: "post a comment",
  toolName: "atm_add_comment",
};

const commentResult: AgentEvent = {
  callId: "call-1",
  kind: "tool_result",
  ok: true,
  outputChars: 4,
  summary: "ok",
};

const doneResult: AgentEvent = {
  costUsd: COST_USD,
  durationMs: 4200,
  errorClass: null,
  errorMessage: null,
  kind: "result",
  outcome: "done",
  providerSessionId: "provider-session-1",
  text: "I opened the pull request.",
  totalTokens: 900,
  turns: 3,
};

const erroredResult: AgentEvent = {
  costUsd: null,
  durationMs: null,
  errorClass: "ProviderCrashed",
  errorMessage: "the provider died holding the connection open",
  kind: "result",
  outcome: "errored",
  providerSessionId: "provider-session-1",
  text: "",
  totalTokens: null,
  turns: null,
};

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

test("a clean run lands the task in review with a run row and a timeline", async () => {
  const seen = await provide(
    runOnce({
      events: [sessionInit, assistant("working"), doneResult],
      title: "clean run",
    })
  );

  expect(seen.task.status).toBe("review");
  expect(seen.terminus.kind).toBe("finished");
  expect(seen.run.outcome).toBe("done");
  expect(seen.run.status).toBe("finished");
  expect(seen.run.model).toBe("claude-test");
  expect(seen.run.turns).toBe(3);
  // Compared as a number: the column is `numeric`, so what comes back carries
  // the scale the column declares rather than the digits that went in.
  expect(Number(seen.run.costUsd)).toBe(Number(COST_USD));
  expect(seen.session.status).toBe("finished");
  expect(seen.session.providerSessionId).toBe("provider-session-1");
  // One row per line of the event file, in the order they arrived.
  expect(seen.events.map((event) => event.seq)).toEqual([0, 1, 2]);
  expect(seen.events.map((event) => event.payload.kind)).toEqual([
    "started",
    "assistant_message",
    "finished",
  ]);
  expect(seen.report?.transitioned).toBe(true);
  // The event file the ingest would re-read, with one line per row.
  const lines = readFileSync(seen.context.layout.eventLogPath, "utf-8")
    .split("\n")
    .filter((line) => line.length > 0);
  expect(lines).toHaveLength(3);
});

test("a failing run posts the error, fails the session, and still lands in review", async () => {
  const seen = await provide(
    runOnce({
      events: [sessionInit, erroredResult],
      title: "failing run",
    })
  );

  expect(seen.task.status).toBe("review");
  expect(seen.terminus.kind).toBe("failed");
  expect(seen.run.outcome).toBe("errored");
  expect(seen.run.status).toBe("failed");
  expect(seen.run.errorClass).toBe("ProviderCrashed");
  expect(seen.session.status).toBe("failed");
  expect(seen.session.errorMessage).toContain("provider died");

  const errors = seen.comments.filter(
    (comment) => comment.kind === "run_error"
  );
  expect(errors).toHaveLength(1);
  expect(errors[0]?.authorKind).toBe("orchestrator");
  expect(errors[0]?.body).toContain("provider died");
  // Economics are null on a degraded ending, never a fabricated zero.
  expect(seen.run.costUsd).toBeNull();
  expect(seen.run.turns).toBeNull();
});

test("a stream that stops without a terminus is a failure of its own", async () => {
  const seen = await provide(
    runOnce({
      events: [sessionInit, assistant("half a thought")],
      title: "truncated stream",
    })
  );

  expect(seen.terminus.kind).toBe("lost");
  expect(seen.task.status).toBe("review");
  expect(seen.run.outcome).toBe("lost");
  expect(seen.run.errorClass).toBe("NoTerminalEvent");
  expect(seen.session.status).toBe("failed");
  expect(
    seen.comments.filter((comment) => comment.kind === "run_error")
  ).toHaveLength(1);
});

test("a turn that outlives its cap is closed as a timeout", async () => {
  const seen = await provide(
    runOnce({
      events: [sessionInit, assistant("thinking")],
      hang: true,
      timeoutMs: 250,
      title: "wedged run",
    })
  );

  expect(seen.terminus.kind).toBe("failed");
  expect(seen.task.status).toBe("review");
  expect(seen.run.outcome).toBe("timeout");
  expect(seen.run.errorClass).toBe("TimedOut");
  expect(seen.session.status).toBe("failed");
  // What it said before it went quiet is still on the timeline and in the
  // thread: a run that hung after doing work did the work.
  expect(seen.events).toHaveLength(2);
  expect(
    seen.comments.filter((comment) => comment.kind === "fallback")
  ).toHaveLength(1);
});

test("a provider that dies mid-stream closes the run as failed", async () => {
  const seen = await provide(
    runOnce({
      events: [sessionInit],
      failure: new ProviderCrashed({
        cause: null,
        message: "spawn claude ENOENT",
      }),
      title: "provider crash",
    })
  );

  expect(seen.terminus.kind).toBe("failed");
  expect(seen.task.status).toBe("review");
  expect(seen.run.errorClass).toBe("ProviderCrashed");
  expect(seen.session.status).toBe("failed");
});

test("the fallback comment appears only when the run posted none", async () => {
  const silent = await provide(
    runOnce({
      events: [sessionInit, assistant("working"), doneResult],
      title: "silent run",
    })
  );
  const fallbacks = silent.comments.filter(
    (comment) => comment.kind === "fallback"
  );
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0]?.body).toBe("I opened the pull request.");
  expect(fallbacks[0]?.authorKind).toBe("agent");
  expect(fallbacks[0]?.runId).toBe(silent.context.runId);

  const spoke = await provide(
    runOnce({
      events: [sessionInit, commentCall, commentResult, doneResult],
      title: "talkative run",
    })
  );
  expect(
    spoke.comments.filter((comment) => comment.kind === "fallback")
  ).toHaveLength(0);
  expect(spoke.report?.commentPosted).toBe(true);
  // The marker the stop hook reads, created by the loop on the tool result.
  expect(
    existsSync(
      commentMarkerPathOf(
        hostRunLayout({ dataRoot, runId: spoke.context.runId })
      )
    )
  ).toBe(true);
});

test("the close hook copies the transcript out of the shared home and reads it there", async () => {
  const seen = await provide(
    Effect.gen(function* () {
      const { owner } = yield* ensureWorkspace;
      const task = yield* seedTask({ owner, title: "transcript ingest" });
      const context = yield* openRun(claimOf(task));
      const ingested: TranscriptIngestReport[] = [];

      yield* runOpened({
        ...RUN_SETTINGS,
        context,
        dataRoot,
        // What the loop's own close hook does, reduced to the one step this
        // claim is about.
        onClose: (closed) =>
          withActor(context.actor)(
            ingestTranscript({
              agentHomeDir,
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
        sandboxKind: "local",
        timeoutMs: TURN_TIMEOUT_MS,
      });

      const runEvents = yield* RunEventRepo;
      const sessions = yield* AgentSessionRepo;
      const { workspaceId } = task;
      return {
        context,
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
    }).pipe(
      // One event, and it is the one that names the conversation: the stream
      // leaves no timeline, so the transcript is the only account of the run
      // there is, and the rows it restores are the proof it was read rather
      // than merely looked for. The id is what narrows the read to this run's
      // own file in a tree every run on the host writes into.
      Effect.provide(
        registryLayer({
          events: [
            {
              kind: "session_init",
              model: "claude-test",
              provider: "claude",
              providerSessionId: TRANSCRIPT_SESSION_ID,
            },
          ],
          failure: null,
          transcript: true,
        })
      )
    )
  );

  expect(seen.report?.found).toBe(true);
  expect(seen.report?.entries).toBe(2);
  expect(seen.report?.providerSessionId).toBe(TRANSCRIPT_SESSION_ID);
  expect(seen.session.providerSessionId).toBe(TRANSCRIPT_SESSION_ID);

  // The stream did leave a timeline — one row, the event that named the
  // conversation — so the transcript is read and not replayed into it. Restoring
  // a timeline that already exists is `./ingest.test`'s claim, over a run whose
  // stream left none.
  expect(seen.report?.restored).toBe(false);
  expect(seen.timeline.every((event) => event.seq < TRANSCRIPT_SEQ_BASE)).toBe(
    true
  );

  // The conversation is in the run directory at full length, and the ingest
  // above read it there rather than back in the shared tree.
  const durable = durableTranscriptPathOf(seen.context.layout);
  expect(seen.report?.path).toBe(durable);
  expect(readFileSync(durable, "utf8")).toContain(TRANSCRIPT_TEXT);

  // One file came out of the operator's own login directory, and it is the
  // transcript: a copy that took the directory rather than the one file this
  // run's session named would have brought the credential with it — and every
  // other run's conversation besides.
  const left = readdirSync(seen.context.layout.runDir, { recursive: true });
  expect(left).toContain(TRANSCRIPT_FILE);
  expect(
    left.filter((entry) =>
      CREDENTIAL_NAMES.some((name) => entry.includes(name))
    )
  ).toEqual([]);
});
