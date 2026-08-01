#!/usr/bin/env bun
/**
 * The stop hook, as both harnesses invoke it: a process that reads one JSON
 * payload on stdin and writes one JSON response on stdout.
 *
 * It runs inside the sandbox container, on the critical path of every turn
 * ending, so it stays a filesystem read and a `switch`. No database, no
 * gateway call, no telemetry — the rule it enforces is decided in
 * `src/stop-hook.ts` and the only fact it gathers is whether the run's comment
 * marker exists.
 *
 * Every failure allows the turn to end. A hook that throws, hangs or writes
 * nothing is a run that cannot finish, which is a far worse outcome than a run
 * that finishes without a comment — the orchestrator appends the final message
 * as a fallback comment in exactly that case.
 */

import { existsSync } from "node:fs";
import process from "node:process";
import {
  ALLOW_TURN_END,
  commentMarkerPath,
  decideStop,
  parseStopHookPayload,
  stopHookResponseOf,
} from "../src/stop-hook";

/**
 * Everything the harness wrote to stdin. Chunk-wise rather than a one-shot
 * read, because the payload carries the final assistant message and outgrows a
 * pipe buffer on any turn worth hooking.
 */
const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** The parsed payload, or null when stdin held something that was not JSON. */
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** One line of JSON on stdout — the only thing either harness reads from us. */
const respond = (response: unknown) => {
  process.stdout.write(`${JSON.stringify(response)}\n`);
};

try {
  const payload = parseStopHookPayload(parseJson(await readStdin()));
  const decision = decideStop({
    commentPosted: existsSync(commentMarkerPath(process.env)),
    payload,
  });
  respond(stopHookResponseOf(decision));
} catch {
  respond(ALLOW_TURN_END);
}
