/**
 * Reading the payload a harness writes to stdin — once, for both readers of it.
 *
 * The stop hook exists twice: as `scripts/stop-hook.ts` for a run outside a
 * container, and as the container entrypoint's `--stop-hook` mode, which is what
 * every real turn uses. Both are handed one JSON document on stdin and both had
 * their own copy of this read, which is how one bug came to live in two places.
 */

import { readFileSync } from "node:fs";

/** Standard input, by the number every process knows it as. */
const STDIN_FD = 0;

/**
 * Everything written to stdin, as one string.
 *
 * A blocking read of the file descriptor, not `for await (… of process.stdin)`,
 * and the difference is not stylistic. Iterating the stream yields **zero
 * chunks** under Bun 1.3.14 when the reader is the bundled entrypoint and the
 * parent is another Bun process: the payload is written, the pipe closes, and
 * the loop ends having seen none of it. The same loop in a small script reads
 * the same payload correctly, and so does the bundle when its parent is a
 * shell — so nothing about the calling code says which case it is in.
 *
 * What makes that worth spelling out is how it fails. The only caller is a stop
 * hook that fails open on purpose — an unreadable payload must never be the
 * thing that wedges a run — so an empty read is not an error anywhere. It is a
 * refusal silently becoming an allow: nothing throws, nothing is logged, and the
 * only symptom is turns ending without the comment the hook exists to require.
 *
 * Blocking costs nothing here. The process was started to answer one question,
 * the payload is already in the pipe, and there is nothing else for it to do
 * while it reads.
 */
export const readStdin = () => readFileSync(STDIN_FD, "utf8");
