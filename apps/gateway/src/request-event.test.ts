import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Telemetry } from "@workspace/telemetry";
import {
  ConfigProvider,
  Effect,
  Layer,
  Logger,
  type LogLevel,
  Metric,
  References,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { type AuthRecord, recordAuth } from "./auth/record";
import {
  pathIdentity,
  REQUEST_EVENT_MARKER,
  RequestEvent,
  requestEventLayer,
} from "./request-event";
import { pathShapeOf } from "./request-metrics";

const SERVICE = "gateway-test";
const COUNTER = "atm_requests_total";
const HISTOGRAM = "atm_request_duration_ms";
const GAUGE = "atm_sse_connections";

/** The route the thinning is exercised on, and the rate it is exercised at. */
const TASK_ROUTE = "/tasks/:taskId";
const ONE_IN = 20;

/** Requests the poll test makes: enough that a one-in-twenty turn comes round. */
const POLLED = 42;

/** A W3C trace id, as the row carries it: 32 lowercase hex characters. */
const TRACE_ID = /^[0-9a-f]{32}$/;

/** A W3C span id, which is half the width of a trace id. */
const SPAN_ID = /^[0-9a-f]{16}$/;

/** A trace context from an upstream caller, in the form the header carries it. */
const UPSTREAM_TRACE = "4f2b1c9d8e7a6b5c4d3e2f1a0b9c8d7e";
const UPSTREAM_TRACEPARENT = `00-${UPSTREAM_TRACE}-1a2b3c4d5e6f7a8b-01`;

/**
 * What the log annotation sinks receive. Open by nature: a logger is handed
 * whatever annotations the fiber carries, so this is `CurrentLogAnnotations`'
 * own type rather than a shape anything here declares.
 */
type Annotations = Record<string, unknown>;

/**
 * One `atm.request` row, decoded through the schema its readers use.
 *
 * `defineEvent` builds `encode` and `rowSchema` from one fields object, so a
 * renamed field moves both at once and is a compile error. The half that can
 * genuinely drift is what the emitter spells by hand — `ts`, the `event` tag
 * and the environment stamp — and that is what the decode holds.
 */
type Row = typeof RequestEvent.rowSchema.Type;

const decodeRow = Schema.decodeUnknownSync(RequestEvent.rowSchema);

/** Captures the wide event by its marker, and every log line for comparison. */
const captureLogger = (events: Annotations[], lines: Annotations[]) =>
  Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    lines.push({ ...annotations });
    if (annotations.event === REQUEST_EVENT_MARKER) {
      events.push({ ...annotations });
    }
  });

interface Capture {
  readonly events: Annotations[];
  readonly lines: Annotations[];
}

/**
 * Keeping one row in one is the sampling predicate turned off, which is what
 * every assertion about the *content* of a row wants: the row's fields are the
 * subject, and a test that had to guess which request survived a thinning would
 * be testing the predicate by accident. `./request-sampling.test.ts` is where
 * the thinning is the subject.
 */
const KEEP_EVERY = 1;

const configLayer = (logDirectory: string, sampleOneIn: number) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      EVENT_LOG_DIR: logDirectory,
      GATEWAY_SAMPLE_ONE_IN: String(sampleOneIn),
      GIT_SHA: "abc1234",
      SERVICE_VERSION: "1.2.3",
    })
  );

const telemetryLayer = (
  logDirectory: string,
  sink: Capture,
  level: LogLevel.LogLevel,
  sampleOneIn: number
) => {
  const config = configLayer(logDirectory, sampleOneIn);
  return Layer.mergeAll(
    Telemetry.layer({ serviceName: SERVICE }).pipe(
      Layer.provide(Layer.mergeAll(BunFileSystem.layer, config))
    ),
    // Merged out as well as provided in, so the sampler the middleware builds
    // beside the emitter reads these values rather than the process environment.
    config,
    Logger.layer([captureLogger(sink.events, sink.lines)]),
    Layer.succeed(References.MinimumLogLevel, level)
  );
};

/** What a refused credential looks like when the access middleware files it. */
const REFUSAL = {
  actorKind: null,
  authBoundTaskId: null,
  authOutcome: "unauthorized",
  authReason: "no_credential",
  authRequired: "task-write",
  authScheme: "bearer",
  authScope: null,
  runId: null,
  sessionId: null,
  userId: null,
  workspaceId: null,
} as const satisfies AuthRecord;

const encoder = new TextEncoder();

