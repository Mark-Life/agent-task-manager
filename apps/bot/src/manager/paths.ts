/**
 * Where one conversation's files live on the host.
 *
 * The layout is per *thread*, not per turn, and that is the whole reason this
 * file exists rather than the manager reusing `runDirOf`. A vendor keeps its
 * transcript inside the agent home, so a fresh agent home every turn is a fresh
 * conversation every turn — the provider would have nothing to resume even
 * where the thread row names a session. One directory per thread, reused for
 * as long as the conversation lives, is what makes a resume possible at all.
 *
 * Inside it the shape is the ordinary one: `runLayout` applied to the thread's
 * run directory, so the container's view is the same `containerRunLayout` every
 * other turn gets and the harness needs no second spelling of anything. The
 * workspace is a sibling of the run directory rather than a child, for the
 * reason `packages/sandbox`'s does: the run directory holds the provider's
 * credentials and is mounted whole, and a scratch tree the agent writes into
 * does not belong inside it.
 *
 * Nothing here touches a disk.
 */

import { join } from "node:path";
import type { ThreadId } from "@workspace/domain";
import { runLayout } from "@workspace/harness";

/** Directory under the data root holding one subdirectory per conversation. */
export const THREADS_SEGMENT = "threads";

/** The conversation's run directory: agent home, event ledger, spec, result. */
export const THREAD_RUN_SEGMENT = "run";

/**
 * The conversation's scratch directory, mounted at `/workspace`.
 *
 * Empty, and it stays empty. The manager has no repo and no checkout — it
 * reads and writes the board over HTTP — so this is only what a CLI needs for
 * a working directory and its temporary files.
 */
export const THREAD_WORKSPACE_SEGMENT = "workspace";

/** What names one conversation's directories on the host. */
export interface ThreadDirInput {
  readonly dataRoot: string;
  readonly threadId: ThreadId;
}

/** The conversation's own directory, under the data root. */
export const threadDirOf = (input: ThreadDirInput) =>
  join(input.dataRoot, THREADS_SEGMENT, input.threadId);

/** The conversation's run directory, which is what gets mounted at `/run`. */
export const threadRunDirOf = (input: ThreadDirInput) =>
  join(threadDirOf(input), THREAD_RUN_SEGMENT);

/** The conversation's scratch directory, which gets mounted at `/workspace`. */
export const threadWorkspaceDirOf = (input: ThreadDirInput) =>
  join(threadDirOf(input), THREAD_WORKSPACE_SEGMENT);

/**
 * The run layout as the host sees it for this conversation — the same algebra
 * the orchestrator applies to a run directory, applied to a thread's.
 */
export const threadRunLayout = (input: ThreadDirInput) =>
  runLayout(threadRunDirOf(input));
