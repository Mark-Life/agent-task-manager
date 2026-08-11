# Orchestrator loop (`bun run loop:start`, `bun run loop:check`)

**Two things wake the loop, and they are the same thing.** Moving a card into *in progress*
fires `atm_task_dispatch`; a person saying something into a conversation fires
`atm_chat_dispatch` from the `chat_message` insert. A slow poll runs beside both as the safety
net for a notification delivered to nobody. Either wakes one sweep, which reads the column in
rank order and the conversations with something unanswered. There is no queue anywhere but the
database.

**A worker run and a chat turn are one runtime.** A run carries a `role` — `worker` or
`manager` — and the role selects exactly five things: the system prompt, what the run is
attached to (a task or a conversation), the container image, what the run's board credential is
bound to, and which GitHub token it is handed (`.docs/agent-access.md`). Everything else is
shared: one dispatch, one lease, one pool, one quota gate, one `run` row, one event ingest, one
retry ladder, one `atm.run`. A pull request that adds a role check inside the lease, the pool,
the quota gate or the turn is wrong by construction.

The two lanes are the one exception, and they are a capacity decision rather than a behaviour
one: `ORCHESTRATOR_MAX_CONCURRENCY` worker slots and `ORCHESTRATOR_MAX_CHAT_CONCURRENCY` chat
slots, so a person waiting on an answer is never queued behind two hour-long worker runs. The
box's ceiling is the sum.

Each unit of work goes through the same sequence, and the order is the design:

```
signal → drain run commands → read the column → plan → quota → pool → lease →
open run → turn → close → ingest → artifact rescan → proposals → retry
```

**Nothing is written before the loop has committed.** A plan only reads: status, park stamp,
live run, project, attempt, provider. The quota gate, the concurrency cap and the durable lease
each get to refuse over that plan with nothing to undo — so a drained subscription costs a
skipped sweep, not a run row and a trip through *review* to say "not now".

**The gate knows what is left before it spends any of it.** Both subscriptions report two
rolling windows — five hours and seven days, on Claude and on Codex alike — through a passive
endpoint that generates nothing, read with the credentials in the agent home the containers are
handed. The loop polls both once per `ORCHESTRATOR_QUOTA_POLL_INTERVAL_MS` (5m) at the top of
each sweep, caches the reading, defers a dispatch whose window is over
`ORCHESTRATOR_QUOTA_THRESHOLD_PCT` (95, plus 5 points reserved per in-flight run), and publishes
what it read to `${DATA_ROOT}/quota/usage.json`, which the gateway serves at `GET /usage` —
remaining percent, the window it belongs to, and when that window rolls over. Under it sits a
reactive floor: a run that dies on a drained provider pauses that provider for a doubling
cooldown, which covers the window filling between two polls. A pause is per provider, so a
drained Claude leaves Codex dispatching. The split that decides everything is *unreadable*
against *drained* — no login, an expired token, a body whose shape moved all mean "could not
tell", which dispatches and warns, because a gate that silently disables itself is worse than no
gate. Only a reading that says the provider is out holds a card back. Nothing already running is
stopped: a live run is allowance already committed, and killing it wastes what it spent.
`bun run quota:check` prints the same reading from a terminal, and is the way to find out a host
is unreadable before a blank dashboard does.

**Every ending lands the task in *review*, failures included.** A crashed run posts its error
into the thread as a message, marks its session failed, and moves the card to the human gate;
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
`lost`; one that never ends at all is torn down at `ORCHESTRATOR_RUN_TIMEOUT_MS` (a day by
default, long enough for a run that is genuinely working through the night) and closed as
`timeout`, so a wedged provider costs one slot for a day rather than one slot forever. The
run's board credential is minted for that same span plus five minutes, because a token that
expires under a live run is a `401` per tool call that the agent narrates instead of failing
on.

