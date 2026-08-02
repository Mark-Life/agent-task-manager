/**
 * Who this process says it is — to the ledger, to Postgres, and to the audit
 * log.
 *
 * Three names, and they are deliberately not the same thing. The service name
 * is the class of process: it names the JSONL ledger file, the OTLP resource,
 * and the `application_name` `pg_stat_activity` reports, so every loop on every
 * host answers to `loop`. The instance id names *this* boot of it, and is what
 * a lease is stamped with. The actor is how the database is told which of the
 * five kinds of writer is making a change, and every row this process writes
 * outside a worker run is written as that one.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import process from "node:process";
import type { Actor } from "@workspace/domain";

/**
 * The service name, and it has to be exactly this string.
 *
 * `bun run logs` reads `${DATA_ROOT}/events/<service>.jsonl` and the build
 * plan's marker table puts `atm.run` — the canonical record of the system — in
 * `loop.jsonl`. Change this and the viewer keeps working while showing an empty
 * ledger, which is the worst of the available failures.
 */
export const SERVICE_NAME = "loop";

/** Characters of the random suffix on an instance id. Enough to not collide, short enough to read. */
const INSTANCE_SUFFIX_CHARS = 8;

/**
 * A name for this boot of the loop: host, pid, and a random tail.
 *
 * The host and the pid are there so an operator reading a held lease can find
 * the process and signal it. The random tail is there because they are not
 * enough on their own — a loop that crashes and is restarted by a supervisor
 * can be handed the same pid, and it would then read a dead instance's stale
 * lease as one of its own and skip reclaiming it. A fresh suffix per boot makes
 * "mine" mean this process and not this pid.
 */
export const loopInstanceId = () =>
  `${hostname()}/${process.pid}/${randomUUID().slice(0, INSTANCE_SUFFIX_CHARS)}`;

/**
 * This process's instance id, minted once at load.
 *
 * A module constant rather than a value built inside a layer, because two
 * unrelated things need the same answer — the actor every write is attributed
 * to, and the startup banner an operator matches against a lease row — and a
 * second call would give them different ones.
 */
export const LOOP_INSTANCE = loopInstanceId();

/**
 * The actor the loop performs its own writes as. Not the actor of a worker
 * run's writes: those are made by the run's own `worker_run` actor through its
 * task-scoped token, so the audit log tells the dispatcher's move into *review*
 * apart from the agent's.
 *
 * `runId` is left absent here on purpose — this is the process-wide actor, and
 * the work it covers (the startup reclaim, the quota gate, the trigger) is not
 * about any one run. The run lifecycle narrows it per run.
 */
export const orchestratorActor = (loopInstance: string): Actor => ({
  kind: "orchestrator",
  loopInstance,
});
