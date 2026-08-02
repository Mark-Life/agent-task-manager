/**
 * What a container is allowed to be, as data plus the argv that states it.
 *
 * The premise of the whole sandbox is that the agent inside it is confused
 * rather than malicious, and that the blast radius of a confused agent should be
 * its own container. Every flag here is one way out of that container closed:
 * capabilities so a process cannot touch the host's devices or network stack,
 * `no-new-privileges` so a stray setuid binary cannot escalate, a non-root user
 * so a mount write lands as the operator rather than as root, and the three
 * limits so one runaway run cannot take the host down with it.
 *
 * Defaults are sized for the real host: four cores, eight gigabytes, arm64, two
 * to three heavy containers at once. They are deliberately not generous. A run
 * that hits the memory limit is killed, counted as `oom_killed`, and retried;
 * a host that swaps because three containers were each promised six gigabytes
 * stops responding to ssh, and nothing is counted at all.
 *
 * Network stays fully open, and that is a decision rather than an omission.
 * Search, `bun install`, `gh`, and the model APIs are all the work, not
 * incidental to it, and an egress allow-list covering package registries, their
 * CDNs, GitHub, and two model providers is a list that breaks every week and
 * teaches an operator to widen it without reading. The additive answer, when it
 * is wanted, is a proxy on the sandbox network with the container pointed at it
 * — no change to any of this, and a real allow-list in one place that is
 * somebody's job to maintain.
 *
 * Everything here is pure argv construction so the flags can be asserted in a
 * unit test. A security flag that is only exercised by starting a real container
 * is a security flag that gets dropped during a refactor.
 */

import process from "node:process";

/**
 * Whether the container's root filesystem is writable. Off by default, and this
 * is the honest reason: an agent's ordinary work writes outside its mounts —
 * `bun install` populates the global install cache under the container's home,
 * `gh` writes a config file, and half the CLIs in the image drop a state
 * directory somewhere in `/home` or `/usr/local`. A read-only rootfs turns all
 * of that into a first-turn crash, and the tmpfs-per-writable-path list that
 * would fix it is a list nobody can keep correct against an image that gains
 * tools. The container is ephemeral, so what it writes to its own layer dies
 * with it; the flag stays here, and flipping it is a real option the day the
 * image ships with every writable path already mounted.
 */
export const DEFAULT_READ_ONLY_ROOTFS = false;

/**
 * Memory ceiling per container, in megabytes. Three of these fit in eight
 * gigabytes with room for the host, Postgres and the loop.
 */
export const DEFAULT_MEMORY_MB = 2048;

/**
 * CPU quota per container. Slight oversubscription against four cores is right:
 * an agent spends most of its wall clock waiting on a model, and a hard 1.0
 * would make the one minute it does spend compiling take four.
 */
export const DEFAULT_CPUS = 1.5;

/**
 * Process ceiling. High enough for an install fanning out across cores and a
 * headless browser's helper processes, low enough that a fork bomb hits the
 * limit instead of the host's pid space.
 */
export const DEFAULT_PIDS_LIMIT = 512;

/** Size of the container's `/tmp`, in megabytes. */
export const DEFAULT_TMPFS_MB = 512;

/**
 * The user a container runs as, `uid:gid`.
 *
 * Numeric rather than a name, because a name has to exist in every image's
 * `/etc/passwd` and a container that cannot resolve it refuses to start. The
 * value has to match the owner of the data root on the host: a bind mount
 * carries host ownership straight through, so a mismatch is a run that boots
 * fine and then cannot write its own agent home.
 */
export const DEFAULT_USER = "1000:1000";

/**
 * The operator's own `uid:gid`, which is what every container actually runs as.
 *
 * This is the answer to the ownership question the mounts raise, and it is one
 * line because the kernel makes it one line. A bind mount carries host
 * ownership straight through and does no id translation, so a container writing
 * the shared agent home writes as whatever numeric uid it was started with. Set
 * that to the uid that owns the directory on the host — the human who ran
 * `mkdir` and `/login` — and every write inside lands as them, on a directory
 * they can still read at `0700`. Nothing needs chowning and nothing needs to be
 * uid 1000.
 *
 * {@link DEFAULT_USER} is only the fallback for a runtime with no `getuid`,
 * which bun has on both platforms. Zero is a last resort that
 * `hardeningArgs` will still refuse to make root-shaped silently: a check
 * script asserts against it.
 */
