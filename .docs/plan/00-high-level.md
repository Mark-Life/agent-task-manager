# Agent Task Manager — High-Level Plan

Status: draft for review. High level only — no implementation detail, no code.

## What this is

A personal software factory. A task board + a manager agent you talk to + a pool of
worker agents that pick tasks up and do them in sandboxes.

Not only coding tasks. "Ship feature X in repo Y" and "plan a 4-day Budapest trip into
my calendar" are the same shape: brief in, agent runs, artifact out, human reviews.

Two interfaces: Telegram (control — voice, forwards, approvals, quick status) and a web
dashboard (observe — boards, run timelines, logs, diffs). Telegram is bad at dense data;
the web app is bad at voice on the move. Use each for what it's good at.

## Why not an off-the-shelf board

**Notion** — what the client factory uses. Works, but the board is a rented API with rate
limits, and it can't hold run data.

**Linear** — has no custom fields (labels only), and its agent APIs are Developer Preview
gated to the Business plan per seat. Modelling "trip task with structured inputs" as
labels is a dead end, and run/event/cost data still needs a real DB. Two sources of
truth, one of them rented.

**Own Postgres.** Docker container on the VPS to start; same wire protocol as any hosted
Postgres later, so going hosted is a connection-string change. `LISTEN/NOTIFY` is the
event bus — no Redis, no queue broker at this scale.

## Core model

Postgres is the only shared state. Three writers: human, manager agent, worker agents.
Workers write status directly (like the client factory) — so an **audit log recording the
actor on every mutation is mandatory**, not optional.

**Task** — kind, optional project, optional repo, status, title, brief, structured inputs,
acceptance criteria, artifacts, parent task.

**Runner profile per kind** — the one seam that matters. It decides three things:

- workspace (fresh clone of a repo vs empty scratch dir)
- tool + MCP set (git/gh vs calendar/maps/search)
- done-condition (PR opened vs artifact written)

Coding is just the kind that gets a repo and opens a PR. Get this seam right on day one;
adding personal/research kinds later is then a config object, not a rewrite.

**Status spine** — generalized from what already works in the client factory:

```
inbox → refining(AGENT) → review(HUMAN) → ready → running(AGENT) → verify(HUMAN) → done
```

Two agent spawn states, two human gates. Nothing more.

**Runs** — one per task attempt. Append-only `run_events` with `pg_notify` on insert: the
live stream, the audit log, and the dashboard replay source are one table.

## Architecture

```
Telegram (control)  ─┐
Web SPA on CF Pages ─┼─→ gateway (VPS: HTTP + SSE) ─→ Postgres ←─ orchestrator ─→ sandboxed workers
                     │                                    ↑
                     └────────→ manager agent ────────────┘
```

- **orchestrator** — long-running. Poll + NOTIFY → worker pool with per-kind concurrency
  caps, durable lease (survives restart), retry backoff, quota gate. Sole owner of
  container lifecycle. Ported in concept (not code) from the client factory, which has
  this part proven.
- **manager agent** — not a loop. A conversational agent invoked per message. Its memory
  is the DB; its tools are the same API the web app uses. Turns "read this article and
  file tickets" into rows. Writes into `review`, never `ready` — the approve gate stays
  human.
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
orchestrator ingests the transcript into Postgres, where the manager agent can query it.

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
**everything the backend can do is available to agents** — projects, tasks, runs — with no
second integration to maintain.

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

Threaded like ChatGPT — many threads, new/clear/switch, history listing. Mirrors the
existing bot's `/history` + `/new`. Thread and provider session id stored separately, so
the provider can change mid-thread.

**Controls running work, through the orchestrator, never directly.** It writes intents
(cancel / restart-with-context / re-prioritize); the orchestrator acts. Keeps one owner of
container lifecycle and makes every intervention auditable.

Mid-run steering is out of scope for v1 — Codex has no clean input path. Stop, then
restart with an added prompt, the same way a human interrupts.

Stuck-run detection starts as a cheap heuristic: no file edits plus repeating tool
signatures over N minutes → flag, let the manager decide.

## Relationship to existing repos

**`telegram-claude` stays a separate repo, unchanged.** It is a good standalone tool for
people who want one synchronous Telegram bot; folding a factory into it would force
Postgres and an orchestrator on those users. This repo starts fresh from the Next.js
monorepo template and **copies the files it needs** — chiefly the provider/harness layer
(normalized agent events, Claude + Codex providers, subscription auth).

Duplication is accepted, deliberately, for now. Extracting a shared `agent-harness`
package — its own repo consumed as a git dependency, with the vendor SDKs as peer
dependencies — is a real option but pure overhead at one-and-a-half consumers. Revisit
when this repo proves itself; it becomes a task in this very factory.

**The client factory is reference only.** Concepts (leases, worker pool, backoff, quota
gating, one global brain prompt) are generic and reusable; its code is not copied.

Both this and `telegram-claude` can run on this VPS side by side — separate processes,
separate state, different bot tokens.

## Template changes

Starting from the Next.js monorepo template, unchanged on first commit. Then:

- drop Next.js, add a Vite + React SPA
- swap the oRPC api package for Effect RPC
- keep: turborepo, bun, biome/ultracite, husky, shared ui + typescript-config packages

Matches the template's own stack guidance for Effect-heavy decoupled apps.

## Phases

1. **Store** — Postgres, schema, migrations, audit log. Seed tasks by hand.
2. **Sandbox + orchestrator** — dispatch `ready` coding tasks into containers → PR.
   Transcript ingest. This alone beats the current setup.
3. **Manager agent in Telegram** — threads, task CRUD, run control. Talking replaces SQL.
4. **Gateway + web dashboard** — read-only boards and run timelines, plus approve/reject.
5. **Second runner profile** — a personal/research kind, to prove the seam.
6. **Hardening** — scoped GitHub tokens, credential-refresh ownership, egress policy.

## Unresolved questions

1. Credential refresh across parallel containers — who owns refresh, and how do containers
   get short-lived copies without racing?
2. Repo mirrors: maintain a bare mirror per repo on the host, or just clone from GitHub
   each run and accept the network cost?
3. Manager agent in a container too — it needs DB access and no repo. Same image, different
   profile, or a separate lighter one?
4. Does the web dashboard need live streaming in v1, or is polling the run-events table
   enough to start?
5. Concurrency caps on a 4-core / 8 GB box: what's the real ceiling for parallel coding
   containers, and does that force an earlier move to a bigger host?
6. Do worker agents talk to Postgres directly, or only through the gateway API? Direct is
   simpler; via API gives one place for validation and audit.
