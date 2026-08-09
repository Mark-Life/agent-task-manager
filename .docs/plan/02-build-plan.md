# Build Plan

How to get from the template to the system in `00-high-level.md`. Phases in order, steps
inside them, an exit test for each phase. No code here — implementation agents write that.

Phases 2 and 3 are independent of each other and can run in parallel. Everything else is a
chain.

**Where it stands:** phases 0–5 shipped. Phase 6 shipped and is being reworked — it built
the manager as a second agent runtime inside `apps/bot`, and the manager is now a **role**
on the runtime Phase 4 already has. Each shipped phase carries its deviations below.

## Package layout

Target shape inside the existing monorepo. One-way dependencies, top to bottom.

| Package | Owns | May import |
| --- | --- | --- |
| `packages/domain` | Entities, Effect schemas, status machine, actor and scope types. No I/O. | — |
| `packages/db` | Drizzle schema, migrations, connection layer, repositories, audit write. | `domain` |
| `packages/harness` | Agent providers (Claude, Codex), normalized events, provider session identity, transcript reading, stop hook. | `domain` |
| `packages/sandbox` | Container lifecycle, mounts (the provider agent home among them), images, hardening, local fallback. | `domain` |
| `packages/api` | HttpApi contract + OpenAPI. Types only, no handlers. | `domain` |
| `packages/prompts` | Prompt text and assembly for both roles: shared rules, section rendering, the unread-watermark algebra, worker and manager renderers. Pure. | `domain` |
| `packages/agent-tools` | The MCP server every run gets, either role. Tool list, provider config, bundle. | `domain` `api` |
| `packages/token` | Signing and minting scoped actor tokens. | `domain` |
| `packages/orchestrator` | Dispatch, leases, pool, run lifecycle, ingest, artifact index — **for both roles**. Owns the role union, the thread↔session binding, prompt assembly and turn queueing. | `domain` `db` `harness` `sandbox` `prompts` `token` |
| `packages/telemetry` | Logger layer, OTLP layer, wide-event base schema, sanitizers, JSONL sink, metric helpers. No domain knowledge. | — |
| `packages/env` | Env parsing. Exists in template, extend. | — |
| `packages/ui` | Shared components. Exists in template. | — |
| `apps/gateway` | HttpApi server, SSE, auth, static artifact serving. | `api` `db` `domain` |
| `apps/loop` | Runtime host for the orchestrator. | `orchestrator` |
| `apps/bot` | Interface only: intake, rendering, queueing, buttons. No container, no prompt text, no agent runtime. | `api` `db` `token` |
| `apps/dashboard` | Vite SPA. | `api` `ui` |
| `apps/web` | Existing Next.js. Untouched. | — |

`harness` and `sandbox` never import `db` — the orchestrator wires them together. That seam
is what keeps the harness extractable later.

Every package may import `telemetry`; `telemetry` imports nothing of ours.

---

## Telemetry

Built in Phase 0, before there is anything to instrument. Retrofitting this later costs
more than writing it now. Ported from `telegram-claude/src/{logger,telemetry,observability}.ts`
and `factory/packages/orchestrator/src/observability.ts` — copy the shape, do not reinvent.
Follow the `observability` skill.

**Model.** One wide event per unit of work — 20–100 fields, high cardinality, emitted once
where every path converges (`Effect.onExit`, so an interrupt still emits). Not scattered
log lines. Plain log lines are for live narration and operator alerts only; anything you
would count, average, or group by is a field.

**Units and markers.** One marker constant per unit, the single filter key for log tooling.

| Unit of work | Emitted by | Marker | Phase |
| --- | --- | --- | --- |
| Agent turn | `harness` | `atm.turn` | 2 |
| Container lifecycle | `sandbox` | `atm.sandbox` | 3 |
| Run (start row + terminus), either role | `apps/loop` | `atm.run` | 4 |
| HTTP request | `apps/gateway` | `atm.request` | 5 |
| Inbound bot message | `apps/bot` | `atm.chat` | 6 |

A manager turn is an `atm.run` row carrying `role: "manager"` plus its `atm.turn` rows —
the same two units a worker leaves. `atm.chat` counts only "a person said something and the
bot did something with it", which is the one unit that exists for updates that never become
a run: a refusal, a slash command, a button tap, an outbound notification. It carries the
`runId` it caused, or null, so the two rows join and "one row each" is checkable.

