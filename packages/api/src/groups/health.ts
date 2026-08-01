import {
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { HealthStatus } from "../schemas/health";

/** Unauthenticated liveness probe. Mounted at the API root, not under a prefix. */
export class HealthGroup extends HttpApiGroup.make("health")
  .add(HttpApiEndpoint.get("check", "/health", { success: HealthStatus }))
  .annotate(OpenApi.Description, "Liveness probe.") {}
