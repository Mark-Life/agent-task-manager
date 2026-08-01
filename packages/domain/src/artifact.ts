import { Schema } from "effect";
import { ArtifactScope } from "./enums";
import { ArtifactId, ProjectId, RunId, TaskId } from "./ids";
import { recordFields, Timestamp } from "./primitives";

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
 * it lives on, and only the task's own folder is writable — if any run could
 * write the shared folders, promoted material would drift with no audit and the
 * evidence would be the thing that got overwritten.
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
