# Agent Task Manager

A personal software factory. A task board, a pool of sandboxed coding agents that work the
board, and a manager agent you talk to. Postgres is the only shared state.

A worker agent and the manager are the same runtime with different prompts — one attaches to a
task, the other to a conversation. Both run in a container, both leave a run row, both stream
their events to the same place. See [`.docs/plan/04-agent-runtime.md`](.docs/plan/04-agent-runtime.md).

## Getting it running

You need Bun, Docker, and the `claude` and `codex` CLIs logged in.

```bash
bun install
bun run db:up                # Postgres in a container
bun run db:migrate
cp .env.example .env         # set DATABASE_URL and BETTER_AUTH_SECRET
```

Each provider gets one host directory holding its login, shared by every container. Nothing on
the run path creates or seeds it — that is deliberate, and the reasoning is in
[`.docs/agent-homes.md`](.docs/agent-homes.md).

```bash
bun run agent-home:login                              # creates both, says what each still needs
CLAUDE_CONFIG_DIR=~/.claude-task-management claude    # then /login
CODEX_HOME=~/.codex-task-management codex login
bun run harness:check --live                          # proves a real turn can run
```

Then build the container images and the bundles a container runs, and start the three processes:

```bash
bun run images:build         # two arm64 images, base and browser
bun run entrypoint:build     # the turn entrypoint
bun run agent-mcp:build      # the board tools, as an MCP server

bun run loop:start           # dispatches runs — nothing happens without it
bun run gateway:start        # the HTTP contract, on :3100
bun run bot:start            # Telegram, needs TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWLIST
```

## Check scripts

Each subsystem has one script that drives it end to end and prints a line per claim. They are
the fastest way to find out whether something works, and the first thing to run when it doesn't.

```bash
bun run harness:check        # a provider turn        --live spends real allowance
bun run sandbox:check        # a real container       --agent uses the built image
bun run loop:check           # dispatch to terminus   --docker contained, --live real model
bun run gateway:check        # a task's lifecycle over HTTP
bun run bot:check            # the bot's handlers, with no token and no Telegram call
```

A claim that stops holding is a named line, not a diff in a five-hundred-line program.

## Working on it

```bash
bun run typecheck            # all packages
bun run test                 # all packages
bun run check                # lint; `bun run fix` to repair
bun run logs                 # read the event ledger: runs | errors | stats | follow
```

The libraries are consumed as source through tsconfig paths and have no build step, so
`typecheck` and `test` — not `build` — are what cover them. `bun run openapi --check` fails when
the committed spec has drifted from the contract.

Other commands: `gateway:token` mints a scoped bearer token, `db:seed` fills a fresh database,
`loop:dev` / `gateway:dev` / `bot:dev` are the watch-mode variants, `upgrade` bumps dependencies.

## Environment

Read from `.env` at the repo root. Four matter before anything runs:

| Var | | |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgres://user:password@localhost:5432/agent_task_manager` |
| `BETTER_AUTH_SECRET` | required by the gateway | signs session cookies and bearer tokens |
| `TELEGRAM_BOT_TOKEN` | required by the bot | from @BotFather |
| `TELEGRAM_ALLOWLIST` | required by the bot | `telegramUserId:workspaceId:userId`, comma separated |

Worth knowing about: `SANDBOX_MODE=local` runs turns as host processes with no isolation at all,
which is the debugging escape hatch. `ORCHESTRATOR_GATEWAY_URL` is the gateway *as a container
reaches it* — unset, agents run with no board tools. `ORCHESTRATOR_MAX_CONCURRENCY` and
`ORCHESTRATOR_MAX_CHAT_CONCURRENCY` are separate lanes, so a long worker run never leaves a
message unanswered.

`.env.example` carries the rest, each commented out at its default.

## How it fits together

Dependencies run one way. Every package may import `telemetry`; `telemetry` imports nothing of
ours.

| Package | Owns |
| --- | --- |
| `domain` | Entities, schemas, the status machine, actors and scopes. No I/O. |
| `db` | Drizzle schema, migrations, repositories, the audit write. |
| `harness` | Agent providers, normalized events, transcripts. |
| `sandbox` | Containers, mounts, images, workspace materialization. |
| `prompts` | What each role is told, and the unread watermark behind it. |
| `agent-tools` | The board's own contract, served to an agent as an MCP server. |
| `orchestrator` | Dispatch, leases, the pool, run lifecycle, ingest — for both roles alike. |
| `api` `token` | The HTTP contract and the scoped bearer token. Types, no handlers. |
| `telemetry` `env` | Wide events and configuration. |
| `apps/loop` | Runs the orchestrator. |
| `apps/gateway` | Serves the contract, SSE, auth, artifacts. |
| `apps/bot` | Telegram: intake, rendering, queueing, buttons. No agent runtime. |
| `apps/dashboard` | Vite SPA. Scaffold — wiring and nothing else. |
| `apps/web` | Next.js marketing app. |

## Reading further

Design record, written before the code: [`.docs/plan/`](.docs/plan/) — the
[high-level plan](.docs/plan/00-high-level.md), the [build plan](.docs/plan/02-build-plan.md),
the [data model](.docs/plan/03-data-model.md), the
[agent runtime](.docs/plan/04-agent-runtime.md).

How each part actually behaves: [agent homes](.docs/agent-homes.md),
[harness](.docs/harness.md), [sandbox](.docs/sandbox.md),
[orchestrator](.docs/orchestrator.md), [gateway](.docs/gateway.md), [bot](.docs/bot.md),
[event ledger](.docs/telemetry.md).

Monorepo conventions, editor setup and shadcn components: [`.docs/monorepo.md`](.docs/monorepo.md).
