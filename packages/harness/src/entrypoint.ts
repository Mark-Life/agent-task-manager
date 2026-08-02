/**
 * The process that runs one agent turn inside a container.
 *
 * Everything here is composition. The provider, the normalization, the wide
 * event, the classification and the stop rule already exist in this package;
 * what was missing was a `main` that reads a spec off a mount, drives them, and
 * leaves the answer somewhere the host can read after the container is gone.
 * Nothing in this file decides anything a run cares about.
 *
 * **Three artefacts, and each is written as it happens.** The normalized events
 * are appended to {@link TurnSpec.eventLogPath} one JSON line at a time, so the
 * host tailing that file watches the turn live rather than receiving it at the
 * end. The `atm.turn` row goes through the registry's own combinator — this
 * package's single definition of "one row per invocation on every exit path" —
 * into the ledger directory the sandbox pointed `EVENT_LOG_DIR` at, which is
 * also inside the run mount. The result file is written last, on every exit
 * path, which is what makes it exist even when the fiber was interrupted.
 *
 * **The spec is the authority on identity.** The ids are on the container's
 * environment too — that is what `readTurnIdentity` reads — but a container
 * started by hand has neither, so the spec's ids are layered over the
 * environment as the primary config source for the duration of the turn. The
 * row such a container writes then still joins the run it claims to be.
 *
 * **The same bundle is also the stop hook.** The mount set carries exactly one
 * file, and a hook is a second process the provider spawns per attempted
 * ending, so {@link runStopHook} is this file in its other mode. The rule it
 * applies is `decideStop` and nothing else; `scripts/stop-hook.ts` stays the
 * executable for a run that is not in a container.
 */

import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import process from "node:process";
import { clipError } from "@workspace/telemetry";
import {
  Cause,
  ConfigProvider,
  DateTime,
  Effect,
  type Exit,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import { FileSystem } from "effect/FileSystem";
import { useImageClaudeCli } from "./claude";
import {
  describeError,
  type HarnessError,
  type HarnessErrorClass,
  TimedOut,
  type TurnOutcome,
} from "./errors";
import { type AgentEvent, AgentEventRecord } from "./events";
import {
  claudeExecutorMcpServers,
  codexExecutorConfig,
  type ExecutorMcp,
  readExecutorMcp,
} from "./executor-mcp";
import { containerRunLayout, runLayout } from "./paths";
import { ProviderRegistry } from "./provider";
import {
  ALLOW_TURN_END,
  commentMarkerPath,
  decideStop,
  parseStopHookPayload,
  STOP_HOOK_COMMAND_ENV_VAR,
  stopHookResponseOf,
} from "./stop-hook";
import {
  makeTurnCounters,
  observeTurnEvent,
  TURN_ENV_VARS,
  type TurnCounters,
} from "./turn-event";
import {
  containerStopHookCommand,
  exitCodeOf,
  mcpServersPathOf,
  TURN_SPEC_ENV_VAR,
  TURN_SPEC_FLAG,
  type TurnExitReason,
  TurnResult,
  TurnSpec,
  type TurnSpecIdentity,
  turnResultPathOf,
  turnSpecPathOf,
} from "./turn-spec";

/** Decoder over the spec, built once — it compiles an AST on every call otherwise. */
const decodeSpec = Schema.decodeUnknownEffect(TurnSpec);

/** Encoder for one line of the run's event file. */
const encodeRecord = Schema.encodeEffect(AgentEventRecord);

/** Encoder for the container's last word. */
const encodeResult = Schema.encodeEffect(TurnResult);

/**
 * The spec file was absent, unparseable, or not a spec. Its own failure rather
 * than a crash: the host has to tell "the orchestrator wrote a spec this build
 * cannot read" from "the model failed", and both would otherwise be a container
 * that exited non-zero.
 */
export class TurnSpecUnreadable extends Schema.TaggedErrorClass<TurnSpecUnreadable>()(
  "Harness.TurnSpecUnreadable",
  { detail: Schema.String, path: Schema.String }
) {}

/**
 * The spec, decoded. Read through the platform filesystem rather than `Bun.file`
 * so a test can run the same code over an in-memory one.
 */
export const readTurnSpec = Effect.fn("Turn.readSpec")(function* (
  path: string
) {
  const fs = yield* FileSystem;
  const unreadable = (cause: unknown) =>
    new TurnSpecUnreadable({ detail: clipError(String(cause)), path });
  const raw = yield* fs.readFileString(path).pipe(Effect.mapError(unreadable));
  const parsed = yield* Effect.try({
    catch: unreadable,
    try: () => JSON.parse(raw) as unknown,
  });
  return yield* decodeSpec(parsed).pipe(Effect.mapError(unreadable));
});

/**
 * The ids as a config source, so `readTurnIdentity` inside the registry answers
 * from the spec. A null id is an omitted key rather than a blank one: the
 * environment is the fallback, and an empty string there reads as a supplied id.
 */
const identityConfig = (identity: TurnSpecIdentity) => ({
  [TURN_ENV_VARS.runId]: identity.runId,
  [TURN_ENV_VARS.workspaceId]: identity.workspaceId,
  ...(identity.taskId === null
    ? {}
    : { [TURN_ENV_VARS.taskId]: identity.taskId }),
  ...(identity.sessionId === null
    ? {}
    : { [TURN_ENV_VARS.sessionId]: identity.sessionId }),
});

/**
 * Codex's `mcp_servers` table as TOML. Deliberately not a general encoder: the
 * only thing this ever renders is a server's string fields, so a table header
 * and quoted strings is the whole grammar, and a dependency for it would be a
 * dependency inside a container image.
 */
const codexMcpToml = (servers: unknown) =>
  Object.entries((servers ?? {}) as Record<string, unknown>)
    .filter(([, server]) => typeof server === "object" && server !== null)
    .map(([name, server]) => {
      const fields = Object.entries(server as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join("\n");
      return `[mcp_servers.${name}]\n${fields}\n`;
    })
    .join("\n");

/**
 * A JSON object off disk, or an empty one. Absent, unreadable and unparseable
 * all answer the same way on purpose: this is only ever used to merge into a
 * file the provider owns, and refusing to write because the vendor left
 * something we cannot parse would cost the run its tools over a file we did not
 * write.
 */
const readJsonObject = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* fs.readFileString(path).pipe(
      Effect.flatMap((raw) =>
        Effect.try({
          catch: () => new Error("unparseable"),
          try: () => JSON.parse(raw) as Record<string, unknown>,
        })
      ),
      Effect.orElseSucceed(() => ({}) as Record<string, unknown>)
    );
  });

