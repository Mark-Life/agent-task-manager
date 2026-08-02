/**
 * How `gateway:check` talks to a gateway and reads back what it wrote.
 *
 * Both halves are here because they are two ends of one claim. Every call mints
 * its own W3C `traceparent` and remembers it; every row in the ledger carries
 * the trace the request arrived under. So "this request left exactly one
 * `atm.request` row" is a lookup rather than a guess about ordering, and
 * "the gateway adopted the caller's trace" falls out of the same mechanism.
 *
 * **The gateway runs as a child process, and the ledger is read off disk.**
 * Serving in-process would prove the layers compose and nothing about the thing
 * an operator starts: the composition root, the port binding, the signal
 * handling and the flush on the way out are all properties of a process. So the
 * check starts `apps/gateway/src/main.ts` exactly as `bun run` would, drives it
 * over a socket, stops it with `SIGTERM`, and only then reads the file it left
 * behind — which is also the only way the last rows are certain to be flushed.
 *
 * **The event schema and the token format are imported from the gateway's own
 * source**, by path, because that is where they live and a second spelling of
 * either is a check that passes while the thing it checks has moved. The same
 * reason `loop-check` reads `RunEvent` out of `@workspace/orchestrator`.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { Effect, Schema } from "effect";
import {
  REQUEST_EVENT_MARKER,
  RequestEvent,
} from "../apps/gateway/src/request-event";

/**
 * One thing the gateway was supposed to do and did not.
 *
 * The two fields are rendered into `message` because this is what a failing
 * check exits on: the runner prints the error and nothing else, and a tag with
 * a line number does not say which claim broke or what was found instead.
 */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()(
  "GatewayCheck.Failed",
  { detail: Schema.String, step: Schema.String }
) {
  override get message() {
    return `${this.step} — ${this.detail}`;
  }
}

/** Asserts one claim, naming what was expected when it does not hold. */
export const check = (options: {
  readonly detail: string;
  readonly ok: boolean;
  readonly step: string;
}) =>
  options.ok
    ? Effect.logInfo(`ok    ${options.step}`)
    : Effect.fail(
        new CheckFailed({ detail: options.detail, step: options.step })
      );

/** One decoded `atm.request` row of the ledger the child gateway wrote. */
export type RequestRow = typeof RequestEvent.rowSchema.Type;

const decodeRow = Schema.decodeUnknownOption(RequestEvent.rowSchema);

/**
 * Every `atm.request` row in a ledger file, in the order they were appended.
 *
 * A line that is not JSON, or is another unit's, is skipped rather than failing
 * the read — the same tolerance `bun run logs` has, and for the same reason:
 * one bad line must not hide the rest of the ledger.
 */
export const requestRows = (path: string): RequestRow[] => {
  if (!existsSync(path)) {
    return [];
  }
  const rows: RequestRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0 || !line.includes(REQUEST_EVENT_MARKER)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const decoded = decodeRow(parsed);
    if (decoded._tag === "Some") {
      rows.push(decoded.value);
    }
  }
  return rows;
};

/** W3C trace context version and sampling flag, as the header spells them. */
const TRACEPARENT_VERSION = "00";
const TRACEPARENT_SAMPLED = "01";

/** Hex digits in a trace id and in a span id. */
const TRACE_ID_HEX = 32;
const SPAN_ID_HEX = 16;

/** Base and width of one byte rendered as hex. */
const HEX = 16;
const BYTE_VALUES = 256;
const HEX_DIGITS_PER_BYTE = 2;

/** A random lowercase hex string, which is what both halves of a trace id are. */
const randomHex = (digits: number) =>
  Array.from({ length: digits / HEX_DIGITS_PER_BYTE }, () =>
    Math.floor(Math.random() * BYTE_VALUES)
      .toString(HEX)
      .padStart(HEX_DIGITS_PER_BYTE, "0")
  ).join("");

/**
 * The socket refused, or hung up before a status. A typed failure rather than a
 * defect, because the boot probe below asks the question on purpose and a
 * connection nothing answered is not a request the gateway ever saw.
 */
