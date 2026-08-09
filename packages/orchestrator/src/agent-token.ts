/**
 * How a turn's board credential reaches the container it is for, and how it
 * stays valid for as long as the turn lasts.
 *
 * **It rolls.** A token is minted with a short life and written to a file on
 * the run mount; a fiber in the run's scope rewrites that file every
 * {@link refreshPeriodOf} for as long as the turn is alive, and the server
 * inside the container reads the file per request. So the lifetime of the
 * credential and the length of the run are no longer one number that has to be
 * guessed right in advance: a run of any length holds a token minted minutes
 * ago, and a token that escapes the mount is worth minutes rather than a day.
 * That number used to be set from the turn's own deadline, which made a
 * twelve-hour run carry a twelve-hour credential and a deployment that pinned
 * fifteen minutes lose the board at minute fifteen — {@link scopedRollingToken}
 * is what makes both of those the same short-lived file.
 *
 * **Deleting the file is the revocation.** Nothing caches what it read, so the
 * run's access ends when the scope closes and the file goes, rather than
 * whenever the last token it held happens to expire.
 *
 * **It travels on a mount, not in the environment and not in argv.** A server
 * entry in `<runDir>/mcp-servers.json` is read by the container's own
 * entrypoint through the run mount; an environment variable is printed by
 * `docker inspect` to anyone who can reach the daemon, and an argv is printed
 * by `ps` to every process on the host. That entry now names the credential's
 * path rather than carrying its value. The file is written before the container
 * starts and removed when the run's scope closes — {@link scopedMcpServersFile}
 * is that pair, held together so a turn that fails cannot leave the credential
 * on disk.
 *
 * **The bundle is one file on the host, mounted read-only.** It was a copy onto
 * the run mount, on the argument that one file copy per turn cost less than
 * another entry in the mount set. It did not: the bundle is about 1.7 MB, a run
 * directory keeps what it was given, and on the first host to be measured 184
 * copies of four distinct builds were 77% of everything under `runs/`. So
 * {@link agentBundlePath} checks the one built file and hands its path to the
 * mount set instead. A run that cannot find it fails rather than starting an
 * agent with no way to reach the board, because what such an agent answers is a
 * confident account of tasks it did not file.
 *
 * Which actor the token speaks as is {@link bindingOf} and nothing else: a
 * worker is bound to its one task, a manager to its conversation. That single
 * difference is the whole of it: the manager's reach is a wider binding of the
 * same credential, not a second tool list.
 */

import {
  agentMcpBundlePathOf,
  agentMcpServersFile,
  CONTAINER_AGENT_TOKEN_PATH,
} from "@workspace/agent-tools";
import type { WorkspaceId } from "@workspace/domain";
import { CONTAINER_AGENT_MCP_PATH } from "@workspace/harness";
import {
  type AgentBinding,
  mintAgentToken,
  type TokenSigner,
} from "@workspace/token";
import { Effect, Redacted, Schema } from "effect";
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
 * How many times a token is replaced within its own lifetime.
 *
 * Three, so a refresh that fails has two more attempts before the credential on
 * the mount goes stale, and the gateway is never asked to accept a token minted
 * more than a third of a lifetime ago — which is the slack that absorbs clock
 * skew between the host that signs and the container that presents.
 */
const REFRESHES_PER_LIFETIME = 3;

/**
 * The floor on the refresh period. A deployment that asks for a very short
 * lifetime gets a short one; what it does not get is a fiber rewriting the same
 * file hundreds of times a minute.
 */
const MIN_REFRESH_MS = 10_000;

/** How often the credential on the mount is replaced, for a token that lives `ttlMs`. */
export const refreshPeriodOf = (ttlMs: number) =>
  Math.max(MIN_REFRESH_MS, Math.floor(ttlMs / REFRESHES_PER_LIFETIME));

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

/**
 * The board tools on this host, having checked they are there.
 *
 * The check is the whole of it, and it is why this is not simply
 * `agentMcpBundlePathOf` at the call site. The path goes into the mount set, so
 * a host that never bundled would otherwise fail as a mount source the daemon
 * could not find — the same run lost, told as a Docker problem — and a turn
 * running as a host process would get no error at all, only a provider that
 * quietly starts no server.
 */
