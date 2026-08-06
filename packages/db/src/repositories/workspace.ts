/**
 * Reads of the workspace, which is the auth library's `organization` row in our
 * vocabulary.
 *
 * There are no writes here, and that is the point: organizations are created,
 * renamed and deleted through the auth library, which owns the table and
 * regenerates its definition. Every `workspace_id` of ours points at it with
 * `on delete restrict`, so a workspace cannot be erased out from under the
 * tasks, runs and audit rows that name it. What this repository exists for is
 * to hand back a domain `Workspace` instead of the library's row.
 */

import { type UserId, WorkspaceId } from "@workspace/domain";
import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { Database } from "../client";
import { decodeWorkspace } from "../rows";
import { member, organization } from "../schema/auth";
import { decodeMany, decodeOne, execute } from "./audit";

const ENTITY = "workspace";

const make = Effect.gen(function* () {
  const db = yield* Database;

  /** One workspace, or {@link NotFound}. */
  const byId = Effect.fn("WorkspaceRepo.byId")(function* (options: {
    readonly id: WorkspaceId;
  }) {
    yield* Effect.annotateCurrentSpan({ workspaceId: options.id });

    const rows = yield* execute(
      "WorkspaceRepo.byId",
      db.select().from(organization).where(eq(organization.id, options.id))
    );

    return yield* decodeOne({
      decode: decodeWorkspace,
      entity: ENTITY,
      id: options.id,
      rows,
    });
  });

  /**
   * Every workspace this database holds. There is one while this is a
   * single-operator system; the seed script and the workspace picker both read
   * it, and neither wants to know that.
   */
  const list = Effect.fn("WorkspaceRepo.list")(function* () {
    const rows = yield* execute(
      "WorkspaceRepo.list",
      db.select().from(organization).orderBy(asc(organization.name))
    );

    return yield* decodeMany({
      decode: decodeWorkspace,
      entity: ENTITY,
      rows,
    });
  });

  /**
   * The workspaces a person belongs to *right now*, as ids.
   *
   * Ids rather than workspaces because the caller is authorization rather than
   * a screen: what it needs to know is whether the workspace a credential names
   * is one this person may see, and reading the rest of the row to answer that
   * would be work nobody asked for.
   *
   * It exists for the credentials that carry no session. A browser's cookie can
   * be handed back to the auth library, which knows how to read memberships off
   * it; an API key is a row naming a user and nothing more, so the membership
   * has to be looked up. Same rule either way, and it is checked on every
   * request rather than trusted from issue time — a person removed from a
   * workspace, or deleted outright, stops reaching its board on the next call
   * instead of whenever somebody remembers their keys.
   */
  const membershipsOf = Effect.fn("WorkspaceRepo.membershipsOf")(function* (
    options: Readonly<{ userId: UserId }>
  ) {
    const rows = yield* execute(
      "WorkspaceRepo.membershipsOf",
      db
        .select({ workspaceId: member.organizationId })
        .from(member)
        .where(eq(member.userId, options.userId))
        .orderBy(asc(member.organizationId))
    );

    return rows.map((row) => WorkspaceId.make(row.workspaceId));
  });

  return { byId, list, membershipsOf } as const;
});

/** Reads of the workspace. Writes belong to the auth library. */
export class WorkspaceRepo extends Context.Service<
  WorkspaceRepo,
  Effect.Success<typeof make>
>()("@workspace/db/WorkspaceRepo") {
  static readonly layer = Layer.effect(WorkspaceRepo, make);
}
