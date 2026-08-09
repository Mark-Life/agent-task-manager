/**
 * What `gateway:check` claims, group by group.
 *
 * Split from the driver because the two answer different questions. The driver
 * decides what exists — a port, a child process, a workspace, a run — and this
 * file decides what is true of it. Each function below drives one surface over
 * HTTP and states the claims that surface is supposed to satisfy, so a claim
 * that stops holding is a named line in one place rather than a diff in a
 * five-hundred-line program.
 *
 * Nothing here reaches the database. Every claim is made through the same door
 * an external consumer has: a URL, a bearer token, and whatever came back.
 */

import type { RunId, TaskId } from "@workspace/domain";
import { Effect } from "effect";
import {
  type Caller,
  check,
  type RequestRow,
  requestRows,
} from "./gateway-check-client";

/** The security schemes the spec has to name for a connector to configure itself. */
const EXPECTED_SCHEMES = [
  "adminToken",
  "readToken",
  "sessionCookie",
  "taskWriteToken",
] as const;

/** The lifecycle, in the order a card walks it. */
const LIFECYCLE = ["backlog", "in_progress", "review", "done"] as const;

/** The shape of a wire failure, as far as a claim cares. */
interface WireFailure {
  readonly _tag?: string;
  readonly reason?: string;
}

const failureOf = (body: unknown) => (body ?? {}) as WireFailure;

/** Whatever carries an id, which is most of what comes back. */
const idOf = (body: unknown) => (body as { id?: string }).id ?? "";

/** An array response, or an empty one — a claim about length must not throw. */
const listOf = (body: unknown) => (Array.isArray(body) ? body : []);

/** What the document says about itself, and about where it is served. */
interface SpecShape {
  readonly components?: { readonly securitySchemes?: Record<string, unknown> };
  readonly info?: { readonly title?: string };
  readonly openapi?: string;
  readonly paths?: Record<string, unknown>;
  readonly servers?: readonly { readonly url?: string }[];
}

/** Statuses a claim compares against, named so they read as answers. */
const OK = 200;
/** A delete answers with no body, which is a status of its own. */
const NO_CONTENT = 204;
const FORBIDDEN = 403;
const CONFLICT = 409;
const UNAUTHORIZED = 401;

/** The document the gateway publishes, and the three things a consumer needs from it. */
export const specClaims = (caller: Caller, token: string) =>
  Effect.gen(function* () {
    const spec = yield* caller.call({ path: "/openapi.json" });
    const document = spec.body as SpecShape;

    yield* check({
      detail: `openapi ${document.openapi ?? "absent"}, title ${document.info?.title ?? "absent"}`,
      ok:
        spec.status === OK &&
        document.openapi === "3.1.0" &&
        document.info?.title === "Agent Task Manager",
      step: "the spec loads and is an OpenAPI 3.1 document",
    });

    const schemes = Object.keys(document.components?.securitySchemes ?? {});
    yield* check({
      detail: `found ${schemes.join(", ") || "none"}`,
      ok: EXPECTED_SCHEMES.every((scheme) => schemes.includes(scheme)),
      step: "the spec names every credential an operation can take",
    });

    const paths = Object.keys(document.paths ?? {});
    yield* check({
      detail: `${paths.length} paths, first server ${document.servers?.[0]?.url ?? "absent"}`,
      ok:
        paths.includes("/tasks/{taskId}/runs/{runId}/events/stream") &&
        paths.includes("/tasks/{taskId}/artifacts") &&
        (document.servers?.[0]?.url ?? "") === caller.origin,
      step: "the spec carries this deployment's origin and the whole surface",
    });

    const docs = yield* caller.call({ path: "/docs", token });
    yield* check({
      detail: `the reference UI answered ${docs.status}`,
      ok: docs.status === OK && String(docs.body).includes("<html"),
      step: "the reference UI renders",
    });
  });

/**
 * The four ways a credential is turned away, each with a reason of its own.
 *
 * `forgedToken` is a real token with its signature swapped, not a string of
 * nonsense: nonsense is refused while it is still being parsed, and what is
 * worth proving is the check after that — a well-formed claim set nobody with
 * the secret ever signed.
 */
