/**
 * The docker CLI as pure data: the argv it is handed, and the text it hands
 * back.
 *
 * Everything in this file is a total function over plain values, which is the
 * point. A container's confinement is decided by an array of strings, and an
 * array of strings can be asserted in a millisecond without a daemon, an image
 * or a network — while the same assertion made by starting a real container
 * costs minutes and gets deleted the first time CI has no docker. The
 * effectful half lives in `./docker.ts` and does nothing but hand these arrays
 * to a process and read what comes back.
 *
 * Four decisions are made here rather than at a call site, and each of them is
 * load-bearing.
 *
 * **Values never enter the argv.** `--env=NAME` with no `=value` tells docker to
 * read that variable out of the CLI process's own environment, so the run's ids
 * and settings ride the child's environment and the command line carries only
 * their names. Every process table on the host, every `ps` an agent could run,
 * and every span that ever records a command line therefore sees `--env=ATM_RUN_ID`
 * and never its value.
 *
 * **Nothing from the host's observability export crosses in.** {@link containerEnv}
 * drops every `OTEL_*` variable the caller passed, and points `EVENT_LOG_DIR` at
 * the ledger directory inside the run mount instead. The container writes its
 * wide events to a file that is on the host through a bind mount; the loop reads
 * them afterwards and forwards them. An export endpoint and its bearer token
 * belong to the operator, and an agent that reads its own environment should
 * find a directory there, not a credential for the operator's backend.
 *
 * **No `--rm`.** The two facts the `atm.sandbox` row cannot be assembled without
 * — the kernel's OOM verdict and the container's real exit code — are only
 * readable from `docker inspect` after the container has exited, and `--rm`
 * deletes the container the instant it does. Removal is explicit and belongs to
 * a scope release, which is also the only form of it that survives an interrupt.
 *
 * **The container is named before it exists.** A name minted on the host is what
 * makes a container removable by a fiber that was interrupted between the spawn
 * and the first byte of output — there is no window in which the thing to remove
 * has no handle.
 */

import type { RunId } from "@workspace/domain";
import { hardeningArgs } from "./hardening";
import { CONTAINER_EVENT_LOG_DIR, mountArgs } from "./mounts";
import { identityEnv, type SandboxSpec } from "./spec";

/** The CLI this implementation drives. Resolved on the host's `PATH`. */
export const DOCKER_COMMAND = "docker";

/**
 * Where the wide-event ledger is written, as `@workspace/telemetry` reads it.
 *
 * Spelled out here because telemetry keeps the name private to its own config
 * reader, and this is the one place outside it that has to set the variable. If
 * that name ever changes, the container writes its `atm.turn` rows into the
 * data root's default path — which inside a container is a directory on the
 * container's own dying filesystem, so the rows are lost silently rather than
 * loudly.
 */
export const EVENT_LOG_DIR_ENV_VAR = "EVENT_LOG_DIR";

/**
 * Logging settings a container starts with. Defaults, not decisions: a caller's
 * `spec.env` overrides them.
 *
 * `json` because nothing inside a container is a terminal and the loop reads
 * what the container prints rather than a human, so the pretty encoding would
 * only make the output harder to parse on the way through.
 */
export const CONTAINER_LOG_ENV = { LOG_FORMAT: "json" } as const;

/**
 * The prefix of every variable that configures OpenTelemetry export — the
 * endpoint, the protocol, and `OTEL_EXPORTER_OTLP_HEADERS`, which is where the
 * backend's credential lives. Filtered out of the container's environment
 * wholesale rather than named one at a time, because the set grows with the
 * spec and a variable added next year would otherwise be forwarded by default.
 */
export const EXPORT_ENV_PREFIX = "OTEL_";

/** Docker's name for a label; one per container, carrying the run it serves. */
export const RUN_LABEL = "atm.run";

/**
 * Stated rather than left to the daemon's default. `missing` pulls only what is
 * not on the host, so a run never re-fetches an image that is already there and
 * never silently runs a stale one after a rebuild changed the tag.
 */
export const PULL_POLICY = "missing";

/** How many characters of the uniqueness suffix a container name carries. */
export const NONCE_CHARS = 8;