export class CallFailed extends Schema.TaggedErrorClass<CallFailed>()(
  "GatewayCheck.CallFailed",
  { detail: Schema.String }
) {}

/** What one call did, plus the trace that finds its row. */
export interface Call {
  readonly body: unknown;
  readonly status: number;
  /** The id this call put on the wire, which the row must carry back. */
  readonly traceId: string;
}

/** What one call says. Everything but `path` is optional. */
export interface CallInput {
  readonly body?: unknown;
  /** A multipart body, for the artifact upload. Exclusive with `body`. */
  readonly form?: FormData;
  readonly method?: string;
  readonly path: string;
  /** Absent sends no `Authorization` header at all, which is its own claim. */
  readonly token?: string;
}

/** What an event stream said before the reader let go of it. */
export interface Streamed extends Call {
  /** The media type the server chose, which is what makes it a held connection. */
  readonly contentType: string | null;
  /** The first `data:` line, or null when nothing arrived in the time allowed. */
  readonly first: string | null;
}

/** Drives one gateway, remembering every trace it minted. */
export interface Caller {
  /** One request, with a fresh trace on it. */
  readonly call: (input: CallInput) => Effect.Effect<Call, CallFailed>;
  /** Where this caller points. */
  readonly origin: string;
  /**
   * Opens an event stream, reads until the first event or the deadline, then
   * hangs up. Hanging up is the point: a stream is the one response whose row
   * is written long after the handler returned, and only a closed connection
   * makes that row appear.
   */
  readonly stream: (input: {
    readonly path: string;
    readonly timeoutMs: number;
    readonly token: string;
  }) => Effect.Effect<Streamed, CallFailed>;
  /** Every request that reached the server, in order. Includes the health probes. */
  readonly traceIds: readonly string[];
}

const headersOf = (input: CallInput, traceparent: string) => {
  const headers: Record<string, string> = { traceparent };
  if (input.token !== undefined) {
    headers.authorization = `Bearer ${input.token}`;
  }
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return headers;
};

/**
 * Reads a response body as JSON where it is JSON and as text otherwise, so a
 * 501, an HTML page and a decoded entity are all things a claim can look at.
 */
const bodyOf = async (response: Response) => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** The prefix an SSE frame puts its payload behind. */
const SSE_DATA = "data:";

/** A caller pointed at one origin. */
export const makeCaller = (origin: string): Caller => {
  const traceIds: string[] = [];

  /** A fresh trace for one call, in the form the header carries it. */
  const nextTrace = () => {
    const traceId = randomHex(TRACE_ID_HEX);
    return {
      traceId,
      traceparent: [
        TRACEPARENT_VERSION,
        traceId,
        randomHex(SPAN_ID_HEX),
        TRACEPARENT_SAMPLED,
      ].join("-"),
    };
  };

  const call = (input: CallInput) =>
    Effect.tryPromise({
      catch: (cause) => new CallFailed({ detail: String(cause) }),
      try: async () => {
        const { traceId, traceparent } = nextTrace();
        const response = await fetch(`${origin}${input.path}`, {
          body:
            input.form ??
            (input.body === undefined ? undefined : JSON.stringify(input.body)),
          headers: headersOf(input, traceparent),
          method: input.method ?? "GET",
        });
        traceIds.push(traceId);
        return {
          body: await bodyOf(response),
          status: response.status,
          traceId,
        };
      },
    });

  const stream = (input: {
    readonly path: string;
    readonly timeoutMs: number;
    readonly token: string;
  }) =>
    Effect.tryPromise({
      catch: (cause) => new CallFailed({ detail: String(cause) }),
      try: async () => {
        const { traceId, traceparent } = nextTrace();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), input.timeoutMs);
        const response = await fetch(`${origin}${input.path}`, {
          headers: {
            authorization: `Bearer ${input.token}`,
            traceparent,
          },
          signal: abort.signal,
        });
        traceIds.push(traceId);

        let first: string | null = null;
        let body = "";
        try {
          const decoder = new TextDecoder();
          // Read to the deadline rather than to the first frame. The claim is
          // about the row a held connection leaves, and a reader that hangs up
          // the instant something arrives measures its own impatience.
          for await (const chunk of response.body ?? []) {
            body += decoder.decode(chunk as Uint8Array, { stream: true });
            const line = body
              .split("\n")
              .find((candidate) => candidate.startsWith(SSE_DATA));
            first =
              first ??
              (line === undefined ? null : line.slice(SSE_DATA.length).trim());
          }
        } catch {
          // An aborted read is the deadline, not a failure: a quiet run is a
          // stream that says nothing, and the claim is about the row it leaves.
        }
        // Hanging up is what closes the socket, and closing the socket is what
        // makes the row appear.
        abort.abort();
        clearTimeout(timer);

        return {
          body,
          contentType: response.headers.get("content-type"),
          first,
          status: response.status,
          traceId,
        };
      },
    });

  return {
    call,
    origin,
    stream,
    get traceIds() {
      return traceIds;
    },
  };
};