export const doorClaims = (input: {
  readonly caller: Caller;
  readonly forgedToken: string;
  readonly readToken: string;
}) =>
  Effect.gen(function* () {
    const { caller, forgedToken, readToken } = input;
    const none = yield* caller.call({ path: "/projects" });
    yield* check({
      detail: `${none.status} ${failureOf(none.body).reason ?? "no reason"}`,
      ok:
        none.status === UNAUTHORIZED &&
        failureOf(none.body).reason === "no_credential",
      step: "no credential is 401 with the reason on it",
    });

    const forged = yield* caller.call({
      path: "/projects",
      token: forgedToken,
    });
    yield* check({
      detail: `${forged.status} ${failureOf(forged.body).reason ?? "no reason"}`,
      ok:
        forged.status === UNAUTHORIZED &&
        failureOf(forged.body).reason === "token_bad_signature",
      step: "a forged token is 401, named as a bad signature",
    });

    const underScoped = yield* caller.call({
      body: { name: "gateway-check refused" },
      method: "POST",
      path: "/projects",
      token: readToken,
    });
    yield* check({
      detail: `${underScoped.status} ${failureOf(underScoped.body).reason ?? "no reason"}`,
      ok:
        underScoped.status === FORBIDDEN &&
        failureOf(underScoped.body).reason === "insufficient_scope",
      step: "a read token is 403 on a write, not 401",
    });

    // The fourth door, and the one a person's own integration comes to. A key
    // nobody issued proves the header is read on the running process and that
    // the refusal is a key's refusal rather than "no credential" — which is
    // what a caller who mistyped their key needs to be told. Provisioning a
    // real key would mean a signed-in person with a known password, which this
    // check does not have; the paths that need one are covered against a real
    // database in `apps/gateway/src/auth/principal.test.ts`.
    const strangeKey = yield* caller.call({
      apiKey: "atm_nobody-ever-issued-this-one",
      path: "/projects",
    });
    yield* check({
      detail: `${strangeKey.status} ${failureOf(strangeKey.body).reason ?? "no reason"}`,
      ok:
        strangeKey.status === UNAUTHORIZED &&
        failureOf(strangeKey.body).reason === "key_rejected",
      step: "an unknown API key is 401, named as a key and not as a missing credential",
    });

    return [
      none.traceId,
      forged.traceId,
      underScoped.traceId,
      strangeKey.traceId,
    ];
  });

/** What a card did on the board, and the ids the rest of the check hangs off. */
export const boardClaims = (caller: Caller, token: string) =>
  Effect.gen(function* () {
    const project = yield* caller.call({
      body: { name: "gateway-check drive" },
      method: "POST",
      path: "/projects",
      token,
    });
    const projectId = idOf(project.body);
    yield* check({
      detail: `${project.status} ${projectId || "no id"}`,
      ok: project.status === OK && projectId !== "",
      step: "a project is filed over HTTP",
    });

    const filed = yield* caller.call({
      body: { brief: "driven over HTTP", projectId, title: "gateway-check" },
      method: "POST",
      path: "/tasks",
      token,
    });
    const { status } = filed.body as { status?: string };
    yield* check({
      detail: `${filed.status}, status ${status ?? "absent"}`,
      ok: filed.status === OK && status === "ideas",
      step: "a task with no status named is filed into ideas",
    });
    const taskId = idOf(filed.body) as TaskId;

    // Two columns forward in one move, which the machine used to refuse and now
    // allows anybody holding this token: the board is the operator's to arrange.
    const jumped = yield* caller.call({
      body: { to: "done" },
      method: "POST",
      path: `/tasks/${taskId}/status`,
      token,
    });
    yield* check({
      detail: `${jumped.status} ${(jumped.body as { status?: string }).status ?? "no status"}`,
      ok:
        jumped.status === OK &&
        (jumped.body as { status?: string }).status === "done",
      step: "ideas -> done in one move, in either direction",
    });

    const sameColumn = yield* caller.call({
      body: { to: "done" },
      method: "POST",
      path: `/tasks/${taskId}/status`,
      token,
    });
    yield* check({
      detail: `${sameColumn.status} ${failureOf(sameColumn.body)._tag ?? "no tag"}`,
      ok:
        sameColumn.status === CONFLICT &&
        failureOf(sameColumn.body)._tag === "IllegalTransition",
      step: "a move to the column the card is already in is 409, not 500",
    });

    return { created: filed.traceId, projectId, taskId };
  });