/** What names one container: the run it serves, plus a suffix that makes a retry legal. */
export interface ContainerNameInput {
  /** Random, and only that: a retried run must not collide with a container the last attempt leaked. */
  readonly nonce: string;
  readonly runId: RunId;
}

/**
 * The container's name. Carries the run id so a human reading `docker ps` on the
 * host can tell which run is which, and so an orphan reaper has something to
 * match on together with {@link RUN_LABEL}.
 */
export const containerName = (input: ContainerNameInput) =>
  `atm-${input.runId}-${input.nonce}`;

/** Everything the caller asked for, minus what belongs to the host alone. */
const withoutExportEnv = (env: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith(EXPORT_ENV_PREFIX))
  );

/**
 * The environment one container runs with, in precedence order: the log
 * defaults, then the caller's own settings, then the correlation ids, then the
 * ledger directory.
 *
 * The last two win deliberately. A caller cannot overwrite the ids its own row
 * joins on, and it cannot redirect the ledger away from the mount — a wide event
 * written anywhere else inside a container is written to a filesystem that is
 * deleted seconds later.
 */
export const containerEnv = (
  spec: SandboxSpec
): Readonly<Record<string, string>> => ({
  ...CONTAINER_LOG_ENV,
  ...withoutExportEnv(spec.env),
  ...identityEnv(spec.identity),
  [EVENT_LOG_DIR_ENV_VAR]: CONTAINER_EVENT_LOG_DIR,
});

/**
 * The environment half of a run's argv: one `--env=NAME` per variable, sorted so
 * two identical specs produce byte-identical argv. Names only — see the module
 * note on why no value is ever written here.
 */
export const envArgs = (env: Readonly<Record<string, string>>) =>
  Object.keys(env)
    .sort()
    .map((name) => `--env=${name}`);

/** Which container to build, under which name. */
export interface RunArgsInput {
  readonly containerName: string;
  readonly spec: SandboxSpec;
}

/**
 * The complete `docker run` argv for one container, minus the executable
 * itself.
 *
 * Attached and without `--tty`, which is what keeps stdout and stderr two
 * streams instead of one interleaved pty: the harness's normalized events come
 * up one of them and the crash that explains a failed turn comes up the other,
 * and a pty would merge them beyond separating.
 */
export const dockerRunArgs = ({
  containerName: name,
  spec,
}: RunArgsInput): readonly string[] => [
  "run",
  `--name=${name}`,
  `--label=${RUN_LABEL}=${spec.identity.runId}`,
  `--pull=${PULL_POLICY}`,
  ...hardeningArgs(spec.hardening),
  ...mountArgs(spec.mounts),
  `--workdir=${spec.workingDir}`,
  ...envArgs(containerEnv(spec)),
  spec.image,
  spec.command,
  ...spec.args,
];

/**
 * What one `docker inspect` returns, as one line of JSON. A Go template rather
 * than `{{json .}}`, which would return a kilobyte of image configuration for
 * the four fields anybody reads.
 */
export const INSPECT_FORMAT =
  '{"id":"{{.Id}}","state":{{json .State}}}' as const;

/** The argv that reads a container's final state, by name or by id. */
export const inspectArgs = (target: string): readonly string[] => [
  "inspect",
  `--format=${INSPECT_FORMAT}`,
  target,
];

/**
 * The argv that answers "is this image already on the host". Asked before the
 * run, because afterwards the answer is always yes and the cold-start half of a
 * slow run becomes unattributable.
 */
export const imageInspectArgs = (image: string): readonly string[] => [
  "image",
  "inspect",
  "--format={{.Id}}",
  image,
];

/**
 * The argv that removes a container, its anonymous volumes with it. `--force`
 * covers the container that is still running, which is what an interrupted run
 * leaves behind, and makes the command succeed when there is nothing left to
 * remove.
 */
export const removeArgs = (target: string): readonly string[] => [
  "rm",
  "--force",
  "--volumes",
  target,
];

/**
 * The argv that reads a running container's memory usage once.
 *
 * `--no-stream` is not a detail. The streaming form is one process for the whole
 * run and would sample far more finely, but it only ever ends by being killed —
 * and killing a child that is blocked reading a pipe is precisely what the
 * current Bun spawner cannot do: the scope waits forever, and a scope that never
 * closes is a container that is never removed. One short-lived process per
 * sample costs a couple of seconds of a CLI and every one of them ends on its
 * own, which is the property the teardown depends on.
 */
