/**
 * A project on the wire.
 *
 * The response schema is the domain entity, named so the generated document
 * carries one `Project` component instead of the same object inlined at every
 * operation. The request schemas are picks off that same entity, so a field
 * that is nullable in the store is nullable here and cannot drift into being
 * something else.
 */

import { Project as DomainProject } from "@workspace/domain";
import { Schema } from "effect";

/** A project, exactly as the store holds it. */
export const Project = DomainProject.annotate({ identifier: "Project" });

export interface Project extends Schema.Schema.Type<typeof Project> {}

/**
 * What creating one takes. The workspace is absent on purpose: it comes from
 * the credential, never from the body, so no caller can file a row into a
 * workspace it cannot read.
 */
export const ProjectCreate = Schema.Struct({
  description: Schema.optionalKey(DomainProject.fields.description),
  name: DomainProject.fields.name,
  repoDefaultBranch: Schema.optionalKey(DomainProject.fields.repoDefaultBranch),
  repoUrl: Schema.optionalKey(DomainProject.fields.repoUrl),
}).annotate({ identifier: "ProjectCreate" });

export interface ProjectCreate
  extends Schema.Schema.Type<typeof ProjectCreate> {}

/**
 * What may change. Every key is optional and absence means "leave it"; an
 * explicit `null` clears the column, which is the difference a patch has to be
 * able to express.
 */
export const ProjectPatch = Schema.Struct({
  description: Schema.optionalKey(DomainProject.fields.description),
  name: Schema.optionalKey(DomainProject.fields.name),
  repoDefaultBranch: Schema.optionalKey(DomainProject.fields.repoDefaultBranch),
  repoUrl: Schema.optionalKey(DomainProject.fields.repoUrl),
}).annotate({ identifier: "ProjectPatch" });

export interface ProjectPatch extends Schema.Schema.Type<typeof ProjectPatch> {}
