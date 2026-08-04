import { ProjectId, Timestamp, WorkspaceId } from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { project } from "../schema/project";

/** The columns a writer supplies and a reader trusts. See the note in `./index`. */
const columns = {
  id: () => ProjectId,
  name: () => Schema.NonEmptyString,
  workspaceId: () => WorkspaceId,
};

/** A `project` row as the database hands it back. */
export const ProjectRow = createSelectSchema(project, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a repository writes to create a project. */
export const ProjectInsert = createInsertSchema(project, columns);

/** What a repository may change on a project. */
export const ProjectUpdate = createUpdateSchema(project, columns);

/**
 * Turns a raw row into the domain entity, by validating it rather than by
 * asserting it. A project written by the seed script, by a migration, or by an
 * older version of this code is checked on the way in like any other.
 */
export const decodeProject = Schema.decodeUnknownEffect(ProjectRow);
