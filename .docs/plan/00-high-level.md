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
- **in progress** — moving a task here *is* the trigger, every time, with no second
  confirmation. A worker picks it up subject to a global cap on parallel agents. Whether a
  run is currently live is separate from the status: a task sitting in this column with no
  live run is waiting for a slot or has stalled, and the UI shows the difference (a spinner
  while an agent is working).
- **review** — the human gate. The run finished and left something to look at: a PR, a
  document, a calendar. Comment here or on the PR itself, then move the task back to *in
  progress* and the worker resumes with those comments as its next prompt.
- **done**.

Two agent spawn points (*backlog* on demand, *in progress* always) and one human gate
(*review*). Nothing more.

**No done-condition check.** The agent process exiting *is* the completion signal — every
SDK reports it. Run ends → task moves *in progress → review*. Inspecting whether a PR was
actually opened is a later refinement, not a v1 gate.

**Stop and rerun** are always available on a live run. Stop kills the process. Rerun
resumes the same session with any comments added since as extra prompt input — the same
move as interrupting an agent mid-thought, adding a correction, and letting it carry on.
Because entering *in progress* auto-starts, "stop, comment, rerun" is the steering loop.

### Entities

**Project** — optional GitHub repo. Projects without a repo are ordinary projects
(a trip, a piece of writing, an area of life). Tasks can also belong to no project at all.

**Task** — kind, optional project, status, title, brief, structured inputs, acceptance
criteria, parent task. Carries comments, artifacts, and sessions.

**Run** — one task attempt. Append-only `run_events` with `pg_notify` on insert: the live
stream, the audit log, and the dashboard replay source are one table.

**Session** — an agent conversation. A task has **many** sessions over its life, so the
link is its own table. Each carries a status of its own — running, finished, failed — so a
research session that died without producing anything is visible as failed rather than as
an absence. The dashboard lists them and lets you switch between them.

**Artifact** — a versioned document produced by a run: research reports, plans, scraped
data, generated output. Attaches to a task and can be fed as context into any later run on
it. See *Artifacts* below.

**Comment** — the task's conversation. Human, agent, and manager all write here; every
comment records its author, and an agent comment also records which session and run it came
from. This is the cross-session channel (see *How agents talk back*).

### Tools are uniform

Every agent gets the same tools regardless of task kind: git, `gh`, the shell, and the
Executor MCP server. Gating tools by kind is a hardening concern, not a v1 concern, and the
distinction does not survive contact with real tasks — "read these three library repos and
write me a report on what to steal" is a personal research task that badly wants `git` and
`gh`.

**Executor** is the connector layer — an external service holding authenticated connectors
(Google Workspace, Gmail, and the rest), exposed to every agent as MCP. Scattered across
two systems, but one place to manage credentials and most of what's needed is already
wired.

So the per-kind seam shrinks to **workspace**: a fresh clone when the task has a repo, an
empty scratch dir when it doesn't. That's the whole difference, and it's enough to make a
trip-planning task and a feature task run on the same machinery.

### Sessions on a task

Resuming beats starting over most of the time, so **the default is to continue the task's
latest session** with its full history. Starting a fresh session is a deliberate,
one-click override, because sometimes clean context is exactly what you want — reviews
especially.

**Which session runs next is a property of the task**, not a decision made at dispatch
time. While a task sits in *review* (or anywhere with no live run) that property can be
set: the latest session, a specific older one, or a new session. Default is latest;
default with no sessions yet is new. When the task moves to *in progress*, the
orchestrator honours whatever is set and clears it back to the default.

Making it a field rather than an argument is what lets the UI and the manager agent do the
same thing through the same API — a dropdown on the task and a sentence to the manager both
end up writing one value.

The shape this enables, end to end: an implementation run opens a PR and the task lands in
*review*. A **new** session reviews that PR with no memory of having written it. Its review
becomes an artifact or a comment. The task goes back to *in progress*, and the **original**
implementation session resumes, now with the review as its next prompt. Two sessions on one
task, each doing what it is good at, both visible and switchable in the UI.

### How agents talk back

Two channels, deliberately not the same thing.

**Transcripts** are captured, not written. Every tool call and message of every session is
ingested wholesale and rendered in the dashboard. Nobody decides what goes in; it is the
full record, and it is where you go when you want to know what actually happened.

**Comments** are deliberate and short. This is the task's conversation, and the only
channel that crosses sessions. Agents get a comment tool and are expected to use it to say
the thing the next reader needs.

**The final assistant message is auto-appended as a comment only if the run posted no
comment of its own**, and it is flagged as auto-generated so the UI can collapse it. Always
appending it turns the thread into a dump of "I've updated the file, let me know if you
need anything else", which duplicates the transcript. Never appending it means a run that
forgets the tool leaves the task silent. The fallback rule gets both.

**The rule can also be enforced, on both harnesses.** Claude and Codex each expose a stop
hook that fires when the agent tries to end its turn, receives the final assistant message,
and can refuse — returning a reason that the agent then reads as its next prompt. So a run
that finished without commenting gets sent back to write one. The input payload and the
refusal contract are compatible across the two, so one hook serves both. Cap it at a single
retry; both harnesses flag a re-entered stop hook, and neither enforces a limit for you.

