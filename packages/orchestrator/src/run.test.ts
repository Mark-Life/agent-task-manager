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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { localWorkspaceLayer } from "@workspace/sandbox";
import { Telemetry } from "@workspace/telemetry";
import { Effect, Layer, Stream } from "effect";
import type { RunClaim } from "./open-run";
import { performRun } from "./run";
import { loadRootEnv } from "./testing/root-env";

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

/** One scripted turn, standing in for a provider. */
const providerOf = (input: {
  readonly events: readonly AgentEvent[];
  readonly failure: ProviderCrashed | null;
  /** Say the events and then never end, which is what a wedged provider looks like. */
  readonly hang?: boolean;
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
  run: () => {
    const said = Stream.fromIterable(input.events);
    if (input.hang === true) {
      return said.pipe(Stream.concat(Stream.never));
    }
    return input.failure === null
      ? said
      : said.pipe(Stream.concat(Stream.fail(input.failure)));
  },
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

/** The store and the disk. The provider is layered on per test. */
const baseLayer = Layer.mergeAll(
  storeLayer({ applicationName: APPLICATION_NAME }),
  Telemetry.layer({ serviceName: APPLICATION_NAME }),
  localWorkspaceLayer({ clone: () => Effect.void })
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
      claim: claimOf(task),
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
