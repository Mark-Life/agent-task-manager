# Orchestrator loop (`bun run loop:start`, `bun run loop:check`)

**Two things wake the loop, and they are the same thing.** Moving a card into *in progress*
fires `atm_task_dispatch`; a person saying something into a conversation fires
`atm_chat_dispatch` from the `chat_message` insert. A slow poll runs beside both as the safety
net for a notification delivered to nobody. Either wakes one sweep, which reads the column in
rank order and the conversations with something unanswered. There is no queue anywhere but the
database.

**A worker run and a chat turn are one runtime.** A run carries a `role` — `worker` or
`manager` — and the role selects exactly four things: the system prompt, what the run is
attached to (a task or a conversation), the container image, and what the run's board
credential is bound to. Everything else is shared: one dispatch, one lease, one pool, one quota
gate, one `run` row, one event ingest, one retry ladder, one `atm.run`. A pull request that adds
a role check inside the lease, the pool, the quota gate or the turn is wrong by construction.

The two lanes are the one exception, and they are a capacity decision rather than a behaviour
one: `ORCHESTRATOR_MAX_CONCURRENCY` worker slots and `ORCHESTRATOR_MAX_CHAT_CONCURRENCY` chat
slots, so a person waiting on an answer is never queued behind two hour-long worker runs. The
box's ceiling is the sum.

Each unit of work goes through the same sequence, and the order is the design:

```
signal → drain run commands → read the column → plan → quota → pool → lease →
open run → turn → close → ingest → artifact rescan → retry
```

**Nothing is written before the loop has committed.** A plan only reads: status, park stamp,
live run, project, attempt, provider. The quota gate, the concurrency cap and the durable lease
each get to refuse over that plan with nothing to undo — so a drained subscription costs a
skipped sweep, not a run row and a trip through *review* to say "not now".

**Every ending lands the task in *review*, failures included.** A crashed run posts its error
into the thread as a comment, marks its session failed, and moves the card to the human gate;
there is no failed column and no auto-retry. The backoff ladder and the park stamp
(`task.parked_until`) apply to the two failures that leave the card in the column, where the
next sweep would otherwise try again forever: a dispatch that never became a run, and a run
that ended but whose move to *review* was refused. The second one is stamped from inside the
run's own close, so the `atm.run` row reports the rung it earned.

**Every dispatched turn runs in its own container.** The loop writes a turn spec into the run's
directory, starts `atm.local/base:latest` over the mounts above, and reads back what the
container left in that same directory: the normalized event file — tailed *while* the container
runs, so the timeline fills live and `seq` is the file's line ordinal on both passes — the
`atm.turn` row, and a result file that is the container's last word on a run whose stream said
nothing at all. The entrypoint is not baked into the image. The image carries bun, node, git,
`gh` and the agent CLIs, which move on a weekly rebuild, while the entrypoint is this repo's own
code and changes every commit, so `bun run entrypoint:build` bundles it to
`${DATA_ROOT}/bin/turn.js` and it is bind-mounted read-only at `/opt/atm/turn.js`. Run that once
before the first dispatch; the loop says so at boot when the bundle is missing. Three caps nest,
each below the one outside it — the loop's `ORCHESTRATOR_RUN_TIMEOUT_MS`, the container's, and
the turn's — because the container's cap is a `SIGKILL` that leaves no result file, so the
informative ending is always the one that fires first. `SANDBOX_MODE=local` still serves the
turn as a plain host process for debugging a harness change without an image, and writes
`kind: "local"` on the row so an unisolated run can never be mistaken for a contained one.

**A run that goes quiet is closed, not waited on.** A stream that ends with no result is
`lost`; one that never ends at all is torn down at `ORCHESTRATOR_RUN_TIMEOUT_MS` (an hour by
default) and closed as `timeout`, so a wedged provider costs one slot for one hour rather than
one slot forever.

**A run that posted no comment gets its last message appended as one**, flagged
`fallback` so the UI can collapse it. After the turn the loop reads the run's directory back:
the normalized event file into `run_events` (idempotently — `seq` is the file's line ordinal),
the transcript into the session, and the task's artifacts folder into the artifact index.

**Stop and rerun are rows.** Anyone may write a `run_command`; only the loop acts on one.
Writing one notifies `atm_run_command`, which wakes a sweep the same way a card does — the
queue is drained before the column is read, so a stop lands even with every slot busy. A stop
interrupts the fiber holding the run, which is the whole of a teardown, and a refused command
is rejected with its reason on the row rather than consumed in silence.

**Kill it and it recovers.** A lease file per claimed task is heartbeated under
`${DATA_ROOT}/leases`; at boot the loop reclaims every lease whose holder is gone and closes
every run row still marked live behind it as `lost` — posting the comment, ending the session,
moving the task, and writing the terminus row the killed process could not. A run leaves two
`atm.run` rows sharing one `runId`: a `start` when it is claimed and a terminus on every exit
path, so a start with no end is a countable `lost` run rather than silence.

```bash
bun run loop:start           # the loop, against DATABASE_URL; Ctrl-C for a graceful stop
bun run loop:check           # stub provider, turn as a host process, own data root, seconds, free
bun run loop:check --docker  # the same claims with the turn in a real container — still free
bun run loop:check --live    # the same, on the real provider — this one costs money
```

`loop:check` files a task, watches the loop run it into *review*, opens a conversation and
watches the same loop answer it as a `role: manager` run with no task, then kills a second loop
mid-run with `SIGKILL` and proves the restart closes the killed run as `lost`.

`--docker` runs that first half with the turn inside `atm.local/base:latest` and adds the three
claims a host process cannot make: the `atm.run` rows say `kind: docker` on that image, the
daemon left an `atm.sandbox` row for a container that really ran, and the `atm.turn` row written
*inside* the container came back out through the mount carrying the run id the host minted. It
stays free because it bundles its own entrypoint — the real one from `packages/harness` with the
provider stubbed, so the model call is the only thing faked — into its own data root, never over
the operator's `${DATA_ROOT}/bin/turn.js`. It skips the kill half, which is a claim about the
loop and needs no container.

Knobs: `ORCHESTRATOR_MAX_CONCURRENCY` (default 2, sized for a 4-core box),
`ORCHESTRATOR_MAX_CHAT_CONCURRENCY` (default 1), `ORCHESTRATOR_POLL_INTERVAL_MS`,
`ORCHESTRATOR_LEASE_STALE_MS`, `ORCHESTRATOR_MAX_ATTEMPTS`, `ORCHESTRATOR_RUN_TIMEOUT_MS`,
`ORCHESTRATOR_CHAT_TIMEOUT_MS`, `ORCHESTRATOR_DEFAULT_PROVIDER`,
`ORCHESTRATOR_GATEWAY_URL`, `ORCHESTRATOR_AGENT_TOKEN_TTL_MS`, `LOOP_SHUTDOWN_GRACE_MS`.

**Every turn gets the board tools**, worker and manager alike: the loop mints a scoped token
per run, writes an `mcp-servers.json` onto that run's mount before the container starts and
deletes it on every exit path. A worker's token is bound to its one task, a manager's to its
conversation — the same credential, one bound narrower. `ORCHESTRATOR_GATEWAY_URL` is the
gateway **as a container resolves it** (`http://host.docker.internal:3100` on macOS); unset, a
turn runs with no board tools and the loop says so once at boot. `bun run agent-mcp:build` has
to have bundled the tools to `${DATA_ROOT}/bin/agent-mcp.js` first; a missing bundle fails the
run rather than producing an agent that answers confidently with no board access.