/** Waits by the clock, which is the only way to prove a stream was held. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** A gate the test opens by hand, so a stream is held until it says otherwise. */
const newGate = () => {
  let release = () => {
    // replaced synchronously by the promise's executor
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

let gate = newGate();

/**
 * The routes under test: one of each shape the middleware has to describe — a
 * plain read, a task-scoped read carrying ids in its path, a held event stream,
 * a refused credential, and a handler that dies.
 */
const routesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const add = (
      path: HttpRouter.PathInput,
      route: Effect.Effect<HttpServerResponse.HttpServerResponse>
    ) => router.add("GET", path, route);

    yield* add("/health", Effect.succeed(HttpServerResponse.text("ok")));
    yield* add(
      "/tasks/:taskId",
      Effect.succeed(HttpServerResponse.text("task body"))
    );
    yield* add(
      "/tasks/:taskId/runs/:runId/events/stream",
      Effect.succeed(
        HttpServerResponse.stream(
          Stream.make(encoder.encode("data: one\n\n")).pipe(
            Stream.concat(
              Stream.fromEffect(Effect.promise(() => gate.promise)).pipe(
                Stream.flatMap(() =>
                  Stream.make(encoder.encode("data: two\n\n"))
                )
              )
            )
          ),
          { contentType: "text/event-stream" }
        )
      )
    );
    yield* add(
      "/guarded",
      Effect.as(
        recordAuth(REFUSAL),
        HttpServerResponse.text("unauthorized", { status: 401 })
      )
    );
    yield* add("/boom", Effect.die(new Error("handler exploded")));
  })
);

let directory: string;
let capture: Capture;
let web: ReturnType<typeof buildHandler>;

const buildHandler = (
  level: LogLevel.LogLevel,
  sampleOneIn: number = KEEP_EVERY
) =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(routesLayer, requestEventLayer).pipe(
      // Merged rather than provided: the capture logger is a reference on the
      // built context, and a plain `provide` keeps it out of the one the
      // request fibers run on — where the row is annotated.
      Layer.provideMerge(telemetryLayer(directory, capture, level, sampleOneIn))
    )
  );

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "request-event-"));
  capture = { events: [], lines: [] };
  gate = newGate();
  web = buildHandler("Info");
});

afterEach(async () => {
  gate.release();
  await web.dispose();
  rmSync(directory, { force: true, recursive: true });
});

/**
 * The ledger as bytes, and empty until the first row lands.
 *
 * Every "this never reached a row" assertion is made against this rather than
 * against a decoded row, for two reasons that both make the decoded reading
 * worthless as evidence: `SanitizedText` runs `clipError` on the way in as well
 * as out, so the reader redacts the very value it would then swear is clean,
 * and a key the schema does not declare is dropped rather than reported.
 */
const ledgerText = () => {
  try {
    return readFileSync(join(directory, `${SERVICE}.jsonl`), "utf-8");
  } catch {
    return "";
  }
};

/** One ledger line, or null where the line is not JSON at all. */
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Whether a parsed line is a request row, read off the parsed `event` field. A
 * substring test over the line would also match the marker inside a field
 * value — a route, an error message — and hand a foreign row to the decoder,
 * failing the test for the wrong reason.
 */
const isRequestRow = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "event" in value &&
  value.event === REQUEST_EVENT_MARKER;

const readRows = (): readonly Row[] =>
  ledgerText()
    .split("\n")
    .map(jsonOf)
    .filter(isRequestRow)
    .map((row) => decodeRow(row));

/**
 * How long a row is waited for before the ledger is read one last time and the
 * assertion speaks for itself.
 *
 * Generous on purpose. The wait costs nothing on the happy path, since it
 * returns the moment the row lands, and the whole suite runs beside thirteen
 * others under one task runner — a budget tight enough to expire under that
 * load turns a passing property into a test that fails on a busy machine and
 * passes when run alone, which is worse than a slow test.
 */
const ROW_DEADLINE_MS = 10_000;

/** How often the ledger is asked whether the finalizer has written yet. */
const ROW_POLL_MS = 5;

/**
 * The ledger, once it holds `count` rows. The row is written from a finalizer
 * on the request's scope, which the platform closes after the response has been
 * handed back — so the assertion has to wait for it rather than assume it.
 */
