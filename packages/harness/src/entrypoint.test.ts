import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BunFileSystem } from "@effect/platform-bun";
import { RunId, TaskId, WorkspaceId } from "@workspace/domain";
import { Telemetry } from "@workspace/telemetry";
import { Effect, Layer, Schema, Stream } from "effect";
import { CLAUDE_CLI_PATH_ENV_VAR } from "./claude";
import { runTurn, specPathFrom } from "./entrypoint";
import { Unauthenticated } from "./errors";
import type { AgentEvent } from "./events";
import {
  type AgentProvider,
  makeProviderRegistry,
  ProviderRegistry,
} from "./provider";
import { STOP_HOOK_COMMAND_ENV_VAR } from "./stop-hook";
import {
  containerStopHookCommand,
  TURN_EXIT_CODE,
  TURN_SPEC_ENV_VAR,
  TURN_SPEC_FLAG,
  TurnResult,
  type TurnSpec,
} from "./turn-spec";

const decodeResult = Schema.decodeUnknownSync(TurnResult);

/** A provider that emits a scripted stream. The model call is the only fake here. */
const scripted = (
  events: readonly AgentEvent[],
  failure: Unauthenticated | null = null
): AgentProvider => ({
  capabilities: {
    cost: false,
    hooks: false,
    rateLimitSignal: false,
    reasoning: false,
    resume: false,
    subagents: false,
  },
  defaultEffort: null,
  displayName: "scripted",
  efforts: [],
  id: "claude",
  models: [],
  run: () =>
    failure === null
      ? Stream.fromArray(events)
      : Stream.concat(Stream.fromArray(events), Stream.fail(failure)),
});

/**
 * The emitter, stubbed. The `atm.turn` row is the registry's promise and is
 * tested there; what these cases are about is the files the container leaves.
 */
const telemetryStub = Layer.succeed(
  Telemetry,
  Telemetry.of({
    emit: () => Effect.void,
    environment: { gitSha: "test", host: "test", version: "test" },
  })
);

const registryLayer = (provider: AgentProvider) =>
  Layer.succeed(
    ProviderRegistry,
    makeProviderRegistry({ claude: provider, codex: provider })
  );

const specFor = (runDir: string): TurnSpec => ({
  agentHomeDir: join(runDir, "agent-home", "claude"),
  effort: null,
  eventLogPath: join(runDir, "events.jsonl"),
  identity: {
    runId: RunId.make("019fbfd0-0000-7000-8000-0000000000aa"),
    sessionId: null,
    taskId: TaskId.make("019fbfd0-0000-7000-8000-0000000000bb"),
    traceparent: null,
    workspaceId: WorkspaceId.make("entrypoint-test"),
  },
  model: null,
  prompt: "say something",
  provider: "claude",
  resumeSessionId: null,
  timeoutMs: null,
  workspaceDir: runDir,
});

const SESSION_INIT: AgentEvent = {
  kind: "session_init",
  model: "sonnet",
  provider: "claude",
  providerSessionId: "prov-1",
};

const TERMINUS: AgentEvent = {
  costUsd: null,
  durationMs: null,
  errorClass: null,
  errorMessage: null,
  kind: "result",
  outcome: "done",
  providerSessionId: "prov-1",
  text: "done",
  totalTokens: null,
  turns: 1,
};

describe("specPathFrom", () => {
  it("prefers the flag, then the environment, then the container's run dir", () => {
    expect(
      specPathFrom({ argv: [TURN_SPEC_FLAG, "/a/spec.json"], env: {} })
    ).toBe("/a/spec.json");
    expect(
      specPathFrom({ argv: [], env: { [TURN_SPEC_ENV_VAR]: "/b/spec.json" } })
    ).toBe("/b/spec.json");
    expect(specPathFrom({ argv: [], env: {} })).toBe("/run/turn-spec.json");
  });
});

