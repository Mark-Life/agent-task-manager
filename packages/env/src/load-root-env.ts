import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

/** How many parent directories to walk up before giving up. */
const MAX_DEPTH = 10;

/**
 * Loads .env and .env.local from monorepo root into process.env.
 * Does not override existing env vars (existing values take precedence).
 */
const findMonorepoRoot = () => {
  let dir = import.meta.dirname;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    if (existsSync(resolve(dir, "turbo.json"))) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
};

const root = findMonorepoRoot();

if (root) {
  config({ override: false, path: resolve(root, ".env") });
  config({ override: false, path: resolve(root, ".env.local") });
}