const waitForRows = async (count: number) => {
  const deadline = Date.now() + ROW_DEADLINE_MS;
  while (Date.now() < deadline) {
    const rows = readRows();
    if (rows.length >= count) {
      return rows;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling the file is the point
    await sleep(ROW_POLL_MS);
  }
  return readRows();
};

/**
 * The annotation sinks, once they have seen `count` events.
 *
 * The emitter writes the ledger first and logs the annotated line second, so a
 * row on disk does not yet mean the logger has been called. Waiting on the file
 * alone and then reading the capture is a race the assertion loses on a busy
 * machine and wins on an idle one.
 */
const waitForCapture = async (count: number) => {
  const deadline = Date.now() + ROW_DEADLINE_MS;
  while (capture.events.length < count && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling the sink is the point
    await sleep(ROW_POLL_MS);
  }
};

/** The single row a request just wrote. Fails loudly when the count is not one. */
const onlyRow = async () => {
  const rows = await waitForRows(1);
  await waitForCapture(rows.length);
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`expected exactly one row, found ${rows.length}`);
  }
  return row;
};

const get = (path: string, headers: Record<string, string> = {}) =>
  web.handler(new Request(`http://gateway.test${path}`, { headers }));

describe("the atm.request row", () => {
  test("a finished request leaves exactly one row, keyed by route pattern", async () => {
    const response = await get("/tasks/task-42?fields=all");

    expect(response.status).toBe(200);
    const row = await onlyRow();
    expect(capture.events).toHaveLength(1);
    expect(row.event).toBe(REQUEST_EVENT_MARKER);
    expect(row.phase).toBe("end");
    expect(row.outcome).toBe("done");
    // the pattern, never the path — and never the query string either
    expect(row.route).toBe("/tasks/:taskId");
    expect(ledgerText()).not.toContain("fields=all");
    expect(row.method).toBe("GET");
    expect(row.status).toBe(200);
    // the id the route named, lifted so no handler has to record it
    expect(row.taskId).toBe("task-42");
    expect(row.bytesOut).toBe("task body".length);
    expect(row.sse).toBe(false);
    expect(row.streamHeldMs).toBeNull();
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    expect(row.traceId).toMatch(TRACE_ID);
    expect(row.errorClass).toBeNull();
    // no credential was checked on this route, so the verdict fields are absent
    expect(row.authOutcome).toBeNull();
    expect(row.workspaceId).toBeNull();
  });

  test("the caller's traceparent is the trace the row joins", async () => {
    await get("/health", { traceparent: UPSTREAM_TRACEPARENT });

    const row = await onlyRow();
    expect(row.traceId).toBe(UPSTREAM_TRACE);
    expect(row.spanId).toMatch(SPAN_ID);
    // and a request without one still gets a trace, minted here
    expect(row.spanId).not.toBe("1a2b3c4d5e6f7a8b");
  });

  test("a path that matched nothing is one value, not the path", async () => {
    const response = await get("/nope/7f3a9c2e1b4d8a6f");

    expect(response.status).toBe(404);
    const row = await onlyRow();
    expect(row.route).toBe("unmatched");
    expect(row.status).toBe(404);
    // a status the gateway chose is the API answering, not a fault of its own
    expect(row.outcome).toBe("done");
    expect(row.errorClass).toBe("RouteNotFound");
    // the platform's message for this failure is the request line: the class
    // says everything it would, and the path never reaches a durable sink
    expect(row.errorMessage).toBeNull();
    // what the suppressed message was wanted for, bounded: this one got nowhere
    expect(row.pathShape).toBe("/*");
    expect(ledgerText()).not.toContain("7f3a9c2e1b4d8a6f");
  });

  test("a 404 on a real endpoint is a different shape from a probe", async () => {
    // the contract declares /tasks/:taskId/messages; this router does not mount
    // it, so the request 404s exactly as a wrong method on it would
    await get("/tasks/019a4c48-1f0f-7000-8000-000000000001/messages");

    const row = await onlyRow();
    expect(row.route).toBe("unmatched");
    expect(row.pathShape).toBe("/tasks/:taskId/messages");
    // the id it asked for is still identity, not shape
    expect(JSON.stringify({ pathShape: row.pathShape })).not.toContain("019a");
  });

  test("a matched route leaves no shape, since the pattern already says it", async () => {
    await get("/tasks/task-42");

    const row = await onlyRow();
    expect(row.route).toBe("/tasks/:taskId");
    expect(row.pathShape).toBeNull();
  });

  test("a defect is a 500 and an errored row, with its text sanitized", async () => {
    const response = await get("/boom");

    expect(response.status).toBe(500);
    const row = await onlyRow();
    expect(row.outcome).toBe("errored");
    expect(row.status).toBe(500);
    expect(row.errorMessage).toContain("handler exploded");
  });

  test("a refused credential leaves a row, and its economics stay null", async () => {
    const response = await get("/guarded", {
      authorization: "Bearer sk-not-a-real-token",
    });

    expect(response.status).toBe(401);
    const row = await onlyRow();
    // the refusal is this request's outcome, not a second event about it
    expect(row.outcome).toBe("rejected");
    expect(row.authOutcome).toBe("unauthorized");
    expect(row.authReason).toBe("no_credential");
    expect(row.authRequired).toBe("task-write");
    expect(row.authScheme).toBe("bearer");
    expect(row.authScope).toBeNull();
    expect(row.actorKind).toBeNull();
    // a degraded outcome produced no economics, and never a fabricated 0
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    expect(row.turns).toBeNull();
    expect(row.queueWaitMs).toBeNull();
    // the credential itself never reaches a sink
    expect(ledgerText()).not.toContain("sk-not-a-real-token");
  });

  test("an event stream leaves one row, written when the stream ends", async () => {
    const response = await get("/tasks/task-9/runs/run-3/events/stream");

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // the response is out, the connection is held: no row yet
    expect(readRows()).toHaveLength(0);
    const drained = response.text();
    await sleep(30);
    expect(readRows()).toHaveLength(0);

    gate.release();
    const body = await drained;
    const row = await onlyRow();

    expect(body).toContain("data: two");
    expect(row.sse).toBe(true);
    expect(row.outcome).toBe("done");
    expect(row.route).toBe("/tasks/:taskId/runs/:runId/events/stream");
    // both ids the route named, so the row joins the run it was following
    expect(row.taskId).toBe("task-9");
    expect(row.runId).toBe("run-3");
    // how long it held, measured from the response rather than from the request
    expect(row.streamHeldMs).toBeGreaterThanOrEqual(30);
    expect(row.durationMs).toBeLessThan(row.streamHeldMs ?? 0);
    // counted as it went out, since a stream has no content length to read
    expect(row.bytesOut).toBe(body.length);
  });

  test("a client that hangs up mid-stream still leaves its row", async () => {
    const response = await get("/tasks/task-7/runs/run-7/events/stream");
    const reader = response.body?.getReader();
    await reader?.read();

    // the browser tab went away: the stream is cancelled, never completed
    await reader?.cancel();

    const row = await onlyRow();
    expect(row.outcome).toBe("interrupted");
    expect(row.sse).toBe(true);
    // it really did hold, and it really did send what it sent
    expect(row.streamHeldMs).toBeGreaterThanOrEqual(0);
    expect(row.bytesOut).toBe("data: one\n\n".length);
  });

  test("a poll is thinned, and every row kept says what it stands for", async () => {
    await web.dispose();
    web = buildHandler("Info", ONE_IN);
    const before = await countedOn(TASK_ROUTE);

    // one dashboard card, polled for three and a half minutes
    for (let index = 0; index < POLLED; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: the turn is sequential
      await get(`/tasks/task-${index}`);
    }
    // the counter, which sits above the predicate, saw all of them — and it is
    // moved by the same finalizer that writes the row, so waiting on it is how
    // the ledger below is read after the last request has finished closing
    expect((await waitForCount(TASK_ROUTE, before + POLLED)) - before).toBe(
      POLLED
    );
    await waitForRows(2);

    const rows = readRows();
    // the ledger holds a fraction of them, and every one of those carries the
    // number of requests it stands for
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThan(POLLED / 2);
    for (const row of rows) {
      expect(typeof row.sampleRate).toBe("number");
      expect(row.sampleRate).toBeGreaterThanOrEqual(1);
    }
  });

  test("the row survives a Warn floor that silences ordinary log lines", async () => {
    await web.dispose();
    web = buildHandler("Warn");

    await get("/health");

    await waitForRows(1);
    await waitForCapture(1);
    expect(capture.events).toHaveLength(1);
    expect(readRows()).toHaveLength(1);
  });
});

