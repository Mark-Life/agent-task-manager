import type {
  EnvFilePath,
  ProjectEnvFileId,
  ProjectId,
} from "@workspace/domain";
import {
  bytea,
  foreignKey,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mutableColumns } from "./columns";
import { project } from "./project";

/**
 * One environment file a project hands to every run that works in its repo.
 *
 * The row is a path and a sealed blob. `content_enc` is `bytea` and holds
 * `iv ‖ ciphertext ‖ tag` — see `@workspace/token`'s `secrets.ts` — so the
 * statement the driver sends carries ciphertext and a statement log, a slow
 * query log and a `pg_dump` all leak nothing. There is no plaintext column and
 * there is deliberately nowhere to put one.
 *
 * `key_version` is here from the first migration even though there is one key.
 * It names the derivation, so a later change of algorithm ships as version 2
 * with both readable while a re-encryption pass runs — and the pass can tell a
 * converted row from a pending one by reading the column. Adding it on the day
 * it is needed means adding a column to a table nobody can read.
 *
 * `(workspace_id, project_id, path)` is unique because the path is the natural
 * key: two rows for `apps/web/.env` would be two files racing to be written
 * last into the same place in the checkout. The composite foreign key back to
 * `(workspace_id, id)` is the same rule every child table here follows, and it
 * cascades: the files belong to the project and mean nothing without it.
 */
export const projectEnvFile = pgTable(
  "project_env_file",
  {
    ...mutableColumns<ProjectEnvFileId>(),
    contentEnc: bytea("content_enc").notNull(),
    keyVersion: smallint("key_version").notNull(),
    // Repo-relative, validated by `EnvFilePath` in the domain before it can
    // reach here — the column is the natural key, not the guard.
    path: text("path").$type<EnvFilePath>().notNull(),
    projectId: uuid("project_id").$type<ProjectId>().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_env_file_project_fk",
    }).onDelete("cascade"),
    uniqueIndex("project_env_file_project_id_path_uidx").on(
      t.workspaceId,
      t.projectId,
      t.path
    ),
  ]
);
