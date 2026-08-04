/**
 * Which of the two implementations serves a run, and how that is decided.
 *
 * The orchestrator asks for a {@link Sandbox} and gets one. It never learns
 * which, and that is the point of the seam: dispatch, streaming, teardown and
 * the row a run leaves are identical either way, so the debugging escape hatch
 * costs one environment variable rather than a branch in the dispatch path.
 * Anything above this line that asked "am I in local mode" would be a second
 * place the modes could differ.
 *
 * The default is `docker`, and it defaults rather than being required for one
 * reason: the failure of a missing setting has to be the safe one. An operator
 * who forgets the variable gets a container; an operator who wants no isolation
 * has to say so, in writing, in the environment of the process — and the
 * `local` on every row that process produces is what says so afterwards.
 */

import { Config, Effect, Layer } from "effect";
import { dockerSandboxLayer } from "./docker";
import { localSandboxLayer } from "./local";
import { Sandbox, SandboxKind } from "./spec";

/** The variable naming the implementation. `docker` or `local`, nothing else. */
export const SANDBOX_MODE_ENV_VAR = "SANDBOX_MODE";

/** What an unset {@link SANDBOX_MODE_ENV_VAR} means. Isolation, not the absence of it. */
export const DEFAULT_SANDBOX_KIND: SandboxKind = "docker";

/**
 * The implementation named in the environment, `docker` when nothing is.
 *
 * Decoded through the same literal union the row carries, so a typo is a
 * startup failure naming both legal values rather than a silent fall back to a
 * default the operator did not ask for.
 */
export const sandboxKindConfig = Config.schema(
  SandboxKind,
  SANDBOX_MODE_ENV_VAR
).pipe(Config.withDefault(DEFAULT_SANDBOX_KIND));

/**
 * The layer for one kind. Total over the union, so a third implementation is a
 * compile error here rather than a mode that silently resolves to docker.
 */
export const sandboxLayerFor = (kind: SandboxKind) =>
  kind === "docker" ? dockerSandboxLayer : localSandboxLayer;

/**
 * What an application wires: the {@link Sandbox} service, built from whichever
 * implementation the environment names.
 *
 * Both branches require `Telemetry` and nothing else — the platform services
 * each of them needs are provided inside its own layer, so the caller's wiring
 * does not have to know that one of them spawns `docker` and the other does
 * not.
 */
export const sandboxLayer = Layer.unwrap(
  Effect.map(sandboxKindConfig, sandboxLayerFor)
);

/**
 * Announces the mode once, where a layer is built rather than where a run
 * starts. An operator scrolling back through a loop's startup should be able to
 * see that every container this process claims to have started was in fact a
 * bare host process.
 */
export const logSandboxMode = Effect.gen(function* () {
  const kind = yield* sandboxKindConfig;
  yield* Effect.logInfo(
    kind === "local"
      ? "sandbox mode is local: runs have no container isolation"
      : "sandbox mode is docker"
  ).pipe(Effect.annotateLogs({ kind }));
  return kind;
});
