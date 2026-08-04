/**
 * Writes the OpenAPI document to disk.
 *
 * The spec is derived, never edited: `packages/api` is the source and this
 * turns it into the file a connector, a code generator or a reviewer reads. It
 * is checked in so a change to the contract shows up as a diff on the document
 * in the same commit — which is the only way "we did not mean to change the
 * public surface" is a question anybody answers before shipping.
 *
 * `bun run openapi` writes it. `bun run openapi --check` writes nothing and
 * exits non-zero when the file on disk has drifted from the contract, which is
 * what CI runs.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { makeOpenApiSpec } from "@workspace/api";

/** Where the document lives, relative to the repository root. */
const SPEC_PATH = join(import.meta.dir, "..", "openapi.json");

/** Exit code for a stale checked-in document. Non-zero: CI has to fail on it. */
const DRIFTED_EXIT_CODE = 1;

const render = () => `${JSON.stringify(makeOpenApiSpec(), null, 2)}\n`;

const check = async (document: string) => {
  const current = await readFile(SPEC_PATH, "utf8").catch(() => null);
  if (current === document) {
    process.stdout.write("openapi: up to date\n");
    return;
  }
  process.stderr.write(
    `openapi: ${SPEC_PATH} is stale — run \`bun run openapi\`\n`
  );
  process.exitCode = DRIFTED_EXIT_CODE;
};

const write = async (document: string) => {
  await mkdir(dirname(SPEC_PATH), { recursive: true });
  await writeFile(SPEC_PATH, document);
  process.stdout.write(`openapi: wrote ${SPEC_PATH}\n`);
};

const rendered = render();

if (process.argv.includes("--check")) {
  await check(rendered);
} else {
  await write(rendered);
}