/** The thread, and who a message is attributed to. */
export const taskMessageClaims = (input: {
  readonly caller: Caller;
  readonly taskId: TaskId;
  readonly token: string;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    const posted = yield* input.caller.call({
      body: { body: "said over HTTP" },
      method: "POST",
      path: `/tasks/${input.taskId}/messages`,
      token: input.token,
    });
    const author = (posted.body as { authorUserId?: string }).authorUserId;
    yield* check({
      detail: `${posted.status}, authored by ${author ?? "nobody"}`,
      ok: posted.status === OK && author === input.userId,
      step: "a message is attributed to the credential, never to the body",
    });

    const thread = yield* input.caller.call({
      path: `/tasks/${input.taskId}/messages`,
      token: input.token,
    });
    yield* check({
      detail: `${thread.status}, ${listOf(thread.body).length} in the thread`,
      ok: thread.status === OK && listOf(thread.body).length === 1,
      step: "the thread reads back",
    });
  });

/** The whole walk across the board, one column at a time. */
export const lifecycleClaims = (input: {
  readonly caller: Caller;
  readonly projectId: string;
  readonly taskId: TaskId;
  readonly token: string;
}) =>
  Effect.gen(function* () {
    for (const to of LIFECYCLE) {
      const moved = yield* input.caller.call({
        body: { to },
        method: "POST",
        path: `/tasks/${input.taskId}/status`,
        token: input.token,
      });
      const landed = (moved.body as { status?: string }).status;
      yield* check({
        detail: `${moved.status}, now ${landed ?? "nowhere"}`,
        ok: moved.status === OK && landed === to,
        step: `the card moves to ${to}`,
      });
    }

    const detail = yield* input.caller.call({
      path: `/tasks/${input.taskId}`,
      token: input.token,
    });
    const view = detail.body as {
      project?: { id?: string };
      task?: { status?: string };
    };
    yield* check({
      detail: `project ${view.project?.id ?? "absent"}, status ${view.task?.status ?? "absent"}`,
      ok:
        detail.status === OK &&
        view.project?.id === input.projectId &&
        view.task?.status === "done",
      step: "the task reads back with its project and where it ended",
    });
  });

/** The queue the orchestrator reads, written over HTTP and read back. */
export const runSurfaceClaims = (input: {
  readonly caller: Caller;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly token: string;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    const runs = yield* input.caller.call({
      path: `/tasks/${input.taskId}/runs`,
      token: input.token,
    });
    yield* check({
      detail: `${runs.status}, ${listOf(runs.body).length} runs`,
      ok:
        runs.status === OK &&
        listOf(runs.body).some((run) => idOf(run) === input.runId),
      step: "a task's runs are listed",
    });

    const stop = yield* input.caller.call({
      body: {},
      method: "POST",
      path: `/tasks/${input.taskId}/commands/stop`,
      token: input.token,
    });
    const command = stop.body as { actorUserId?: string; status?: string };
    yield* check({
      detail: `${stop.status}, ${command.status ?? "no status"} by ${command.actorUserId ?? "nobody"}`,
      ok:
        stop.status === OK &&
        command.status === "pending" &&
        command.actorUserId === input.userId,
      step: "a run command is queued, pending, and names who asked",
    });

    const queued = yield* input.caller.call({
      path: `/tasks/${input.taskId}/commands`,
      token: input.token,
    });
    yield* check({
      detail: `${queued.status}, ${listOf(queued.body).length} intents`,
      ok: queued.status === OK && listOf(queued.body).length === 1,
      step: "the intent reads back off the queue",
    });
  });

