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
bun run images:build         # the arm64 sandbox image; sweeps old ones
bun run entrypoint:build     # the turn entrypoint
bun run agent-mcp:build      # the board tools, as an MCP server

bun run loop:start           # dispatches runs — nothing happens without it
bun run gateway:start        # the HTTP contract, on :3100
bun run bot:start            # Telegram, needs TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWLIST
```

Those three run in the foreground and stop with the terminal. To keep them up —
across a logout, across a reboot — `service:install` puts the same three behind
systemd user units, from this checkout, and `deploy/README.md` says what it
assumes.

```bash
bun run service:install      # writes the units, enables them, turns linger on
bun run service:status       # active, enabled and linger, per service
bun run service:logs -n 50 loop
bun run service:restart      # after a code change; name a subset or get all three
```

`service:install` also arms `atm-backup.timer`, which dumps the database and tars the artifact
tree at 03:20 into `<DATA_ROOT>-backups` — 14 daily sets and 4 weekly. Take one now with
`bun run backup`, and prove one is restorable with `bun run backup:verify`, which restores it
into a scratch database and checks every table's row count. `deploy/README.md` has the restore
procedure and what a set does not contain.

## The dashboard

```bash
bun run dashboard:dev        # gateway on :3100, dashboard on :5173
```

Sign-up is closed, so the way in is made at the console rather than through a form. Set
`OWNER_PASSWORD` and run `bun run db:seed`: it gives the seeded owner —
`owner@agent-task-manager.local` — a password. Re-seeding never overwrites one already there, so
change it and the value in `.env` stops mattering. There is no account screen to change it
from — the dashboard is the board, a task, the project list and the sign-in page — so a rotation
is `POST /api/auth/change-password` carrying that session's cookie.

That owner is a placeholder; nothing mails the address. `user:add` is how anybody real gets in,
and the only way a second person ever does — there is no form and no invitation, because nothing
here sends mail. It also prints the `userId` and `workspaceId` a `TELEGRAM_ALLOWLIST` entry
needs, which exist nowhere else a person can read them off.

```bash
USER_PASSWORD='...' bun run user:add --email you@example.com --name You
```

`DASHBOARD_ORIGIN` is required locally too, set to the dev server's own address. The Vite proxy
makes the gateway look same-origin to application code, but the browser still stamps the dev
server's origin on every request, and Better Auth refuses a sign-in from an origin it was not
told about.

## Check scripts

Each subsystem has one script that drives it end to end and prints a line per claim. They are
the fastest way to find out whether something works, and the first thing to run when it doesn't.

```bash
bun run harness:check        # a provider turn        --live spends real allowance
bun run sandbox:check        # a real container       --agent uses the built image
bun run loop:check           # dispatch to terminus   --docker contained, --live real model
bun run gateway:check        # a task's lifecycle over HTTP
bun run bot:check            # the bot's handlers, with no token and no Telegram call
bun run github:check         # what the agents' GitHub credential may do; add owner/name
bun run quota:check          # what is left on both subscriptions, per window
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

The repository tests run against a real Postgres, and never against yours. `bun run test` runs
`bun run db:test` first, which creates `<your database>_test` beside the ordinary one and migrates
it; the test preload redirects `DATABASE_URL` there whatever the environment says, and
`TEST_DATABASE_URL` is the only way to aim the suite somewhere else. Inside it, each suite creates
a workspace of its own — `fixtures-<suite>` — rather than filing into the first one it finds, and
what it files carries `metadata.fixture`, which keeps a card the teardown missed out of every
column listing and therefore out of the dispatch queue as well. Running `bun test` in one package
directly gets the same redirect: it is the preload, not the script.

