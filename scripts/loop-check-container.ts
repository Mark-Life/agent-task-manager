/**
 * What `bun run loop:check --docker` adds: the two things a contained run needs
 * before it can start, and the three claims only a container can answer.
 *
 * **The entrypoint is bundled by the check, into the check's own data root.**
 * `bun run entrypoint:build` produces the operator's entrypoint, which runs a
 * model; this produces the one in `./loop-check-turn`, which is the same code
 * on a stubbed provider. They are two different programs at the same relative
 * path under two different roots, and a check that overwrote the operator's
 * bundle would leave the next real dispatch stubbed.
 *
 * **All three claims are read back off files.** The `atm.run` rows and the
 * daemon's own account of the container come off this process's ledger; the
 * `atm.turn` row comes out of the run's directory, which is where the container
 * wrote it and where the host can only see it because of a bind mount. By the
 * time any of them is asked the container has been removed, which is the point:
 * what is being checked is what a run leaves behind, not what the check watched
 * happen.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunId } from "@workspace/domain";
import { entrypointBundlePathOf, TURN_EXIT_CODE } from "@workspace/harness";
import { DEFAULT_SANDBOX_IMAGE } from "@workspace/sandbox";
import { Effect } from "effect";
import {
  CheckFailed,
  check,
  type LedgerRow,
  sandboxRows,
  turnRows,
} from "./loop-check-claims";
import { STUB_MODEL } from "./loop-check-stub";

/** The entry the contained mode bundles: the real entrypoint on a stub provider. */
const CONTAINED_ENTRY = new URL("./loop-check-turn.ts", import.meta.url)
  .pathname;

/**
 * Puts this check's own entrypoint where the orchestrator mounts one from, and
 * makes sure there is an image to mount it into.
 *
 * Both failures are named here rather than left to the run, because both are
 * about the host and neither is a fact about the loop: a missing image is a
 * container that never starts, and a missing bundle is a
 * `Sandbox.MountSourceMissing` per run.
 */
export const prepareContainer = (dataRoot: string) =>
  Effect.gen(function* () {
    const probe = yield* Effect.sync(() =>
      spawnSync("docker", [
        "image",
        "inspect",
        "--format={{.Id}}",
        DEFAULT_SANDBOX_IMAGE,
      ])
    );
    if (probe.status !== 0) {
      return yield* Effect.fail(
        new CheckFailed({
          detail: `no docker daemon holding ${DEFAULT_SANDBOX_IMAGE} — run \`bun run images:build\``,
          step: "the image the turn runs in is built",
        })
      );
    }

    const bundle = entrypointBundlePathOf(dataRoot);
    const built = yield* Effect.sync(() => {
      mkdirSync(dirname(bundle), { recursive: true });
      return spawnSync(
        "bun",
        ["build", CONTAINED_ENTRY, "--target=bun", "--outfile", bundle],
        { encoding: "utf8" }
      );
    });
    if (built.status !== 0) {
      return yield* Effect.fail(
        new CheckFailed({
          detail: `bun build refused: ${built.stderr?.trim() ?? built.status}`,
          step: "the turn entrypoint bundles",
        })
      );
    }
    yield* Effect.logInfo(`entrypoint bundled to ${bundle}`);
  });

/** What the three container claims are asked against. */
export interface ContainedClaimsInput {
  readonly dataRoot: string;
  /** This process's ledger file, holding the `atm.run` and `atm.sandbox` rows. */
  readonly ledgerPath: string;
  /** The run's own `atm.run` rows, already read for the claims above these. */
  readonly rows: readonly LedgerRow[];
  readonly runId: RunId;
}

/** The three claims only a container can make, asked once its container is gone. */
export const containedClaims = (input: ContainedClaimsInput) =>
  Effect.gen(function* () {
    const kinds = [...new Set(input.rows.map((row) => row.kind))];
    yield* check({
      detail: `the ${input.rows.length} atm.run rows say kind ${kinds.join(", ")} on image ${input.rows.at(-1)?.image}`,
      ok:
        input.rows.length > 0 &&
        input.rows.every(
          (row) => row.kind === "docker" && row.image === DEFAULT_SANDBOX_IMAGE
        ),
      step: `the atm.run rows report the turn as contained on ${DEFAULT_SANDBOX_IMAGE}`,
    });

    const containers = sandboxRows({
      path: input.ledgerPath,
      runId: input.runId,
    });
    const container = containers.find((row) => row.phase === "end");
    yield* check({
      detail: `found ${containers.length} atm.sandbox rows; the terminus says kind ${container?.kind}, container ${container?.containerId}, ${container?.mountCount} mounts, exit ${container?.exitCode}`,
      ok:
        container?.kind === "docker" &&
        container.containerId !== null &&
        container.exitCode === TURN_EXIT_CODE.completed,
      step: "a real container served this turn and the daemon says it exited cleanly",
    });

    const turns = turnRows({ dataRoot: input.dataRoot, runId: input.runId });
    const last = turns.at(-1);
    yield* check({
      detail: `found ${turns.length} atm.turn rows under this run's own directory; the last reports ${last?.eventsSeen} events from ${last?.model}, ending ${last?.outcome}`,
      ok: turns.some((row) => row.phase === "end" && row.model === STUB_MODEL),
      step: "the atm.turn row written inside the container came back out on the run id the host minted",
    });
  });