/** The object at `key`, or an empty one where the file holds something else. */
const objectAt = (source: Record<string, unknown>, key: string) => {
  const value = source[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
};

/**
 * Executor's MCP server in the shape the provider about to run actually reads.
 *
 * Claude takes its map as a query option, so nothing is written at all. Codex
 * reads `config.toml` out of its config directory, and that directory is now
 * shared by every run on the host — see {@link wireCodexExecutor}.
 *
 * Absence is not an error. An install with no Executor configured runs with no
 * Executor tools, which is a smaller agent and not a broken one.
 */
const wireCodexExecutor = Effect.fn("Turn.wireCodexExecutor")(
  function* (input: {
    readonly agentHomeDir: string;
    readonly executor: ExecutorMcp | null;
  }) {
    const config = codexExecutorConfig(input.executor);
    if (config === null) {
      return;
    }
    // TODO: render this as `codex -c mcp_servers.<name>.<field>=<value>` instead.
    // The file is a whole-file write into a directory other containers are
    // reading, and the only thing keeping it safe is that every run writes the
    // same bytes. It holds no secret — `bearer_token_env_var` names the variable
    // rather than carrying the token — which is why this is a TODO and not a
    // blocker, and why Claude's map moved off disk first.
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(input.agentHomeDir, { recursive: true });
    yield* fs.writeFileString(
      join(input.agentHomeDir, "config.toml"),
      codexMcpToml(config.config.mcp_servers)
    );
  }
);

/**
 * The `mcpServers` map the host left on the run mount, or null where it left
 * none.
 *
 * Absence is the ordinary case and is not an error, exactly as a missing
 * Executor configuration is not: a turn with no extra servers is a smaller
 * agent, and a file this build cannot parse costs the turn those tools rather
 * than the turn itself.
 */
const readExtraMcpServers = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem;
  const present = yield* fs
    .exists(path)
    .pipe(Effect.orElseSucceed(() => false));
  if (!present) {
    return null;
  }
  const file = yield* readJsonObject(path);
  const servers = objectAt(file, "mcpServers");
  return Object.keys(servers).length === 0 ? null : servers;
});