`typecheck` is two gates in one pass. The compiler is TypeScript 7, the native Go port, and the
binary behind `tsc` is [`@effect/tsgo`](https://github.com/Effect-TS/tsgo) — a superset of
Microsoft's `tsgo` carrying the Effect language service, so ordinary type errors and Effect
diagnostics (`floatingEffect`, `missingEffectContext`, `missingLayerContext`, …) come out of the
same run over the same program. Errors and warnings fail the build; suggestions print and do not.
Severities are set in `packages/typescript-config/base.json`, which also records the rules
currently held at `suggestion` and what each is waiting on.

Two things this changes day to day. `effect-tsgo patch` is what puts that binary behind `tsc`, and
it runs from `prepare` on every `bun install` — if the Effect diagnostics ever go quiet, that is
the thing to re-run. And because `incremental` is on, a `.tsbuildinfo` written before a change to
the plugin's options will keep serving the old severities; delete `**/*.tsbuildinfo` after editing
them.

Other commands: `gateway:token` mints a scoped bearer token for the system's own agents — a
person issues their own from the dashboard's *API keys* screen, `db:seed` fills a fresh database,
`user:add` creates a login, `dashboard:build` / `dashboard:publish` produce and place the static
bundle, `loop:dev` / `gateway:dev` / `bot:dev` are the watch-mode variants, `upgrade` bumps
dependencies.

## Environment

Read from `.env` at the repo root. These matter before anything runs:

| Var | | |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgres://user:password@localhost:5432/agent_task_manager` |
| `BETTER_AUTH_SECRET` | required by all three | one value shared: the gateway verifies the tokens the loop and bot mint, and both derive the key a project's env files are sealed with |
| `TELEGRAM_BOT_TOKEN` | required by the bot | from @BotFather |
| `TELEGRAM_ALLOWLIST` | required by the bot | `telegramUserId:workspaceId:userId`, comma separated |
| `DASHBOARD_ORIGIN` | required by the dashboard | its exact origin, `http://localhost:5173` locally |
| `OWNER_PASSWORD` | read by `db:seed` | the owner's first password; unset, nobody can sign in |
| `ATM_GITHUB_TOKEN` | required to clone a private repo or let an agent push | needs `repo` **and** `workflow`; `bun run github:check` says what yours has, `.docs/github-credential.md` says why |
| `ATM_MANAGER_GITHUB_TOKEN` | optional | the manager reads GitHub and does not write it; set a read-only token here and that stops being a prompt rule. Unset, it holds the one above — `.docs/agent-access.md` argues that |

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
| `api` `token` | The HTTP contract, the scoped bearer token, and the sealer for stored secrets. |
| `telemetry` `env` | Wide events and configuration. |
| `apps/loop` | Runs the orchestrator. |
| `apps/gateway` | Serves the contract, SSE, auth, artifacts. |
| `apps/bot` | Telegram: intake, rendering, queueing, buttons. No agent runtime. |
| `apps/dashboard` | Vite SPA. The operator board, task detail, manager chat, API keys. |
| `apps/web` | Next.js marketing app. |

## Reading further

Design record, written before the code: [`.docs/plan/`](.docs/plan/) — the
[high-level plan](.docs/plan/00-high-level.md), the [build plan](.docs/plan/02-build-plan.md),
the [data model](.docs/plan/03-data-model.md), the
[agent runtime](.docs/plan/04-agent-runtime.md).

How each part actually behaves: [agent homes](.docs/agent-homes.md),
[harness](.docs/harness.md), [sandbox](.docs/sandbox.md),
[project env files](.docs/project-env.md), [orchestrator](.docs/orchestrator.md),
[gateway](.docs/gateway.md), [bot](.docs/bot.md), [event ledger](.docs/telemetry.md).

What is under `DATA_ROOT`, what removes each of it, and what to delete when the disk gets
tight: [`.docs/disk.md`](.docs/disk.md).

Every prompt and rule an agent is given, with a link to each and who reads it when:
[`.docs/agent-prompts.md`](.docs/agent-prompts.md).

Monorepo conventions, editor setup and shadcn components: [`.docs/monorepo.md`](.docs/monorepo.md).
