# Agent Task Manager

A turborepo monorepo for running coding agents against tasks: a task store, an agent harness, a
sandbox, an orchestrator loop, and the interfaces onto them. Bun, Effect, shadcn/ui, Ultracite.

## What's Inside

Dependencies run one way, top to bottom. Every package may import `telemetry`; `telemetry`
imports nothing of ours.

| Package | Owns | May import |
| --- | --- | --- |
| `packages/domain` | Entities, schemas, status machine, actor and scope types. No I/O. | — |
| `packages/db` | Drizzle schema, migrations, connection layer, repositories, audit write. | `domain` |
| `packages/harness` | Agent providers, normalized events, session identity, transcripts. | `domain` |
| `packages/sandbox` | Container lifecycle, mounts, images, repo and artifact materialization. | `domain` |
| `packages/api` | HttpApi contract + OpenAPI. Types only, no handlers. | `domain` |
| `packages/orchestrator` | Dispatch, leases, pool, run lifecycle, ingest, artifact index. | `domain` `db` `harness` `sandbox` |
| `packages/telemetry` | Logger and OTLP layers, wide-event schema, sanitizers, JSONL sink, metrics. | — |
| `packages/env` | Env parsing. | — |
| `packages/ui` | Shared shadcn/ui components. | — |
| `packages/typescript-config` | Shared TypeScript configs. | — |
| `apps/gateway` | HttpApi server, SSE, auth, artifact serving. | `api` `db` `domain` `sandbox` |
| `apps/loop` | Runtime host for the orchestrator. | `orchestrator` |
| `packages/token` | The scoped bearer token: mint, verify, actor ceiling. | `domain` |
| `packages/manager-tools` | The manager's fourteen board tools, as a stdio MCP server. | `api` `domain` `harness` |
| `apps/bot` | Telegram bot + manager agent. | `api` `db` `domain` `env` `harness` `sandbox` `token` `manager-tools` |
| `apps/dashboard` | Vite SPA. | `api` `ui` |
| `apps/web` | Next.js marketing app. | — |

`domain`, `db`, `harness`, `sandbox`, `orchestrator`, `api`, `telemetry`, `token`,
`manager-tools`, `apps/loop`, `apps/gateway` and `apps/bot` are built. `apps/dashboard` is a
scaffold: it carries its wiring and nothing else.

## Stack

- **Runtime**: Bun
- **Build**: Turborepo
- **Linting/Formatting**: Ultracite (Biome)
- **UI**: shadcn/ui + Tailwind CSS
- **Pre-commit**: Husky + Ultracite

## Editor Setup

Open the repo in VS Code or Cursor and accept the prompt to install the recommended extensions (`.vscode/extensions.json`):

- **Biome** — formatting + linting, set as the default formatter
- **Tailwind CSS IntelliSense** — autocomplete inside `cn` / `cva` / `tv`
- **Bun** — run and debug Bun scripts
- **Pretty TypeScript Errors** / **Error Lens** — readable, inline diagnostics

Format-on-save, import organization, and lint auto-fix run on every save via Biome. An `.editorconfig` keeps other editors consistent, and `F5` debugs the Next.js app (`.vscode/launch.json`).

## Create a New Project

Using GitHub CLI:

```bash
gh repo create my-app --template Mark-Life/netxjs-monorepo --private --clone
cd my-app
bun install
bun run upgrade
```

Or from GitHub UI: click **"Use this template"** > **"Create a new repository"**, then:

```bash
git clone https://github.com/YOUR_USERNAME/my-app.git
cd my-app
bun install
bun run upgrade
```

The `upgrade` command updates Next.js, refreshes all shadcn/ui components, updates dependencies, and runs lint fixes.

## Commands

