/**
 * That a message stranded on disk is found.
 *
 * A real directory rather than a stubbed filesystem, because the claim is
 * entirely about where the file is: the reader has to look in the task's own
 * artifacts folder, under the name the prompt told the agent to use, in the
 * layout `@workspace/sandbox` lays out. A fake that answers whatever path it is
 * asked for would agree with a reader looking in the wrong place, which is the
 * only interesting way this can be wrong.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { HANDOFF_FILENAME, TaskId } from "@workspace/domain";
import { taskArtifactsDirOf } from "@workspace/sandbox";
import { Effect } from "effect";
import { handoffPathOf, readHandoff } from "./handoff";

const dataRoot = mkdtempSync(join(tmpdir(), "atm-handoff-test-"));

afterAll(() => {
  rmSync(dataRoot, { force: true, recursive: true });
});

/** What the reporting worker actually wrote, in the shape it wrote it. */
const HANDOFF_BODY = `## What I did

Rewrote the dispatcher's lease handling.

The run's atm MCP token expired part-way through, so this is a file rather
than a message.`;

let next = 0;
/** A task with its own artifacts directory, holding whatever the run left there. */
const taskWith = (contents: string | null) => {
  next += 1;
  const taskId = TaskId.make(
    `0199a000-0000-7000-8000-00000000000${next.toString(16)}`
  );
  const directory = taskArtifactsDirOf({ dataRoot, taskId });
  mkdirSync(directory, { recursive: true });
  if (contents !== null) {
    writeFileSync(join(directory, HANDOFF_FILENAME), contents);
  }
  return taskId;
};

const read = (taskId: TaskId) =>
  Effect.runPromise(
    readHandoff({ dataRoot, taskId }).pipe(Effect.provide(BunFileSystem.layer))
  );

describe("handoffPathOf", () => {
  test("points at the one directory that outlives the container", () => {
    const taskId = TaskId.make("0199a000-0000-7000-8000-0000000000ff");
    expect(handoffPathOf({ dataRoot, taskId })).toBe(
      join(taskArtifactsDirOf({ dataRoot, taskId }), HANDOFF_FILENAME)
    );
  });
});

describe("readHandoff", () => {
  test("reads back what a run that could not reach the board wrote", async () => {
    const handoff = await read(taskWith(HANDOFF_BODY));

    expect(handoff?.body).toBe(HANDOFF_BODY);
    expect(handoff?.path).toContain(HANDOFF_FILENAME);
  });

  test("answers nothing for the ordinary run, which writes none", async () => {
    expect(await read(taskWith(null))).toBeNull();
  });

  test("answers nothing where the task has no artifacts directory at all", async () => {
    // A run that failed before the directory was made. The teardown still asks.
    const taskId = TaskId.make("0199a000-0000-7000-8000-0000000000fe");
    expect(await read(taskId)).toBeNull();
  });

  test("treats a blank file as nothing to say", async () => {
    // The agent created the file and then posted through the tool after all.
    // A blank message on the card reads as a run that had nothing to report.
    expect(await read(taskWith("\n  \n\t\n"))).toBeNull();
  });

  test("keeps the file where it was, so the rescan still indexes it", async () => {
    // The handoff is a message *and* an artifact. Consuming it would take the
    // run's only surviving output off the card the moment it was read.
    const taskId = taskWith(HANDOFF_BODY);
    await read(taskId);
    const again = await read(taskId);

    expect(again?.body).toBe(HANDOFF_BODY);
  });
});