/**
 * A conversation with the manager, opened and spoken to over HTTP.
 *
 * This is the claim that the dashboard reaches what Telegram reaches. The
 * thread has no chat behind it, the message is stored exactly as one typed into
 * the bot is, and the insert is the dispatch source — so an answer, when a loop
 * is running, comes from the same turn a chat message would have started.
 * Nothing here waits for one: this check has no loop.
 *
 * The thread is archived at the end rather than deleted. There is no delete: an
 * audit row naming the conversation that asked for a board write has to keep
 * pointing at something.
 */
const openedThreadClaims = (input: {
  readonly caller: Caller;
  readonly token: string;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    const opened = yield* input.caller.call({
      body: { title: "gateway-check conversation" },
      method: "POST",
      path: "/threads",
      token: input.token,
    });
    const thread = opened.body as {
      chatId?: number | null;
      provider?: string;
      status?: string;
      userId?: string;
    };
    const threadId = idOf(opened.body);
    yield* check({
      detail: `${opened.status} ${threadId || "no id"}, ${thread.provider ?? "no provider"}, chat ${thread.chatId ?? "none"}`,
      ok:
        opened.status === OK &&
        threadId !== "" &&
        thread.status === "active" &&
        thread.userId === input.userId &&
        (thread.chatId ?? null) === null,
      step: "a conversation is opened over HTTP, belonging to no Telegram chat",
    });

    const said = yield* input.caller.call({
      body: { body: "asked over HTTP" },
      method: "POST",
      path: `/threads/${threadId}/messages`,
      token: input.token,
    });
    const posted = said.body as {
      message?: { body?: string; intakeKind?: string; role?: string };
      queued?: boolean;
    };
    yield* check({
      detail: `${said.status}, ${posted.message?.role ?? "no role"} by ${posted.message?.intakeKind ?? "no intake"}, queued ${String(posted.queued)}`,
      ok:
        said.status === OK &&
        posted.message?.role === "user" &&
        posted.message.intakeKind === "api" &&
        posted.queued === false,
      step: "a message posted over HTTP is stored as a user message that starts a turn",
    });

    const read = yield* input.caller.call({
      path: `/threads/${threadId}`,
      token: input.token,
    });
    const detail = read.body as {
      liveRunId?: string | null;
      thread?: { id?: string; title?: string | null };
    };
    yield* check({
      detail: `${read.status}, ${detail.thread?.id ?? "no thread"}, live run ${detail.liveRunId ?? "none"}`,
      ok:
        read.status === OK &&
        detail.thread?.id === threadId &&
        (detail.liveRunId ?? null) === null,
      step: "the conversation reads back by id, with no turn running on it",
    });

    const history = yield* input.caller.call({
      path: `/threads/${threadId}/messages`,
      token: input.token,
    });
    const page = history.body as {
      messages?: { body?: string }[];
      nextOffset?: number | null;
    };
    yield* check({
      detail: `${history.status}, ${page.messages?.length ?? 0} said, next ${page.nextOffset ?? "nothing"}`,
      ok:
        history.status === OK &&
        page.messages?.length === 1 &&
        page.messages[0]?.body === "asked over HTTP" &&
        (page.nextOffset ?? null) === null,
      step: "what was said reads back as a page of the conversation",
    });

    const listed = yield* input.caller.call({
      path: "/threads",
      token: input.token,
    });
    const threads = listOf(listed.body) as { id?: string }[];
    yield* check({
      detail: `${listed.status}, ${threads.length} conversations`,
      ok: listed.status === OK && threads.some((each) => each.id === threadId),
      step: "the conversation is in the workspace's list, which belongs to no chat",
    });

    return threadId;
  });

