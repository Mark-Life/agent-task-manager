# Agent Task Manager — High-Level Plan

Status: draft for review. High level only — no implementation detail, no code.

## What this is

A personal software factory. A task board + a manager agent you talk to + a pool of
worker agents that pick tasks up and do them in sandboxes.

Not only coding tasks. "Ship feature X in repo Y" and "plan a 4-day Budapest trip into
my calendar" are the same shape: brief in, agent runs, artifact out, human reviews.

Two full interfaces over the same data, neither subordinate to the other:

- **Telegram** — voice, forwarded messages, approvals, quick status. Good on the move,
  bad at dense data.
- **Web dashboard** — boards, run timelines, logs, diffs, and direct editing. Create
  tasks, drag them between statuses, comment, cancel runs, all by hand and without
  involving the manager agent.

## Why not an off-the-shelf board

**A hosted Kanban board driven over its API** — Notion or similar — is the obvious
default and does work. The board becomes a rented API with rate limits, though, and it has
nowhere to put run data: attempts, events, cost, transcripts, artifacts.

**Linear** — no custom fields (labels only), and its agent APIs are Developer Preview
gated to the Business plan per seat. Modelling "trip task with structured inputs" as
labels is a dead end, and run/event data still needs a real DB. Two sources of truth, one
of them rented.

**Own Postgres.** Docker container on the VPS to start; same wire protocol as any hosted
Postgres later, so going hosted is a connection-string change. `LISTEN/NOTIFY` is the
event bus — no Redis, no queue broker at this scale.

## Core model

Postgres is the only shared state. Three writers: human, manager agent, worker agents.
Workers write status directly, so an **audit log recording the actor on every mutation is
mandatory**, not optional.

### Statuses

```
ideas → backlog → in progress → review → done
```

- **ideas** — unstructured. Anything, in any shape, no quality bar. A dumping ground on
  purpose.
- **backlog** — things being prepared. An idea that survived. From here a **research agent
  can be spawned on demand** (from the dashboard or by asking the manager) to investigate
  and produce an artifact, so the task arrives at implementation with real context.
  Research is opt-in, not automatic.
- **in progress** — moving a task here *is* the trigger. A worker picks it up, subject to a
  global cap on parallel implementation agents. Whether a run is currently live is separate
  from the status: a task sitting in this column with no live run is waiting for a slot or
  has stalled, and the UI shows the difference (a spinner while an agent is working).
- **review** — the human gate. The run finished and left something to look at: a PR, a
  document, a calendar. Comment on it here, or on the PR itself, then move it back to *in
  progress* and the worker resumes with those comments as its next prompt.
- **done**.

Two agent spawn points (*backlog* on demand, *in progress* always) and one human gate
(*review*). Nothing more.

### Entities

**Project** — optional GitHub repo. Projects without a repo are ordinary projects
(a trip, a piece of writing, an area of life). Tasks can also belong to no project at all.

**Task** — kind, optional project, status, title, brief, structured inputs, acceptance
criteria, parent task. Carries comments, artifacts, and sessions.

**Run** — one task attempt. Append-only `run_events` with `pg_notify` on insert: the live
stream, the audit log, and the dashboard replay source are one table.

**Session** — an agent conversation. A task has **many** sessions over its life, so the
link is its own table. The dashboard lists them and lets you switch between them.

**Artifact** — a file produced by a run, held outside git: research reports, plans,
scraped data, generated documents. Files, because that is what coding agents are good at.
Local filesystem storage on the VPS to start, behind an interface that takes an S3-compatible
adapter later (R2 or S3 — same API). Artifacts attach to a task and can be fed as context
into any later run on that task.

**Runner profile per kind** — the seam that keeps this from being a coding-only tool. It
decides three things:

- workspace (fresh clone of a repo vs empty scratch dir)
- tool + MCP set (git/gh vs calendar/maps/search)
- done-condition (PR opened vs artifact written)

Coding is just the kind that gets a repo and opens a PR. Get this seam right on day one;
adding personal and research kinds later is then a config object, not a rewrite.

### Sessions on a task

Resuming beats starting over most of the time, so **the default is to continue the task's
current session** with its full history. Starting a fresh session is a deliberate,
one-click override, because sometimes clean context is exactly what you want — reviews
especially.