/**
 * Every MCP server this turn gets, as one map handed to the provider.
 *
 * Two sources: Executor, which is the same on every run, and whatever the host
 * left on the run mount — which is how a run gets its board tools, the bearer
 * token riding a mount the container already has rather than an environment
 * `docker inspect` prints. A name collision resolves in favour of the host's,
 * because those were decided for this turn.
 *
 * Claude only. `codexMcpToml` renders a server's string fields alone, so an
 * `args` array would be dropped and the server would launch with nothing to
 * run — a silently toolless agent, which is worse than a warning that says so.
 */
const mcpServersFor = Effect.fn("Turn.mcpServers")(function* (input: {
  readonly executor: ExecutorMcp | null;
  readonly path: string;
  readonly provider: TurnSpec["provider"];
}) {
  const extras = yield* readExtraMcpServers(input.path);
  if (input.provider !== "claude") {
    if (extras !== null) {
      yield* Effect.logWarning(
        "extra mcp servers ignored: this provider's configuration renderer cannot express them",
        { names: Object.keys(extras), provider: input.provider }
      );
    }
    return null;
  }
  const merged = {
    ...claudeExecutorMcpServers(input.executor),
    ...extras,
  };
  return Object.keys(merged).length === 0 ? null : merged;
});

/**
 * The environment the provider's subprocess is started with, on top of what the
 * container already has.
 *
 * Only Executor's token, and only for Codex: the config file above names the
 * variable rather than carrying the value, so the two have to travel together.
 * Everything else a provider needs — the ids, the ledger directory, the agent
 * home — is already on the container's environment or is the provider's own to
 * merge.
 */
const providerEnv = (input: {
  readonly executor: ExecutorMcp | null;
  readonly provider: TurnSpec["provider"];
}): Readonly<Record<string, string>> => {
  if (input.provider !== "codex") {
    return {};
  }
  const config = codexExecutorConfig(input.executor);
  return config === null ? {} : config.env;
};

/** How the turn ended, in the vocabulary the result file speaks. */
interface TurnEnding {
  readonly errorClass: HarnessErrorClass | null;
  readonly errorMessage: string | null;
  readonly exitReason: TurnExitReason;
  readonly outcome: TurnOutcome | null;
}

/**
 * Reads the ending off the exit and the counters together, the same way the
 * wide event does: a provider that streamed a terminus and then returned
 * cleanly reports its own outcome, while an interrupt, a typed failure and a
 * defect exist only on the exit.
 *
 * A success with no terminus is `no_terminus` rather than `completed`. A stream
 * that stopped talking produced nothing, and counting it as a success is how a
 * broken provider looks healthy. A defect is `crashed` rather than a failed
 * turn, because it is the container's own plumbing giving way and not a model.
 */
export const endingOf = (
  exit: Exit.Exit<unknown, HarnessError>,
  counters: TurnCounters
): TurnEnding => {
  if (exit._tag === "Success") {
    if (counters.outcome === null) {
      return {
        errorClass: "NoTerminalEvent",
        errorMessage: `the provider stream ended after ${counters.eventsSeen} events without a terminus`,
        exitReason: "no_terminus",
        outcome: "no_terminal_event",
      };
    }
    return {
      errorClass: counters.errorClass,
      errorMessage: counters.errorMessage,
      exitReason: counters.outcome === "done" ? "completed" : "turn_failed",
      outcome: counters.outcome,
    };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      errorClass: "Interrupted",
      errorMessage: null,
      exitReason: "interrupted",
      outcome: "interrupted",
    };
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    const described = describeError(failure.value);
    return {
      ...described,
      exitReason:
        described.outcome === "interrupted" ? "interrupted" : "turn_failed",
    };
  }
  return {
    errorClass: "ProviderCrashed",
    errorMessage: clipError(String(Cause.squash(exit.cause))),
    exitReason: "crashed",
    outcome: "errored",
  };
};

/**
 * The result file. Best-effort, like every other emit: a container that could
 * not write its last word still has an exit code, and failing the turn over it
 * would let bookkeeping abort the work it describes.
 */
const writeResult = (input: {
  readonly path: string;
  readonly result: TurnResult;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const encoded = yield* encodeResult(input.result);
    yield* fs.makeDirectory(dirname(input.path), { recursive: true });
    yield* fs.writeFileString(input.path, `${JSON.stringify(encoded)}\n`);
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("turn result not written", { cause, path: input.path })
    ),
    Effect.ignore
  );

