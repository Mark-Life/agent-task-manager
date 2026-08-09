import { Schema } from "effect";
import { ArtifactScope } from "./enums";
import { ArtifactId, ProjectId, RunId, TaskId } from "./ids";
import { recordFields, Timestamp } from "./primitives";

/**
 * The file a worker writes when it has something to say and no way to say it.
 *
 * A run's board tools can stop answering — an expired credential, a gateway
 * that moved, a network the container lost — and the agent still holds the
 * thing the whole run was for. The task's artifacts directory is the one place
 * it can write that outlives the container, so a file with this exact name in
 * that directory is a task message the run could not post, and the orchestrator
 * attaches it on the way out.
 *
 * It is a name rather than a mechanism on purpose. The agent needs no new tool
 * and no new credential to use it: it already knows how to write a file, and
 * the directory is already mounted. What the convention buys is that the file
 * is found — the alternative is the one this replaced, where the output sat on
 * disk under whatever name the agent chose and a person went looking for it.
 *
 * Named here rather than in the orchestrator or the sandbox because two
 * packages have to agree on it and neither owns the other: `@workspace/prompts`
 * tells the agent to write it, `@workspace/orchestrator` reads it back. A
 * second spelling in either is a handoff nobody collects.
 */
export const HANDOFF_FILENAME = "handoff.md";

/**
 * What a rescan of an artifact directory reads off one file. The index is
 * derivable from disk, which makes it a cache rather than a source of truth: if
 * it ever drifts, rescan. That removes a whole class of consistency bug, and it
 * is why bytes are never in here — Postgres is fast for metadata, the
 * filesystem is fast for bytes, and large values bloat the write-ahead log and
 * every backup forever.
 */
export const ArtifactStat = Schema.Struct({
  bytes: Schema.Natural,
  /** Lets the dashboard pick a renderer. */
  ext: Schema.NullOr(Schema.String),
  /** From `stat`, not from us. */
  modifiedAt: Timestamp,
  /** Relative to the scope root. The natural key. */
  path: Schema.NonEmptyString,
});

export interface ArtifactStat extends Schema.Schema.Type<typeof ArtifactStat> {}

/**
 * A file a run produced and someone wanted to keep. Scope decides which mount
 * it lives on, and therefore who may write it: a worker writes its task's
 * folder and its project's, and the global folder is read-only to it, so
 * material every project sees only ever arrives by promotion.
 *
 * Reuse across projects is always a copy, never a reference, so `sourceArtifactId`
 * records where a file came from without making one task's record of what it
 * worked from change retroactively when the original is refined.
 */
export const Artifact = Schema.Struct({
  ...recordFields,
  ...ArtifactStat.fields,
  /**
   * The bytes this file had when it was promoted or copied, and null on every
   * row that is neither.
   *
   * A rescan does not compute it: size and modified time already answer "has
   * this changed since the last scan", which is all a cache of the directory
   * needs, and hashing every file on every scan to learn nothing more would be
   * the whole artifacts tree read on every run. What a hash answers instead is
   * whether two files are the same bytes — a promoted copy against the source it
   * came from — and that question only exists at the moment of copying, which is
   * the only moment it is written.
   */
  contentHash: Schema.NullOr(Schema.String),
  id: ArtifactId,
  /** Which run last touched the file. Provenance, not load-bearing. */
  lastRunId: Schema.NullOr(RunId),
  /** Set only for a project-scoped row. */
  projectId: Schema.NullOr(ProjectId),
  /** When it was promoted, for the UI. The `promote` audit row is the trail. */
  promotedAt: Schema.NullOr(Timestamp),
  scope: ArtifactScope,
  /** The row this file was copied from, by promotion or by cross-project reuse. Which one it was is the audit action. */
  sourceArtifactId: Schema.NullOr(ArtifactId),
  /** The owning task, set only for a task-scoped row, so promoted and global files survive the task that made them. */
  taskId: Schema.NullOr(TaskId),
});

export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}
