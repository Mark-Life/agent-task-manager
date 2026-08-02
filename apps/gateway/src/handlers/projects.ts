/**
 * Projects: the places tasks belong to.
 *
 * Five thin operations over one repository. Nothing branches on whether a
 * project has a repository — that difference is a nullable column and a run
 * that either clones something or gets an empty scratch directory, and neither
 * is decided here.
 *
 * The workspace is never read off the request. It comes from the principal the
 * access middleware resolved, so a caller cannot name a workspace it cannot
 * read, and every query below is scoped by construction.
 */

import { Api, Principal } from "@workspace/api";
import { ProjectRepo, withActor } from "@workspace/db";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { storeDefects, toInvalidInput, toNotFound } from "./store-failures";

/**
 * The `projects` group, implemented.
 *
 * The repository is taken once, when the layer is built, rather than per
 * request: it is a handle on the process's connection pool and not something a
 * request owns. What a request does own is who it is, and that is read inside
 * each handler and provided to the write — so the audit row the repository
 * writes in the same transaction names the caller rather than the gateway.
 */
export const projectsHandlers = HttpApiBuilder.group(
  Api,
  "projects",
  (handlers) =>
    Effect.gen(function* () {
      const projects = yield* ProjectRepo;

      return handlers.handleAll({
        create: ({ payload }) =>
          Effect.gen(function* () {
            const { actor, workspaceId } = yield* Principal;
            return yield* projects.create({ ...payload, workspaceId }).pipe(
              withActor(actor),
              Effect.catchTags({
                ...storeDefects,
                "Db.InvalidInput": toInvalidInput,
              })
            );
          }),

        // The response carries nothing, but the store hands back the row it
        // erased: the audit entry outlives the project, and this is the last
        // moment the two are in the same transaction.
        //
        // A delete sends no body, so the only thing left that could be refused
        // as invalid input is the audit row this process builds itself — which
        // makes it a defect rather than an answer.
        delete: ({ params }) =>
          Effect.gen(function* () {
            const { actor, workspaceId } = yield* Principal;
            return yield* projects
              .delete({ id: params.projectId, workspaceId })
              .pipe(
                withActor(actor),
                Effect.catchTags({
                  ...storeDefects,
                  "Db.InvalidInput": Effect.die,
                  "Db.NotFound": toNotFound,
                }),
                Effect.asVoid
              );
          }),

        get: ({ params }) =>
          Effect.gen(function* () {
            const { workspaceId } = yield* Principal;
            return yield* projects
              .byId({ id: params.projectId, workspaceId })
              .pipe(
                Effect.catchTags({
                  ...storeDefects,
                  "Db.NotFound": toNotFound,
                })
              );
          }),

        list: () =>
          Effect.gen(function* () {
            const { workspaceId } = yield* Principal;
            return yield* projects
              .list({ workspaceId })
              .pipe(Effect.catchTags(storeDefects));
          }),

        patch: ({ params, payload }) =>
          Effect.gen(function* () {
            const { actor, workspaceId } = yield* Principal;
            return yield* projects
              .update({ fields: payload, id: params.projectId, workspaceId })
              .pipe(
                withActor(actor),
                Effect.catchTags({
                  ...storeDefects,
                  "Db.InvalidInput": toInvalidInput,
                  "Db.NotFound": toNotFound,
                })
              );
          }),
      });
    })
);