/** The turns behind a conversation, and the two ways it is steered. */
const answeredThreadClaims = (input: {
  readonly caller: Caller;
  readonly threadId: string;
  readonly token: string;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    const { threadId } = input;

    const turns = yield* input.caller.call({
      path: `/threads/${threadId}/runs`,
      token: input.token,
    });
    yield* check({
      detail: `${turns.status}, ${listOf(turns.body).length} turns`,
      ok: turns.status === OK && listOf(turns.body).length === 0,
      step: "the conversation's turns are listed, and there are none without a loop",
    });

    const stopped = yield* input.caller.call({
      body: {},
      method: "POST",
      path: `/threads/${threadId}/stop`,
      token: input.token,
    });
    const intent = stopped.body as {
      actorUserId?: string;
      payload?: { kind?: string };
      status?: string;
      taskId?: string | null;
      threadId?: string | null;
    };
    yield* check({
      detail: `${stopped.status}, ${intent.payload?.kind ?? "no kind"} on thread ${intent.threadId ?? "none"} / task ${intent.taskId ?? "none"}`,
      ok:
        stopped.status === OK &&
        intent.payload?.kind === "stop" &&
        intent.status === "pending" &&
        intent.threadId === threadId &&
        (intent.taskId ?? null) === null &&
        intent.actorUserId === input.userId,
      step: "a force send is a stop intent naming the thread, not a task",
    });

    const archived = yield* input.caller.call({
      body: { status: "archived" },
      method: "PATCH",
      path: `/threads/${threadId}`,
      token: input.token,
    });
    const retired = archived.body as { isCurrent?: boolean; status?: string };
    yield* check({
      detail: `${archived.status}, ${retired.status ?? "no status"}, current ${String(retired.isCurrent)}`,
      ok:
        archived.status === OK &&
        retired.status === "archived" &&
        retired.isCurrent === false,
      step: "archiving retires the conversation and drops its currency",
    });

    const active = yield* input.caller.call({
      path: "/threads",
      token: input.token,
    });
    const retiredOnes = yield* input.caller.call({
      path: "/threads?status=archived",
      token: input.token,
    });
    const idsOf = (body: unknown) =>
      (listOf(body) as { id?: string }[]).map((each) => each.id);
    yield* check({
      detail: `${idsOf(active.body).length} active, ${idsOf(retiredOnes.body).length} archived`,
      ok:
        active.status === OK &&
        retiredOnes.status === OK &&
        !idsOf(active.body).includes(threadId) &&
        idsOf(retiredOnes.body).includes(threadId),
      step: "a retired conversation leaves the list until it is asked for by name",
    });
  });

/** The whole of the conversation surface, opened and then answered. */
export const threadClaims = (input: {
  readonly caller: Caller;
  readonly token: string;
  readonly userId: string;
}) =>
  Effect.gen(function* () {
    const threadId = yield* openedThreadClaims(input);
    yield* answeredThreadClaims({ ...input, threadId });
  });

/** How much of a body is repeated back when the claim about it fails. */
const DETAIL_CHARS = 48;

/** What the upload wrote, and the bytes the read gave back. */
const ARTIFACT_BODY = "gateway-check wrote this\n";
const ARTIFACT_PATH = "notes/check.md";

/** A file into the task's folder, out of the index, and back down the wire. */
export const artifactClaims = (input: {
  readonly caller: Caller;
  readonly taskId: TaskId;
  readonly token: string;
}) =>
  Effect.gen(function* () {
    const form = new FormData();
    form.set("path", ARTIFACT_PATH);
    form.set("file", new Blob([ARTIFACT_BODY]), "check.md");

    const uploaded = yield* input.caller.call({
      form,
      method: "POST",
      path: `/tasks/${input.taskId}/artifacts`,
      token: input.token,
    });
    const written = uploaded.body as { id?: string; path?: string };
    yield* check({
      detail: `${uploaded.status}, indexed as ${written.path ?? "nothing"}`,
      ok: uploaded.status === OK && written.path === ARTIFACT_PATH,
      step: "an upload lands in the task's folder and in the index",
    });

    const listed = yield* input.caller.call({
      path: `/tasks/${input.taskId}/artifacts`,
      token: input.token,
    });
    yield* check({
      detail: `${listed.status}, ${listOf(listed.body).length} files`,
      ok:
        listed.status === OK &&
        listOf(listed.body).some((found) => idOf(found) === written.id),
      step: "the index lists the file that was just written",
    });

    const content = yield* input.caller.call({
      path: `/tasks/${input.taskId}/artifacts/${written.id}/content`,
      token: input.token,
    });
    yield* check({
      detail: `${content.status}, ${JSON.stringify(content.body).slice(0, DETAIL_CHARS)}`,
      ok: content.status === OK && String(content.body) === ARTIFACT_BODY,
      step: "the bytes come back off disk",
    });
  });