**A run that posted no message gets its last message appended as one**, flagged
`fallback` so the UI can collapse it. After the turn the loop reads the run's directory back:
the normalized event file into `run_events` (idempotently — `seq` is the file's line ordinal),
the transcript into the session, and the task's artifacts folder into the artifact index.

**A worker asks for what it may not write, and the loop only records the asking.** A worker's
workspace scope is a read-only mount, so a run that has read an untrusted repository cannot edit
the house rules every later run is given. What it can do is write
`.atm/proposals/<name>.md` into its own task directory, front matter naming the scope and the
path within it. The same teardown that rescans the artifacts reads those files, refuses and logs
any that name a path outside the scope they declared, and records the rest pending and inert
against the task and run that raised them. Nothing reaches a shared directory until a person
confirms it through the gateway, and the file stays where it was written — re-collection
recognises the same bytes and records nothing.

**Which rules a run had is a lookup.** The workspace and project folders are git repositories,
snapshotted before and after every run, and the `before` snapshot is taken as the run is handed
its directories — so the commit it leaves behind is exactly the tree that run read. That commit
goes on the run's `atm.run` row as `workspaceCommit` and `projectCommit`, which points at bytes
`git show` can still print rather than at whatever those folders hold today. A scope with no
history yet, or a git that refused, is a null and costs the run nothing.

**Stop and rerun are rows.** Anyone may write a `run_command`; only the loop acts on one.
Writing one notifies `atm_run_command`, which wakes a sweep the same way a card does — the
queue is drained before the column is read, so a stop lands even with every slot busy. A stop
interrupts the fiber holding the run, which is the whole of a teardown, and a refused command
is rejected with its reason on the row rather than consumed in silence.

**Kill it and it recovers.** A lease file per claimed task is heartbeated under
`${DATA_ROOT}/leases`; at boot the loop reclaims every lease whose holder is gone and closes
every run row still marked live behind it as `lost` — posting the message, ending the session,
moving the task, and writing the terminus row the killed process could not. A run leaves two
`atm.run` rows sharing one `runId`: a `start` when it is claimed and a terminus on every exit
path, so a start with no end is a countable `lost` run rather than silence.

**The same boot pass reclaims the disk and the daemon.** A teardown registered before a
container starts covers every ordinary ending and cannot cover its own process being killed, so
after the rows are closed the loop joins what is on the host against what the database still
owns: labelled containers against the live runs, then `runs/<runId>` against the run rows,
`workspaces/<runId>` and `composed-skills/<runId>` against the live ones, and
`${DATA_ROOT}/mirrors` against the repositories projects and tasks still name. A run directory
is kept while its **row** exists rather than while the run is live, because the transcript on
disk is the whole conversation and the contract serves it back; a checkout is the opposite, a
repo clone with the project's env files in it that nothing but this would ever remove. A read
that failed sweeps nothing rather than treating an unreachable database as one that owns
nothing. `${DATA_ROOT}/caches` is deliberately not in that list — nothing evicts from it, which
is a decision with a threshold and a procedure in [disk](./disk.md).

```bash
bun run loop:start           # the loop, against DATABASE_URL; Ctrl-C for a graceful stop
bun run loop:check           # stub provider, turn as a host process, own data root, seconds, free
bun run loop:check --docker  # the same claims with the turn in a real container — still free
bun run loop:check --live    # the same, on the real provider — this one costs money
```

`loop:check` files a task, watches the loop run it into *review*, opens a conversation and
watches the same loop answer it as a `role: manager` run with no task, then kills a second loop
mid-run with `SIGKILL` and proves the restart closes the killed run as `lost` and removes the
checkout that kill stranded on disk.

`--docker` runs that first half with the turn inside `atm.local/base:latest` and adds the three
claims a host process cannot make: the `atm.run` rows say `kind: docker` on that image, the
daemon left an `atm.sandbox` row for a container that really ran, and the `atm.turn` row written
*inside* the container came back out through the mount carrying the run id the host minted. It
stays free because it bundles its own entrypoint — the real one from `packages/harness` with the
provider stubbed, so the model call is the only thing faked — into its own data root, never over
the operator's `${DATA_ROOT}/bin/turn.js`. It skips the kill half, which is a claim about the
loop and needs no container.

Knobs: `ORCHESTRATOR_MAX_CONCURRENCY` (default 2, sized for a 4-core box),
`ORCHESTRATOR_MAX_CHAT_CONCURRENCY` (default 2), `ORCHESTRATOR_POLL_INTERVAL_MS`,
`ORCHESTRATOR_LEASE_STALE_MS`, `ORCHESTRATOR_MAX_ATTEMPTS`, `ORCHESTRATOR_RUN_TIMEOUT_MS`,
`ORCHESTRATOR_CHAT_TIMEOUT_MS`, `ORCHESTRATOR_DEFAULT_PROVIDER`,
`ORCHESTRATOR_GATEWAY_URL`, `ORCHESTRATOR_AGENT_TOKEN_TTL_MS`, `LOOP_SHUTDOWN_GRACE_MS`.
The gate's own: `ORCHESTRATOR_QUOTA_ENABLED` (the gate at all), `ORCHESTRATOR_QUOTA_READ` (poll
and publish), `ORCHESTRATOR_QUOTA_PROACTIVE` (let a reading defer — set it to `false` for
watch-only, which still publishes and still keeps the reactive floor),
`ORCHESTRATOR_QUOTA_THRESHOLD_PCT`, `ORCHESTRATOR_QUOTA_HEADROOM_PCT`,
`ORCHESTRATOR_QUOTA_POLL_INTERVAL_MS`, `ORCHESTRATOR_QUOTA_COOLDOWN_MS`.

**Every turn gets the board tools**, worker and manager alike: the loop mints a scoped token
per run, writes an `mcp-servers.json` onto that run's mount before the container starts and
deletes it on every exit path. A worker's token is bound to its one task, a manager's to its
conversation — the same credential, one bound narrower. `ORCHESTRATOR_GATEWAY_URL` is the
gateway **as a container resolves it** (`http://host.docker.internal:3100` on macOS); unset, a
turn runs with no board tools and the loop says so once at boot. `bun run agent-mcp:build` has
to have bundled the tools to `${DATA_ROOT}/bin/agent-mcp.js` first; a missing bundle fails the
run rather than producing an agent that answers confidently with no board access. That one file
is mounted read-only at `/opt/atm/agent-mcp.js` rather than copied per run — the copy was 77% of
everything under `runs/` on the host that was measured.