/**
 * The turn itself: the provider's stream, appended to the event file line by
 * line and folded into the counters the result is built from.
 *
 * The registry is what is called rather than a provider, because the registry
 * is where the `atm.turn` row is attached — a bare provider would run a turn
 * that leaves no row.
 */
const streamTurn = (input: {
  readonly counters: Ref.Ref<TurnCounters>;
  readonly executor: ExecutorMcp | null;
  readonly mcpServers: Readonly<Record<string, unknown>> | null;
  readonly spec: TurnSpec;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const registry = yield* ProviderRegistry;
    const { spec } = input;

    /** One line of the event file, flushed before the next event is read. */
    const append = (event: AgentEvent) =>
      Effect.gen(function* () {
        const occurredAt = yield* DateTime.now;
        const encoded = yield* encodeRecord({ event, occurredAt });
        yield* fs.writeFileString(
          spec.eventLogPath,
          `${JSON.stringify(encoded)}\n`,
          { flag: "a" }
        );
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("turn event not written to the event file", {
            cause,
            path: spec.eventLogPath,
          })
        ),
        Effect.ignore
      );

    const events = registry.get(spec.provider).run({
      agentHomeDir: spec.agentHomeDir,
      effort: spec.effort,
      env: providerEnv({ executor: input.executor, provider: spec.provider }),
      mcpServers: input.mcpServers,
      model: spec.model,
      prompt: spec.prompt,
      resumeSessionId: spec.resumeSessionId,
      runId: spec.identity.runId,
      // Interrupting the fiber is how this process is stopped: the container
      // takes a signal, the runtime interrupts the main fiber, and the provider
      // subprocess dies with the stream's own scope.
      signal: null,
      taskId: spec.identity.taskId,
      workspaceDir: spec.workspaceDir,
    });

    yield* Stream.runForEach(events, (event) =>
      Effect.andThen(append(event), observeTurnEvent(input.counters, event))
    );
  });

/** What the ending of a turn is written down from. */
interface FinishInput {
  readonly counters: Ref.Ref<TurnCounters>;
  readonly exit: Exit.Exit<void, HarnessError>;
  readonly resultPath: string;
}

/**
 * The result file and the exit code, from the exit and the counters.
 *
 * `process.exitCode` is set here as well as returned, and the duplication is
 * deliberate: on the interrupted path the returned value never travels back out
 * to the runner, because the fiber it would travel through is already
 * interrupted.
 */
const finish = (input: FinishInput) =>
  Effect.gen(function* () {
    const counted = yield* Ref.get(input.counters);
    const ending = endingOf(input.exit, counted);
    yield* writeResult({
      path: input.resultPath,
      result: {
        errorClass: ending.errorClass,
        errorMessage: ending.errorMessage,
        eventsSeen: counted.eventsSeen,
        exitReason: ending.exitReason,
        finishedAt: yield* DateTime.now,
        outcome: ending.outcome,
        providerSessionId: counted.providerSessionId,
      },
    });
    const code = exitCodeOf(ending.exitReason);
    yield* Effect.sync(() => {
      process.exitCode = code;
    });
    return code;
  });

/** One decoded spec, run to its ending. Answers with the process exit code. */
const runSpec = (input: {
  readonly resultPath: string;
  readonly spec: TurnSpec;
}) =>
  Effect.gen(function* () {
    const { spec } = input;
    // Executor is optional and its absence is not an error, so neither is a
    // configuration this build cannot read: a run with no Executor tools is a
    // smaller agent, and failing the turn over it would be a worse answer.
    const executor = yield* readExecutorMcp.pipe(
      Effect.orElseSucceed(() => null)
    );
    const counters = yield* makeTurnCounters;

    // The hook command and the provider's CLI are read off the process
    // environment as the provider builds its options, not from `RunOptions.env`.
    // The hook names this bundle in its other mode; the CLI is the image's own.
    yield* useImageClaudeCli(spec.provider);
    yield* Effect.sync(() => {
      process.env[STOP_HOOK_COMMAND_ENV_VAR] = containerStopHookCommand();
    });
    // A config file that could not be written costs the run its Executor tools
    // and nothing else, so it is a warning rather than an ending.
    yield* wireCodexExecutor({
      agentHomeDir: spec.agentHomeDir,
      executor,
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("executor mcp not wired", { cause })
      ),
      Effect.ignore
    );
    // Same tolerance, same reason: a turn with fewer tools is a smaller agent
    // and not a broken one.
    const mcpServers = yield* mcpServersFor({
      executor,
      path: mcpServersPathOf(containerRunLayout),
      provider: spec.provider,
    }).pipe(Effect.orElseSucceed(() => null));

    const work = streamTurn({ counters, executor, mcpServers, spec });
    const { timeoutMs } = spec;
    const capped =
      timeoutMs === null
        ? work
        : work.pipe(
            // An ending rather than a kill. The container has a cap of its own
            // and that one is a SIGKILL with no result file behind it, so this
            // one is set lower and leaves the container's last word.
            Effect.timeoutOrElse({
              duration: timeoutMs,
              orElse: () => Effect.fail(new TimedOut({ timeoutMs })),
            })
          );

    const exit = yield* Effect.exit(
      capped.pipe(
        Effect.provide(
          ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown(identityConfig(spec.identity)),
            { asPrimary: true }
          )
        )
      )
    );
    // Uninterruptible, because the common way for this to be reached is an
    // interrupt: a fiber that has just observed one is re-interrupted at its
    // next yield point, and the container's last word would be the one thing a
    // stopped run failed to write.
    return yield* Effect.uninterruptible(
      finish({ counters, exit, resultPath: input.resultPath })
    );
  });

