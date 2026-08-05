/**
 * A project's environment files on the wire.
 *
 * Two response shapes, and the difference between them is the whole design:
 * {@link ProjectEnvFile} is a path and a timestamp, {@link ProjectEnvFileContent}
 * is that plus the text. Listing returns the first and only the editor's read
 * returns the second, so the endpoint that hands back a secret is one endpoint
 * and it is obvious which.
 *
 * Both are the domain entities, named so the generated document carries one
 * component each rather than the same object inlined per operation.
 */

import {
  ProjectEnvFile as DomainProjectEnvFile,
  ProjectEnvFileContent as DomainProjectEnvFileContent,
} from "@workspace/domain";
import { Schema } from "effect";

/** One environment file: where it goes, and when it last changed. Never its text. */
export const ProjectEnvFile = DomainProjectEnvFile.annotate({
  identifier: "ProjectEnvFile",
});

export interface ProjectEnvFile
  extends Schema.Schema.Type<typeof ProjectEnvFile> {}

/** One environment file with its text, which only the editor's read returns. */
export const ProjectEnvFileContent = DomainProjectEnvFileContent.annotate({
  identifier: "ProjectEnvFileContent",
});

export interface ProjectEnvFileContent
  extends Schema.Schema.Type<typeof ProjectEnvFileContent> {}

/**
 * What saving one takes. The path is the key, so this is an upsert rather than
 * a create: an editor knows where the file goes and does not know whether a row
 * for it exists.
 *
 * The path is the domain's own schema, which refuses anything that is not an
 * ordinary repo-relative path — so a request that would write outside the
 * checkout is a decode failure at the edge rather than a check some handler
 * remembers to make.
 */
export const ProjectEnvFileSave = Schema.Struct({
  content: DomainProjectEnvFileContent.fields.content,
  path: DomainProjectEnvFile.fields.path,
}).annotate({ identifier: "ProjectEnvFileSave" });

export interface ProjectEnvFileSave
  extends Schema.Schema.Type<typeof ProjectEnvFileSave> {}
