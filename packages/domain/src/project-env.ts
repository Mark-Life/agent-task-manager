/**
 * The environment files a project hands to every run that works in its repo.
 *
 * **The unit is a file, not a key-value pair.** Key-value rows cannot say where
 * a value goes: one monorepo keeps everything in a root `.env.local`, another
 * needs one per app, and `apps/web/.env` and `packages/db/.env.test` are two
 * files rather than two sets of keys. A file also survives comments, blank lines,
 * multi-line values and whatever quoting the reader expects, all four of which
 * a key-value editor destroys on the first save.
 *
 * **The path is the natural key and the only thing here that is validated
 * hard.** It is turned into a filesystem path inside the run's checkout, so a
 * path that escapes the checkout writes anywhere the loop user can write — and
 * the loop user owns the whole data root. {@link EnvFilePath} is that rule
 * applied, declared as a schema so the API refuses a bad path at decode, the
 * store refuses it at encode, and the materializer re-checks it before it
 * writes. The rule itself is `./relative-path`, shared with every other path a
 * caller hands us to join to a directory of ours.
 *
 * The content is not in this file. It is a secret, it is stored encrypted, and
 * the only shapes that carry it are the two below that say so in their names —
 * so a handler that means to list paths cannot accidentally return the values.
 */

import { Schema } from "effect";
import { ProjectEnvFileId, ProjectId } from "./ids";
import { recordFields } from "./primitives";
import { relativePathFilter } from "./relative-path";

/**
 * Where an environment file goes, relative to the root of the run's checkout.
 *
 * Branded, so a string that has not been through
 * {@link relativePathRefusalOf} cannot be joined to a checkout by accident —
 * the brand is the evidence that the check happened.
 */
export const EnvFilePath = Schema.String.pipe(
  Schema.check(relativePathFilter("repo-relative path")),
  Schema.brand("EnvFilePath")
);
export type EnvFilePath = typeof EnvFilePath.Type;

/**
 * One environment file as everything but the editor sees it: where it goes and
 * when it last changed, and never what is in it.
 *
 * The content is absent by construction rather than by a handler remembering to
 * strip it. Listing the files of a project is the common read — it renders the
 * editor's sidebar and it answers "what does this project inject" — and a shape
 * that carried the values would put every project's secrets into every one of
 * those responses.
 */
export const ProjectEnvFile = Schema.Struct({
  ...recordFields,
  id: ProjectEnvFileId,
  path: EnvFilePath,
  projectId: ProjectId,
});

export interface ProjectEnvFile
  extends Schema.Schema.Type<typeof ProjectEnvFile> {}

/**
 * One environment file with its text, which is the shape exactly two things
 * take: the editor reading a file back, and the materializer writing it into a
 * checkout.
 */
export const ProjectEnvFileContent = Schema.Struct({
  ...ProjectEnvFile.fields,
  /** The file's whole text, decrypted. Never logged, never on an event. */
  content: Schema.String,
});

export interface ProjectEnvFileContent
  extends Schema.Schema.Type<typeof ProjectEnvFileContent> {}

/**
 * A file as the materializer takes it: a path and bytes, with none of the row
 * it came from. `@workspace/sandbox` writes these and never learns that a
 * project, a workspace or an encryption key was involved.
 */
export interface EnvFileWrite {
  readonly content: string;
  readonly path: EnvFilePath;
}
