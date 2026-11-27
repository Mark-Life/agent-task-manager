/**
 * The whole contract as a fetch handler that runs in the page.
 *
 * Built from the same `Api` value the gateway implements, so every response
 * goes through the contract's own codecs and a fixture that drifts from a
 * schema fails to compile rather than rendering wrong.
 */

import {
  AdminAccess,
  Api,
  Principal,
  ReadAccess,
  TaskWriteAccess,
} from "@workspace/api";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  healthHandlers,
  messagesHandlers,
  projectsHandlers,
  tasksHandlers,
  usageHandlers,
} from "./handlers/board";
import {
  artifactsHandlers,
  proposalsHandlers,
  runCommandsHandlers,
  runsHandlers,
  sessionsHandlers,
} from "./handlers/runs";
import {
  filesHandlers,
  skillsHandlers,
  threadsHandlers,
} from "./handlers/workspace";
import { DEMO_USER, DEMO_WORKSPACE } from "./ids";

/** Every request is the demo's one person, with every scope. */
const grant = <A, E, R>(httpEffect: Effect.Effect<A, E, R>) =>
  Effect.provideService(httpEffect, Principal, {
    actor: { kind: "human", userId: DEMO_USER },
    scope: "admin",
    workspaceId: DEMO_WORKSPACE,
  });

const accessLayer = Layer.mergeAll(
  Layer.succeed(
    ReadAccess,
    ReadAccess.of({ readToken: grant, sessionCookie: grant, userApiKey: grant })
  ),
  Layer.succeed(
    TaskWriteAccess,
    TaskWriteAccess.of({
      sessionCookie: grant,
      taskWriteToken: grant,
      userApiKey: grant,
    })
  ),
  Layer.succeed(
    AdminAccess,
    AdminAccess.of({
      adminToken: grant,
      sessionCookie: grant,
      userApiKey: grant,
    })
  )
);

const handlersLayer = Layer.mergeAll(
  artifactsHandlers,
  filesHandlers,
  healthHandlers,
  messagesHandlers,
  projectsHandlers,
  proposalsHandlers,
  runCommandsHandlers,
  runsHandlers,
  sessionsHandlers,
  skillsHandlers,
  tasksHandlers,
  threadsHandlers,
  usageHandlers
);

export const { handler } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(handlersLayer),
    Layer.provide(accessLayer),
    Layer.provide(HttpServer.layerServices)
  ),
  { disableLogger: true }
);
