import { ProjectId, RunId, TaskId, ThreadId } from "@workspace/domain";
import { Option, Schema } from "effect";

/**
 * A URL is something a person can type, truncate or paste half of, so every
 * value read out of one is treated as unknown until the domain's own schema has
 * agreed with it. Turning a mismatch into `undefined` rather than a thrown
 * error is what makes a mangled link degrade into the unfiltered screen instead
 * of an error page.
 */
const optional =
  <A>(decode: (value: unknown) => Option.Option<A>) =>
  (value: unknown) =>
    Option.getOrUndefined(decode(value));

/** The project the board is narrowed to, if the URL names one that could exist. */
export const parseProjectId = optional(Schema.decodeUnknownOption(ProjectId));

/** The task a detail page is about. */
export const parseTaskId = optional(Schema.decodeUnknownOption(TaskId));

/** The attempt a timeline is showing, when the reader picked one. */
export const parseRunId = optional(Schema.decodeUnknownOption(RunId));

/** The conversation the overlay is open on. */
export const parseThreadId = optional(Schema.decodeUnknownOption(ThreadId));

/**
 * The panels of a task page, in the order they are drawn.
 *
 * Runs comes first because it is what a link from a finished or failed run is
 * about, and it is the panel the page opens on when the URL asks for nothing.
 */
export const TASK_TABS = ["runs", "comments", "sessions", "artifacts"] as const;

/** Which panel of a task page is open. */
export type TaskTab = (typeof TASK_TABS)[number];

/** Name to panel, so an unknown string reads back as a plain absent value. */
const BY_NAME: Record<string, TaskTab> = Object.fromEntries(
  TASK_TABS.map((tab) => [tab, tab])
);

/** The panel a URL asks for, or undefined when it asks for nothing sensible. */
export const parseTaskTab = (value: unknown) =>
  typeof value === "string" ? BY_NAME[value] : undefined;