/** The gateway would not answer in the time it was given. */
export class NeverListened extends Schema.TaggedErrorClass<NeverListened>()(
  "GatewayCheck.NeverListened",
  { detail: Schema.String }
) {}

/** The status a gateway that is up answers its liveness probe with. */
const OK = 200;

/** How long the child gets to bind, connect to Postgres and answer. */
const BOOT_TIMEOUT_MS = 20_000;

/** How often the child is asked whether it is up yet. */
const BOOT_POLL_MS = 200;

/** How long the child gets to stop after `SIGTERM` before the check gives up. */
const STOP_TIMEOUT_MS = 20_000;

/** A gateway process the check owns. */
export interface Child {
  /** What it printed, for the failure that only the log explains. */
  readonly output: () => string;
  /** Signals it and waits. Answers the exit code, or null when it was signalled dead. */
  readonly stop: () => Effect.Effect<number | null>;
}

/**
 * Starts `apps/gateway/src/main.ts` and waits until it answers.
 *
 * The environment is passed rather than inherited-and-patched, so the child's
 * data root, ledger and port are the check's own and a real gateway's ledger is
 * never appended to. Health is polled through the caller, which means the
 * probes leave rows like anything else — and the row count below accounts for
 * them rather than pretending they did not happen.
 */
export const startGateway = (options: {
  readonly caller: Caller;
  readonly env: Readonly<Record<string, string>>;
  readonly repoRoot: string;
}) =>
  Effect.gen(function* () {
    const child = spawn(
      process.execPath,
      ["run", join(options.repoRoot, "apps", "gateway", "src", "main.ts")],
      {
        cwd: options.repoRoot,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const stop = () =>
      Effect.promise(
        () =>
          new Promise<number | null>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve(child.exitCode);
              return;
            }
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve(null);
            }, STOP_TIMEOUT_MS);
            child.once("exit", (code) => {
              clearTimeout(timer);
              resolve(code);
            });
            child.kill("SIGTERM");
          })
      );

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // A connection refused is not a request: the server was not there to see
      // it, so it leaves no row and must not be counted as one.
      const answered = yield* options.caller
        .call({ path: "/health" })
        .pipe(Effect.option);
      if (answered._tag === "Some" && answered.value.status === OK) {
        return { output: () => output, stop } satisfies Child;
      }
      yield* Effect.sleep(BOOT_POLL_MS);
    }

    yield* stop();
    return yield* Effect.fail(
      new NeverListened({
        detail: `no answer on ${options.caller.origin} in ${BOOT_TIMEOUT_MS}ms — ${output}`,
      })
    );
  });

/**
 * A port nothing is listening on, found by binding one and letting it go.
 *
 * There is a window between the release and the child's bind in which something
 * else could take it. Nothing else on a developer's box is racing for an
 * ephemeral port, and the alternative — a fixed port — collides with the
 * gateway the operator already has running, which is the failure that actually
 * happens.
 */
export const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port =
      typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});