Two things not to trip over. Codex silently ignores hooks in headless runs unless trust is
explicitly bypassed on the invocation — no warning, they just never fire. And on a *failed*
turn the Codex stop hook does not run at all, so enforcement covers clean completion only;
crashes are handled by the orchestrator watching for the failure event, below. Keep the
auto-append fallback regardless — enforcement is the belt, the fallback is the braces.

**Attribution is what makes multiple sessions work.** Every comment carries an author —
human, or an agent plus its session and run. The UI can then say "from the review session"
rather than presenting one undifferentiated voice.

**Each session carries a watermark**: the last comment it has seen. On resume, its prompt is
every comment added since, each labelled with its author. That single mechanism covers the
whole review loop — the implementation session comes back and reads "the review session
found X" and "you said Y", with no special-casing anywhere. It works unchanged for two
sessions or ten.

**Structured writes go through the same API the dashboard uses**, not through raw SQL. The
gateway already exposes every operation; a run gets a token scoped to its own task, so it
can update that task, comment on it, and attach artifacts, while only reading everything
else. Fields the UI renders (status, title, brief, PR link) are real columns. Anything else
an agent wants to record goes in a `metadata` JSON blob — free to write, no migration, and
a key that proves itself gets promoted to a column later.

**Run lifecycle events are not comments.** Started, finished, failed, cost, duration live on
the run and in `run_events`. The dashboard interleaves them into the thread for reading; the
storage keeps them apart so the comment thread stays a conversation.

**A crashed run posts its error as a comment and moves the task to *review* anyway.** No
summarization, no auto-retry, no special failure state on the task — the error text lands
in the thread, the session is marked failed, and a human decides. If that turns out to read
badly in practice, summarizing the failure or having an agent respond to it are additive
changes on top.

This is orchestrator work, not hook work. Both harnesses emit a distinguishable failed
terminal event, and Claude additionally fires a stop-failure hook, but a stream that simply
truncates on an abort emits nothing at all — so the orchestrator must treat "process gone,
no terminal event" as a failure in its own right.

## Artifacts

A file produced by a run, held outside git: research reports, plans, scraped data,
generated documents. Files, because that is what agents are natively good at producing.

**Agents write to a known directory in their workspace.** At run end the orchestrator
collects whatever is there and stores it. No special tool to learn, no API call to
remember — writing a file is the interface.

**Versioning is content-addressed, and it comes for free.** Blobs are immutable and named
by the hash of their contents; nothing is ever overwritten. A new version means writing a
new blob and inserting a new row. Two runs producing identical content produce one blob.
Rollback is repointing a row. Diffing two versions is reading two blobs. This is git's
object store without the commit graph, and it is less work than the naive
write-file-at-a-path design it replaces — which is why versioning is in from day one
rather than deferred.

**Two tables.** An `artifact` is the stable identity: task, name, current version. An
`artifact_version` is one immutable revision: hash, size, extension, author (run, session,
or human), timestamp. The extension is what the dashboard renders from — markdown, HTML,
CSV.

**Where the bytes live, by size.** Small text goes inline in a Postgres column, which is
almost everything this system will produce; a report is kilobytes. Anything large gets a
blob on disk with the row keeping a pointer. Same table, same API, one nullable column
each. Start with the inline path only and add the pointer path the first time something
big shows up — an additive migration, not a rewrite.

**Object storage changes one function.** Because keys are content hashes, moving blobs to
R2 or S3 swaps a put/get implementation and nothing else. Deliberately **not** using S3's
own object versioning: it would split version history between bucket metadata and the
database. The database stays the single source of truth for what versions exist.

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

Scoping: consumers get scoped tokens (read, task-write, admin). A worker run's token is
scoped to its own task — write there, read everywhere else — which costs almost nothing to
build and stops a confused agent from editing an unrelated ticket. The Executor connector
and the manager agent do not get destructive scopes.

## Auth & workspaces

Better Auth in the same Postgres, Drizzle schema, organization plugin as workspaces.
`workspace_id` on every table from the first migration. Single workspace to start; admin
invites others later. Telegram user links to an account via a one-time code.

## Manager agent

Threaded like ChatGPT — many threads, new/clear/switch, history listing. Available in
Telegram first, in the dashboard later. Thread and provider session id stored separately,
so the provider can change mid-thread.

**Controls running work, through the orchestrator, never directly.** It writes intents —
the same stop and rerun a human has, plus re-prioritize — and the orchestrator acts. Keeps
one owner of container lifecycle and makes every intervention auditable.

Mid-run steering is out of scope for v1 — Codex has no clean input path. Stop, comment,
rerun, the same way a human interrupts.

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
5. **Research + non-repo tasks** — on-demand research from *backlog*, scratch-dir
   workspaces, artifacts as first-class output.
6. **Hardening** — scoped GitHub tokens, credential-refresh ownership, egress policy,
   per-kind tool restriction if it turns out to be wanted.

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
6. Inline-in-Postgres artifact bodies: what size is the cutover to blob storage, and is it
   worth building both paths up front rather than one?
