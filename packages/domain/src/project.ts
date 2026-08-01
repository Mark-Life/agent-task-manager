import { Schema } from "effect";
import { ProjectId } from "./ids";
import { recordFields } from "./primitives";

/**
 * A place tasks belong to. The repo fields are nullable because a project with
 * no repo is an ordinary project — a trip, a piece of writing, an area of life
 * — and that is the whole of the difference at this layer: a run either clones
 * something or gets an empty scratch dir.
 */
export const Project = Schema.Struct({
  ...recordFields,
  description: Schema.NullOr(Schema.String),
  id: ProjectId,
  name: Schema.NonEmptyString,
  /** The PR base. Null means whatever the clone's HEAD turns out to be. */
  repoDefaultBranch: Schema.NullOr(Schema.String),
  repoUrl: Schema.NullOr(Schema.String),
});

export interface Project extends Schema.Schema.Type<typeof Project> {}
