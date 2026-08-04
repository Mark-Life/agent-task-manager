/**
 * Liveness. The one endpoint with no credential and no database behind it: it
 * answers whether this process is up and answering, which is exactly the
 * question a load balancer and a supervisor ask, and adding a query to it would
 * turn a slow database into an unhealthy gateway.
 */

import { Api } from "@workspace/api";
import { DateTime, Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/** The health group, implemented. */
export const healthHandlers = HttpApiBuilder.group(Api, "health", (handlers) =>
  handlers.handle("check", () =>
    Effect.map(DateTime.now, (now) => ({
      status: "ok" as const,
      timestamp: DateTime.formatIso(now),
    }))
  )
);
