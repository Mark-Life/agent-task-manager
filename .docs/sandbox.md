# Sandbox (`bun run sandbox:check`)

Every run gets its own Docker container, torn down after it. `packages/sandbox` owns that
lifetime end to end: one `run` call creates the container, streams its output, waits, inspects
it, and removes it — on every exit path including the interrupt a stop command produces.
Interrupting the fiber *is* how a run is stopped, which is why there is no `kill` method. The
package never imports `packages/db`.

**Seven mounts, and nothing else.** The run directory (rw, mounted at `/run`, holding the message
marker, the turn spec and the event ledger), the provider's agent home (rw, `/agent-home`, see
[agent homes](./agent-homes.md)), the workspace checkout (rw, `/workspace`), the shared package
store (rw, `/cache`, the other mount shared between runs — see below), the
task's artifacts folder (rw, `/artifacts/task`), and the project's and global promoted folders
(**ro**, `/artifacts/project` and `/artifacts/global`). Read-only on the shared folders is
load-bearing: promotion is a deliberate act performed on the host, and that separation is the
audit trail. Never the docker socket — that one mount turns a sandbox into host root. A
container that runs our own turn entrypoint gets one more, read-only: the bundled entrypoint
at `/opt/atm/turn.js` (see below).

**The operator's skills, when there are any.** `ATM_SKILLS_DIR` names one host directory,
mounted **ro** at `/agent-home/skills` — inside the agent home, because that is where a provider
looks for the personal skills of whoever it is running as. It is the one bind inside another
bind, and the nesting is what makes it work at all; the daemon mounts a destination before
anything under it. Unset shares nothing, which is the default. Mounted rather than copied, so an
edit on the host is in the next container with no sync step.

**One package store for the whole host.** `${DATA_ROOT}/caches` is mounted rw at `/cache`, and
`BUN_INSTALL_CACHE_DIR`, `npm_config_cache`, `npm_config_store_dir`,
`PNPM_CONFIG_STORE_DIR`, `YARN_GLOBAL_FOLDER` and `YARN_ENABLE_GLOBAL_CACHE` point every manager
at it. pnpm is named twice for one directory: through pnpm 10 the store came off
`npm_config_store_dir`, and pnpm 11 reads `PNPM_CONFIG_STORE_DIR` and ignores the other. Shared across projects, because these
stores are content-addressed and sharing is where the dedupe comes from; a sibling of
`workspaces/` under one root, because pnpm hardlinks out of its store into `node_modules` and a
hardlink cannot cross a filesystem. `node_modules` is still per run — the cache makes the install
fast, it does not remove it. Nothing evicts: `du` it when the disk gets tight, delete it, and
take one cold install. A poisoned cache spreads to later runs, which is accepted — the agent
already has network access and push rights. Only worker runs get it.

**The project's environment files land in the checkout.** After the clone returns, before the
container starts: `0600`, parent directories made as needed, each path appended to the
checkout's `.git/info/exclude`, and the whole checkout `0700` rather than `0755` because it now
holds credentials beside every other run's checkout under one data root. The paths come from the
orchestrator as plain `{path, content}`, so this package still never imports `packages/db`, and
they die with the checkout when the scope closes. See [project env](./project-env.md).

A chat turn has no task and no project, so it gets four: the run directory, the agent home, a
scratch `/workspace` released with the run, and the global promoted folder read-only. Nothing
it writes to `/workspace` outlives the container, and the prompt says so.

**Hardening**: `--cap-drop=ALL`, `no-new-privileges`, non-root, `SANDBOX_MEMORY_MB` (2048 by
default) with swap pinned equal, `SANDBOX_CPUS` (1.5), 512 pids, `/tmp` as a capped tmpfs,
`--init`. Both limits are ceilings and not reservations — nothing is allocated up front, so
the sum across the slots may exceed the box; what the memory number decides is that a runaway
run is OOM-killed and retried rather than the kernel choosing a victim on the host, and an
over-committed CPU quota only ever costs contention. Network is fully open, and that is a
decision: search, `bun install`, `gh` and the model APIs are the work.

**Two implementations behind one service.** `SANDBOX_MODE=docker` (the default) or `local`,
which runs the same spec as a plain host process for debugging a harness change without an
image build. Local isolates nothing and says so — it logs every confinement it dropped, and
writes `kind: "local"` on its row, so an unisolated run can never be mistaken for a sandboxed
one afterwards. The orchestrator asks for a `Sandbox` and never learns which it got.

**Repos are cloned from a host-side bare mirror** under `${DATA_ROOT}/mirrors`, fetched at the
start of every materialization so a run branches from the remote's tip as it stands at
dispatch. The fetch used to be a scheduled sweep held off the dispatch path for latency;
nothing ever owned the schedule, so mirrors were fetched once and every later run branched from
a base frozen on the day the repo was first seen. It is bounded (3 minutes) and retried past the
ref-lock race two concurrent dispatches cause, and a fetch that still fails **fails the run** —
there is no fallback to the stale mirror, because a silently old base is the bug this prevents.
A task with no repo gets an empty scratch directory and the same machinery. Artifacts live under
`${DATA_ROOT}/artifacts/{global,projects/<id>,tasks/<id>}`; Postgres holds an index of them,
never the bytes.

Every container leaves exactly one `atm.sandbox` row: image, mounts counted, exit code, OOM
flag, peak memory, wall clock, pull-vs-cached, teardown outcome. The `atm.turn` rows the
harness writes inside the container land on the host through the run mount, carrying the
`runId` the host minted, so one query joins the two.

```bash
bun run sandbox:check          # alpine, seconds: mounts, isolation, the agent home, the rows
bun run sandbox:check --agent  # the same, against atm.local/base:latest and its tools
bun run sandbox:check --image X  # against any image by name
```

Every container this repo starts — the check and every dispatched run — runs as the operator's
own uid rather than the image's `1000:1000`, because a bind mount carries host ownership
straight through; everything else in the default confinement is untouched. See
`docker/README.md` for the two images and the rebuild cadence.

