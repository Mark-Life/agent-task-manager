/**
 * The claims worth pinning are the ones a container silently breaks on: that a
 * conversation's directories are keyed by the thread rather than by the turn,
 * that the workspace is not inside the run mount, and that the layout the host
 * computes is the one the harness computes.
 */

import { describe, expect, test } from "bun:test";
import { newThreadId } from "@workspace/domain";
import { containerRunLayout, runLayout } from "@workspace/harness";
import {
  threadDirOf,
  threadRunDirOf,
  threadRunLayout,
  threadWorkspaceDirOf,
} from "./paths";

const dataRoot = "/data";
const threadId = newThreadId();

describe("thread directories", () => {
  test("every path a conversation has is keyed by the thread and nothing else", () => {
    const input = { dataRoot, threadId };
    expect(threadDirOf(input)).toBe(`/data/threads/${threadId}`);
    expect(threadRunDirOf(input)).toBe(`/data/threads/${threadId}/run`);
    expect(threadWorkspaceDirOf(input)).toBe(
      `/data/threads/${threadId}/workspace`
    );
  });

  test("the same thread answers the same way twice, which is what a resume rests on", () => {
    expect(threadRunDirOf({ dataRoot, threadId })).toBe(
      threadRunDirOf({ dataRoot, threadId })
    );
  });

  test("two conversations share no directory", () => {
    const other = newThreadId();
    expect(threadDirOf({ dataRoot, threadId })).not.toBe(
      threadDirOf({ dataRoot, threadId: other })
    );
  });

  test("the scratch directory is a sibling of the run directory, not a child", () => {
    const input = { dataRoot, threadId };
    expect(
      threadWorkspaceDirOf(input).startsWith(`${threadRunDirOf(input)}/`)
    ).toBe(false);
  });
});

describe("threadRunLayout", () => {
  test("is the harness's own layout over the thread's run directory", () => {
    const input = { dataRoot, threadId };
    expect(threadRunLayout(input)).toEqual(runLayout(threadRunDirOf(input)));
  });

  test("names the same files the container will, under a different root", () => {
    const host = threadRunLayout({ dataRoot, threadId });
    expect(host.eventLogPath.endsWith("/events.jsonl")).toBe(true);
    expect(containerRunLayout.eventLogPath.endsWith("/events.jsonl")).toBe(
      true
    );
  });
});