/** Every series of one metric after the work, with its attribute keys. */
const seriesOf = (id: string) =>
  Effect.runPromise(
    Effect.map(Metric.snapshot, (snapshot) =>
      snapshot.filter((metric) => metric.id === id)
    )
  );

/**
 * Requests the counter has recorded on one route, across every method and
 * status class. Read as a delta by its caller: `Metric` is process-wide and
 * every test in this file has already moved it.
 */
const countedOn = async (route: string) =>
  (await seriesOf(COUNTER))
    .filter((metric) => metric.attributes?.route === route)
    .reduce(
      (total, metric) => total + (metric.state as { count: number }).count,
      0
    );

/** That counter, once it has reached `target` or the deadline has passed. */
const waitForCount = async (route: string, target: number) => {
  const deadline = Date.now() + ROW_DEADLINE_MS;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling the metric is the point
    const counted = await countedOn(route);
    if (counted >= target) {
      return counted;
    }
    await sleep(ROW_POLL_MS);
  }
  return countedOn(route);
};

const attributeKeys = async (id: string) => {
  const series = await seriesOf(id);
  expect(series.length).toBeGreaterThan(0);
  return series.map((metric) => Object.keys(metric.attributes ?? {}).sort());
};

/** The stream route's own gauge series, which the test asserts the level of. */
const gaugeFor = (series: Awaited<ReturnType<typeof seriesOf>>) => {
  const found = series.find(
    (metric) =>
      metric.attributes?.route === "/tasks/:taskId/runs/:runId/events/stream"
  );
  if (found === undefined) {
    throw new Error("the stream route left no gauge series");
  }
  return {
    attributes: found.attributes,
    state: found.state as { value: number },
  };
};

