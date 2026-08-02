#!/usr/bin/env bun

/**
 * Proves what Phase 5 exits on: a whole task lifecycle driven over HTTP against
 * a real gateway, a spec that loads and describes the surface behind it, and a
 * ledger in which every request left exactly one row — the refused ones
 * included.
 *
 * It is a script rather than a test because every claim is about a process. The
 * gateway is started the way an operator starts it, bound to a real port,
 * driven over a socket, and stopped with `SIGTERM`; the rows are read off the
 * file it flushed on the way out. Serving in-process would prove that the
 * layers compose and nothing about the thing that runs on the box.
 *
 * Six surfaces, each with its claims in `./gateway-check-claims`:
 *
 * **The door.** No credential, a forged one and an under-scoped one are three
 * different refusals with three different reasons, and each leaves a row. A
 * rejected token that vanished would be the one failure nobody could count.
 *
 * **The board.** File a project, file a task, say something on it, walk it
 * `ideas → backlog → in progress → review → done`, and be refused the move that
 * is not in the status machine. Every write is attributed to the token's own
 * actor, which is what the audit trail is for.
 *
 * **The run surface.** List a task's runs, queue an intent, read it back.
 * Nothing here starts a container: the gateway writes rows and the loop acts on
 * them, which is the whole point of that seam.
 *
 * **The files.** Upload into the task's folder, list the index, stream the bytes
 * back — metadata is a query and content is a file read.
 *
 * **The task binding.** A run's token writes on its own task and is refused on
 * anybody else's, checked once in the access middleware against the `:taskId`
 * every task-owned route nests below.
 *
 * **The stream.** A live run's timeline over SSE, and the row that is written
 * when the connection closes rather than when the handler returned.
 *
 * The one thing this cannot claim is the trace reaching the run — see
 * `traceClaims` below, which says exactly how far it goes and what is missing.
 *
 * Everything is scoped to its own data root (`${DATA_ROOT}/gateway-check`) so a
 * real gateway's ledger is never appended to, and every row it files is deleted
 * on the way out. The audit trail behind them stays, as it does everywhere.
 * Usage: `bun run gateway:check`.
 */

import { join } from "node:path";
import process from "node:process";

/**
 * Every setting the child gateway reads, pinned before a layer is built.
 *
 * Written onto this process's environment as well as handed to the child,
 * because the check reads the same ledger the child writes and a second
 * spelling of that path is a check that reads an empty file and passes.
 */
const CHECK_SEGMENT = "gateway-check";
const CONFIGURED_ROOT = process.env.DATA_ROOT?.trim() || ".data";
const CHECK_ROOT = CONFIGURED_ROOT.endsWith(CHECK_SEGMENT)
  ? CONFIGURED_ROOT
  : join(CONFIGURED_ROOT, CHECK_SEGMENT);
const CHECK_EVENT_DIR = join(CHECK_ROOT, "events");
process.env.DATA_ROOT = CHECK_ROOT;
process.env.EVENT_LOG_DIR = CHECK_EVENT_DIR;

import { rmSync } from "node:fs";
import { BunRuntime } from "@effect/platform-bun";
import {
  AgentSessionRepo,
  AuditLogRepo,
  RunEventRepo,
  RunRepo,
  storeLayer,
  withActor,
} from "@workspace/db";
import type { TaskId, WorkspaceId } from "@workspace/domain";
import { Actor, UserId } from "@workspace/domain";
import { DateTime, Effect } from "effect";
import { makeTokenSigner } from "../apps/gateway/src/auth/tokens";
import { SERVICE_NAME } from "../apps/gateway/src/identity";
import {
  artifactClaims,
  bindingClaims,
  boardClaims,
  cleanUp,
  commentClaims,
  doorClaims,
  ledgerClaims,
  lifecycleClaims,
  runSurfaceClaims,
  specClaims,
  streamClaims,
} from "./gateway-check-claims";
import {
  CheckFailed,
  check,
  freePort,
  gap,
  makeCaller,
  startGateway,
} from "./gateway-check-client";
import { ensureWorkspace } from "./store/workspace";

/** Reported as `application_name`, so `pg_stat_activity` names this process. */
const APPLICATION_NAME = "gateway-check";

