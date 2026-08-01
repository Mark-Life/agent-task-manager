import { Schema } from "effect";

/** Liveness payload: the service answered and knows what time it is. */
export const HealthStatus = Schema.Struct({
  status: Schema.Literal("ok"),
  timestamp: Schema.String,
}).annotate({ identifier: "HealthStatus" });

export interface HealthStatus extends Schema.Schema.Type<typeof HealthStatus> {}
