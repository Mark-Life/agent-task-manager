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
 * **The conversation.** Open a thread over HTTP, say something into it, read it
 * and its turns back, file a force send, and archive it. The dashboard's door
 * onto the manager is the bot's door: one row, one dispatch source, one queue.
 *
 * **The stream.** A live run's timeline over SSE, and the row that is written
 * when the connection closes rather than when the handler returned.
 *
 * **The trace.** A request's id on the audit row it wrote, and on the two rows
 * the loop reads to open a run — the whole of the gateway's half of that seam.
 * The loop adopting them is `bun run loop:check`'s claim, because it needs a
 * loop.
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
import { Actor, parseTraceparent, UserId } from "@workspace/domain";
import { makeTokenSigner } from "@workspace/token";
import { DateTime, Effect } from "effect";
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
  threadClaims,
} from "./gateway-check-claims";
import {
  CheckFailed,
  check,
  freePort,
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
      subject: { id: input.taskId, kind: "task" },
      workspaceId: input.workspaceId,
    });
    const run = yield* runs.create({
      agentSessionId: session.id,
      provider: "claude",
      subject: { id: input.taskId, kind: "task" },
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
      subject: { id: input.taskId, kind: "task" },
      workspaceId: input.workspaceId,
    });
    return { run, session };
  }).pipe(
    withActor(Actor.cases.orchestrator.make({ loopInstance: APPLICATION_NAME }))
  );

/** The trace id a row carries, or the header itself when it carries none. */
const carried = (header: string | null | undefined) => {
  const context = parseTraceparent(header);
  return context === null ? `nothing (${header ?? "null"})` : context.traceId;
};

/**
 * How far a request's trace reaches, which is every row on this side of the
 * seam between the gateway and the loop.
 *
 * Three rows, one request each. The audit row is the trail an operator greps:
 * every mutation stamps the current span's trace onto it. The other two are
 * what the loop reads to decide there is work — a card in *in progress* and an
 * intent on the queue — and each carries the asking request's whole
 * `traceparent`, so the run opened off it seconds or a restart later is a child
 * of the request rather than a second tree with a matching id.
 *
 * Nothing here needs a loop, and nothing here is the loop's claim: that the
 * orchestrator adopts the header and the run row lands in the request's trace
 * is proved by `bun run loop:check`, which has one.
 */
const traceClaims = (input: {
  readonly caller: ReturnType<typeof makeCaller>;
  readonly created: string;
  readonly projectId: string;
  readonly taskId: TaskId;
  readonly token: string;
  readonly workspaceId: WorkspaceId;
}) =>
  Effect.gen(function* () {
    const auditLog = yield* AuditLogRepo;
    const entries = yield* auditLog.forTask({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    });
    const wroteTask = entries.find(
      (entry) => entry.action === "create" && entry.entityType === "task"
    );

    yield* check({
      detail: `the create request traced ${input.created}, its audit row ${wroteTask?.traceId ?? "nothing"}`,
      ok: wroteTask?.traceId === input.created,
      step: "the create request's trace is on the audit row it wrote",
    });

    // Filed straight into the column rather than moved into it: a create is as
    // much a dispatch trigger as a move, and it is the path the manager and the
    // seed script take, so it is the one worth driving over the wire.
    const filed = yield* input.caller.call({
      body: {
        projectId: input.projectId,
        status: "in_progress",
        title: "gateway-check dispatch",
      },
      method: "POST",
      path: "/tasks",
      token: input.token,
    });
    const dispatchTaskId = ((filed.body as { id?: string }).id ?? "") as TaskId;
    const stamped = (call: { readonly body: unknown }) =>
      (call.body as { dispatchTraceparent?: string | null })
        .dispatchTraceparent ?? null;

    yield* check({
      detail: `the request traced ${filed.traceId}, the card carries ${carried(stamped(filed))}`,
      ok: parseTraceparent(stamped(filed))?.traceId === filed.traceId,
      step: "a card filed into in_progress carries the request's trace for the loop to read",
    });

    const intent = yield* input.caller.call({
      body: {},
      method: "POST",
      path: `/tasks/${dispatchTaskId}/commands/rerun`,
      token: input.token,
    });
    const queued = (intent.body as { traceparent?: string | null }).traceparent;
    yield* check({
      detail: `the request traced ${intent.traceId}, the intent carries ${carried(queued)}`,
      ok: parseTraceparent(queued)?.traceId === intent.traceId,
      step: "an intent queued over HTTP carries the asking request's trace too",
    });

    // A rerun moves no card, so the card is still where it was: leaving the
    // column now is what proves the stamp is cleared rather than left to join a
    // run to a request that ended days ago.
    const left = yield* input.caller.call({
      body: { to: "review" },
      method: "POST",
      path: `/tasks/${dispatchTaskId}/status`,
      token: input.token,
    });
    yield* check({
      detail: `after the move the card carries ${stamped(left) ?? "nothing"}`,
      ok: stamped(left) === null,
      step: "leaving the column clears the stamp, so no later run joins a spent request",
    });

    return dispatchTaskId;
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
    yield* threadClaims({ caller, token: adminToken, userId: CHECK_USER });

    const streamed = yield* streamClaims({
      caller,
      holdMs: STREAM_HOLD_MS,
      runId: run.id,
      taskId,
      token: adminToken,
    });

    // Last of the claims, because it files a third card and the cleanup below
    // is what takes it away again.
    const dispatchTaskId = yield* traceClaims({
      caller,
      created,
      projectId,
      taskId,
      token: adminToken,
      workspaceId,
    });

    yield* cleanUp({
      caller,
      projectId,
      taskIds: [otherTaskId, taskId, dispatchTaskId],
      token: adminToken,
    });

    return { refused, streamed, taskId };
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
