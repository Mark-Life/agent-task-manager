/**
 * What answers instead of a model when `loop:check` runs, and the vocabulary
 * the check asserts against.
 *
 * The check is about the loop and about the container, never about a model, so
 * the provider is scripted: three events, one artifact file, and a final
 * message that becomes the run's fallback comment. Everything downstream — the
 * event file, `run_events`, the terminus, the comment, the artifact index, the
 * two `atm.run` rows — is driven by that stream, so a scripted one exercises
 * the whole lifecycle at no cost.
 *
 * It lives in its own file because two processes need the same script: the
 * check itself, which runs the turn on the host in the default mode, and
 * `./loop-check-turn`, which is bundled and mounted into the container in
 * `--docker` mode. Two copies would be two checks that can quietly stop
 * asserting the same thing.
 *
 * The one thing that differs between the two is where the artifact goes. The
 * host writes into `${DATA_ROOT}/artifacts/tasks/<id>`; the container writes
 * into `/artifacts/task`, which is that same directory seen through a bind
 * mount. So the folder is asked for rather than computed here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunId, SessionProvider } from "@workspace/domain";
import type { AgentEvent, AgentProvider, RunOptions } from "@workspace/harness";
import { Effect, Stream } from "effect";

/** What the stub writes into the task's artifacts directory. */
export const ARTIFACT_FILE = "stub-run-output.md";

/** The stub's answer, which becomes the run's fallback comment. */
export const STUB_FINAL_TEXT =
  "Stubbed turn: nothing was asked of a model, and this text is what the fallback comment carries.";

/** The model the stub claims to be, so the run row carries one to assert on. */
export const STUB_MODEL = "stub-1";

/** Tokens the stub reports, so the economics on the row are a number and not a null. */
export const STUB_TOTAL_TOKENS = 128;

/**
 * The conversation id the stub answers under. Derived from the run so two runs
 * of the same check never look like one resumed session.
 */
export const stubSessionId = (runId: RunId | null) => `stub-${runId ?? "run"}`;

/** The three events one stubbed turn says: it starts, it answers, it ends. */
export const stubEvents = (input: {
  readonly provider: SessionProvider;
  readonly providerSessionId: string;
}): readonly AgentEvent[] => [
  {
    kind: "session_init",
    model: STUB_MODEL,
    provider: input.provider,
    providerSessionId: input.providerSessionId,
  },
  { kind: "assistant_text", text: STUB_FINAL_TEXT },
  {
    costUsd: null,
    durationMs: 1,
    errorClass: null,
    errorMessage: null,
    kind: "result",
    outcome: "done",
    providerSessionId: input.providerSessionId,
    text: STUB_FINAL_TEXT,
    totalTokens: STUB_TOTAL_TOKENS,
    turns: 1,
  },
];

/**
 * The file a stubbed turn leaves behind, which is what makes the artifact
 * rescan's claim checkable: an index built from a directory a run really wrote
 * to, through whichever filesystem the turn was served over.
 */
export const writeStubArtifact = (input: {
  readonly directory: string;
  readonly provider: SessionProvider;
  readonly runId: RunId | null;
}) => {
  mkdirSync(input.directory, { recursive: true });
  writeFileSync(
    join(input.directory, ARTIFACT_FILE),
    `# Stub run\n\nWritten by the ${input.provider} stub for run ${input.runId}.\n`
  );
};

/**
 * What a provider declares about itself. The same for all three stubs below:
 * none of them is asked a capability question, and answering differently would
 * only invite one.
 */
const declarations = (id: SessionProvider) => ({
  capabilities: {
    cost: false,
    hooks: false,
    rateLimitSignal: false,
    reasoning: false,
    resume: true,
    subagents: false,
  },
  defaultEffort: null,
  displayName: `${id} (stub)`,
  efforts: [],
  id,
  models: [],
});

/** What building one scripted provider needs. */
export interface StubProviderInput {
  /**
   * This turn's artifacts folder, as the process running the turn sees it, or
   * null where there is nothing to write into. A function of the options rather
   * than a path, because the host derives it from the task and the container
   * has one fixed mount point for it.
   */
  readonly artifactsDir: (options: RunOptions) => string | null;
  readonly id: SessionProvider;
}

/**
 * A provider that answers without a model.
 *
 * A whole `AgentProvider` rather than a patched real one because the registry
 * hands the loop a provider and nothing else — so a scripted stream is a whole
 * turn as far as everything above it is concerned.
 */
export const stubProvider = (input: StubProviderInput): AgentProvider => ({
  ...declarations(input.id),
  run: (options: RunOptions) =>
    Stream.unwrap(
      Effect.sync(() => {
        const directory = input.artifactsDir(options);
        if (directory !== null) {
          writeStubArtifact({
            directory,
            provider: input.id,
            runId: options.runId,
          });
        }
        return Stream.fromIterable(
          stubEvents({
            provider: input.id,
            providerSessionId: stubSessionId(options.runId),
          })
        );
      })
    ),
});

/**
 * A provider that starts a turn and then says nothing forever, so the process
 * running it can be killed with a run genuinely in flight. Without the
 * `session_init` the run row would never reach `running`, and the crash would
 * be indistinguishable from a loop that never picked the task up.
 */
export const hangingProvider = (id: SessionProvider): AgentProvider => ({
  ...declarations(id),
  run: (options: RunOptions) =>
    Stream.concat(
      Stream.fromIterable<AgentEvent>([
        {
          kind: "session_init",
          model: STUB_MODEL,
          provider: id,
          providerSessionId: stubSessionId(options.runId),
        },
      ]),
      Stream.never
    ),
});

/**
 * A provider that dies if anything reaches it. What the host registry holds
 * while a contained run is in flight: the turn happens inside the container,
 * and a host process quietly serving it instead would otherwise pass every
 * claim the check makes.
 */
export const forbiddenProvider = (id: SessionProvider): AgentProvider => ({
  ...declarations(id),
  run: () =>
    Stream.fromEffect(
      Effect.die(`a contained run started the ${id} provider on the host`)
    ),
});
