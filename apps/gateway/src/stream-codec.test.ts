/**
 * That an event this gateway streams can be read back off the wire.
 *
 * This is the failure it exists for, and it survived review, a typechecker and
 * a shipped release: `StreamSse` puts the event's *encoded* side inside a JSON
 * string, and a run event's encoded side carries `Date`, because `Timestamp` is
 * `DateTimeUtcFromDate`. JSON has no Date. So the server rendered the ISO
 * string `JSON.stringify` makes of one, every client asked its schema for a
 * `Date` object, and every frame failed with "Expected a valid Date" — a
 * transport that was declared, implemented, tested against its own database and
 * unusable by anything holding the contract. The dashboard polled instead.
 *
 * Nothing about that is visible in a type, and the buffered endpoints do not
 * have it, because a JSON body is encoded through `toCodecJson` by the response
 * codec on the way out. So the check is per streaming endpoint and it is a
 * round trip through the text in between: encode as the server encodes, render
 * the frame, parse it back, decode as a client decodes, and compare.
 *
 * Read off `Api` rather than restating the schema. A test that spelled the data
 * schema itself would pass while the endpoint carried the other one.
 *
 * It sits in the gateway rather than in `@workspace/api`, whose contract this
 * is, because a `Schema.decode*` call in that package segfaults the type
 * checker: `@effect/tsgo`'s `preferTypedSchemaDecoder` rule dereferences a nil
 * node while analysing one there. The bug is upstream and predates this file —
 * a two-line scratch module in `packages/api` reproduces it on a clean tree.
 * Here the round trip runs beside the server that writes the frames, which is
 * the next best place for it.
 */

import { describe, expect, test } from "bun:test";
import { Api, BoardColumn, RunEvent } from "@workspace/api";
import {
  newProjectId,
  newRunEventId,
  newRunId,
  newTaskId,
} from "@workspace/domain";
import { DateTime, Effect, Predicate, Schema } from "effect";
import { Sse } from "effect/unstable/encoding";
import type { HttpApiEndpoint } from "effect/unstable/httpapi";

/** The name the server writes on every application frame of an SSE response. */
const MESSAGE = "message";

/** A fixed instant, so a failure here is about the codec and not about a clock. */
const AT = new Date("2026-09-09T09:00:00.000Z");

/** The workspace every fixture below belongs to. Never read, only carried. */
const WORKSPACE = "ws-stream-codec-test";

/**
 * A streaming success as this file needs to read it: the event schema behind
 * it, decoding with nothing provided.
 *
 * Declared here rather than imported because the library marks its own
 * `isStreamSse` internal, so it does not reach the published types — and
 * because `StreamSse`'s event schema carries `unknown` decoding services, which
 * would make every round trip below ask for a context no test can hand it.
 */
interface SseSuccess {
  readonly _tag: "StreamSse";
  readonly events: Schema.Codec<unknown, unknown, never, never>;
}

const isSse = (schema: Schema.Top): schema is Schema.Top & SseSuccess =>
  Predicate.hasProperty(schema, "_tag") && schema._tag === "StreamSse";

/**
 * The event schema the transport uses for one streaming endpoint, taken off the
 * contract itself.
 *
 * An endpoint's success is a set of schemas and at most one of them is a
 * stream, so this both finds it and asserts there is one — an endpoint that
 * stopped streaming would fail here rather than pass by testing nothing.
 */
const eventsOf = (endpoint: HttpApiEndpoint.Top) => {
  for (const schema of endpoint.success) {
    if (isSse(schema)) {
      return schema.events;
    }
  }
  throw new Error(`${endpoint.name} does not stream`);
};

/** The text an SSE frame is, and back into the shape a parser reports. */
const parseFrame = (text: string) => {
  const seen: Sse.AnyEvent[] = [];
  const parser = Sse.makeParser((event) => seen.push(event));
  parser.feed(text);
  const [first] = seen;
  if (first === undefined || first._tag !== "Event") {
    throw new Error(`no event parsed out of: ${JSON.stringify(text)}`);
  }
  return { data: first.data, event: first.event, id: first.id };
};

/**
 * One value through the whole transport and back: encoded as the server encodes
 * it, rendered as the wire renders it, parsed as a client parses it, decoded as
 * a client decodes it.
 *
 * The text in the middle is what makes this worth writing. Encoding and
 * decoding one object with one schema proves nothing about a transport whose
 * middle is JSON — that middle is where a `Date` stops being a `Date`, and it
 * is the only place this can go wrong.
 */
const roundTrip = (
  events: Schema.Codec<unknown, unknown, never, never>,
  value: unknown
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const frame = (yield* Schema.encodeUnknownEffect(events)({
        data: value,
        event: MESSAGE,
        id: undefined,
      })) as Omit<Sse.Event, "_tag">;
      const text = Sse.encoder.write({ ...frame, _tag: "Event" });
      // Bound rather than passed inline: `@effect/tsgo`'s
      // `preferTypedSchemaDecoder` segfaults the type checker when a decoder
      // built from a schema it cannot resolve is applied to a call expression.
      const parsed = parseFrame(text);
      return yield* Schema.decodeUnknownEffect(events)(parsed);
    })
  );

/** What `JSON.stringify` would put on the wire, as a value a matcher can read. */
const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));

/** One line of a timeline, built the way the store hands one back. */
const runEvent = Schema.decodeSync(RunEvent)({
  createdAt: AT,
  id: newRunEventId(),
  occurredAt: AT,
  payload: { kind: "log", level: "info", message: "a line the agent said" },
  runId: newRunId(),
  seq: 7,
  taskId: newTaskId(),
  threadId: null,
  workspaceId: WORKSPACE,
});

/** One column holding one card, with a run on it — the whole board's shape. */
const boardColumns = Schema.decodeSync(Schema.Array(BoardColumn))([
  {
    status: "in_progress",
    tasks: [
      {
        acceptance: null,
        brief: "what the card asks for",
        createdAt: AT,
        dispatchTraceparent: null,
        id: newTaskId(),
        liveRunId: newRunId(),
        metadata: {},
        nextSessionId: null,
        nextSessionNew: false,
        parentTaskId: null,
        parkedUntil: null,
        projectId: newProjectId(),
        prUrl: null,
        rank: 1024,
        repoUrl: null,
        sandboxImage: null,
        status: "in_progress",
        statusChangedAt: AT,
        title: "A card with a run on it",
        updatedAt: AT,
        workspaceId: WORKSPACE,
      },
    ],
  },
]);

describe("what the contract streams", () => {
  test("a run event survives the frame it is written into", async () => {
    const decoded = await roundTrip(
      eventsOf(Api.groups.runs.endpoints.stream),
      runEvent
    );
    const { data } = decoded as { data: typeof runEvent };

    // Not a string that looks like one: the bug was a timestamp arriving as
    // text a screen would then have to parse itself.
    expect(DateTime.isDateTime(data.occurredAt)).toBe(true);
    expect(asJson(data)).toEqual(asJson(runEvent));
  });

  test("a board snapshot survives the frame it is written into", async () => {
    const decoded = await roundTrip(
      eventsOf(Api.groups.tasks.endpoints.boardStream),
      boardColumns
    );
    const { data } = decoded as { data: typeof boardColumns };

    expect(DateTime.isDateTime(data[0]?.tasks[0]?.statusChangedAt)).toBe(true);
    expect(asJson(data)).toEqual(asJson(boardColumns));
  });
});