export const statsArgs = (target: string): readonly string[] => [
  "stats",
  "--no-stream",
  "--format={{.MemUsage}}",
  target,
];

/**
 * What docker writes into `StartedAt` for a container that was created and
 * never ran. It is the zero value of a Go `time.Time`, and it is the only
 * reliable way to tell "the command ran and exited 127" from "the command was
 * never found, so nothing ran" — both of which report 127.
 */
export const CONTAINER_NEVER_STARTED = "0001-01-01T00:00:00Z";

/** A container's final state, as much of it as an event needs. */
export interface InspectedContainer {
  readonly containerId: string;
  /** The runtime's own account of why a container never started. Empty otherwise. */
  readonly error: string;
  /** Null where the container never produced one. */
  readonly exitCode: number | null;
  /** `State.OOMKilled`, the only thing that tells a memory kill from a teardown's SIGKILL. */
  readonly oomKilled: boolean;
  /** False for a container that was created and never ran a command. */
  readonly started: boolean;
}

/** Whether a parsed JSON value is a plain object, which every field below lives on. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One field, or null where the daemon's shape is not what this expects. */
const stringAt = (record: Readonly<Record<string, unknown>>, key: string) =>
  typeof record[key] === "string" ? (record[key] as string) : null;

/**
 * Reads {@link inspectArgs} output.
 *
 * Total, and null on anything unexpected: an unparseable inspect is a container
 * whose fate is unknown, and the caller treats that as a container that never
 * started rather than inventing an exit code for it. A daemon that changes the
 * shape of `State` should degrade a row, never fail a run.
 */
export const parseInspect = (stdout: string): InspectedContainer | null => {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return null;
    }
  })();
  if (!isRecord(parsed)) {
    return null;
  }
  const id = stringAt(parsed, "id");
  const { state } = parsed;
  if (id === null || !isRecord(state)) {
    return null;
  }
  return {
    containerId: id,
    error: stringAt(state, "Error") ?? "",
    exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    started: stringAt(state, "StartedAt") !== CONTAINER_NEVER_STARTED,
  };
};

/**
 * Terminal control sequences, which `docker stats` emits even when nothing it
 * writes to is a terminal: the streaming form repaints its table in place, so
 * every line arrives wrapped in cursor moves.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the thing being matched
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

/** One line of terminal output with its cursor moves removed. */
export const stripAnsi = (text: string) => text.replace(ANSI_PATTERN, "");

/**
 * Byte sizes as the docker CLI writes them. Both families are listed because
 * the CLI picks its unit per value and its own helpers have shipped each of
 * them: reading `2GB` as two gigabytes when it meant `2GiB` misreports a
 * container's peak by seven percent, and reading it as nothing at all loses the
 * measurement.
 */
const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;
const TIB = GIB * KIB;
const PIB = TIB * KIB;
const KB = 1000;
const MB = KB * KB;
const GB = MB * KB;
const TB = GB * KB;
const PB = TB * KB;

const MEMORY_UNITS: Readonly<Record<string, number>> = {
  B: 1,
  GB,
  GiB: GIB,
  KB,
  KiB: KIB,
  kB: KB,
  MB,
  MiB: MIB,
  PB,
  PiB: PIB,
  TB,
  TiB: TIB,
};

/** `540KiB / 7.654GiB` — the used half, a number and a unit. */
const MEM_USAGE_PATTERN = /^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)$/;

/**
 * The used-memory half of one `docker stats` line, in bytes, or null for a
 * line that carries no reading — a header, a repaint artefact, or the blank
 * line the CLI prints while a container is still starting.
 */
export const parseMemUsage = (line: string): number | null => {
  const [used] = stripAnsi(line).split("/");
  const matched = MEM_USAGE_PATTERN.exec(used?.trim() ?? "");
  if (matched === null) {
    return null;
  }
  const [, amount, unit] = matched;
  const scale = MEMORY_UNITS[unit ?? ""];
  return scale === undefined ? null : Number(amount) * scale;
};