/** What one invocation of the entrypoint needs. */
export interface RunTurnInput {
  /** The spec file, as the container sees it. */
  readonly specPath: string;
}

/**
 * One turn, start to finish, ending in an exit code.
 *
 * Never fails: every way a turn can go wrong is a reason on the result file and
 * a code on the way out, because a container that dies without writing one is a
 * run the host can only infer from silence. The result path is derived from the
 * spec path rather than from the spec, so a spec that would not decode still
 * leaves an answer in the run directory.
 */
export const runTurn = Effect.fn("Turn.run")(function* (input: RunTurnInput) {
  const resultPath = turnResultPathOf(runLayout(dirname(input.specPath)));
  return yield* readTurnSpec(input.specPath).pipe(
    Effect.flatMap((spec) => runSpec({ resultPath, spec })),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logError("turn spec unreadable", error);
        yield* writeResult({
          path: resultPath,
          result: {
            errorClass: "ProviderCrashed",
            errorMessage: `turn spec at ${error.path}: ${error.detail}`,
            eventsSeen: 0,
            exitReason: "spec_unreadable",
            finishedAt: yield* DateTime.now,
            outcome: null,
            providerSessionId: null,
          },
        });
        const code = exitCodeOf("spec_unreadable");
        yield* Effect.sync(() => {
          process.exitCode = code;
        });
        return code;
      })
    )
  );
});

/**
 * The spec path a container was told to read: the flag, then the environment,
 * then the container's own run directory — which is the case that needs no
 * wiring at all, because every run is mounted at the same place.
 */
export const specPathFrom = (input: {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}) => {
  const at = input.argv.indexOf(TURN_SPEC_FLAG);
  const named = at === -1 ? undefined : input.argv[at + 1];
  return (
    named ?? input.env[TURN_SPEC_ENV_VAR] ?? turnSpecPathOf(containerRunLayout)
  );
};

/** Whatever the harness wrote to stdin, as one string. */
const readStdin = Effect.promise(async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
});

/**
 * The stop hook: one JSON payload on stdin, one JSON response on stdout.
 *
 * On the critical path of every turn ending, so it stays a filesystem check and
 * a `switch`; the rule is `decideStop` and the only fact it gathers is whether
 * the run's comment marker exists. Every failure allows the ending — a hook that
 * throws is a run that cannot finish, which is far worse than a run that
 * finishes without a comment.
 */
export const runStopHook = Effect.fn("Turn.stopHook")(function* () {
  const decide = Effect.gen(function* () {
    const fs = yield* FileSystem;
    const raw = yield* readStdin;
    const payload = parseStopHookPayload(
      yield* Effect.try({
        catch: () => new Error("not json"),
        try: () => JSON.parse(raw) as unknown,
      }).pipe(Effect.orElseSucceed(() => null))
    );
    const commentPosted = yield* fs
      .exists(commentMarkerPath(process.env))
      .pipe(Effect.orElseSucceed(() => false));
    return stopHookResponseOf(decideStop({ commentPosted, payload }));
  });
  // `catchCause` rather than a typed recovery: a hook that throws must still
  // answer, and a defect is exactly the case a typed recovery would miss.
  const response = yield* decide.pipe(
    Effect.catchCause(() => Effect.succeed(ALLOW_TURN_END))
  );
  yield* Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return 0;
});
