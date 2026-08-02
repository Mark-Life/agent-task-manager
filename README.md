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
| `apps/gateway` | HttpApi server, SSE, auth, artifact serving. | `api` `db` `domain` |
| `apps/loop` | Runtime host for the orchestrator. | `orchestrator` |
| `apps/telegram` | Bot + manager agent. | `api` `harness` |
| `apps/dashboard` | Vite SPA. | `api` `ui` |
| `apps/web` | Next.js marketing app. | — |

Most of these are scaffolds today: they carry their wiring and nothing else.

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
audit trail. Never the docker socket — that one mount turns a sandbox into host root.

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

The check runs the container as the operator's own uid rather than the image's `1000:1000`,
because a bind mount carries host ownership straight through; everything else in the default
confinement is untouched. See `docker/README.md` for the two images and the rebuild cadence.

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
