/**
 * The registry's one promise: a turn run through it leaves exactly one
 * `atm.turn` row, on every path a turn can end on, counted from the events the
 * provider actually emitted.
 *
 * The provider here is a scripted stream rather than either real harness. That
 * is the point — the claim under test is about the wrapper, and the two paths
 * that break it are the ones a real provider makes hard to reach on demand: a
 * stream that ends without a terminus, and a stream interrupted mid-flight
 * because someone stopped the run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Telemetry } from "@workspace/telemetry";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import type { AgentEvent } from "./events";
import { costUsdOf } from "./events";
import type { AgentProvider, RunOptions } from "./provider";
import { instrumented } from "./registry";
import { TURN_EVENT_MARKER } from "./turn-event";

const SERVICE = "harness-registry-test";

type Row = Record<string, unknown>;

const options: RunOptions = {
  agentHomeDir: "/run/agent-home/claude",
  effort: null,
  env: {},
  mcpServers: null,
  model: "opus",
  prompt: "ship it",
  resumeSessionId: null,
  runId: null,
  signal: null,
  taskId: null,
  workspaceDir: "/run/workspace",
};

/** A harness that emits exactly what it is handed, and nothing else. */
const scripted = (stream: Stream.Stream<AgentEvent, never>): AgentProvider => ({
  capabilities: {
    cost: true,
    hooks: true,
    rateLimitSignal: false,
    reasoning: true,
    resume: true,
    subagents: false,
  },
  defaultEffort: "high",
  displayName: "Scripted",
  efforts: [],
  id: "claude",
  models: [],
  run: () => stream,
});

const sessionInit: AgentEvent = {
  kind: "session_init",
  model: "claude-opus-4",
  provider: "claude",
  providerSessionId: "sess-1",
};

const toolCall: AgentEvent = {
  callId: "call-1",
  inputChars: 12,
  kind: "tool_call",
  summary: "read a file",
  toolName: "Read",
};

const finished: AgentEvent = {
  costUsd: costUsdOf(0.25),
  durationMs: 1200,
  errorClass: null,
  errorMessage: null,
  kind: "result",
  outcome: "done",
  providerSessionId: "sess-1",
  text: "done",
  totalTokens: 900,
  turns: 2,
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "harness-registry-"));
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const testLayer = () =>
  Telemetry.layer({ serviceName: SERVICE }).pipe(
    Layer.provide(
      Layer.mergeAll(
        BunFileSystem.layer,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ EVENT_LOG_DIR: directory })
        )
      )
    )
  );

const run = <A, E>(program: Effect.Effect<A, E, Telemetry>) =>
  Effect.runPromise(program.pipe(Effect.provide(testLayer()), Effect.exit));

const rows = (): Row[] =>
  readFileSync(join(directory, `${SERVICE}.jsonl`), "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row);

/** The one row a turn left. Fails loudly when it left none or several. */
const onlyRow = () => {
  const written = rows();
  const [row] = written;
  if (!row || written.length !== 1) {
    throw new Error(`expected one turn row, found ${written.length}`);
  }
  return row;
};

describe("a turn through the registry", () => {
  test("passes every event through and leaves one row", async () => {
    const exit = await run(
      Stream.runCollect(
        instrumented(
          scripted(Stream.fromArray([sessionInit, toolCall, finished]))
        ).run(options)
      )
    );

    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.map((event) => event.kind)).toEqual([
        "session_init",
        "tool_call",
        "result",
      ]);
    }

    const row = onlyRow();
    expect(row.event).toBe(TURN_EVENT_MARKER);
    expect(row.outcome).toBe("done");
    expect(row.provider).toBe("claude");
    // What the provider chose, not what was asked for.
    expect(row.model).toBe("claude-opus-4");
    expect(row.toolCalls).toBe(1);
    expect(row.eventsSeen).toBe(3);
    expect(row.promptChars).toBe(options.prompt.length);
    expect(row.costUsd).toBe(0.25);
    expect(row.totalTokens).toBe(900);
    // A caller that named no effort still lands under the level that applied.
    expect(row.effort).toBe("high");
  });

  test("a stream that stops without a terminus is not a success", async () => {
    await run(
      Stream.runDrain(
        instrumented(scripted(Stream.fromArray([sessionInit]))).run(options)
      )
    );

    const row = onlyRow();
    expect(row.outcome).toBe("no_terminal_event");
    expect(row.errorClass).toBe("NoTerminalEvent");
    expect(row.costUsd).toBeNull();
  });

  test("an interrupt mid-stream leaves a row with null economics", async () => {
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const turn = instrumented(
          scripted(
            Stream.concat(
              Stream.fromArray([sessionInit, toolCall]),
              Stream.never
            )
          )
        ).run(options);
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(turn, (event) =>
            event.kind === "tool_call"
              ? Deferred.succeed(started, undefined)
              : Effect.void
          )
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
      })
    );

    const row = onlyRow();
    expect(row.outcome).toBe("interrupted");
    expect(row.errorClass).toBe("Interrupted");
    expect(row.costUsd).toBeNull();
    expect(row.totalTokens).toBeNull();
    // The counters survive the interrupt: how far a killed turn got is the
    // reason an interrupted row is worth having at all.
    expect(row.toolCalls).toBe(1);
  });
});