**Sinks, in this order.** (1) One JSON line appended per event to
`${DATA_ROOT}/events/<service>.jsonl` — always on, the load-bearing ledger, rotation policy
written the day the path is created. (2) The same annotated record through the configured
logger. (3) OTLP export, additive, gated on `OTEL_EXPORTER_OTLP_ENDPOINT` being set — when
unset the layer is `Layer.empty` and no HTTP client is built. Axiom, Grafana, or a collector
ride the same env pair; credentials only in `OTEL_EXPORTER_OTLP_HEADERS`, split on the first
`=`. The sinks carry the identical record so they cannot diverge.

**Correlation.** Every event carries `workspaceId`, `taskId`, `runId`, `sessionId` where
known, plus `traceId` / `spanId` captured at the top of the unit. `runId` is minted by the
orchestrator and passed into the container as an env var, so the harness event inside the
sandbox joins the run event on the host. HTTP takes the id from `traceparent` when present.

**Shared field vocabulary**, typed as an Effect schema so a bad emit fails a test: identity
(the ids above), economics (`costUsd`, `turns`, `totalTokens`, `durationMs`, `queueWaitMs`),
outcome (a closed literal union plus `errorClass` / `errorMessage`), environment stamped once
at startup (`version`, git sha, `host`). Economics are nullable and stay null on degraded
outcomes — never a fabricated 0.

**Rules that hold everywhere.** Content is measured, never carried: `promptChars`,
`transcriptChars`, a hash — no prompts, transcripts, comment bodies, or file contents on an
event. Every free-text field passes one pure, unit-tested sanitizer that collapses
whitespace, redacts secret shapes, and clips to 240 chars. Emission is best-effort and
wrapped in `Effect.ignoreCause` — telemetry can never abort or mask the work it describes.
The wide event is emitted above the configurable log floor, so quieting a service to `Warn`
does not delete the ledger.

**Metrics** are a second, bounded projection of the same event, derived at the emit site:
low-cardinality tags only (provider, outcome, kind, status), each drawn from a `const` tuple,
absent values mapped to `"none"`. Never `repo`, `taskId`, or `userId` on a metric. Only in
`apps/loop` and `apps/gateway`, which outlive the export interval.

**Query path** ships with the sink: `bun run logs` over the JSONL giving
`runs | errors | stats | follow`, as in `telegram-claude/scripts/logs.sh`.

**Tests.** A capture logger keyed on the marker; one test per terminus asserting exactly one
event; one asserting a degraded outcome serializes `null` economics; one per metric pinning
its exact attribute key set; one that sets the minimum level to `Warn` and still captures the
event.

**Sampling** stays off — single-operator volume, keep everything. The predicate lands only if
volume rises 10x, and the assumed volume is written beside the sink.

---

## Phase 0 — Scaffold — **shipped**

1. Pin `effect` and `@effect/platform-bun` to the same version, ≥ `4.0.0-beta.81` (see
   `01-api-surface.md` for why not beta.78). Add to the workspace catalog.
2. Create the empty packages above with `package.json`, tsconfig, and workspace wiring.
   Nothing in them yet.
3. Add `apps/dashboard` as a Vite + React app. Leave `apps/web` alone.
4. Replace the oRPC dependency in `packages/api` with Effect HttpApi. Delete the sample
   procedures.
5. Docker Compose for Postgres: volume, port, healthcheck. Local-only, no exposure.
6. Extend `packages/env` with the new variables — database URL, data root, bot token,
   provider settings, Executor MCP URL and key, plus the telemetry set: `LOG_FORMAT`
   (pretty on TTY, logfmt otherwise, json for a collector), `LOG_LEVEL`, `EVENT_LOG_DIR`
   (default `${DATA_ROOT}/events`), `OTEL_EXPORTER_OTLP_ENDPOINT`,
   `OTEL_EXPORTER_OTLP_HEADERS`, `SERVICE_VERSION`, `GIT_SHA`.
7. **`packages/telemetry`, filled in, not empty.** Logger layer (format-switching, level
   from env, the sole console sink under `ManagedRuntime`). OTLP layer via
   `Otlp.layerJson`, config-gated, `Layer.empty` when the endpoint is unset, built over the
   logger layer. Wide-event base schema with the shared identity / economics / outcome /
   environment fields, extended per unit later. `clipError` sanitizer with its test. JSONL
   append sink, parent dir on demand, whole emit path `ignoreCause`. Metric helpers with the
   `orNone` sentinel.
