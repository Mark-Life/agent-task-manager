/**
 * Who this process says it is — to the ledger, to Postgres, and to the audit
 * log.
 *
 * The service name is the class of process: it names the JSONL ledger file, the
 * OTLP resource, and the `application_name` that `pg_stat_activity` reports, so
 * every gateway on every host answers to `gateway`.
 */

import type { Actor } from "@workspace/domain";

/**
 * The service name, and it has to be exactly this string.
 *
 * `bun run logs` reads `${DATA_ROOT}/events/<service>.jsonl` and the build
 * plan's marker table puts `atm.request` in `gateway.jsonl`. Change this and
 * the viewer keeps working while showing an empty ledger, which is the worst of
 * the available failures.
 */
export const SERVICE_NAME = "gateway";

/**
 * The actor a write made by the gateway itself is attributed to.
 *
 * Almost nothing uses it. Every write a request makes is made as that request's
 * principal — a person, the manager speaking for one, or a run's own actor —
 * and the audit log is only worth having because those are told apart. This
 * covers the residue: a write the process makes on nobody's behalf.
 */
export const gatewayActor: Actor = {
  kind: "system",
  reason: "gateway",
};