/** The account this check acts as. Nothing logs in as it. */
const CHECK_USER = UserId.make("gateway-check-human");

/** How long a token this check mints is good for. Minutes, not days. */
const TOKEN_TTL = "10 minutes";

/** How long the event stream is held open before the reader hangs up. */
const STREAM_HOLD_MS = 2000;

/** The ledger the child appends to and this check reads back. */
const LEDGER = join(CHECK_EVENT_DIR, `${SERVICE_NAME}.jsonl`);

/**
 * The exit code a gateway stopped by a signal answers with.
 *
 * The runtime reserves 130 for a fiber that ended in interruption and nothing
 * else, which is exactly what a graceful `SIGTERM` produces. A 1 would be the
 * shutdown watchdog giving up on a drain, and anything else is a crash.
 */
const INTERRUPTED_EXIT = 130;

/** Base64url digits in a SHA-256 signature, which is what the third segment is. */
const SIGNATURE_CHARS = 43;

/**
 * A real token with its signature replaced, which is the forgery worth
 * refusing: a string of nonsense never reaches the signature check.
 */
const tamper = (token: string) => {
  const [version, claims] = token.split(".");
  return [version, claims, "0".repeat(SIGNATURE_CHARS)].join(".");
};

/**
 * A live run on the task, opened through the repositories.
 *
 * The gateway cannot open one and must not be able to: run creation belongs to
 * the orchestrator, and the API's own path to it is an intent on a queue. So
 * the run this check streams from is opened here, as the orchestrator — which
 * is exactly who would have opened it.
 */
const openRun = (input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const sessions = yield* AgentSessionRepo;
    const runs = yield* RunRepo;
    const events = yield* RunEventRepo;

    const session = yield* sessions.open({
      provider: "claude",
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    });
    const run = yield* runs.create({
      agentSessionId: session.id,
      provider: "claude",
      taskId: input.taskId,
      trigger: "manual",
      workspaceId: input.workspaceId,
    });
    yield* events.append({
      occurredAt: yield* DateTime.now,
      payload: {
        kind: "started",
        model: null,
        promptChars: 0,
        provider: "claude",
        sandboxImage: null,
      },
      runId: run.id,
      seq: 1,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    });
    return { run, session };
  }).pipe(
    withActor(Actor.cases.orchestrator.make({ loopInstance: APPLICATION_NAME }))
  );

/**
 * How far a request's trace actually reaches, stated exactly.
 *
 * The audited half holds: every mutation stamps the current span's trace onto
 * its audit row, so a task filed over HTTP is joined to the request that filed
 * it by an id an operator can grep for. The run half does not, and this says so
 * out loud rather than asserting something weaker and calling it the criterion.
 */
const traceClaims = (input: {
  readonly created: string;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const auditLog = yield* AuditLogRepo;
    const entries = yield* auditLog.forTask({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    });
    const wrote = (entityType: string) =>
      entries.find(
        (entry) => entry.action === "create" && entry.entityType === entityType
      );

    yield* check({
      detail: `the create request traced ${input.created}, its audit row ${wrote("task")?.traceId ?? "nothing"}`,
      ok: wrote("task")?.traceId === input.created,
      step: "the create request's trace is on the audit row it wrote",
    });

    yield* gap({
      detail: `the run traces ${wrote("run")?.traceId ?? "nothing"} — its opener's, not the request's. Nothing the gateway writes can carry a trace to the loop: run_command has no trace column and RunCommandRepo.enqueue no trace argument, task has none either, and RunRepo.create's only caller is the orchestrator passing its own claim span. Closing it is one column and one argument in @workspace/db`,
      step: "the create request's trace does NOT reach the atm.run row",
    });
  });

/** The four credentials every claim below is made with. */
const mintTokens = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const tokens = yield* makeTokenSigner;
    const human = Actor.cases.human.make({ userId: CHECK_USER });
    const asHuman = (scope: "admin" | "read") =>
      tokens.mint({ actor: human, scope, ttl: TOKEN_TTL, workspaceId });
    return {
      adminToken: yield* asHuman("admin"),
      readToken: yield* asHuman("read"),
      tokens,
    };
  });

