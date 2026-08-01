# Build Plan

How to get from the template to the system in `00-high-level.md`. Phases in order, steps
inside them, an exit test for each phase. No code here — implementation agents write that.

Phases 2 and 3 are independent of each other and can run in parallel. Everything else is a
chain.

## Package layout

Target shape inside the existing monorepo. One-way dependencies, top to bottom.

| Package | Owns | May import |
| --- | --- | --- |
| `packages/domain` | Entities, Effect schemas, status machine, actor and scope types. No I/O. | — |
| `packages/db` | Drizzle schema, migrations, connection layer, repositories, audit write. | `domain` |
| `packages/harness` | Agent providers (Claude, Codex), normalized events, session identity, transcript reading, stop hook. | `domain` |
| `packages/sandbox` | Container lifecycle, mounts, images, credential seeding, local fallback. | `domain` |
| `packages/api` | HttpApi contract + OpenAPI. Types only, no handlers. | `domain` |
| `packages/orchestrator` | Dispatch, leases, pool, run lifecycle, ingest, artifact index. | `domain` `db` `harness` `sandbox` |
| `packages/env` | Env parsing. Exists in template, extend. | — |
| `packages/ui` | Shared components. Exists in template. | — |
| `apps/gateway` | HttpApi server, SSE, auth, static artifact serving. | `api` `db` `domain` |
| `apps/loop` | Runtime host for the orchestrator. | `orchestrator` |
| `apps/telegram` | Bot + manager agent. | `api` `harness` |
| `apps/dashboard` | Vite SPA. | `api` `ui` |
| `apps/web` | Existing Next.js. Untouched. | — |

`harness` and `sandbox` never import `db` — the orchestrator wires them together. That seam
is what keeps the harness extractable later.

---

## Phase 0 — Scaffold

1. Pin `effect` and `@effect/platform-bun` to the same version, ≥ `4.0.0-beta.81` (see
   `01-api-surface.md` for why not beta.78). Add to the workspace catalog.
2. Create the empty packages above with `package.json`, tsconfig, and workspace wiring.
   Nothing in them yet.
3. Add `apps/dashboard` as a Vite + React app. Leave `apps/web` alone.
4. Replace the oRPC dependency in `packages/api` with Effect HttpApi. Delete the sample
   procedures.
5. Docker Compose for Postgres: volume, port, healthcheck. Local-only, no exposure.
6. Extend `packages/env` with the new variables — database URL, data root, bot token,
   provider settings, Executor MCP URL and key.
7. Turbo pipeline covers build, typecheck, lint, test across the new packages.

**Exit:** `bun run build`, `typecheck`, `lint` all green with the new packages present and
empty. Postgres reachable from the host.

---

## Phase 1 — Store and domain

1. **Domain entities** in `packages/domain`: workspace, project, task, comment, session,
   run, run event, run command, artifact, audit entry. Effect schemas, branded ids.
2. **Status machine** as data, not conditionals: the five statuses, which transitions are
   legal, and which actor kinds may perform each. One place, used by every writer.
3. **Actor type** — human, manager, worker run — carried on every mutation.
4. **Drizzle schema and first migration.** `workspace_id` on every table from this
   migration, not a later one. Indexes for the queries the orchestrator and board actually
   run: tasks by status, comments by task, run events by run.
5. **Task fields**: status, kind, project (nullable), repo (nullable), title, brief,
   acceptance, `metadata` JSON, `next_session` selection, PR link.
6. **Session fields**: provider, provider session id, status (running / finished /
   failed), comment watermark, link to task.
7. **Run and run event tables.** Run events append-only; `pg_notify` trigger on insert.
8. **Repositories** over Drizzle, one per aggregate, returning domain types.
9. **Audit write** built into the repository layer so a mutation cannot skip it.
10. **Better Auth** tables in the same database, organization plugin as workspaces.
11. **Seed script**: one workspace, one project, a few tasks.