/**
 * A run's token writes on its own task and nowhere else.
 *
 * The last three claims are what the worker's tool listing is filtered on. A
 * tool the board refuses on every call a worker could write is a schema in
 * every worker's prompt bought with a `403`, so `agentToolsFor` in
 * `@workspace/agent-tools` leaves those three out — and it derives which ones
 * from the endpoint each declares rather than being told. These are the
 * refusals that derivation claims exist, made here against a real token so the
 * filter rests on the gateway's behaviour and not on a reading of it.
 */
export const bindingClaims = (input: {
  readonly caller: Caller;
  readonly otherTaskId: TaskId;
  readonly projectId: string;
  readonly taskId: TaskId;
  readonly workerToken: string;
}) =>
  Effect.gen(function* () {
    const own = yield* input.caller.call({
      body: { body: "reported from inside the run" },
      method: "POST",
      path: `/tasks/${input.taskId}/messages`,
      token: input.workerToken,
    });
    yield* check({
      detail: `${own.status} on its own task`,
      ok: own.status === OK,
      step: "a run's token writes on the task it was dispatched for",
    });

    const other = yield* input.caller.call({
      body: { body: "should never land" },
      method: "POST",
      path: `/tasks/${input.otherTaskId}/messages`,
      token: input.workerToken,
    });
    yield* check({
      detail: `${other.status} ${failureOf(other.body).reason ?? "no reason"}`,
      ok:
        other.status === FORBIDDEN &&
        failureOf(other.body).reason === "task_not_owned",
      step: "the same token is refused on somebody else's task",
    });

    const read = yield* input.caller.call({
      path: `/tasks/${input.otherTaskId}`,
      token: input.workerToken,
    });
    yield* check({
      detail: `${read.status} reading the neighbouring task`,
      ok: read.status === OK,
      step: "and still reads the rest of the board",
    });

    const filed = yield* input.caller.call({
      body: { projectId: input.projectId, title: "should never be filed" },
      method: "POST",
      path: "/tasks",
      token: input.workerToken,
    });
    yield* check({
      detail: `${filed.status} ${failureOf(filed.body).reason ?? "no reason"}`,
      ok:
        filed.status === FORBIDDEN &&
        failureOf(filed.body).reason === "unscoped_route",
      step: "a run's token cannot file a task, because a new task is nobody's task",
    });

    const project = yield* input.caller.call({
      body: { name: "should never be filed" },
      method: "POST",
      path: "/projects",
      token: input.workerToken,
    });
    yield* check({
      detail: `${project.status} ${failureOf(project.body).reason ?? "no reason"}`,
      ok:
        project.status === FORBIDDEN &&
        failureOf(project.body).reason === "unscoped_route",
      step: "nor a project, for the same reason",
    });

    // Its own task on purpose: the binding would refuse any other one first,
    // and what is being claimed is the refusal that comes *after* the binding.
    const erased = yield* input.caller.call({
      method: "DELETE",
      path: `/tasks/${input.taskId}`,
      token: input.workerToken,
    });
    yield* check({
      detail: `${erased.status} ${failureOf(erased.body)._tag ?? "no tag"}`,
      ok:
        erased.status === FORBIDDEN &&
        failureOf(erased.body)._tag === "IllegalDeletion",
      step: "and cannot erase the task it was dispatched for, though it may write to it",
    });

    return other.traceId;
  });

/** The live tail, and what it said before the reader hung up. */
export const streamClaims = (input: {
  readonly caller: Caller;
  readonly holdMs: number;
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly token: string;
}) =>
  Effect.gen(function* () {
    const held = yield* input.caller.stream({
      path: `/tasks/${input.taskId}/runs/${input.runId}/events/stream`,
      timeoutMs: input.holdMs,
      token: input.token,
    });
    yield* check({
      detail: `${held.status} ${held.contentType ?? "no content type"}, first frame ${held.first === null ? "never came" : "arrived"}`,
      ok:
        held.status === OK &&
        (held.contentType ?? "").startsWith("text/event-stream") &&
        (held.first ?? "").includes('"kind":"started"'),
      step: "a run's timeline streams as server-sent events",
    });
    return held.traceId;
  });