/** Everything the check does while the gateway is up. */
const drive = (input: {
  readonly caller: ReturnType<typeof makeCaller>;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const { caller, workspaceId } = input;
    const { adminToken, readToken, tokens } = yield* mintTokens(workspaceId);

    yield* specClaims(caller, adminToken);
    const refused = yield* doorClaims({
      caller,
      forgedToken: tamper(adminToken),
      readToken,
    });

    const { created, projectId, taskId } = yield* boardClaims(
      caller,
      adminToken
    );
    yield* commentClaims({
      caller,
      taskId,
      token: adminToken,
      userId: CHECK_USER,
    });
    yield* lifecycleClaims({ caller, projectId, taskId, token: adminToken });

    // Filed after the walk so the two ids exist together: the binding claim
    // needs a task the run's token is not about.
    const neighbour = yield* caller.call({
      body: { projectId, title: "gateway-check neighbour" },
      method: "POST",
      path: "/tasks",
      token: adminToken,
    });
    const otherTaskId = ((neighbour.body as { id?: string }).id ??
      "") as TaskId;

    const { run, session } = yield* openRun({ taskId, workspaceId });
    const workerToken = yield* tokens.mint({
      actor: Actor.cases.worker_run.make({
        runId: run.id,
        sessionId: session.id,
        taskId,
      }),
      scope: "task-write",
      ttl: TOKEN_TTL,
      workspaceId,
    });

    yield* runSurfaceClaims({
      caller,
      runId: run.id,
      taskId,
      token: adminToken,
      userId: CHECK_USER,
    });
    yield* artifactClaims({ caller, taskId, token: adminToken });
    refused.push(
      yield* bindingClaims({ caller, otherTaskId, taskId, workerToken })
    );
    const streamed = yield* streamClaims({
      caller,
      holdMs: STREAM_HOLD_MS,
      runId: run.id,
      taskId,
      token: adminToken,
    });

    yield* cleanUp({
      caller,
      projectId,
      taskIds: [otherTaskId, taskId],
      token: adminToken,
    });

    return { created, refused, streamed, taskId };
  });

const gatewayCheck = Effect.gen(function* () {
  // The row counts are exact, and only a ledger this run wrote can make them
  // so. It is under this check's own root, so nothing else is erased.
  yield* Effect.sync(() => rmSync(LEDGER, { force: true }));

  const port = yield* freePort;
  const origin = `http://127.0.0.1:${port}`;
  const caller = makeCaller(origin);
  const { workspace } = yield* ensureWorkspace();

  const child = yield* startGateway({
    caller,
    env: {
      DATA_ROOT: CHECK_ROOT,
      EVENT_LOG_DIR: CHECK_EVENT_DIR,
      GATEWAY_PORT: String(port),
      GATEWAY_PUBLIC_URL: origin,
    },
    repoRoot: join(import.meta.dir, ".."),
  });
  yield* Effect.logInfo(`${APPLICATION_NAME}: gateway up on ${origin}`);

  const driven = yield* drive({ caller, workspaceId: workspace.id }).pipe(
    // The gateway is stopped whatever happened, and before the ledger is read:
    // the last rows are flushed as its layers finalize, so a check that read
    // the file first would be reading one still being written.
    Effect.onExit(() =>
      Effect.flatMap(child.stop(), (code) =>
        code === INTERRUPTED_EXIT
          ? Effect.logInfo("ok    SIGTERM drains the server and exits clean")
          : Effect.logError(
              `the gateway exited ${code ?? "only when it was killed"}\n${child.output()}`
            )
      )
    )
  );

  yield* ledgerClaims({
    caller,
    holdMs: STREAM_HOLD_MS,
    ledger: LEDGER,
    refused: driven.refused,
    streamed: driven.streamed,
    taskId: driven.taskId,
  });
  yield* traceClaims({
    created: driven.created,
    taskId: driven.taskId,
    workspaceId: workspace.id,
  });

  yield* Effect.logInfo(
    `every claim held; read the requests back with EVENT_LOG_DIR=${CHECK_EVENT_DIR} bun run logs runs atm.request`
  );
});

BunRuntime.runMain(
  gatewayCheck.pipe(
    Effect.tapError((failure) =>
      Effect.logError(
        failure instanceof CheckFailed ? failure.message : String(failure)
      )
    ),
    Effect.provide(storeLayer({ applicationName: APPLICATION_NAME }))
  )
);