export const agentBundlePath = Effect.fn("Run.agentBundlePath")(
  function* (input: { readonly dataRoot: string }) {
    const fs = yield* FileSystem;
    const bundlePath = agentMcpBundlePathOf(input.dataRoot);
    const present = yield* fs
      .exists(bundlePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!present) {
      return yield* Effect.fail(new AgentBundleMissing({ path: bundlePath }));
    }
    return bundlePath;
  }
);

/** What one run's rolling credential is made of, and where it is written. */
export interface RollingTokenInput {
  readonly binding: AgentBinding;
  /** `agentTokenPathOf` applied to the run directory, **as this host sees it**. */
  readonly path: string;
  readonly signer: TokenSigner;
  /** How long each minted token lives. Each is replaced well before it ends. */
  readonly ttlMs: number;
  readonly workspaceId: WorkspaceId;
}

/**
 * Keeps a live board credential in a file for as long as the ambient scope is
 * open, and takes it away when the scope closes.
 *
 * **The first write is the acquire, so a run that cannot mint never starts.** A
 * refused mint means this loop asked for more than the actor may hold, which is
 * a bug worth failing the turn over rather than dispatching an agent that will
 * narrate its 401s.
 *
 * **Later writes are best-effort and loud.** By then the container is running,
 * and one failed mint is not worth killing a turn that still holds a valid
 * token for two more periods — but it is worth an error line, because the third
 * one in a row is a run about to lose the board.
 *
 * **The replacement is a rename.** The server inside the container reads this
 * file on every request with no lock and no retry, so it has to be whole at
 * every instant: a write in place has a window where it is half a token, and a
 * rename within the same directory has none.
 */
export const scopedRollingToken = Effect.fnUntraced(function* (
  input: RollingTokenInput
) {
  const fs = yield* FileSystem;
  const pending = `${input.path}.next`;

  const write = Effect.gen(function* () {
    const token = yield* mintAgentToken({
      binding: input.binding,
      signer: input.signer,
      ttlMs: input.ttlMs,
      workspaceId: input.workspaceId,
    });
    yield* fs.writeFileString(pending, Redacted.value(token));
    yield* fs.rename(pending, input.path);
  });

  yield* Effect.acquireRelease(write, () =>
    Effect.forEach([input.path, pending], (path) =>
      fs.remove(path, { force: true }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("board credential not removed", { cause, path })
        ),
        Effect.ignore
      )
    )
  );

  // Forked into the run's scope: it is interrupted with the turn, so nothing
  // rewrites a credential for a run that has ended.
  yield* Effect.forkScoped(
    Effect.sleep(refreshPeriodOf(input.ttlMs)).pipe(
      Effect.andThen(
        write.pipe(
          Effect.tapError((cause) =>
            Effect.logError("board credential not refreshed", {
              cause,
              path: input.path,
            })
          ),
          Effect.ignore
        )
      ),
      Effect.forever
    )
  );

  return input.path;
});

/** What the servers file names: where to reach the board, and as whom. */
export interface McpServersFileInput {
  readonly gatewayUrl: string;
  /** `mcpServersPathOf` applied to the run's layout. */
  readonly path: string;
}

/**
 * Writes the file into the ambient scope, and deletes it when that scope closes
 * — on every exit path, including an interrupt.
 *
 * Both paths it names are the container's own, because the container's
 * entrypoint is the only reader this file has: a host-side turn is handed the
 * same server map directly, spelled in host paths. Naming them here rather than
 * taking them from the caller is what keeps the two spellings from being
 * swapped, which is a turn whose tools cannot find their own credential.
 *
 * Acquired rather than written and later remembered, because the failure this
 * guards against is precisely the one a caller forgets: a turn that crashed
 * leaves the run pointed at a live credential in a directory that outlives it by
 * design, since the run directory is what the ingest, the transcript and anyone
 * debugging the run read afterwards.
 *
 * The removal is best-effort. A file that could not be deleted is a warning, and
 * the credential it names is removed by {@link scopedRollingToken} on the same
 * exit path; failing the turn over it would report a cleanup problem as the
 * model's answer.
 */
export const scopedMcpServersFile = Effect.fnUntraced(function* (
  input: McpServersFileInput
) {
  const fs = yield* FileSystem;
  const contents = agentMcpServersFile({
    bundlePath: CONTAINER_AGENT_MCP_PATH,
    credential: { kind: "file", path: CONTAINER_AGENT_TOKEN_PATH },
    gatewayUrl: input.gatewayUrl,
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