/** Deletes what this check filed. Everything hanging off the tasks cascades. */
export const cleanUp = (input: {
  readonly caller: Caller;
  readonly projectId: string;
  readonly taskIds: readonly TaskId[];
  readonly token: string;
}) =>
  Effect.gen(function* () {
    for (const taskId of input.taskIds) {
      yield* input.caller.call({
        method: "DELETE",
        path: `/tasks/${taskId}`,
        token: input.token,
      });
    }
    const removed = yield* input.caller.call({
      method: "DELETE",
      path: `/projects/${input.projectId}`,
      token: input.token,
    });
    yield* check({
      detail: `the project's delete answered ${removed.status}`,
      ok: removed.status === NO_CONTENT,
      step: "an admin token reaches the destructive end",
    });
  });

/**
 * How much shorter than the intended hold the server's own measurement is
 * allowed to be. The reader starts its clock before it opens the connection and
 * the server starts its when the request lands, so the row can only ever report
 * less than was asked for — by the connection setup, which is a millisecond on
 * a loopback and more on a loaded machine. Demanding the full hold makes the
 * claim fail on arithmetic rather than on behaviour.
 */
const STREAM_SETUP_SLACK_MS = 250;

/** What the ledger says about the requests that were just made. */
export const ledgerClaims = (input: {
  readonly caller: Caller;
  readonly holdMs: number;
  readonly ledger: string;
  readonly refused: readonly string[];
  readonly streamed: string;
  readonly taskId: TaskId;
}) =>
  Effect.gen(function* () {
    const rows = requestRows(input.ledger);
    const forTrace = (traceId: string) =>
      rows.filter((row: RequestRow) => row.traceId === traceId);

    const wrong = input.caller.traceIds.filter(
      (traceId) => forTrace(traceId).length !== 1
    );
    yield* check({
      detail: `${wrong.length} of ${input.caller.traceIds.length} requests left ${wrong.map((traceId) => forTrace(traceId).length).join(", ") || "the right number of"} rows`,
      ok: wrong.length === 0,
      step: "every request left exactly one atm.request row",
    });

    yield* check({
      detail: `${rows.length} rows for ${input.caller.traceIds.length} requests`,
      ok: rows.length === input.caller.traceIds.length,
      step: "and the ledger holds no rows nobody asked for",
    });

    yield* check({
      detail: "a row carried a trace this check never sent",
      ok: rows.every((row) =>
        input.caller.traceIds.includes(row.traceId ?? "")
      ),
      step: "the trace on every row is the caller's, taken off traceparent",
    });

    const pathy = rows.filter((row) => row.route.includes(input.taskId));
    yield* check({
      detail: `${pathy.length} rows carry the task id in their route`,
      ok: pathy.length === 0,
      step: "the route on a row is the pattern, never the path",
    });

    const rejected = input.refused.flatMap(forTrace);
    yield* check({
      detail: `outcomes ${rejected.map((row) => row.outcome).join(", ") || "none"}, reasons ${rejected.map((row) => row.authReason).join(", ") || "none"}`,
      ok:
        rejected.length === input.refused.length &&
        rejected.every((row) => row.outcome === "rejected"),
      step: "a refused credential is a row, not a 401 that vanished",
    });

    const [stream] = forTrace(input.streamed);
    yield* check({
      detail: `sse ${stream?.sse}, held ${stream?.streamHeldMs}ms of an intended ${input.holdMs}ms, answered in ${stream?.durationMs}ms`,
      ok:
        stream?.sse === true &&
        (stream.streamHeldMs ?? 0) >= input.holdMs - STREAM_SETUP_SLACK_MS &&
        (stream.durationMs ?? input.holdMs) < (stream.streamHeldMs ?? 0),
      step: "the stream's row waited for the connection, not for the handler",
    });

    return rows;
  });
