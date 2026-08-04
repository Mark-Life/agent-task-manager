import {
  ArtifactId,
  ArtifactScope,
  ProjectId,
  RunId,
  TaskId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { artifact } from "../schema/artifact";

/**
 * `modified_at` comes from `stat`, not from us, which is why it is refined like
 * any other instant rather than left to the database: a rescan reads a file's
 * mtime in whatever zone the host is in, and the domain wants the instant.
 *
 * `bytes` is `Natural`: the column is `bigint` in number mode, so the value is
 * an ordinary number the API can serialize, and a negative file size means the
 * rescan is broken.
 */
const columns = {
  bytes: () => Schema.Natural,
  id: () => ArtifactId,
  lastRunId: () => RunId,
  modifiedAt: () => Timestamp,
  path: () => Schema.NonEmptyString,
  projectId: () => ProjectId,
  promotedAt: () => Timestamp,
  scope: () => ArtifactScope,
  sourceArtifactId: () => ArtifactId,
  taskId: () => TaskId,
  workspaceId: () => WorkspaceId,
};

/** An `artifact` row as the database hands it back. */
export const ArtifactRow = createSelectSchema(artifact, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a rescan upserts, keyed per scope on the path. */
export const ArtifactInsert = createInsertSchema(artifact, columns);

/** What a rescan or a promotion changes on a file already indexed. */
export const ArtifactUpdate = createUpdateSchema(artifact, columns);

/** Turns a raw row into the domain entity. */
export const decodeArtifact = Schema.decodeUnknownEffect(ArtifactRow);