8. **`bun run logs`** — `runs | errors | stats | follow` over the JSONL.
9. Turbo pipeline covers build, typecheck, lint, test across the new packages.

**Exit:** `bun run build`, `typecheck`, `lint` all green with the new packages present and
empty. Postgres reachable from the host. A throwaway script emits one wide event: it lands
in the JSONL, `bun run logs` shows it, and with the OTLP endpoint unset the process makes no
network call.

**Shipped**, deviations from the above:

- Effect pinned at `4.0.0-beta.102`, the latest beta, not the beta.81 floor.
- `apps/gateway`, `apps/loop` and `apps/bot` not created — they belong to their own
  phases. Only the `packages/*` rows and `apps/dashboard` exist.
- `bun run build` covers `dashboard` and `web` only; the packages are consumed as source
  through path aliases and have no build step, so the exit clause passes vacuously for them.
- `withWideEvent` wraps the emit in `Effect.onExit`, so later phases get the exactly-once
  property rather than re-deriving it. `outcome` is nullable, which is what a `phase: "start"`
  row needs.
- Ledger rotation implemented: one generation, 64 MiB cap per service.

---

## Phase 1 — Store and domain — **shipped**

1. **Domain entities** in `packages/domain`: workspace, project, task, comment, session,
   run, run event, run command, artifact, audit entry. Effect schemas, branded ids.
2. **Status machine** as data, not conditionals: the five statuses, which transitions are
   legal, and which actor kinds may perform each. One place, used by every writer.
3. **Actor type** — human, manager, worker run — carried on every mutation. A different
   axis from the run's role: the actor says who authored a change, the role says what a run
   is. Both are needed.
4. **Drizzle schema and first migration.** `workspace_id` on every table from this
   migration, not a later one. Indexes for the queries the orchestrator and board actually
   run: tasks by status, comments by task, run events by run.
5. **Task fields**: status, kind, project (nullable), repo (nullable), title, brief,
   acceptance, `metadata` JSON, `next_session` selection, PR link.
6. **Session fields**: provider, provider session id, status (running / finished /
   failed), unread watermark, and a link to a task **or** a thread — exactly one.
7. **Run and run event tables.** A run carries its **role** (`worker | manager`) and
   attaches to a task or a thread accordingly, one live run per either. Run events
   append-only; `pg_notify` trigger on insert.
8. **Repositories** over Drizzle, one per aggregate, returning domain types.
9. **Audit write** built into the repository layer so a mutation cannot skip it.
10. **Better Auth** tables in the same database, organization plugin as workspaces.
11. **Seed script**: one workspace, one project, a few tasks.
12. **Spans on repositories** — `Effect.fn("TaskRepo.byStatus")`, one name per operation, ids
    as attributes. No wide event here: a repository call is not a unit of work, and the audit
    row is the durable record of a mutation. Telemetry answers "what happened to this run",
    audit answers "who changed this task" — different tables, different lifetimes, no
    overlap.

**Exit:** a script creates a project and a task, moves it through legal transitions,
is rejected on an illegal one, and every change has an audit row naming its actor.

**Shipped**, deviations from the above:

- Literal unions are `text` columns plus an app-layer union, never `pg_enum`. A native
  enum is a migration tax on every added value.
- The session table is `agent_session` — `session` is Better Auth's.
- Items 6 and 7 shipped **without** the role and the thread attachment: `run.task_id` and
  `agent_session.task_id` are `NOT NULL`, so a manager run has nowhere to live. That is the
  migration the current change carries, and it is why the wording above now names them.
- The chat tables (`chat_thread`, `chat_message`, `chat_notification`) arrived with Phase 6
  rather than here, and are not in this phase's entity list.

---

## Phase 2 — Harness — **shipped**

Port from `telegram-claude`, do not invent. Copy the provider abstraction and adapt.

