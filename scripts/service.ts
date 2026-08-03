#!/usr/bin/env bun

/**
 * The three long-running processes, as systemd user services.
 *
 * `systemctl --user` is the thing an operator actually types here, and it is
 * three units, a `daemon-reload`, a unit directory nobody remembers the path
 * of, and one `loginctl enable-linger` without which none of it survives a
 * logout. This wraps that so the commands worth running are in `package.json`
 * beside every other command, and so installing is idempotent rather than a
 * sequence somebody has to get right from the README.
 *
 *     bun run service:install            # all three, or name some
 *     bun run service:status
 *     bun run service:logs -n 50 loop
 *     bun run service:restart gateway bot
 *
 * The unit files in `deploy/user/` are the source. They are templates only in
 * the two places a checkout can differ — where the repository is and where
 * `bun` lives — and this substitutes both at install time, so a checkout
 * anywhere works without editing a committed file. Everything else, including
 * `%h/.config/agent-task-manager`, stays a systemd specifier because systemd
 * resolves it better than we can.
 *
 * The system-wide units beside them are a different deployment and are not
 * touched here; see `deploy/README.md`.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";

/** The repository root, from this file rather than from the caller's cwd. */
const REPO_DIR = resolve(import.meta.dir, "..");

/** The `bun` running this script, which is the one the units should name. */
const BUN_PATH = process.execPath;

/** Where a user unit goes. `systemctl --user` looks here and nowhere else. */
const UNIT_DIR = join(
  process.env.HOME ?? userInfo().homedir,
  ".config/systemd/user"
);

/** Width of the active column, so `inactive` and `failed` line up under it. */
const ACTIVE_WIDTH = "inactive".length;

/** Indent for the `--json` output, so it is readable in a terminal. */
const JSON_INDENT = 2;

/** Where the environment files live, matching the `%h` path in every unit. */
const ENV_DIR = join(
  process.env.HOME ?? userInfo().homedir,
  ".config/agent-task-manager"
);

/**
 * What each service is called, what unit carries it, and which environment
 * files it cannot start without.
 *
 * The required list is why `install` can be run on a half-configured host: a
 * unit whose `EnvironmentFile=` has no `-` prefix fails at boot when the file
 * is missing, and systemd reports that as a service that will not start rather
 * than as a file somebody has not written yet.
 */
const SERVICES = {
  bot: { requires: ["common.env", "bot.env"], unit: "atm-bot" },
  gateway: { requires: ["common.env"], unit: "atm-gateway" },
  loop: { requires: ["common.env"], unit: "atm-loop" },
} as const;

type ServiceName = keyof typeof SERVICES;

const ALL: readonly ServiceName[] = Object.keys(
  SERVICES
).sort() as ServiceName[];

const args = process.argv.slice(2);
const [command] = args;

/** True when `flag` appears anywhere in argv. */
const hasFlag = (flag: string) => args.includes(flag);

/** The value after `--flag`, or undefined when the flag is absent. */
const readFlag = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/**
 * The services named on the command line, or all of them.
 *
 * An unknown name stops the command rather than being ignored: "restart the
 * gatway" silently restarting nothing is the kind of thing an operator finds
 * out about much later.
 */