The shape this enables, end to end: an implementation run opens a PR and the task lands in
*review*. A **new** session reviews that PR with no memory of having written it. Its review
becomes an artifact or a comment. The task goes back to *in progress*, and the **original**
implementation session resumes, now with the review as its next prompt. Two sessions on one
task, each doing what it is good at, both visible and switchable in the UI.

## Architecture

```
Telegram (control)  ─┐
Web SPA on CF Pages ─┼─→ gateway (VPS: HTTP + SSE) ─→ Postgres ←─ orchestrator ─→ sandboxed workers
                     │                                    ↑
                     └────────→ manager agent ────────────┘
```

- **orchestrator** — long-running. Poll + NOTIFY → worker pool with per-kind concurrency
  caps, durable lease (survives restart), retry backoff, quota gate. Sole owner of
  container lifecycle. Ported in concept (not code) from existing factory examples, where
  this part is proven.
- **manager agent** — not a loop. A conversational agent invoked per message. Its memory
  is the DB; its tools are the same API the web app uses. Turns "read this article and
  file tickets" into rows. Files into *backlog*, never straight into *in progress* — the
  decision to spend a worker slot stays human.
- **gateway** — the API. One contract serves the SPA, the bot, the manager's tools, and
  external agents.
- **telegram bot** — thin client. Voice in, approvals, status, summaries + links. Does
  **not** stream raw tool calls for background runs.
- **web app** — Vite + React SPA on Cloudflare Pages, data from the VPS gateway over
  Caddy + a domain. Client bundle from CDN, so opening the dashboard costs no VPS
  round-trip for assets.

## Sandboxing

Every run gets its own Docker container, including personal tasks and the manager agent.
Ephemeral: torn down after the run.

**Mounted from host:** the run workspace (rw) and a per-run agent-home dir (rw). Nothing
else. Never the docker socket — that one mount turns a sandbox into host root.

**Hardening:** drop all capabilities, no-new-privileges, non-root user, pid/memory/cpu
limits. Blast radius of a confused agent = its own container.

**Network: fully open.** Search, package installs, `gh`, and the model APIs all need it.
An egress allowlist is a permanent maintenance tax for little gain here. Revisit later
via a proxy on the sandbox network — additive change.

**GitHub: full access as the user, deliberately.** Per-repo scoped tokens (GitHub App
installation tokens) are the right end state but over-complication for v1. Accepted risk,
tracked as a later task.

**Container as isolation replaces git worktrees.** Each run clones fresh from a host-side
bare mirror mounted read-only (fast, no network). Drops worktree GC, orphan sweeps, and
`.env` copying.

**Local (no-container) mode stays** as a second sandbox implementation — needed for
debugging and as an escape hatch.

**Images.** Host is aarch64 / 4 cores / 8 GB, so images must be arm64 and concurrency caps
must be low (order of 2–3 heavy containers). Two images, both arm64:

- `base` — bun, node, git, gh, ripgrep, the agent CLIs. Small, starts fast.
- `browser` — base + Chromium and its system libs for `agent-browser`.

Coding and browser-needing personal tasks pick the heavier image; everything else takes
base. Bake tooling into the image and rebuild on a schedule rather than installing per
run.

## Session history

The unresolved question from the discussion, now answered.

Both harnesses write transcripts to their config dir, and both let you relocate it:
`CLAUDE_CONFIG_DIR` for Claude (verified: transcripts land in `<dir>/projects/**.jsonl`),
`CODEX_HOME` for Codex (verified present in the shipped binary).

So: give each run a **per-run agent-home directory on the host**, mounted into the
container, seeded with credentials only — never the personal `~/.claude`, which holds
every transcript from every project. Sessions then survive container teardown and the
orchestrator ingests the transcript into Postgres, where the manager agent can query it
and the dashboard can render it. This is also what makes resuming a specific session on a
task possible at all.

The Claude SDK also has an alpha `sessionStore` hook that dual-writes transcript entries
to an external store — the cleaner path to live transcripts in Postgres, worth trying once
the file-ingest path works.

**Known risk:** subscription credentials refresh and rotate. Parallel containers each
holding a copy of the credentials file may invalidate each other. Needs a deliberate
answer — likely one owner of refresh on the host, with containers getting short-lived
copies.

## API surface

Effect all the way, Effect v4 beta, tracking latest.

One typed contract at the gateway, serving four consumers: the SPA, the Telegram bot, the
manager agent's tools, and external agents via Executor. Executor runs code-as-tools
against an OpenAPI surface, so an OpenAPI spec derived from the same contract means
**everything the backend can do is available to agents** — projects, tasks, runs,
artifacts — with no second integration to maintain.