1. **Normalized event model** and the provider interface. Capability flags per provider.
2. **Claude provider** on the Agent SDK, subscription auth, streaming events.
3. **Codex provider** on the CLI, JSONL parsing, resume support.
4. **Session identity**: point every run at the provider's one system-owned agent home via
   `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so every transcript lands in one known tree and a
   session id is enough to find one. Nothing per run, nothing per thread.
5. **Transcript reader** — parse the JSONL each harness writes into normalized records
   ready for the database.
6. **Stop hook**: one script serving both harnesses, reading the final assistant message
   and refusing turn-end when the run posted no comment. Single-retry cap.
7. **Codex hook trust flag** on every headless invocation, or hooks silently never fire.
8. **Failure detection**: distinguish clean finish, failed turn, and abort-with-no-terminal-event.
9. **Executor MCP wiring** — same server exposed to every provider.
10. **`atm.turn` wide event**, one per provider invocation, emitted on `onExit`: provider,
    model, `runId` and `sessionId` from the env the orchestrator passed in, `promptChars`,
    cost, turns, tokens, tool-use count, subagent fan-out count, rate-limit status and peak
    utilization, outcome (`done | errored | interrupted | timeout | no_terminal_event`),
    sanitized `errorClass` / `errorMessage`. Economics null on the degraded outcomes.
11. **Failure classification feeds the event** — the same tag that picks the outcome sets
    `errorClass`, at the point it is in hand. A silent drop gets its own literal, not silence.

**Exit:** a script runs a prompt on each provider, streams normalized events, writes its
transcript into the shared home's tree, and the stop hook demonstrably forces a second turn.
The session is resumable by id afterwards, from a different run. Each invocation leaves
exactly one `atm.turn` row, and killing one mid-stream leaves an `interrupted` row with null
economics.

**Shipped**, deviations from the above:

- Item 4 shipped as a **per-run** agent home seeded from the host — the design the current
  change reverses. Its cost was paid twice: cross-run resume never worked (the copy is
  created empty just before the provider is asked for a session it cannot see), and a
  credential refreshed inside the copy died with the container. The wording above is the
  target, not what is in the tree.
- A macOS keychain read was added to synthesize that per-run credential. It survives only as
  the one-shot login export in `agent-home:login`.

---

## Phase 3 — Sandbox — **shipped**

1. **Base image**, arm64: bun, node, git, `gh`, ripgrep, both agent CLIs. Pinned versions.
2. **Browser image**: base plus Chromium and its system libraries for `agent-browser`.
3. **Image build script** and a rebuild cadence. No per-run installs.
4. **Container lifecycle**: create, run, stream stdout, wait, tear down. Ephemeral.
5. **Mounts**: run workspace rw, task artifacts rw, project and global artifacts ro, the
   run's own provider agent home rw at `/agent-home`. Nothing else, never the other
   provider's home, and never the docker socket.
6. **Hardening flags**: drop capabilities, no-new-privileges, non-root user, pid / memory /
   cpu limits. The container runs as the host uid/gid, which is what makes a bind-mounted
   home writable with no chown and no ownership rule anywhere.
7. **No credential seeding, ever.** The human logs into the system-owned home once by hand
   (`CLAUDE_CONFIG_DIR=<dir> claude`, then `/login`); every container mounts that directory
   read-write. A missing or empty home is a named mount error, never auto-created — an
   auto-created empty directory boots a container that reports an auth failure nobody can
   tell from an expired token.
8. **Repo materialization**: host-side bare mirror, clone by reference into the workspace.
   Mirror refresh on a schedule.
9. **Artifact directory materialization** — the interface that mounts locally and will copy
   for a bucket later. Local implementation only.
10. **Local (no-container) implementation** of the same interface, for debugging.
11. **Telemetry passthrough**: `runId`, `taskId`, `traceparent`, `EVENT_LOG_DIR` and the log
    env into the container; the in-container event dir is a mount, so the harness's
    `atm.turn` rows land on the host and join the run. Never mount the host OTLP
    credentials — the loop forwards, the container writes files.
12. **`atm.sandbox` wide event** per container: image tag, `runId`, mount count, exit code,
    OOM kill flag, peak memory, wall-clock, pull-vs-cached, teardown outcome. Span
    `sandbox.run`; subprocess spans labelled by subcommand, never the full argv — a `gh` or
    `git` command line carries a token.

**Exit:** the Phase 2 script runs unchanged inside a container; files written to the
artifacts mount are on the host after teardown; the container cannot read the host home
directory beyond the one mounted agent home; and the `atm.turn` row written inside the
container is on the host afterwards carrying the host's `runId`.

**Shipped**, deviations from the above:

- Items 5 and 7 shipped as the per-run seeded home; see Phase 2. Items 5–7 as worded are
  the current change.
- A second mount set was added for the manager's containers rather than the one set both
  roles share; it goes with the Phase 6 rework.
- Local (no-container) mode is selected by `SANDBOX_MODE`, and the mode is stamped on every
  row that process writes, so nothing downstream has to ask which implementation ran.

---

## Phase 4 — Orchestrator — **shipped**

**Every item here is shared by both roles.** Dispatch, pool, lease, quota, retry, run
lifecycle, terminal handling, ingest and telemetry take the role as a parameter and branch
on it in exactly one place — the task transition on close, which a manager run has none of.
A role check anywhere else in this list is a bug, and the alternative is a parallel copy of
the whole phase, which is what Phase 6 first built.

1. **Runtime host** `apps/loop` — config, logger + OTLP layers from `telemetry`, graceful
   shutdown that finalizes the layer scope so the exporter flushes.
2. **Trigger**: `LISTEN/NOTIFY` for immediacy plus a slow poll as a safety net. One channel
   per source, tasks and chat messages alike.
3. **Dispatch**: pick up tasks entering *in progress*, honour the task's next-session
   selection, then clear it back to default. Pick up threads holding a message the session
   has not seen, ordered by that message's arrival. Both queues are database reads, so
   nothing is lost on restart.
4. **Pool** with a lane per role and a concurrency cap each, the sum sized for a 4-core box.
   Two lanes rather than one cap with a reservation: a chat starved behind two hour-long
   worker runs is the failure the lane exists to prevent.
5. **Leases**: in-memory in-flight set, durable lease file heartbeated on an interval, and
   startup reclaim of stale leases after a crash. Keyed by the run's subject — `task:<id>`
   or `thread:<id>` — which is also the key the interrupt handle and the live-run index use.
6. **Run lifecycle**: create run row, start sandbox, stream normalized events into
   `run_events`, close out on terminal event.
7. **Terminal handling**: clean finish moves the task to *review*; failure posts the error
   as a comment and moves to *review* too, marking the session failed. Process gone with no
   terminal event counts as failure. The task move is the one branch that reads the role; a
   manager run ends the same way and moves no card.
8. **Comment fallback**: auto-append the final assistant message when the run posted no
   comment, flagged as auto-generated. A manager run's answer lands in its thread as a
   message the same way.
9. **Transcript ingest** into sessions and messages after each run.
10. **Artifact index rescan** of the task directory after each run.
11. **Run commands**: stop and rerun consumed from the database, acted on only here. A stop
    naming a thread is the force-send button: the turn is interrupted, the messages it never
    read are still unread, and the next dispatch resumes the session with them appended.
12. **Retry backoff** on repeated failures, and a park state after too many.
13. **Quota gate** — pause dispatch when a provider's subscription limit is hit rather than
    burning tasks against it.
14. **`atm.run` wide event**, the canonical record of the system. A `phase: "start"` row when
    the lease is claimed, carrying the immutable context; a terminus row on `Effect.onExit`
    with the same `runId`, so a start with no terminus is a countable `lost` run rather than
    silence. Fields: role, task or thread, project, repo, branch, kind, provider, session,
    attempt and max-attempts, `queueWaitMs`, `leaseDurationMs`, lane and pool depth at claim,
    outcome
    (`done | errored | parked | interrupted | skipped | lost`), rolled-up turn economics,
    comment-fallback flag, artifact count written, `errorClass` / `errorMessage`. One emit
    site, one row per run, never double-emitted on the park path.
15. **Metrics** off that event: `runs_total` (role, outcome, provider, kind) — without the
    role tag "what did chat cost this week" is not a query — `retries_total`,
    `parked_total`, `quota_pause_total`, histograms for run duration, cost, turns. Tags from
    `const` tuples; no repo or task id on a metric.
16. **Lost-run reconciliation** on startup: a start row whose run is not in the reclaimed
    lease set closes as `lost`.
17. **Harness event ingest** — the container's `atm.turn` rows read off the mount after
    teardown and folded into the run event, so one query joins host and container.

**Exit:** insert a task by hand, move it to *in progress*, and a PR appears without touching
anything else. Post a message to a thread and an answer appears, through the same lease,
pool and ledger. Kill the process mid-run and it recovers on restart, and the killed run
shows up as `interrupted` or `lost` in `bun run logs` — never as a green row and never as
nothing.

**Shipped**, deviations from the above:

- Shipped worker-only. Every item works, and every item takes a task: one lane, one live-run
  index on `task_id`, a lease keyed by task id, no chat channel on the trigger. The
  role-shaped wording above is what the current change lands.
- The quota gate is never asked about a chat turn, so a drained subscription defers workers
  and burns manager turns against it.
- Transcript ingest resumes a session by id, which only works against a shared agent home —
  so it is broken today in the same way Phase 2's deviation describes, and fixed by the
  same change.

---

## Phase 5 — Gateway — **shipped**

1. **HttpApi contract** in `packages/api`: projects, tasks, comments, sessions, runs,
   artifacts, run commands, threads and thread messages, promotion. Every operation the
   dashboard and either role need — and because an agent's tools **are** this surface, a
   missing endpoint is a missing agent capability, not a coverage gap.
2. **Handlers** in `apps/gateway` over the repositories.
3. **Auth**: Better Auth sessions for humans; scoped tokens for machines. Both roles get
   `task-write`; a worker run's token is **bound** to its own task — write there, read
   elsewhere — and a manager run's is bound to nothing. The binding is the whole difference,
   which is why the manager's reach is a superset with no second tool list.
4. **SSE endpoint** for run events, fed by Postgres NOTIFY. Run events only: a turn's
   timeline is already there for anyone who wants it, and no streaming chat endpoint is
   built on top of it.
5. **OpenAPI spec** mounted, plus Scalar docs. Security schemes in the spec.
6. **Artifact endpoints**: list, read, upload, promote. Files streamed from disk.
7. **Executor connector** pointed at the spec, with a scoped token, verified end to end.
8. **Deployment**: Caddy in front, domain, gateway as a service unit.
9. **`atm.request` wide event**, one per request on `onExit`: route pattern (not the raw
   path — that is unbounded), method, status, `durationMs`, workspace, actor kind and id,
   token scope, bytes out, whether it was an SSE stream and how long it held, outcome and
   `errorClass`. `traceId` from inbound `traceparent` when present, minted otherwise, and
   propagated to the loop through the database row so a task dispatched by the manager
   traces end to end.
10. **Metrics**: `requests_total` (route, method, status class), request-duration histogram,
    `sse_connections` gauge. Route pattern only — never the path.
11. **Auth failures are events, not 401s that vanish** — a rejected token records scope,
    reason, and actor.

**Exit:** a full task lifecycle driven over HTTP with curl, the spec loads in Scalar, and
Executor can list and update tasks as tools. Every curl leaves exactly one `atm.request` row,
and the `traceId` from a task-create request appears on the `atm.run` row that follows.

**Shipped**, deviations from the above:

- Item 1 shipped without the threads group. Thread and thread-message endpoints are the
  current change: without them a conversation started in Telegram is unreachable from the
  dashboard, and no agent can read one.
- Item 3 shipped with the binding built and correct in the middleware — but only the bot
  mints a token, so a **worker run gets no gateway tools at all** today. The loop mints per
  run, for both roles, as part of the current change.

---

## Phase 6 — Telegram, and the manager as a role — **shipped, being reworked**

The bot is an interface: intake, rendering, queueing, buttons. The agent it talks to is the
Phase 4 runtime with `role: "manager"` on the run — built where dispatch is built, not
re-implemented here.

1. **Bot app**: access control, command routing, voice transcription, forwarded-message
   intake. Port what exists.
2. **Threads**: create, list, switch, clear, over the gateway's thread group. Their own
   listed entity, reachable from Telegram and the dashboard alike. A manager run attaches to
   a thread the way a worker run attaches to a task, and the provider session id lives on
   the session — one place, not one per interface.
3. **The manager role** on the existing runtime: a container with no repo, whose tools are
   the gateway API and whose memory is the database. It is a run row, a lease, a pool slot,
   a quota check, a session, a transcript and an `atm.run` pair, because it is a run.
4. **Prompt and rules**, in `packages/prompts` beside the worker's: files into *backlog*,
   never straight into *in progress*. Both roles share the section rendering, the shared
   rules and the unread-watermark algebra; the rules block and how one row renders are the
   only per-role text.
5. **Run control**: stop, rerun, re-prioritize, written as run commands.
6. **Notifications**: run finished, run failed, task needs review. Summaries and links, not
   raw tool calls. A manager run's terminal event is what puts its answer in the chat —
   end-of-turn sync, no mid-turn streaming into anything but Telegram's own draft.
7. **Approval actions** on messages — move to *in progress*, approve, comment.
8. **One live turn per thread**: a mid-turn message is stored and the person told it is
   queued, several queued messages coalesce into one prompt by the watermark that already
   feeds a resumed worker, and a Force Send button files a stop command. Ported from
   `telegram-claude`, not designed.
9. **Stuck-run heuristic**: no file edits plus repeating tool signatures over N minutes,
   surfaced to the manager. Reads the run's telemetry, not a second parallel counter.
10. **`atm.chat` wide event** per inbound message — chat and user id, intake kind
    (text / voice / forward), `transcriptChars` and `promptChars` (never the text),
    transcription duration, thread, the `runId` it caused or null, and outcome
    (`accepted | queued | rejected | not_allowed | errored`). Access-control rejections get a
    row; a dropped message is an outcome, not silence. The turn's cost, tokens, tool calls
    and exit code are **not** here — they are on the `atm.run` row this one points at.

**Exit:** create a project, file three tasks, dispatch one, read its status, stop it,
comment, and rerun — entirely by talking to the bot. Send a message while a turn is running:
it is queued, the reply says so, and the next turn answers it. Every manager turn leaves one
`atm.run` row with `role: "manager"`, and `bun run logs` counts chat cost the same way it
counts a worker's.

**Shipped**, and what the current change replaces:

- Items 1, 5, 6, 7 and 9 shipped and stand: intake, board buttons and views over the
  gateway, notifications, the stuck scan. They stay in `apps/bot`.
- Item 3 shipped as a **second agent runtime inside the bot** — one 754-line turn module
  that is the container half of the worker path hand-copied, minus every guard. No lease, no
  pool slot, no quota check, no retry, no run row, no `atm.run`, and six pure helpers
  duplicated byte for byte. Two bot processes on one data root would both answer the same
  thread. **Deleted**, and replaced by the role.
- Item 2 shipped with `provider_session_id` on the thread *and* on the message, a third and
  fourth spelling of a fact `agent_session` already holds. Both columns go.
- Item 4 shipped as prompt text inside `apps/bot`, re-sending the last 40 messages every
  turn because a thread had no session row to hang a watermark on. Moves to
  `packages/prompts`; the window becomes the watermark, and the 40 survives only as a tail
  cap on a fresh render.
- Item 8 shipped as an in-memory `Map` of queued messages in the bot, dropped on restart.
  The queue becomes a database read: threads holding a message newer than their session's
  watermark.
- Item 10 shipped carrying the turn's economics, so a manager turn's cost was counted in a
  row shaped for a Telegram update and a worker's in `atm.run`. Those fields move.
- **Left to do:** the role on the run and its subject key; the chat dispatch channel and
  queue; the pool lane; `packages/prompts`; `packages/agent-tools` serving both roles with
  the loop minting the token; the threads API group; the shared agent home (Phases 2–3
  above); and `apps/bot` cut back to an interface.

---

## Phase 7 — Dashboard — **deferred**

The UI is out of scope for now; `apps/dashboard` is a Vite scaffold and stays one. Its
API-side prerequisites are **not** deferred and land earlier: the thread group (Phase 5), so
a Telegram conversation is readable from anywhere, and the end-of-turn sync that puts a
finished run's answer where a reader finds it (Phase 6). Building those late is what would
force a second thread model.

1. **App shell**: auth, workspace context, routing, layout.
2. **Board**: columns by status, drag between them, filters by project and kind.
3. **Task detail**: brief, metadata, comments thread with authors, PR link.
4. **Sessions panel**: list with status, transcript viewer, next-session selector.
5. **Run timeline**: the run's events, tool calls, cost, duration — synced at end of turn.
   No mid-turn streaming in v1; Telegram's own draft-editing is local to the bot and stays.
6. **Artifacts panel**: list, render by extension, edit, promote.
7. **Task creation and editing** by hand, no manager involved.
8. **Manager chat** in the dashboard, over the same threads the bot uses — the same thread,
   not a shared shape. The API for it exists from Phase 5; only the screen is left.
9. **Deploy** to Cloudflare Pages, pointed at the gateway domain.
10. **No event pipeline in the browser** — the SPA is static and the gateway's
    `atm.request` rows already cover every action. The one exception: unhandled client
    errors POST to a gateway endpoint that emits them as a row, so a white screen is
    countable.
11. **Run timeline reads the run's events**, the same records the ledger holds — no second
    source of truth for what a run did.

**Exit:** every board operation available in Telegram is available here, and a finished run
reads back in full.

---

## Phase 8 — Non-repo tasks

1. **Scratch workspace** for tasks with no repo — same machinery, empty directory.
2. **Research spawn from *backlog***: on-demand session that investigates and writes an
   artifact, without moving the task to *in progress*.
3. **Artifact-first task kind** where the output is a document rather than a PR.
4. **Connector coverage** — whatever the first real personal task needs, added to Executor
   rather than to this codebase.

**Exit:** a task with no project and no repo produces a usable artifact end to end.

---

## Phase 9 — Hardening

1. **GitHub App** per-run installation tokens scoped to one repo, replacing full access.
2. **Codex credential refresh** — the one piece of the credential problem the shared agent
   home does not settle, deliberately unfixed and carrying a TODO on the Codex provider.
   Claude is the provider for chats meanwhile. Copying credentials into containers is not a
   candidate answer: it is the bug the shared home removed.
4. **Workspace scoping for artifacts** — the mount-the-whole-root shortcut ends when a
   workspace has a second member. The shared agent home is the same shortcut in a second
   place: nothing prunes it, so any run can read any other run's conversation.
5. **Backups**: database dump plus the artifact tree, on a schedule, restore tested once.
   **Shipped** as `scripts/backup.ts` and `deploy/user/atm-backup.{service,timer}` — 14 daily
   sets and 4 weekly, and `bun run backup:verify` restores one into a scratch database and
   compares every table's row count against the manifest, rather than reading a table of
   contents and calling that a restore. The event ledger is deliberately not in a set; it
   joins one when item 6 gives it a bounded size.
6. **Event ledger rotation and retention** enforced — size-capped rotation on the JSONL,
   a stated retention window, and the backup covers the ledger too.
7. **OTLP destination chosen and pointed at** — Axiom or a collector, endpoint and headers
   in env only. Nothing in the code changes; the layer is already there from Phase 0.
8. **Sampling predicate**, only if volume has risen ~10x: takes the finished event, keeps
   every non-`done` outcome and everything above p99, stamps `sampleRate` on what it keeps,
   sits below the metric updates.

---

## Not building

Named so nobody proposes them as missing steps: dashboard UI, mid-turn streaming into
anything but Telegram's own draft, a fix for Codex's credential refresh, and per-kind tool
restriction — the last one because every agent already gets every tool by design, and the
seam that matters is the token's binding.

---

## Cross-cutting, every phase

- **Telemetry**: see the Telemetry section. A phase is not done until its unit of work emits
  its wide event and that event has a test. New field on an existing event is cheap and
  expected; a new marker is a decision.
- **Tests**: real Postgres for repository tests, real containers for sandbox tests. Mock
  the model calls, nothing else. Every phase adds its capture-logger test alongside.
- **Migrations** are forward-only and checked in with the change that needs them.
- **Docs**: each phase updates the README section it touches. `.docs/plan/` stays the
  design record.

## Sequencing notes

- `packages/telemetry` is Phase 0, not a later pass. Every phase after it instruments as it
  builds; nothing gets a "we'll add logging later" item.
- Phase 1 blocks everything. Do not start it twice in parallel branches — schema conflicts
  are expensive.
- Phases 2 and 3 are independent; either can go first.
- Phase 4 is the first point where the system does something useful on its own. Everything
  before it is scaffolding, everything after it is interface.
- Phase 5 must land before Phase 6, because both roles' tools are the gateway API — and the
  manager's set is a superset, so the gateway has to expose everything a worker can do plus
  reads of another run's transcript and of the threads.
- The manager **role** belongs to Phase 4's machinery, not to Phase 6. Built in the phase
  that owns dispatch it is a parameter; built in the bot phase it is a parallel copy of
  dispatch, which is what happened the first time.
- Phase 7 can slip without blocking anything — its API prerequisites cannot.
