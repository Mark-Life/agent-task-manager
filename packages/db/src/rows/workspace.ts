import { Timestamp, WorkspaceId } from "@workspace/domain";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";
import { organization } from "../schema/auth";

/**
 * The workspace, read off the auth library's `organization` table. There is no
 * table of ours behind it — every row we own simply carries `workspace_id` —
 * and this schema exists so a repository has a domain type to hand back rather
 * than the auth library's row.
 *
 * Select only, and deliberately: organizations are created, renamed and deleted
 * through the auth library, which owns this table and regenerates its
 * definition. An insert or update schema here would be an invitation to write
 * behind its back, and `workspace_id` points at it with `on delete restrict`
 * precisely so nothing can.
 *
 * One caveat, and it is theirs rather than ours: the library declares
 * `created_at` as a bare `timestamp`, which is `timestamp without time zone`,
 * where every column of ours goes through the `tstz` helper. Reading it as a
 * UTC instant is therefore only as good as the server's zone — fine while
 * nothing reasons about a workspace's age, and a trap for the first query that
 * does. The fix is not available here: the file is generated, so it is either a
 * migration that alters the column or dropping the field until it is wanted.
 */
export const WorkspaceRow = createSelectSchema(organization, {
  createdAt: () => Timestamp,
  id: () => WorkspaceId,
  name: () => Schema.NonEmptyString,
});

/** Turns a raw `organization` row into the domain entity. */
export const decodeWorkspace = Schema.decodeUnknownEffect(WorkspaceRow);