const targets = (): readonly ServiceName[] => {
  const flagValues = new Set(
    args.filter((arg) => arg.startsWith("-")).map((flag) => readFlag(flag))
  );
  const named = args
    .slice(1)
    .filter((arg) => !(arg.startsWith("-") || flagValues.has(arg)));
  if (named.length === 0) {
    return ALL;
  }
  const unknown = named.filter((name) => !(name in SERVICES));
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown service ${unknown.join(", ")} — known: ${ALL.join(", ")}\n`
    );
    process.exit(1);
  }
  return named as ServiceName[];
};

/** One command, with its output captured. */
const run = (cmd: readonly string[]) => {
  const result = spawnSync(cmd[0] ?? "", cmd.slice(1), { encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stderr: (result.stderr ?? "").trim(),
    stdout: (result.stdout ?? "").trim(),
  };
};

/** One command, streaming straight to this terminal. */
const runInherit = (cmd: readonly string[]) =>
  spawnSync(cmd[0] ?? "", cmd.slice(1), { stdio: "inherit" }).status ?? 1;

/** `systemctl --user …`, captured. */
const systemctl = (...rest: string[]) => run(["systemctl", "--user", ...rest]);

/** The unit file as this host should have it, with the two paths substituted. */
const render = (service: ServiceName) => {
  const template = join(
    REPO_DIR,
    "deploy/user",
    `${SERVICES[service].unit}.service`
  );
  return readFileSync(template, "utf8")
    .replaceAll("%h/projects/agent-task-manager", REPO_DIR)
    .replaceAll("%h/.bun/bin/bun", BUN_PATH);
};

/** The environment files a service needs and this host does not have. */
const missingEnv = (service: ServiceName) =>
  SERVICES[service].requires.filter((file) => !existsSync(join(ENV_DIR, file)));

/** Whether linger is on, without which every unit stops at logout. */
const lingerOn = (user: string) =>
  run(["loginctl", "show-user", user, "--property=Linger"]).stdout.includes(
    "Linger=yes"
  );

/**
 * Writes the unit files, enables what can be enabled, and turns linger on.
 *
 * Idempotent by construction: a unit whose content already matches is left
 * alone, and one that changed while its service was running is restarted, so
 * re-running after an edit is the whole upgrade path. A service missing an
 * environment file is installed but not enabled — the file is the operator's to
 * write, and a crash-looping unit is a worse way to say so.
 */
const writeUnits = (chosen: readonly ServiceName[]) => {
  mkdirSync(UNIT_DIR, { recursive: true });
  const changed: ServiceName[] = [];

  for (const service of chosen) {
    const path = join(UNIT_DIR, `${SERVICES[service].unit}.service`);
    const wanted = render(service);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (existing === wanted && !hasFlag("--force")) {
      process.stdout.write(`${service}: unit already up to date\n`);
      continue;
    }
    // Written beside the target and renamed, so a unit file is never half
    // there — systemd reads this directory on a timer as well as on demand.
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, wanted, "utf8");
    renameSync(temporary, path);
    changed.push(service);
    process.stdout.write(
      `${service}: ${existing === null ? "wrote" : "updated"} ${path}\n`
    );
  }

  return changed;
};

/**
 * Enables and starts each service whose environment files are all present.
 *
 * A service whose unit changed while it was running is restarted, because
 * `enable --now` on an already-running unit does nothing and the edit would
 * otherwise take effect at the next reboot and nowhere sooner.
 */
const enableUnits = (
  chosen: readonly ServiceName[],
  changed: readonly ServiceName[]
) => {
  for (const service of chosen) {
    const missing = missingEnv(service);
    if (missing.length > 0) {
      process.stdout.write(
        `${service}: not enabled — ${ENV_DIR} is missing ${missing.join(", ")}\n`
      );
      continue;
    }
    const wasActive =
      systemctl("is-active", SERVICES[service].unit).stdout === "active";
    const enabled = systemctl("enable", "--now", SERVICES[service].unit);
    if (enabled.code !== 0) {
      process.stderr.write(`${service}: ${enabled.stderr || enabled.stdout}\n`);
      continue;
    }
    if (changed.includes(service) && wasActive) {
      systemctl("restart", SERVICES[service].unit);
      process.stdout.write(`${service}: restarted, the unit changed\n`);
    }
  }
};

/** Turns linger on, or says who has to. Without it nothing survives a logout. */
const ensureLinger = () => {
  const user = process.env.USER ?? userInfo().username;
  if (hasFlag("--no-linger") || lingerOn(user)) {
    return;
  }
  const linger = run(["loginctl", "enable-linger", user]);
  process.stdout.write(
    linger.code === 0
      ? `enabled linger for ${user}\n`
      : `could not enable linger — run: sudo loginctl enable-linger ${user}\n`
  );
};

/**
 * Writes the unit files, enables what can be enabled, and turns linger on.
 *
 * Idempotent by construction: a unit whose content already matches is left
 * alone, and one that changed while its service was running is restarted, so
 * re-running after an edit is the whole upgrade path. A service missing an
 * environment file is installed but not enabled — the file is the operator's to
 * write, and a crash-looping unit is a worse way to say so.
 */
const install = () => {
  const chosen = targets();

  if (hasFlag("--dry-run")) {
    for (const service of chosen) {
      process.stdout.write(`${render(service)}\n`);
    }
    return 0;
  }

  const changed = writeUnits(chosen);
  systemctl("daemon-reload");
  enableUnits(chosen, changed);
  ensureLinger();
  return 0;
};

/** One line per service, or `--json` for something a script can read. */
const status = () => {
  const chosen = targets();
  const rows = chosen.map((service) => ({
    active: systemctl("is-active", SERVICES[service].unit).stdout,
    enabled: systemctl("is-enabled", SERVICES[service].unit).stdout,
    missingEnv: missingEnv(service),
    service,
    unit: SERVICES[service].unit,
  }));

  if (hasFlag("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          linger: lingerOn(process.env.USER ?? userInfo().username),
          services: rows,
        },
        null,
        JSON_INDENT
      )}\n`
    );
    return 0;
  }

  const width = Math.max(...chosen.map((service) => service.length));
  for (const row of rows) {
    const note =
      row.missingEnv.length > 0
        ? `   missing ${row.missingEnv.join(", ")}`
        : "";
    process.stdout.write(
      `${row.service.padEnd(width)}  ${row.active.padEnd(ACTIVE_WIDTH)} ${row.enabled}${note}\n`
    );
  }
  const user = process.env.USER ?? userInfo().username;
  process.stdout.write(`linger: ${lingerOn(user) ? "yes" : "no"}\n`);
  return 0;
};

