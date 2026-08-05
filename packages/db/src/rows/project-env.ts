import {
  EnvFilePath,
  ProjectEnvFileId,
  ProjectId,
  Timestamp,
  WorkspaceId,
} from "@workspace/domain";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Effect, Schema } from "effect";
import { projectEnvFile } from "../schema/project-env";
import { asEntity } from "./conformance";

/**
 * The columns a writer supplies and a reader trusts. `path` is refined because
 * the domain's schema says something the column cannot — a path that stays
 * inside the checkout — so a row written by a script or by an older build is
 * checked on the way in like any other.
 *
 * `content_enc` is refined for a duller reason: drizzle derives a `bytea`
 * through a schema whose type is chosen by a ternary on whether `Buffer`
 * exists, and indexing that union for its decoding services yields `unknown` —
 * which then propagates into the requirements of every effect built from this
 * schema. Restating the same declaration settles it, and the driver still sends
 * and receives the same bytes.
 */
const columns = {
  contentEnc: () => Schema.instanceOf(Buffer),
  id: () => ProjectEnvFileId,
  path: () => EnvFilePath,
  projectId: () => ProjectId,
  workspaceId: () => WorkspaceId,
};

/** A `project_env_file` row as the database hands it back, sealed blob included. */
export const ProjectEnvFileRow = createSelectSchema(projectEnvFile, {
  ...columns,
  createdAt: () => Timestamp,
  updatedAt: () => Timestamp,
});

/** What a repository writes to create one. */
export const ProjectEnvFileInsert = createInsertSchema(projectEnvFile, columns);

/** What may change: the text, and therefore the blob and its derivation. */
export const ProjectEnvFileUpdate = createUpdateSchema(projectEnvFile, columns);

/**
 * The whole row, sealed content and all. Used by the repository, which is the
 * only thing that holds a key and can do anything with the blob.
 */
export const decodeProjectEnvFileRow =
  Schema.decodeUnknownEffect(ProjectEnvFileRow);

/**
 * The row as the domain means it: where the file goes and when it changed, with
 * the sealed columns dropped.
 *
 * The drop happens here rather than at each call site because it is the whole
 * of what makes {@link ProjectEnvFile} safe to return — a listing that carried
 * `content_enc` would be shipping every project's ciphertext to whoever asked
 * for a sidebar, and `key_version` is a storage detail that means nothing
 * outside this package.
 */
export const decodeProjectEnvFile = (row: unknown) =>
  Effect.map(
    decodeProjectEnvFileRow(row),
    ({ contentEnc: _contentEnc, keyVersion: _keyVersion, ...rest }) =>
      asEntity(rest)
  );