describe("runTurn", () => {
  let runDir = "";

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "atm-entrypoint-"));
  });

  afterEach(() => {
    rmSync(runDir, { force: true, recursive: true });
    // The entrypoint is a process: it records its answer on `process.exitCode`
    // so an interrupted container still reports one. Here that process is the
    // test runner, which would otherwise exit with the last turn's code.
    process.exitCode = 0;
  });

  /** Runs the entrypoint over a real directory against a scripted provider. */
  const run = (provider: AgentProvider, spec?: TurnSpec) => {
    const specPath = join(runDir, "turn-spec.json");
    writeFileSync(specPath, JSON.stringify(spec ?? specFor(runDir)));
    return Effect.runPromise(
      runTurn({ specPath }).pipe(
        Effect.provide(
          Layer.mergeAll(
            registryLayer(provider),
            telemetryStub,
            BunFileSystem.layer
          )
        )
      )
    );
  };

  const resultOf = () =>
    decodeResult(
      JSON.parse(readFileSync(join(runDir, "turn-result.json"), "utf-8"))
    );

  it("appends one JSON line per event and completes", async () => {
    const code = await run(scripted([SESSION_INIT, TERMINUS]));
    const lines = readFileSync(join(runDir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.length > 0);

    expect(code).toBe(TURN_EXIT_CODE.completed);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}").event.kind).toBe("session_init");
    const result = resultOf();
    expect(result.exitReason).toBe("completed");
    expect(result.outcome).toBe("done");
    expect(result.providerSessionId).toBe("prov-1");
    expect(result.eventsSeen).toBe(2);
  });

  it("names the cli this image put on PATH, so the sdk resolves none itself", async () => {
    const binDir = join(runDir, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = binDir;
    Reflect.deleteProperty(process.env, CLAUDE_CLI_PATH_ENV_VAR);
    try {
      await run(scripted([SESSION_INIT, TERMINUS]));
      expect(process.env[CLAUDE_CLI_PATH_ENV_VAR]).toBe(join(binDir, "claude"));
    } finally {
      process.env.PATH = previousPath;
      Reflect.deleteProperty(process.env, CLAUDE_CLI_PATH_ENV_VAR);
    }
  });

  /**
   * The bug this pair is about: a manager turn answering in a conversation was
   * handed the worker's stop hook, refused for not posting on a task it does
   * not have, and spent its next turn saying so to the person in the chat.
   */
  it("registers the stop hook for a turn that has a task", async () => {
    Reflect.deleteProperty(process.env, STOP_HOOK_COMMAND_ENV_VAR);
    try {
      await run(scripted([SESSION_INIT, TERMINUS]));
      expect(process.env[STOP_HOOK_COMMAND_ENV_VAR]).toBe(
        containerStopHookCommand()
      );
    } finally {
      Reflect.deleteProperty(process.env, STOP_HOOK_COMMAND_ENV_VAR);
    }
  });

  it("registers no stop hook for a turn with no task, whatever the image left set", async () => {
    const spec = specFor(runDir);
    process.env[STOP_HOOK_COMMAND_ENV_VAR] = "bun /opt/atm/turn.js --stop-hook";
    try {
      await run(scripted([SESSION_INIT, TERMINUS]), {
        ...spec,
        identity: { ...spec.identity, taskId: null },
      });
      expect(process.env[STOP_HOOK_COMMAND_ENV_VAR]).toBeUndefined();
    } finally {
      Reflect.deleteProperty(process.env, STOP_HOOK_COMMAND_ENV_VAR);
    }
  });

  it("reports a stream that ended without a terminus", async () => {
    const code = await run(scripted([SESSION_INIT]));
    expect(code).toBe(TURN_EXIT_CODE.no_terminus);
    expect(resultOf().exitReason).toBe("no_terminus");
  });

  it("reports a typed provider failure as a failed turn", async () => {
    const code = await run(
      scripted([SESSION_INIT], new Unauthenticated({ detail: "no login" }))
    );
    expect(code).toBe(TURN_EXIT_CODE.turn_failed);
    const result = resultOf();
    expect(result.errorClass).toBe("Unauthenticated");
    expect(result.outcome).toBe("errored");
  });

  it("leaves a result the host can read when the spec does not decode", async () => {
    const specPath = join(runDir, "turn-spec.json");
    writeFileSync(specPath, "{ not a spec }");
    const code = await Effect.runPromise(
      runTurn({ specPath }).pipe(
        Effect.provide(
          Layer.mergeAll(
            registryLayer(scripted([TERMINUS])),
            telemetryStub,
            BunFileSystem.layer
          )
        )
      )
    );
    expect(code).toBe(TURN_EXIT_CODE.spec_unreadable);
    expect(resultOf().exitReason).toBe("spec_unreadable");
  });
});
