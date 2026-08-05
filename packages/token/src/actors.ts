/**
 * The credential one agent turn holds, minted the same way for both roles.
 *
 * **The manager's tools are a superset of the worker's, and the token is why.**
 * There is one MCP server, one tool list and one scope — `task-write`, the
 * ceiling both actor kinds may hold. What differs is the binding: a worker's
 * actor names the task it was dispatched for, and the gateway's access
 * middleware refuses a write to any other one; a manager's names the
 * conversation it is answering in and is bound to no task, so it reaches the
 * whole board. That is one narrower binding of one credential rather than two
 * tool lists, which is what makes the superset a property nobody has to
 * maintain.
 *
 * **Short, and minted again while the turn runs.** Nothing can recall a token,
 * so the defence is that it expires before it is worth stealing — a quarter of
 * an hour, whatever the turn's own length. What keeps a long turn working is
 * that the orchestrator mints another one and replaces the credential the turn
 * reads (`scopedRollingToken` in `@workspace/orchestrator`), rather than this
 * lifetime being stretched to cover the work.
 *
 * **It carries who acted.** The actor on the token is what the gateway writes
 * on the audit row of every change the turn causes, which is what makes "which
 * conversation edited this task" and "which run edited this task" index scans
 * rather than guesses.
 */

import type {
  AgentSessionId,
  RunId,
  TaskId,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@workspace/domain";
import { Duration, Effect, Redacted } from "effect";
import type { TokenSigner } from "./tokens";

/** How long a turn's token lives unless the deployment says otherwise. */
export const DEFAULT_AGENT_TOKEN_TTL_MS = 900_000;

/**
 * Which scope an agent turn holds. The ceiling for both actor kinds, and no
 * more — a token asking past it is refused at mint as well as at verify, so the
 * limit holds even if this file has a bug.
 */
const AGENT_SCOPE = "task-write" as const;

/** A worker run's binding: the run, its session, and the one task it may write. */
export interface WorkerRunBinding {
  readonly kind: "worker_run";
  readonly runId: RunId;
  readonly sessionId: AgentSessionId;
  readonly taskId: TaskId;
}

/**
 * A manager's binding: the conversation, and the person it is answering.
 *
 * `threadId` is null only where no conversation caused the write — a repair
 * pass, a scan. The claim is then absent rather than present-and-empty, so
 * "which conversation edited this task" has no answer instead of a wrong one.
 */
export interface ManagerBinding {
  readonly kind: "manager";
  readonly threadId: ThreadId | null;
  readonly userId: UserId;
}

/** Who a minted token speaks as. */
export type AgentBinding = ManagerBinding | WorkerRunBinding;

/** Who the token speaks as, for how long, and in which workspace. */
export interface AgentTokenInput {
  readonly binding: AgentBinding;
  readonly signer: TokenSigner;
  readonly ttlMs?: number;
  readonly workspaceId: WorkspaceId;
}

/** The binding as the domain's actor union spells it. */
const actorOf = (binding: AgentBinding) =>
  binding.kind === "worker_run"
    ? {
        kind: "worker_run" as const,
        runId: binding.runId,
        sessionId: binding.sessionId,
        taskId: binding.taskId,
      }
    : {
        kind: "manager" as const,
        ...(binding.threadId === null ? {} : { threadId: binding.threadId }),
        userId: binding.userId,
      };

/**
 * A fresh token for one turn, redacted so it cannot be logged by accident.
 *
 * Fails with the signer's own `TokenRejected` where the mint is refused, which
 * in practice means this file asked for more than the actor may hold — a bug,
 * and one worth failing the turn over rather than running an agent with no
 * board access and letting it narrate the 401s.
 */
export const mintAgentToken = Effect.fn("Token.mintAgent")(function* (
  input: AgentTokenInput
) {
  const token = yield* input.signer.mint({
    actor: actorOf(input.binding),
    scope: AGENT_SCOPE,
    ttl: Duration.millis(input.ttlMs ?? DEFAULT_AGENT_TOKEN_TTL_MS),
    workspaceId: input.workspaceId,
  });
  return Redacted.make(token);
});