export const hostUser = () =>
  `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;

/**
 * The only network mode a sandbox uses. Named rather than inlined so the
 * decision above is greppable, and so the proxy variant has somewhere to land.
 */
export type SandboxNetwork = "bridge";

/** One tmpfs the container gets, in place of a writable path it would otherwise lack. */
export interface TmpfsMount {
  /** Octal permission bits, as docker wants them: `/tmp` is world-writable and sticky. */
  readonly mode: number;
  /** Absolute path inside the container. */
  readonly path: string;
  readonly sizeMb: number;
}

/**
 * `/tmp` as a tmpfs: capped, so a runaway download fills 512MB of RAM and stops
 * instead of the host's disk, and gone the moment the container is.
 *
 * `nosuid` and `nodev` are the two that matter — no setuid escalation, no device
 * nodes. `noexec` is deliberately absent: installers, build scripts and more
 * than one agent CLI unpack a helper into `/tmp` and run it, so the flag buys
 * very little against an agent that can already execute code in its workspace,
 * and costs a class of failure that looks like a broken image.
 */
export const DEFAULT_TMPFS: readonly TmpfsMount[] = [
  { mode: 0o1777, path: "/tmp", sizeMb: DEFAULT_TMPFS_MB },
];

/** Every hardening decision for one container, as one record. */
export interface HardeningSpec {
  /** Capabilities dropped. `ALL`, and nothing is ever added back. */
  readonly capDrop: readonly string[];
  readonly cpus: number;
  /**
   * Run an init process as pid 1. Without one, nothing reaps the agent's
   * children and a stop signal never reaches them — a stopped run leaves
   * zombies and a container that takes the full kill timeout to die.
   */
  readonly init: boolean;
  readonly memoryMb: number;
  /**
   * Total memory plus swap. Equal to {@link HardeningSpec.memoryMb}, which is
   * how docker is told "no swap": a container allowed to swap does not get
   * OOM-killed, it gets slow, and it drags every other container on the box down
   * with it while looking healthy.
   */
  readonly memorySwapMb: number;
  readonly network: SandboxNetwork;
  /** Blocks setuid escalation inside the container. Always on. */
  readonly noNewPrivileges: boolean;
  readonly pidsLimit: number;
  readonly readOnlyRootfs: boolean;
  readonly tmpfs: readonly TmpfsMount[];
  /** `uid:gid`. Never root, and never empty. */
  readonly user: string;
}

/** The defaults, sized for a 4-core / 8 GB arm64 host running two to three containers. */
export const defaultHardening: HardeningSpec = {
  capDrop: ["ALL"],
  cpus: DEFAULT_CPUS,
  init: true,
  memoryMb: DEFAULT_MEMORY_MB,
  memorySwapMb: DEFAULT_MEMORY_MB,
  network: "bridge",
  noNewPrivileges: true,
  pidsLimit: DEFAULT_PIDS_LIMIT,
  readOnlyRootfs: DEFAULT_READ_ONLY_ROOTFS,
  tmpfs: DEFAULT_TMPFS,
  user: DEFAULT_USER,
};

/** Docker reads a tmpfs mode as octal, so the bits are rendered in base 8. */
const OCTAL = 8;

/** One tmpfs as a `docker run` flag. */
export const tmpfsArg = (mount: TmpfsMount) =>
  `--tmpfs=${mount.path}:rw,nosuid,nodev,size=${mount.sizeMb}m,mode=${mount.mode.toString(OCTAL)}`;

/**
 * The hardening half of a run's argv. Pure, ordered, and complete: everything a
 * container's confinement depends on is in this array, so a test that asserts
 * the array asserts the confinement.
 */
export const hardeningArgs = (spec: HardeningSpec): readonly string[] => {
  const args = spec.capDrop.map((capability) => `--cap-drop=${capability}`);
  if (spec.noNewPrivileges) {
    args.push("--security-opt=no-new-privileges:true");
  }
  args.push(
    `--user=${spec.user}`,
    `--pids-limit=${spec.pidsLimit}`,
    `--memory=${spec.memoryMb}m`,
    `--memory-swap=${spec.memorySwapMb}m`,
    `--cpus=${spec.cpus}`,
    // Stated rather than left to the daemon's default, so the one decision this
    // file makes in the open is visible in the argv a post-mortem reads.
    `--network=${spec.network}`
  );
  if (spec.readOnlyRootfs) {
    args.push("--read-only");
  }
  if (spec.init) {
    args.push("--init");
  }
  args.push(...spec.tmpfs.map(tmpfsArg));
  return args;
};
