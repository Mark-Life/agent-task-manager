/**
 * Where the bundled server lives, on the host and inside the container.
 *
 * One spelling of each path, exported rather than repeated: the build script
 * writes exactly here, the turn copies exactly this file onto the run mount,
 * and the provider is told exactly this command. A second spelling anywhere is
 * a manager whose board tools silently fail to start, which reads to a person
 * as the manager having decided not to use them.
 */

import { join } from "node:path";
import { CONTAINER_RUN_DIR } from "@workspace/harness";

/** Directory under the data root holding the bundles a container is handed. */
export const AGENT_MCP_SEGMENT = "bin";

/** The bundle's file name, on the host and inside the container alike. */
export const AGENT_MCP_BUNDLE_FILE = "agent-mcp.js";

/** The bundle on the host, under the data root. The build script writes exactly here. */
export const agentMcpBundlePathOf = (dataRoot: string) =>
  join(dataRoot, AGENT_MCP_SEGMENT, AGENT_MCP_BUNDLE_FILE);

/**
 * The copy the provider launches, on the run mount.
 *
 * A copy per thread rather than a fourth read-only mount: the run directory is
 * already mounted read-write, and one file copy per turn costs less than
 * another entry in the mount set that every reader of `mountsFor` then has to
 * account for.
 */
export const CONTAINER_AGENT_MCP_PATH = join(
  CONTAINER_RUN_DIR,
  AGENT_MCP_BUNDLE_FILE
);

/** The bundle inside one thread's run directory on the host, which is what gets copied. */
export const agentMcpRunCopyPathOf = (threadRunDir: string) =>
  join(threadRunDir, AGENT_MCP_BUNDLE_FILE);

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
