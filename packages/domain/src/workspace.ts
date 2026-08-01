import { Schema } from "effect";
import { WorkspaceId } from "./ids";
import { Timestamp } from "./primitives";

/**
 * The workspace, which is Better Auth's `organization` row read in our
 * vocabulary. There is no workspace table of ours — every table simply carries
 * `workspaceId` — so this schema exists to give repositories something to
 * return, and it is read-only: workspaces are created and deleted through
 * Better Auth, never by us.
 */
export const Workspace = Schema.Struct({
  createdAt: Timestamp,
  id: WorkspaceId,
  logo: Schema.NullOr(Schema.String),
  metadata: Schema.NullOr(Schema.String),
  name: Schema.NonEmptyString,
  slug: Schema.String,
});

export interface Workspace extends Schema.Schema.Type<typeof Workspace> {}