Streaming of run events rides alongside as SSE over Postgres NOTIFY.

The surface is Effect **HttpApi**, not Effect RPC — a deviation from `.docs/stack.md`,
argued in `01-api-surface.md`. Short version: OpenAPI derivation and SSE exist only on
HttpApi, and RPC over HTTP is a single opaque endpoint that Executor cannot use.

Scoping: consumers get scoped tokens (read, task-write, admin). The Executor connector and
the manager agent do not get destructive scopes.

## Auth & workspaces

Better Auth in the same Postgres, Drizzle schema, organization plugin as workspaces.
`workspace_id` on every table from the first migration. Single workspace to start; admin
invites others later. Telegram user links to an account via a one-time code.

## Manager agent

Threaded like ChatGPT — many threads, new/clear/switch, history listing. Available in
Telegram first, in the dashboard later. Thread and provider session id stored separately,
so the provider can change mid-thread.

**Controls running work, through the orchestrator, never directly.** It writes intents
(cancel / restart-with-context / re-prioritize); the orchestrator acts. Keeps one owner of
container lifecycle and makes every intervention auditable.

Mid-run steering is out of scope for v1 — Codex has no clean input path. Stop, then
restart with an added prompt, the same way a human interrupts.

Stuck-run detection starts as a cheap heuristic: no file edits plus repeating tool
signatures over N minutes → flag, let the manager decide.

## Relationship to `telegram-claude`

**[`telegram-claude`](https://github.com/Mark-Life/telegram-claude) stays a separate repo,
unchanged.** It is a good standalone tool for people who want one synchronous Telegram
bot; folding a factory into it would force Postgres and an orchestrator on those users.
This repo starts fresh from the Next.js monorepo template and **copies the files it
needs** — chiefly the provider/harness layer (normalized agent events, Claude + Codex
providers, subscription auth).

Duplication is accepted, deliberately, for now. Extracting a shared `agent-harness`
package — its own repo consumed as a git dependency, with the vendor SDKs as peer
dependencies — is a real option but pure overhead at one-and-a-half consumers. Revisit
when this repo proves itself; it becomes a task in this very factory.

Both can run on this VPS side by side — separate processes, separate state, different bot
tokens.

## Template changes

Starting from the Next.js monorepo template, unchanged on first commit. Then:

- add a Vite + React SPA as a new app. The Next.js app stays for now — it costs nothing
  to leave in place and may earn its keep as a marketing page. Drop it later if unused.
- replace the oRPC api package with Effect HttpApi
- keep: turborepo, bun, biome/ultracite, husky, shared ui + typescript-config packages

## Phases

1. **Store** — Postgres, schema, migrations, audit log, artifact storage. Seed tasks by
   hand.
2. **Sandbox + orchestrator** — dispatch *in progress* coding tasks into containers → PR.
   Transcript ingest, session-per-task linking. This alone beats the current setup.
3. **Manager agent in Telegram** — threads, task CRUD, run control. Talking replaces SQL.
4. **Gateway + web dashboard** — the second full interface: boards with drag between
   statuses, task creation and editing, comments, run timelines, session switching.
5. **Research + personal runner profiles** — on-demand research from *backlog*, and one
   non-coding kind, to prove the seam.
6. **Hardening** — scoped GitHub tokens, credential-refresh ownership, egress policy.

## Unresolved questions

1. Credential refresh across parallel containers — who owns refresh, and how do containers
   get short-lived copies without racing?
2. Repo mirrors: maintain a bare mirror per repo on the host, or just clone from GitHub
   each run and accept the network cost?
3. Manager agent in a container too — it needs DB access and no repo. Same image, different
   profile, or a separate lighter one?
4. Does the dashboard need live streaming in v1, or is polling the run-events table enough
   to start?
5. Concurrency caps on a 4-core / 8 GB box: what's the real ceiling for parallel coding
   containers, and does that force an earlier move to a bigger host?
6. Do worker agents talk to Postgres directly, or only through the gateway API? Direct is
   simpler; via API gives one place for validation and audit.
7. When a task returns from *review* to *in progress*, does the worker resume automatically
   or wait for an explicit "go"? Automatic is fewer clicks and risks burning a slot on a
   half-written comment.
8. Do artifacts get versioned, or does a re-run overwrite? Versioning is cheap on a
   filesystem and expensive to retrofit.
