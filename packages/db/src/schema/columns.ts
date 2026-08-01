import type { WorkspaceId } from "@workspace/domain";
import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * Every timestamp column in the schema goes through here. A bare `timestamp()`
 * emits `timestamp without time zone`, which typechecks, round-trips a `Date`,
 * and is wrong only once the server's zone moves or a DST boundary is crossed —
 * the kind of bug that shows up in production and nowhere else.
 */
export const tstz = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/**
 * The columns every table of ours carries. A function rather than a shared
 * object because a column builder is mutated with its name while the table is
 * built, so two tables spreading one frozen set would fight over one builder.
 *
 * `id` has no database default: ids are minted app-side as uuidv7, which is
 * time-ordered, so the id doubles as a stable tiebreaker on `created_at` and no
 * round trip is needed to learn the id of a row before writing its children.
 *
 * `workspace_id` is text because auth ids are 32-char strings, and it points at
 * the organization that *is* the workspace. Deleting one is `restrict`: an
 * ordinary adapter DELETE from the auth library must never be able to erase a
 * workspace's tasks, runs and audit trail as a side effect.
 *
 * Every id column is `$type`d with its branded domain id, so a query result is
 * already a `TaskId` rather than a `string` and passing one entity's id where
 * another's belongs does not compile — at the query builder, before anything
 * reaches a decoder.
 */
export const baseColumns = <Id extends string>() => ({
  createdAt: tstz("created_at").notNull().defaultNow(),
  id: uuid("id").$type<Id>().primaryKey(),
  workspaceId: text("workspace_id")
    .$type<WorkspaceId>()
    .notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
});

/**
 * {@link baseColumns} plus `updated_at`, for every table that is not
 * append-only. The column carries no `$onUpdate` hook: a `BEFORE UPDATE` trigger
 * maintains it, so a statement that bypassed the repositories cannot leave the
 * value stale.
 */
export const mutableColumns = <Id extends string>() => ({
  ...baseColumns<Id>(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});
