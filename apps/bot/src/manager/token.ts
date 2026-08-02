/**
 * The credential one manager turn holds, and how it reaches the container.
 *
 * **Minted per turn, and short.** Nothing can recall a token, so the defence is
 * that it expires before it is worth stealing. A turn is seconds to minutes; a
 * quarter of an hour is generous. The token is not bound to a task, because the
 * manager works across the whole board — what bounds it is its scope, and
 * `task-write` is the ceiling a `manager` actor may hold at mint *and* at
 * verify, so it cannot reach a delete even if this file asks for more.
 *
 * **It carries the conversation.** The actor on the token is
 * `{ kind: "manager", threadId, userId }`, which is what the gateway writes on
 * the audit row of every change the turn causes. That is the one fact the
 * notification router later reads back: "which conversation edited this task"
 * is an index scan rather than a guess.
 *
 * **It travels on a mount, not in the environment and not in argv.** A server
 * entry in `<threadRunDir>/mcp-servers.json` is read by the container's own
 * entrypoint through the run mount; an environment variable is printed by
 * `docker inspect` to anyone who can reach the daemon, and an argv is printed by
 * `ps` to every process on the host. The file is written before the container
 * starts and deleted after it exits — {@link withMcpServersFile} is that pair,
 * held together so a turn that fails cannot leave the credential on disk.
 */

import type { ThreadId, UserId, WorkspaceId } from "@workspace/domain";
import {
  CONTAINER_MANAGER_MCP_PATH,
  managerMcpServersFile,
} from "@workspace/manager-tools";
import type { TokenSigner } from "@workspace/token";
import { Duration, Effect, Redacted } from "effect";
import { FileSystem } from "effect/FileSystem";

/** How long a turn's token lives unless the deployment says otherwise. */
export const DEFAULT_MANAGER_TOKEN_TTL_MS = 900_000;

/** Which scope a manager turn holds. The ceiling for its actor kind, and no more. */
const MANAGER_SCOPE = "task-write" as const;

/** Who the token speaks as, and for how long. */
export interface ManagerTokenInput {
  readonly signer: TokenSigner;
  /**
   * Null only where no conversation caused the write — a repair pass, a scan.
   * The claim is then absent rather than present-and-empty, so "which
   * conversation edited this task" has no answer instead of a wrong one.
   */
  readonly threadId: ThreadId | null;
  readonly ttlMs?: number;
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
}

/**
 * A fresh token for one turn, redacted so it cannot be logged by accident.
 *
 * Fails with the signer's own `TokenRejected` where the mint is refused, which
 * in practice means this file asked for more than a manager may hold — a bug,
 * and one worth failing the turn over rather than running an agent with no
 * board access and letting it narrate the 401s.
 */
export const mintManagerToken = Effect.fn("Manager.mintToken")(function* (
  input: ManagerTokenInput
) {
  const token = yield* input.signer.mint({
    actor: {
      kind: "manager",
      ...(input.threadId === null ? {} : { threadId: input.threadId }),
      userId: input.userId,
    },
    scope: MANAGER_SCOPE,
    ttl: Duration.millis(input.ttlMs ?? DEFAULT_MANAGER_TOKEN_TTL_MS),
    workspaceId: input.workspaceId,
  });
  return Redacted.make(token);
});

/** What the servers file names: where to reach the board, and as whom. */
export interface McpServersFileInput {
  readonly gatewayUrl: string;
  /** `mcpServersPathOf` applied to the thread's run layout. */
  readonly path: string;
  readonly token: Redacted.Redacted<string>;
}

/**
 * Writes the file, runs the turn, and deletes the file — on every exit path,
 * including an interrupt.
 *
 * A bracket rather than two calls a caller sequences, because the failure this
 * guards against is precisely the one a caller forgets: a turn that crashed
 * leaves a live bearer token in a directory that outlives it by design, since
 * the thread's run directory is reused by the next turn and read after this one
 * by whoever is debugging it.
 *
 * The removal is best-effort. A file that could not be deleted is a warning and
 * a token that expires on its own; failing the turn over it would report a
 * cleanup problem as the model's answer.
 */
export const withMcpServersFile = <A, E, R>(
  input: McpServersFileInput,
  work: Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const contents = managerMcpServersFile({
      bundlePath: CONTAINER_MANAGER_MCP_PATH,
      gatewayUrl: input.gatewayUrl,
      token: input.token,
    });
    return yield* Effect.acquireUseRelease(
      fs.writeFileString(input.path, `${JSON.stringify(contents)}\n`),
      () => work,
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