**Exit:** a script creates a project and a task, moves it through legal transitions,
is rejected on an illegal one, and every change has an audit row naming its actor.

---

## Phase 2 — Harness

Port from `telegram-claude`, do not invent. Copy the provider abstraction and adapt.

1. **Normalized event model** and the provider interface. Capability flags per provider.
2. **Claude provider** on the Agent SDK, subscription auth, streaming events.
3. **Codex provider** on the CLI, JSONL parsing, resume support.
4. **Session identity**: relocate each run's agent home via `CLAUDE_CONFIG_DIR` /
   `CODEX_HOME` so transcripts land in a known per-run directory.
5. **Transcript reader** — parse the JSONL each harness writes into normalized records
   ready for the database.
6. **Stop hook**: one script serving both harnesses, reading the final assistant message
   and refusing turn-end when the run posted no comment. Single-retry cap.
7. **Codex hook trust flag** on every headless invocation, or hooks silently never fire.
8. **Failure detection**: distinguish clean finish, failed turn, and abort-with-no-terminal-event.
9. **Executor MCP wiring** — same server exposed to every provider.

**Exit:** a script runs a prompt on each provider, streams normalized events, writes a
transcript to a per-run directory, and the stop hook demonstrably forces a second turn.

---

## Phase 3 — Sandbox

1. **Base image**, arm64: bun, node, git, `gh`, ripgrep, both agent CLIs. Pinned versions.
2. **Browser image**: base plus Chromium and its system libraries for `agent-browser`.
3. **Image build script** and a rebuild cadence. No per-run installs.
4. **Container lifecycle**: create, run, stream stdout, wait, tear down. Ephemeral.
5. **Mounts**: run workspace rw, task artifacts rw, project and global artifacts ro,
   per-run agent home rw. Nothing else, and never the docker socket.
6. **Hardening flags**: drop capabilities, no-new-privileges, non-root user, pid / memory /
   cpu limits.
7. **Credential seeding**: copy only the credential files into the per-run agent home.
   Never the whole personal config directory.
8. **Repo materialization**: host-side bare mirror, clone by reference into the workspace.
   Mirror refresh on a schedule.
9. **Artifact directory materialization** — the interface that mounts locally and will copy
   for a bucket later. Local implementation only.
10. **Local (no-container) implementation** of the same interface, for debugging.

**Exit:** the Phase 2 script runs unchanged inside a container; files written to the
artifacts mount are on the host after teardown; the container cannot read the host home
directory.

---

## Phase 4 — Orchestrator

1. **Runtime host** `apps/loop` — config, logging, graceful shutdown.
2. **Trigger**: `LISTEN/NOTIFY` for immediacy plus a slow poll as a safety net.
3. **Dispatch**: pick up tasks entering *in progress*, honour the task's next-session
   selection, then clear it back to default.
4. **Worker pool** with a global concurrency cap sized for a 4-core box.
5. **Leases**: in-memory in-flight set, durable lease file heartbeated on an interval, and
   startup reclaim of stale leases after a crash.
6. **Run lifecycle**: create run row, start sandbox, stream normalized events into
   `run_events`, close out on terminal event.
7. **Terminal handling**: clean finish moves the task to *review*; failure posts the error
   as a comment and moves to *review* too, marking the session failed. Process gone with no
   terminal event counts as failure.
8. **Comment fallback**: auto-append the final assistant message when the run posted no
   comment, flagged as auto-generated.
9. **Transcript ingest** into sessions and messages after each run.
10. **Artifact index rescan** of the task directory after each run.
11. **Run commands**: stop and rerun consumed from the database, acted on only here.
12. **Retry backoff** on repeated failures, and a park state after too many.
13. **Quota gate** — pause dispatch when a provider's subscription limit is hit rather than
    burning tasks against it.

**Exit:** insert a task by hand, move it to *in progress*, and a PR appears without touching
anything else. Kill the process mid-run and it recovers on restart.