| Command | Description |
| --- | --- |
| `bun dev` | Start all apps in dev mode (web → https://web.localhost:8443) |
| `bun run build` | Build the two apps that have a build step (`web`, `dashboard`) |
| `bun run typecheck` | Typecheck all apps and packages |
| `bun run test` | Run tests across all apps and packages |
| `bun run lint` | Lint all apps and packages |
| `bun run fix` | Auto-fix formatting and lint issues |
| `bun run check` | Check for lint/format issues |
| `bun run db:up` / `db:down` | Start / stop the local Postgres container |
| `bun run logs` | Read the wide-event ledger (`runs \| errors \| stats \| follow`) |
| `bun run harness:check` | Check the agent harness end to end (add `--live` for real model calls) |
| `bun run sandbox:check` | Check the sandbox end to end against a real container (add `--agent` for the built image) |
| `bun run images:build` | Build the two arm64 sandbox images (`--base`, `--browser`, `--check`) |
| `bun run entrypoint:build` | Bundle the container's turn entrypoint to `${DATA_ROOT}/bin/turn.js` (`--check` reports without building) |
| `bun run loop:start` / `loop:dev` | Run the orchestrator loop (watch mode for `dev`) |
| `bun run loop:check` | Check the loop end to end on a stub provider (add `--docker` for a real container, `--live` for real model calls) |
| `bun run gateway:start` / `gateway:dev` | Run the HTTP gateway (watch mode for `dev`) |
| `bun run gateway:token` | Mint a scoped bearer token (`--scope read\|task-write\|admin --user <id> [--ttl-days N]`) |
| `bun run gateway:check` | Drive a whole task lifecycle over HTTP against a real gateway and audit the rows it left |
| `bun run bot:start` / `bot:dev` | Run the Telegram bot and its manager agent (watch mode for `dev`) |
| `bun run bot:check` | Drive the bot's own handlers with synthetic updates — no token, no Telegram call, no container |
| `bun run manager-mcp:build` | Bundle the manager's board tools to `${DATA_ROOT}/bin/manager-mcp.js` |
| `bun run openapi` | Write `openapi.json` from the contract (`--check` fails when it has drifted) |
| `bun run upgrade` | Upgrade Next.js, shadcn/ui, and all deps |

The libraries are consumed as source through tsconfig paths and have no build step, so
`typecheck` and `test` — not `build` — are what cover them.

The web app runs behind [portless](https://portless.sh) at `https://web.localhost:8443` — automatic HTTPS, no port juggling. It binds the unprivileged port `8443` (via `PORTLESS_PORT` in the `dev` script) so it never needs `sudo`; the first run still adds a local certificate authority to your trust store once. Prefer a clean `https://web.localhost` with no port? Drop `PORTLESS_PORT` from the script and accept a one-time `sudo` for port 443. To bypass portless entirely, run `bun run dev:app` in `apps/web` for plain `http://localhost:3000`. Change the subdomain via the `portless` key in `apps/web/package.json`.

## Postgres (local dev)

`docker-compose.yml` runs a single Postgres container, bound to `127.0.0.1` only.

```bash
bun run db:up              # start, detached
bun run db:down            # stop
docker compose logs -f     # tail
```

Data persists in the `atm_postgres_data` named volume. Override `POSTGRES_USER` /
`POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` in `.env` to change credentials or port;
defaults match `DATABASE_URL` in `.env.example`
(`postgres://user:password@localhost:5432/agent_task_manager`).

## Environment variables

Read from `.env` / `.env.local` at the repo root (see `packages/env`). Telemetry set:

| Var | Default / example | Purpose |
| --- | --- | --- |
| `LOG_FORMAT` | `pretty` on a TTY, else `logfmt` | console log shape (`pretty`/`logfmt`/`json`) |
| `LOG_LEVEL` | `Info` | minimum log level |
| `DATA_ROOT` | `.data` | root for local, non-database state |
| `EVENT_LOG_DIR` | `${DATA_ROOT}/events` | JSONL event ledger directory, one file per service |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP collector URL; unset disables export entirely, no HTTP client built |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `k=v,k=v`, split on the first `=` per entry |
| `SERVICE_VERSION` / `GIT_SHA` | — | stamped on every event's environment fields |
| `DATABASE_URL` | required; `.env.example` ships `postgres://user:password@localhost:5432/agent_task_manager` | Postgres connection string |
| `SANDBOX_MODE` | `docker` | `docker` or `local`; `local` runs a host process with no isolation at all |
| `BETTER_AUTH_SECRET` | required by the gateway | signs session cookies, and derives the key that signs bearer tokens |
| `GATEWAY_PORT` | `3100` | what the server binds |
| `GATEWAY_PUBLIC_URL` | `http://localhost:${GATEWAY_PORT}` | the origin written into the served spec's `servers`, and the link on a notification |
| `TELEGRAM_BOT_TOKEN` | required by the bot | token from @BotFather |
| `TELEGRAM_ALLOWLIST` | required by the bot | `telegramUserId:workspaceId:userId`, comma separated |
| `GROQ_API_KEY` | unset | voice-note transcription; unset means voice notes are refused and text still works |
| `BOT_GATEWAY_URL` | `http://localhost:3100` | the gateway as the bot process reaches it |
| `MANAGER_GATEWAY_URL` | `http://localhost:3100` | the gateway as the manager's **container** resolves it |

`.env.example` carries the rest of the bot's knobs — the manager's provider, model, timeout and
token TTL, the renderer's split and draft interval, the notification retry window and the four
stuck-run thresholds — each commented out at its default.

## Agent harness (`bun run harness:check`)

`packages/harness` turns a prompt and a workspace into a stream of normalized events. Claude
and Codex are behind one registry keyed by the `provider` value stored on an agent session, so
the orchestrator selects a harness from a row and never imports either SDK. Capability flags
(`cost`, `hooks`, `resume`, `rateLimitSignal`, `reasoning`, `subagents`) answer what a provider
can be relied on to do before a run starts. The package never imports `packages/db`.

Every run gets a private agent home at `${DATA_ROOT}/runs/<runId>/agent-home/<provider>`,
pointed at through `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and seeded with the credential files and
nothing else, so a container never sees the operator's history and the transcript lands
somewhere the run owns. It is removed when the run ends. One invocation leaves exactly one
`atm.turn` row in the ledger, on every exit path including an interrupt.

A stop hook (`packages/harness/scripts/stop-hook.ts`) refuses a turn that tries to end without
having posted a comment, capped at one retry; the refusal is fed back to the model as its next
prompt. The sandbox names the executable through `ATM_STOP_HOOK_COMMAND` and the run's comment
marker through `ATM_COMMENT_MARKER`.

```bash
bun run harness:check                        # no model call: layout, seeding, registry, hook
bun run harness:check --live                 # one real turn per provider, transcript, rows
bun run harness:check --live --provider codex  # just the one harness
```

## Sandbox (`bun run sandbox:check`)

Every run gets its own Docker container, torn down after it. `packages/sandbox` owns that
lifetime end to end: one `run` call creates the container, streams its output, waits, inspects
it, and removes it — on every exit path including the interrupt a stop command produces.
Interrupting the fiber *is* how a run is stopped, which is why there is no `kill` method. The
package never imports `packages/db`.

**Five mounts, and nothing else.** The run directory (rw, mounted at `/run`, holding the
agent home and the event ledger), the workspace checkout (rw, `/workspace`), the task's
artifacts folder (rw, `/artifacts/task`), and the project's and global promoted folders
(**ro**, `/artifacts/project` and `/artifacts/global`). Read-only on the shared folders is
load-bearing: promotion is a deliberate act performed on the host, and that separation is the
audit trail. Never the docker socket — that one mount turns a sandbox into host root. A
container that runs our own turn entrypoint gets one more, read-only: the bundled entrypoint
at `/opt/atm/turn.js` (see below).

**Hardening**: `--cap-drop=ALL`, `no-new-privileges`, non-root, 2048 MB with swap pinned
equal, 1.5 CPUs, 512 pids, `/tmp` as a capped tmpfs, `--init`. Network is fully open, and that
is a decision: search, `bun install`, `gh` and the model APIs are the work.

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
bun run sandbox:check          # alpine, seconds: mounts, isolation, correlation, the rows
bun run sandbox:check --agent  # the same, against atm.local/base:latest and its tools
bun run sandbox:check --image X  # against any image by name
```

Every container this repo starts — the check and every dispatched run — runs as the operator's
own uid rather than the image's `1000:1000`, because a bind mount carries host ownership
straight through; everything else in the default confinement is untouched. See
`docker/README.md` for the two images and the rebuild cadence.

## Orchestrator loop (`bun run loop:start`, `bun run loop:check`)

**Moving a card into *in progress* is the trigger, every time.** A Postgres trigger notifies
`atm_task_dispatch` and a slow poll runs beside it as the safety net for a notification
delivered to nobody; either wakes one sweep, and the sweep reads the column in rank order.
There is no queue anywhere but the board.

Each task goes through the same sequence, and the order is the design:

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

`loop:check` files a task, watches the loop run it into *review*, then kills a second loop
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
`ORCHESTRATOR_POLL_INTERVAL_MS`, `ORCHESTRATOR_LEASE_STALE_MS`, `ORCHESTRATOR_MAX_ATTEMPTS`,
`ORCHESTRATOR_RUN_TIMEOUT_MS`, `ORCHESTRATOR_DEFAULT_PROVIDER`, `LOOP_SHUTDOWN_GRACE_MS`.

## Gateway (`bun run gateway:start`, `bun run gateway:check`)

**One typed contract, four consumers.** `packages/api` declares every operation — projects,
tasks, comments, sessions, runs, run commands, artifacts — as an Effect `HttpApi` and holds no
handlers at all. `apps/gateway` implements it group by group over the repositories, and
`openapi.json` falls out of the same value. That derivation is the whole reason this is HttpApi
rather than RPC: an external agent reaching the board through [Executor](https://executor.sh)
needs to see each operation to hold it as a tool, and RPC over HTTP is one opaque endpoint.

**The workspace is never addressed.** It is not a path segment and not a body field; it comes
off the credential, so no caller can name a workspace it cannot read and no handler can forget
to scope a query. Everything a task owns nests under `/tasks/:taskId`, which is what lets a
run's task-bound token be checked once, in the access middleware, against the path.

**Two doors, one answer.** A browser sends a Better Auth session cookie; a machine sends a
signed, scoped, expiring bearer token. Both resolve to the same three facts — the actor every
write is attributed to, the scope the credential is good for, and the one workspace it can see.
Scopes are floors, not exact matches: `read` is every GET, `task-write` is ordinary work,
`admin` is the deletes. Tokens are signed rather than stored, so verifying one is arithmetic on
the request thread and there is no revocation short of rotating `BETTER_AUTH_SECRET` — which is
why they are short-lived and why a run's token is bound to its own task.

```bash
bun run gateway:start                                        # serve on GATEWAY_PORT (3100)
bun run gateway:token --scope admin --user me --ttl-days 30  # a bearer token, printed and nothing else
curl -H "Authorization: Bearer $TOKEN" localhost:3100/tasks/board
open http://localhost:3100/docs                              # Scalar, over the derived spec
```

`/openapi.json` and `/docs` carry no credential: the spec describes the door, it does not open
it, and publishing it is how a connector configures itself. `components.securitySchemes` names
the three bearer scopes and the session cookie, one scheme per scope, because OpenAPI has
nowhere else to put a scope on a bearer token.

**Run events stream as SSE over Postgres `NOTIFY`.** One `LISTEN atm_run_event` per process,
multicast to every open stream, so a hundred dashboard tabs cost one connection. A notification
carries ids and never a payload, so every wake-up runs the same cursor query — which makes a
duplicate notice free, a dropped notice recoverable, and replay from an arbitrary `afterSeq` the
same code path as the live tail. A slow tick runs beside the channel for the notification
delivered to nobody.

**Artifacts are metadata in Postgres and bytes on disk.** `list` is a query, `read` is a stream
straight off local disk, and every path is resolved against the task's own folder and refused —
twice, once before `realPath` and once after — unless it stays inside. Promotion copies into the
project's or the global folder, which are read-only mounts everywhere else.

**`atm.request`, one row per request, on every exit path.** Route *pattern* rather than path,
method, status, `durationMs`, workspace, actor kind and id, token scope, bytes out, whether it
held an event stream and for how long, outcome and `errorClass`. `traceId` comes off the
caller's `traceparent` when there is one. A refused credential is `outcome: "rejected"` on that
same row with the reason on it — never a 401 that vanished. Three metrics project the same row
through a bounded vocabulary: `atm_requests_total`, `atm_request_duration_ms`, and an
`atm_sse_connections` gauge.

```bash
bun run gateway:check   # own data root and port, seconds, no model calls
```

`gateway:check` starts the gateway as a child process, drives a whole task lifecycle over a real
socket — file a project, file a task, comment, walk it `ideas → backlog → in progress → review →
done`, list its runs, queue a run command, upload and read an artifact, stream a run's timeline —
then stops it with `SIGTERM` and audits the ledger it flushed: every request left exactly one
row, no row carries a path where a pattern belongs, and each of the four refusals left a row
saying why. Each call mints its own `traceparent`, which is what makes both halves of that
provable at once.

**One thing on the Phase 5 list is not wired, and the check says so out loud.** The `traceId` of
a task-create request reaches the audit row that request wrote, but it does not reach the
`atm.run` row of the run that follows: nothing the gateway writes can carry a trace to the loop —
`run_command` has no trace column, `task` has none either, and `RunRepo.create`'s only caller is
the orchestrator passing its own claim span. `gateway:check` prints it as a `GAP` line on every
run rather than asserting something weaker.

## Telegram bot and manager agent (`bun run bot:start`, `bun run bot:check`)

`apps/bot` is the conversational way in. One inbound message becomes one manager turn: a
container running the same agent CLI a worker run uses, with no repo, no task folder and
exactly one set of tools — the board, over the gateway's own HTTP contract as a stdio MCP
server. The manager files and moves tasks; the loop runs them.

**The boundary.** The bot owns the conversation and the gateway owns the board. `chat_thread`,
`chat_message` and `chat_notification` are read and written directly, on the bot's own pool.
Every project, task, comment and run command — whether a tapped button or a manager tool call —
goes over the gateway with a freshly minted `manager` token carrying the conversation that
caused it, so `actor_thread_id` lands on the audit row and a later notice about that task comes
back to the same chat. There is no third path, and it is a compile error rather than a rule:
the bot's store provides no `CurrentActor`, so a board write from this app names the missing
service.

**Who it answers.** `TELEGRAM_ALLOWLIST`, as `telegramUserId:workspaceId:userId` entries
separated by commas. There is no link-code flow. A malformed entry fails the boot rather than
dropping one person's messages silently, and an account that is not on the list gets one
sentence and one `atm.chat` row saying `not_allowed`.

**What it says without being asked.** A run that finishes, fails or lands in review wakes the
listener on `atm_run_event` — the same channel the loop publishes on, not a second poller — and
the notice goes into the conversation that asked for the work, with *Start* / *Approve* /
*Comment* buttons. `chat_notification` is a claim ledger keyed on
`${kind}:${taskId}:${runId}`, so a restart between claim and send re-sends rather than losing
it, and a duplicate is the failure it chooses. Beside it, a scan looks at live runs every
minute for a run repeating the same tool calls with no file edit — surfaced, never acted on.

**Before the first turn**, `bun run manager-mcp:build` has to have bundled the board tools to
`${DATA_ROOT}/bin/manager-mcp.js`. A missing bundle is a readable failure, not a manager that
answers confidently with no board access. `MANAGER_GATEWAY_URL` is the gateway **as the
container resolves it** (`http://host.docker.internal:3100` on macOS); `BOT_GATEWAY_URL` is the
same server as the bot process reaches it.

`bun run bot:check` proves the wiring without a token and without one call to Telegram: the real
handlers, registered in the real order on a real grammy `Bot`, driven with synthetic updates
through `bot.handleUpdate`, against a real Postgres. Every Telegram API call is answered by a
transformer on `bot.api`, and the manager turn is a layer that answers without a container. It
asserts that a refused account leaves a row with no identity on it, that a text message opens a
conversation and stores the message, that `/new` and a *Switch* button move the current thread,
that a run-finished notice renders, and that the stuck rule fires on a repeating window and
holds off on one that edited a file.

## Event ledger (`bun run logs`)

Every unit of work (agent turn, container run, HTTP request, ...) emits one wide JSON line to
`${EVENT_LOG_DIR}/<service>.jsonl` — one file per service (`loop.jsonl`, `gateway.jsonl`), with
the `event` field naming the unit inside it. Read it with:

```bash
bun run logs                  # same as: bun run logs runs atm.run
bun run logs runs             # one row per unit, newest last
bun run logs errors           # every non-done outcome, with class + message
bun run logs stats            # counts per outcome, total cost, total wall time
bun run logs follow           # poll-tails all ledger files, prints new rows as they land
bun run logs stats atm.turn   # any view takes a marker; `all` reads every atm.* marker
```

Each view reads one marker (default `atm.run`) so counts stay about one kind of thing. For a
unit that writes both a `start` row and a terminus, the pair is collapsed to the terminus; a
start with no terminus is reported as `lost` rather than disappearing.

A missing `EVENT_LOG_DIR` prints an empty table / zeroed stats instead of crashing. Blank reads
as unset, matching `Config`, so the viewer and the sink always agree on the directory. No
running service required; it only reads files on disk.

## Adding Components

Add shadcn/ui components to the shared `ui` package:

```bash
bunx shadcn@latest add button -c packages/ui
```

Then import from `@workspace/ui`:

```tsx
import { Button } from "@workspace/ui/components/button"
```
