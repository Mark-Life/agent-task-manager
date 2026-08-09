/**
 * Where the bundled server lives on the host, and the credential it reads.
 *
 * One spelling of each path, exported rather than repeated: the build script
 * writes exactly here, the run mounts exactly this file, and the provider is
 * told exactly this command. A second spelling anywhere is a manager whose
 * board tools silently fail to start, which reads to a person as the manager
 * having decided not to use them.
 *
 * The container's side of the bundle is `CONTAINER_AGENT_MCP_PATH` in
 * `@workspace/harness`, beside the entrypoint's, because the mount set that
 * puts it there is built by a package that cannot import this one.
 */

import { join } from "node:path";
import { CONTAINER_RUN_DIR } from "@workspace/harness";

/** Directory under the data root holding the bundles a container is handed. */
export const AGENT_MCP_SEGMENT = "bin";

/** The bundle's file name, on the host and inside the container alike. */
export const AGENT_MCP_BUNDLE_FILE = "agent-mcp.js";

/**
 * The bundle on the host, under the data root. The build script writes exactly
 * here, and every run mounts exactly this file.
 *
 * One file for the whole host, read-only, rather than a copy per run. It used
 * to be a copy, on the argument that the run directory was already mounted and
 * one file copy per turn cost less than another entry in the mount set. The
 * numbers did not hold: the bundle is about 1.7 MB and a run directory keeps
 * everything it was given, so 191 runs on one host were carrying 321 MB of the
 * same four builds — 77% of the whole `runs/` tree, growing with the run count
 * and reclaimable only by hand. One entry in `mountsFor` is the price of a
 * directory that stops growing.
 */
export const agentMcpBundlePathOf = (dataRoot: string) =>
  join(dataRoot, AGENT_MCP_SEGMENT, AGENT_MCP_BUNDLE_FILE);

/**
 * Where a build in progress is written before it is renamed into place.
 *
 * The rename is what makes the shared file safe to mount. A bundler writing
 * straight to the mounted path truncates it, and a container starting in that
 * window launches half a file; a rename replaces the directory entry in one
 * step, and a bind mount already made holds the old inode until its run ends —
 * so a rebuild on a live host never reaches a turn that is already going.
 */
export const agentMcpPendingPathOf = (dataRoot: string) =>
  `${agentMcpBundlePathOf(dataRoot)}.next`;

/**
 * The file the board credential is rolled through.
 *
 * Beside the bundle rather than inside it, because the two have opposite
 * lifetimes: the bundle is written once per turn and never changes, and this is
 * rewritten every few minutes for as long as the turn lasts. Reading it is what
 * the server does per request, so a turn of any length holds a credential that
 * was minted minutes ago rather than one minted when the container started.
 *
 * Deleting it is what ends the turn's access — the only revocation this
 * credential shape has, and the reason nothing caches what it read.
 */
export const AGENT_TOKEN_FILE = "agent-token";

/** The rolling credential in one run directory on the host, which is what gets written. */
export const agentTokenPathOf = (threadRunDir: string) =>
  join(threadRunDir, AGENT_TOKEN_FILE);

/** The same file as the container sees it, which is what the server is told to read. */
export const CONTAINER_AGENT_TOKEN_PATH = join(
  CONTAINER_RUN_DIR,
  AGENT_TOKEN_FILE
);