---

## Phase 5 — Gateway

1. **HttpApi contract** in `packages/api`: projects, tasks, comments, sessions, runs,
   artifacts, run commands, promotion. Every operation the dashboard and the manager need.
2. **Handlers** in `apps/gateway` over the repositories.
3. **Auth**: Better Auth sessions for humans; scoped tokens for machines. A run's token is
   scoped to its own task — write there, read elsewhere.
4. **SSE endpoint** for run events, fed by Postgres NOTIFY.
5. **OpenAPI spec** mounted, plus Scalar docs. Security schemes in the spec.
6. **Artifact endpoints**: list, read, upload, promote. Files streamed from disk.
7. **Executor connector** pointed at the spec, with a scoped token, verified end to end.
8. **Deployment**: Caddy in front, domain, gateway as a service unit.

**Exit:** a full task lifecycle driven over HTTP with curl, the spec loads in Scalar, and
Executor can list and update tasks as tools.

---

## Phase 6 — Telegram and the manager agent

1. **Bot app**: access control, command routing, voice transcription, forwarded-message
   intake. Port what exists.
2. **Threads**: create, list, switch, clear. Thread and provider session stored separately.
3. **Manager agent** — a harness run whose tools are the gateway API, running in a
   container with no repo. Its memory is the database.
4. **Prompt and rules**: files into *backlog*, never straight into *in progress*.
5. **Run control**: stop, rerun, re-prioritize, written as run commands.
6. **Notifications**: run finished, run failed, task needs review. Summaries and links, not
   raw tool calls.
7. **Approval actions** on messages — move to *in progress*, approve, comment.
8. **Stuck-run heuristic**: no file edits plus repeating tool signatures over N minutes,
   surfaced to the manager.

**Exit:** create a project, file three tasks, dispatch one, read its status, stop it,
comment, and rerun — entirely by talking to the bot.

---

## Phase 7 — Dashboard

1. **App shell**: auth, workspace context, routing, layout.
2. **Board**: columns by status, drag between them, filters by project and kind.
3. **Task detail**: brief, metadata, comments thread with authors, PR link.
4. **Sessions panel**: list with status, transcript viewer, next-session selector.
5. **Run timeline**: live events over SSE, tool calls, cost, duration.
6. **Artifacts panel**: list, render by extension, edit, promote.
7. **Task creation and editing** by hand, no manager involved.
8. **Manager chat** in the dashboard, sharing the thread model with Telegram.
9. **Deploy** to Cloudflare Pages, pointed at the gateway domain.

**Exit:** every board operation available in Telegram is available here, and a run can be
watched live.

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
2. **Credential refresh ownership** — one refresher on the host, short-lived copies into
   containers. This is the known open risk.
3. **Egress policy** via a proxy on the sandbox network, if wanted.
4. **Per-kind tool restriction**, if it turns out to be wanted.
5. **Workspace scoping for artifacts** — the mount-the-whole-root shortcut ends when a
   workspace has a second member.
6. **Backups**: database dump plus the artifact tree, on a schedule, restore tested once.

---

## Cross-cutting, every phase

- **Observability**: one wide event per run and per request, high-cardinality fields, no
  scattered log lines. Follow the `observability` skill.
- **Tests**: real Postgres for repository tests, real containers for sandbox tests. Mock
  the model calls, nothing else.
- **Migrations** are forward-only and checked in with the change that needs them.
- **Docs**: each phase updates the README section it touches. `.docs/plan/` stays the
  design record.

## Sequencing notes

- Phase 1 blocks everything. Do not start it twice in parallel branches — schema conflicts
  are expensive.
- Phases 2 and 3 are independent; either can go first.
- Phase 4 is the first point where the system does something useful on its own. Everything
  before it is scaffolding, everything after it is interface.
- Phase 5 must land before Phase 6, because the manager's tools are the gateway API.
- Phase 7 can slip without blocking anything.
