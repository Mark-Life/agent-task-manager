# Sandbox (`bun run sandbox:check`)

Every run gets its own Docker container, torn down after it. `packages/sandbox` owns that
lifetime end to end: one `run` call creates the container, streams its output, waits, inspects
it, and removes it — on every exit path including the interrupt a stop command produces.
Interrupting the fiber *is* how a run is stopped, which is why there is no `kill` method. The
package never imports `packages/db`.

**Six mounts, and nothing else.** The run directory (rw, mounted at `/run`, holding the comment
marker, the turn spec and the event ledger), the provider's agent home (rw, `/agent-home`, the
one mount shared between runs — see [agent homes](./agent-homes.md)), the workspace checkout (rw, `/workspace`), the
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

**Repos are cloned from a host-side bare mirror** under `${DATA_ROOT}/mirrors`, refreshed on a
schedule the orchestrator owns, never on the path of a dispatch. A task with no repo gets an
empty scratch directory and the same machinery. Artifacts live under
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