/** The journal for the chosen services, followed unless told otherwise. */
const logs = () => {
  const cmd = [
    "journalctl",
    "--user",
    "-n",
    readFlag("-n") ?? "200",
    "--no-pager",
  ];
  for (const service of targets()) {
    cmd.push("-u", SERVICES[service].unit);
  }
  if (!hasFlag("--no-follow")) {
    cmd.push("-f");
  }
  return runInherit(cmd);
};

/** `start`, `stop` and `restart`, over each chosen service. */
const simple = (verb: string) => {
  let code = 0;
  for (const service of targets()) {
    const result = systemctl(verb, SERVICES[service].unit);
    if (result.code === 0) {
      process.stdout.write(`${service}: ${verb} ok\n`);
    } else {
      process.stderr.write(`${service}: ${result.stderr || result.stdout}\n`);
      ({ code } = result);
    }
  }
  return code;
};

/** Stops, disables and removes the units. Environment files and linger stay. */
const uninstall = () => {
  for (const service of targets()) {
    systemctl("disable", "--now", SERVICES[service].unit);
    const path = join(UNIT_DIR, `${SERVICES[service].unit}.service`);
    rmSync(path, { force: true });
    process.stdout.write(`${service}: removed ${path}\n`);
  }
  systemctl("daemon-reload");
  process.stdout.write(`environment files in ${ENV_DIR} left untouched\n`);
  return 0;
};

const usage = `Usage: bun run service:<command> [service...]

  install    [--force] [--dry-run] [--no-linger]
  status     [--json]
  logs       [-n <lines>] [--no-follow]
  start | stop | restart
  uninstall

Services: ${ALL.join(", ")}. Naming none means all of them.`;

/** Commands that read nothing from systemd, and so run anywhere. */
const isOffline =
  command === undefined ||
  command === "help" ||
  (command === "install" && hasFlag("--dry-run"));

if (!(isOffline || process.platform === "linux")) {
  process.stderr.write("this manages systemd user services, so Linux only\n");
  process.exit(1);
}

const commands: Record<string, () => number> = {
  install,
  logs,
  restart: () => simple("restart"),
  start: () => simple("start"),
  status,
  stop: () => simple("stop"),
  uninstall,
};

if (command === undefined || command === "help") {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

const handler = commands[command];
if (handler === undefined) {
  process.stderr.write(`unknown command ${command}\n\n${usage}\n`);
  process.exit(1);
}

process.exit(handler());
