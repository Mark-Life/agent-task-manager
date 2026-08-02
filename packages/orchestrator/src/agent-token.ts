/**
 * How a turn's board credential reaches the container it is for.
 *
 * **It travels on a mount, not in the environment and not in argv.** A server
 * entry in `<runDir>/mcp-servers.json` is read by the container's own
 * entrypoint through the run mount; an environment variable is printed by
 * `docker inspect` to anyone who can reach the daemon, and an argv is printed
 * by `ps` to every process on the host. The file is written before the
 * container starts and removed when the run's scope closes —
 * {@link scopedMcpServersFile} is that pair, held together so a turn that
 * fails cannot leave the credential on disk.
 *
 * **The bundle is a copy onto the same mount.** The run directory is already
 * mounted read-write, so one file copy per turn costs less than another entry
 * in the mount set that every reader of `mountsFor` then has to account for.
 * The bundle is built once per host; a run that cannot find it fails rather
 * than starting an agent with no way to reach the board, because what such an
 * agent answers is a confident account of tasks it did not file.
 *
 * Which actor the token speaks as is {@link bindingOf} and nothing else: a
 * worker is bound to its one task, a manager to its conversation. That single
 * difference is the whole of it: the manager's reach is a wider binding of the
 * same credential, not a second tool list.
 */

import {
  agentMcpBundlePathOf,
  agentMcpRunCopyPathOf,
  agentMcpServersFile,
  CONTAINER_AGENT_MCP_PATH,
} from "@workspace/agent-tools";
import type { AgentBinding } from "@workspace/token";
import { Effect, type Redacted, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { type DispatchContext, sessionIdOf } from "./dispatch-context";

/**
 * The agent's board tools are not built on this host.
 *
 * Its own failure rather than a warning, for the reason the module note gives:
 * an agent with no way to reach the board answers anyway.
 */
export class AgentBundleMissing extends Schema.TaggedErrorClass<AgentBundleMissing>()(
  "Orchestrator.AgentBundleMissing",
  { path: Schema.String }
) {
  override get message() {
    return `the agent's board tools are not built: ${this.path}`;
  }
}

/**
 * Who this run's token speaks as. The one place the role changes what a
 * credential can reach, and it changes only what it is bound to.
 */
export const bindingOf = (context: DispatchContext): AgentBinding =>
  context.attached.role === "worker"
    ? {
        kind: "worker_run",
        runId: context.runId,
        sessionId: sessionIdOf(context),
        taskId: context.attached.task.id,
      }
    : {
        kind: "manager",
        threadId: context.attached.thread.id,
        userId: context.attached.thread.userId,
      };

/** Copies the board tools onto the run mount the container reads them from. */
export const copyAgentBundle = Effect.fn("Run.copyAgentBundle")(
  function* (input: { readonly dataRoot: string; readonly runDir: string }) {
    const fs = yield* FileSystem;
    const bundlePath = agentMcpBundlePathOf(input.dataRoot);
    const present = yield* fs
      .exists(bundlePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!present) {
      return yield* Effect.fail(new AgentBundleMissing({ path: bundlePath }));
    }
    const copy = agentMcpRunCopyPathOf(input.runDir);
    yield* fs
      .copyFile(bundlePath, copy)
      .pipe(
        Effect.mapError(() => new AgentBundleMissing({ path: bundlePath }))
      );
    return copy;
  }
);

/** What the servers file names: where to reach the board, and as whom. */
export interface McpServersFileInput {
  readonly gatewayUrl: string;
  /** `mcpServersPathOf` applied to the run's layout. */
  readonly path: string;
  readonly token: Redacted.Redacted<string>;
}

/**
 * Writes the file into the ambient scope, and deletes it when that scope closes
 * — on every exit path, including an interrupt.
 *
 * Acquired rather than written and later remembered, because the failure this
 * guards against is precisely the one a caller forgets: a turn that crashed
 * leaves a live bearer token in a directory that outlives it by design, since
 * the run directory is what the ingest, the transcript and anyone debugging the
 * run read afterwards.
 *
 * The removal is best-effort. A file that could not be deleted is a warning and
 * a token that expires on its own; failing the turn over it would report a
 * cleanup problem as the model's answer.
 */
export const scopedMcpServersFile = Effect.fnUntraced(function* (
  input: McpServersFileInput
) {
  const fs = yield* FileSystem;
  const contents = agentMcpServersFile({
    bundlePath: CONTAINER_AGENT_MCP_PATH,
    gatewayUrl: input.gatewayUrl,
    token: input.token,
  });
  return yield* Effect.acquireRelease(
    fs
      .writeFileString(input.path, `${JSON.stringify(contents)}\n`)
      .pipe(Effect.as(input.path)),
    () =>
      fs.remove(input.path, { force: true }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("mcp servers file not removed", {
            cause,
            path: input.path,
          })
        ),
        Effect.ignore
      )
  );
});