describe("the gateway metrics", () => {
  test("atm_requests_total is tagged by route, method and status class", async () => {
    await get("/tasks/task-1");
    await waitForRows(1);

    for (const keys of await attributeKeys(COUNTER)) {
      // pins the tag boundary: an unbounded tag added later fails here
      expect(keys).toEqual(["method", "route", "statusClass"]);
    }
    const series = await seriesOf(COUNTER);
    expect(
      series.some((metric) => metric.attributes?.route === "/tasks/:taskId")
    ).toBe(true);
  });

  test("atm_request_duration_ms is tagged by route and method only", async () => {
    await get("/health");
    await waitForRows(1);

    for (const keys of await attributeKeys(HISTOGRAM)) {
      expect(keys).toEqual(["method", "route"]);
    }
    // `/health` is not in the contract, so it shares the one spare bucket
    const series = await seriesOf(HISTOGRAM);
    expect(series.some((metric) => metric.attributes?.route === "other")).toBe(
      true
    );
  });

  test("atm_sse_connections rises while a stream is held and falls after", async () => {
    const response = await get("/tasks/task-2/runs/run-2/events/stream");
    const drained = response.text();
    await sleep(20);

    const open = gaugeFor(await seriesOf(GAUGE));
    expect(Object.keys(open.attributes ?? {})).toEqual(["route"]);
    expect(open.state.value).toBe(1);

    gate.release();
    await drained;
    await waitForRows(1);
    expect(gaugeFor(await seriesOf(GAUGE)).state.value).toBe(0);
  });
});

describe("pathShapeOf", () => {
  test("describes a path only as far as the contract can, then stops", () => {
    // a probe gets nowhere at all, however many segments it has
    expect(pathShapeOf("/wp-admin/setup.php")).toBe("/*");
    expect(pathShapeOf("/.env")).toBe("/*");
    // a real endpoint asked for the wrong way keeps its whole pattern
    expect(pathShapeOf("/tasks/t1/runs/r1/events/stream")).toBe(
      "/tasks/:taskId/runs/:runId/events/stream"
    );
    // a near miss says where it went wrong, and the rest is one mark
    expect(pathShapeOf("/tasks/t1/comment")).toBe("/tasks/:taskId/*");
    expect(pathShapeOf("/tasks/t1/runs/r1/events/stream/more")).toBe(
      "/tasks/:taskId/runs/:runId/events/stream/*"
    );
    // a literal the contract declares beats the parameter at the same level
    expect(pathShapeOf("/tasks/board")).toBe("/tasks/board");
    expect(pathShapeOf("/")).toBe("/");
    // nothing a caller wrote survives, including a segment shaped like a pattern
    expect(pathShapeOf("/tasks/sk-live-abc123/:taskId")).toBe(
      "/tasks/:taskId/*"
    );
  });
});

describe("pathIdentity", () => {
  test("lifts only the ids a route names, and clips what it lifts", () => {
    expect(
      pathIdentity("/tasks/:taskId/runs/:runId", "/tasks/a/runs/b")
    ).toEqual({ runId: "b", taskId: "a" });
    // a parameter that is not identity stays off the row
    expect(pathIdentity("/projects/:projectId", "/projects/p1")).toEqual({});
    // a pattern that does not describe the path yields nothing rather than a guess
    expect(pathIdentity("/tasks/:taskId", "/tasks/a/runs/b")).toEqual({});
    expect(
      pathIdentity("/tasks/:taskId", `/tasks/${"x".repeat(400)}`).taskId
    ).toHaveLength(240);
  });
});
