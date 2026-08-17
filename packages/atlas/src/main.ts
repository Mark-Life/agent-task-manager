/** Entry point of `bun run atlas`. */

import { run } from "./cli";

await run(Bun.argv.slice(2));
