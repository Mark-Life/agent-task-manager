import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import { HealthGroup } from "./groups/health";

/**
 * The whole HTTP surface of the system, as a contract.
 *
 * Definition only — no handlers live here. Servers implement it group by group
 * with `HttpApiBuilder.group`; clients derive from the same value with
 * `HttpApiClient.make`, so both sides move together.
 */
export class Api extends HttpApi.make("atm")
  .add(HealthGroup)
  .annotate(OpenApi.Title, "Agent Task Manager")
  .annotate(OpenApi.Version, "0.0.1")
  .annotate(
    OpenApi.Description,
    "Task board, agent runs and their artifacts."
  ) {}

/**
 * Derive the OpenAPI 3.1 document for {@link Api}.
 *
 * Pure and synchronous. Servers usually let `HttpApiBuilder.layer` mount the
 * spec; call this directly to write it to disk or hand it to an external
 * consumer.
 */
export const makeOpenApiSpec = () => OpenApi.fromApi(Api);
