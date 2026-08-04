/**
 * Who this process says it is — to the ledger, to Postgres, and to the board.
 *
 * Two names, and they are deliberately not the same thing. The service name is
 * the class of process: it names the JSONL ledger file, the OTLP resource, and
 * the `application_name` that `pg_stat_activity` reports, so every bot on every
 * host answers to `bot`. The instance id names *this* boot of it, which is what
 * an operator matches a startup banner against when two processes are polling
 * one token and Telegram is dropping half the updates.
 *
 * What is **not** here is an `Actor`. The bot never writes a board row directly:
 * every project, task, comment and run command goes over the gateway with a
 * freshly minted manager token carrying the conversation that caused it, and the
 * chat tables it does own are not audited. A process-wide actor would be a
 * second, unattributed way to write, so there is none — see `chatStoreLayer`,
 * which makes that a compile error rather than a rule.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import process from "node:process";

/**
 * The service name, and it has to be exactly this string.
 *
 * `bun run logs` reads `${DATA_ROOT}/events/<service>.jsonl`, and `atm.chat` —
 * the record of every update this process handled — belongs in `bot.jsonl`.
 * Change this and the viewer keeps working while showing an empty ledger, which
 * is the worst of the available failures.
 */
export const SERVICE_NAME = "bot";

/** Characters of the random suffix on an instance id. Enough not to collide, short enough to read. */
const INSTANCE_SUFFIX_CHARS = 8;

/**
 * A name for this boot of the bot: host, pid, and a random tail.
 *
 * The random tail is there because host and pid are not enough on their own — a
 * supervisor restarting a crashed bot can be handed the same pid, and two
 * banners that read identically are exactly the confusion this is for.
 */
export const botInstanceId = () =>
  `${hostname()}/${process.pid}/${randomUUID().slice(0, INSTANCE_SUFFIX_CHARS)}`;

/**
 * This process's instance id, minted once at load.
 *
 * A module constant rather than a value built inside a layer, because the
 * banner and any later diagnostic have to agree on the answer and a second call
 * would give them different ones.
 */
export const BOT_INSTANCE = botInstanceId();
