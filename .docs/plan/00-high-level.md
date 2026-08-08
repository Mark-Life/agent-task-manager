# Agent Task Manager — High-Level Plan

Status: draft for review. High level only — no implementation detail, no code.

## What this is

A personal software factory. A task board + one agent runtime that runs in two roles: a
**worker** picks a task up and does it in a sandbox, a **manager** is the one you talk to.
Same dispatch, same containers, same ledger — the role is a field on the run, not a second
system.

Not only coding tasks. "Ship feature X in repo Y" and "plan a 4-day Budapest trip into
my calendar" are the same shape: brief in, agent runs, artifact out, human reviews.

Two full interfaces over the same data, neither subordinate to the other:

- **Telegram** — voice, forwarded messages, approvals, quick status. Good on the move,
  bad at dense data.
- **Web dashboard** — boards, run timelines, logs, diffs, and direct editing. Create
  tasks, drag them between statuses, post messages, cancel runs, all by hand and without
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

Postgres is the only shared state. Three writers: human, manager runs, worker runs.
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
  document, a calendar. Post a message here or on the PR itself, then move the task back to *in
  progress* and the worker resumes with those messages as its next prompt.
- **done**.

Two agent spawn points (*backlog* on demand, *in progress* always) and one review gate
(*review*). Nothing more.

**The manager role is not restricted relative to a person.** It is an optional second
interface onto the same operations — say it instead of clicking it — so every move on the
board is available to it, including the ones that spend a worker slot. The **worker role**
is the restricted actor: its token is bound to its own task, so a worker run may only move
that task *in progress → review*. The restriction is on the role, not on being a run.

**No done-condition check.** The agent process exiting *is* the completion signal — every
SDK reports it. Run ends → task moves *in progress → review*. Inspecting whether a PR was
actually opened is a later refinement, not a v1 gate.

**Stop and rerun** are always available on a live run. Stop kills the process. Rerun
resumes the same session with any messages added since as extra prompt input — the same
move as interrupting an agent mid-thought, adding a correction, and letting it carry on.
Because entering *in progress* auto-starts, "stop, post, rerun" is the steering loop.

### Entities

**Project** — optional GitHub repo. Projects without a repo are ordinary projects
(a trip, a piece of writing, an area of life). Tasks can also belong to no project at all.

**Task** — kind, optional project, status, title, brief, structured inputs, acceptance
criteria, parent task. Carries messages, artifacts, and sessions.

**Run** — one attempt by one agent, carrying its **role**: a worker run attempts a task, a
manager run answers a thread. Append-only `run_events` with `pg_notify` on insert: the live
stream, the audit log, and the dashboard replay source are one table, for both roles.

**Thread** — a manager conversation. Its own listed entity, not a board card, reachable
from Telegram and the dashboard alike. Carries messages; a manager run attaches to it the
way a worker run attaches to a task.

**Session** — an agent conversation. It hangs off a **task** for a worker run and off a
**thread** for a manager one, and a task has **many** sessions over its life, so the link
is its own table. Each carries a status of its own — running, finished, failed — so a
research session that died without producing anything is visible as failed rather than as
an absence. The dashboard lists them and lets you switch between them.

**Artifact** — a file produced by a run and kept: research reports, plans, scraped
data, generated output. Attaches to a task and can be fed as context into any later run on
it. See *Artifacts* below.

**Task message** — the task's conversation. Human, agent, and manager all write here; every
message records its author, and an agent message also records which session and run it came
from. This is the cross-session channel (see *How agents talk back*).

### Tools are uniform

Every agent gets the same tools regardless of task kind or role: git, `gh`, the shell, the
Executor MCP server, and the gateway API. Gating tools by kind is a hardening concern, not a v1 concern, and the
distinction does not survive contact with real tasks — "read these three library repos and
write me a report on what to steal" is a personal research task that badly wants `git` and
`gh`.

**The manager's set is a superset of the worker's, and it is one list, not two.** Same
server, same tools; what differs is the binding — a worker's token is bound to its own
task, a manager's is not. So the manager can look at what a stuck worker did, and what
keeps it out of repo work is its prompt telling it to file a task, never a missing
capability.

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
becomes an artifact or a message. The task goes back to *in progress*, and the **original**
implementation session resumes, now with the review as its next prompt. Two sessions on one
task, each doing what it is good at, both visible and switchable in the UI.

### How agents talk back

Two channels, deliberately not the same thing.

**Transcripts** are captured, not written. Every tool call and message of every session is
ingested wholesale and rendered in the dashboard. Nobody decides what goes in; it is the
full record, and it is where you go when you want to know what actually happened.

**Task messages** are deliberate and short. This is the task's conversation, and the only
channel that crosses sessions. Agents get a message tool and are expected to use it to say
the thing the next reader needs.

**The final assistant message is auto-appended as a message only if the run posted no
message of its own**, and it is flagged as auto-generated so the UI can collapse it. Always
appending it turns the thread into a dump of "I've updated the file, let me know if you
need anything else", which duplicates the transcript. Never appending it means a run that
forgets the tool leaves the task silent. The fallback rule gets both.

**The rule can also be enforced, on both harnesses.** Claude and Codex each expose a stop
hook that fires when the agent tries to end its turn, receives the final assistant message,
and can refuse — returning a reason that the agent then reads as its next prompt. So a run
that finished without posting gets sent back to write one. The input payload and the
refusal contract are compatible across the two, so one hook serves both. Cap it at a single
retry; both harnesses flag a re-entered stop hook, and neither enforces a limit for you.

Two things not to trip over. Codex silently ignores hooks in headless runs unless trust is
explicitly bypassed on the invocation — no warning, they just never fire. And on a *failed*
turn the Codex stop hook does not run at all, so enforcement covers clean completion only;
crashes are handled by the orchestrator watching for the failure event, below. Keep the
auto-append fallback regardless — enforcement is the belt, the fallback is the braces.

**Attribution is what makes multiple sessions work.** Every message carries an author —
human, or an agent plus its session and run. The UI can then say "from the review session"
rather than presenting one undifferentiated voice.

**Each session carries a watermark**: the last message it has seen. On resume, its prompt is
every message added since, each labelled with its author. That single mechanism covers the
whole review loop — the implementation session comes back and reads "the review session
found X" and "you said Y", with no special-casing anywhere. It works unchanged for two
sessions or ten.

**Structured writes go through the same API the dashboard uses**, not through raw SQL. The
gateway already exposes every operation; a run gets a token scoped to its own task, so it
can update that task, post on it, and attach artifacts, while only reading everything
else. Fields the UI renders (status, title, brief, PR link) are real columns. Anything else
an agent wants to record goes in a `metadata` JSON blob — free to write, no migration, and
a key that proves itself gets promoted to a column later.

**Run lifecycle events are not task messages.** Started, finished, failed, cost, duration live on
the run and in `run_events`. The dashboard interleaves them into the thread for reading; the
storage keeps them apart so the message thread stays a conversation.

**A crashed run posts its error as a message and moves the task to *review* anyway.** No
summarization, no auto-retry, no special failure state on the task — the error text lands
in the thread, the session is marked failed, and a human decides. If that turns out to read
badly in practice, summarizing the failure or having an agent respond to it are additive
changes on top.

This is orchestrator work, not hook work. Both harnesses emit a distinguishable failed
terminal event, and Claude additionally fires a stop-failure hook, but a stream that simply
truncates on an abort emits nothing at all — so the orchestrator must treat "process gone,
no terminal event" as a failure in its own right.

## Artifacts

A file a run produces and you want to keep: research reports, plans, scraped data,
generated documents.

**One directory per task, on disk, mounted into the container.** The host keeps
`tasks/<id>/artifacts/`; every container working that task gets it bind-mounted at a fixed
path alongside the repo clone. Inside the container it is an ordinary directory — the agent
neither knows nor cares that it is a mount. Files written there survive the container. That
is the entire storage mechanism.

### Scope and promotion

Most artifacts are byproducts nobody reads twice, and they belong to the task that made
them. A few turn out to be reference material worth keeping. That difference is a decision
someone makes, not a storage tier — so scope is task-level by default and **promotion** is
an explicit verb, available in the dashboard and as one manager-agent tool.

Three mounts, one writable:

- the task's own folder — read-write
- the project's promoted folder — **read-only**
- a global folder — **read-only**

Read-only on the shared folders is the load-bearing part. If any run could write there,
promoted material would drift with no audit and no way to tell which run changed what — and
the evidence would be the thing that got overwritten. Promotion as a separate deliberate
step *is* the audit trail.

**Reuse is a copy, never a reference.** Agents work on files; a copy is a file and a pointer
is a concept they will get wrong. More importantly, if task B references task A's artifact
and A is later refined, B's record of what it actually worked from becomes retroactively
false. Disk is free; a task folder that is a self-contained record of what that task saw is
worth more than deduplication.

The two cases resolve differently, usefully. Within a project: promote once, and every
future task in that project sees it automatically. Across projects: the manager copies the
file. Reaching for the second one repeatedly is the signal that something wanted to be
global.

**Search is `ripgrep`, not an index.** The manager gets the artifacts root mounted
read-only and greps it. Agents already know the tool, it is already in the image, it handles
markdown and CSV fine, and at this data volume it is instant. The database index covers the
metadata side — which task produced a file, when, how big. Embeddings earn their place the
day literal matching stops being enough, and pgvector is already in the database when that
happens.

**Multi-tenancy caveat.** Mounting the whole artifacts root into the manager is correct
while this is single-tenant. The day workspaces have more than one member, artifact reads
need the same `workspace_id` scoping as every other table, and this shortcut stops being
acceptable.

**Agents use their native file tools.** Every harness ships a write tool taking an absolute
path and file contents, and an edit tool taking a path and a find/replace pair. Models are
heavily trained on them. A bespoke `create_artifact` tool would be a new interface for
something the model already does well, and every extra tool costs a little quality — so
there isn't one. The only instruction needed is one line in the prompt: anything worth
keeping goes in the artifacts directory, everything else is scratch and dies with the
container.

**Postgres holds an index, never bytes.** Path, size, modified time, extension, and which
run last touched it — rebuilt by scanning the directory after each run. Because the index is
derivable from disk it is a cache, not a source of truth: if it ever drifts, rescan. That
removes an entire class of consistency bug.

Bytes-in-Postgres was the wrong instinct and this reverses it. Reading a file from local
disk is a page-cache hit; reading it from Postgres is a query round-trip plus decompression
of a large value, and the bytes are on the same disk anyway. Large values also bloat the
write-ahead log and every backup, forever. Postgres is fast for metadata; the filesystem is
fast for bytes.

**No versioning.** A folder of current files, that's it. What a previous draft said is in
the run transcript if it is ever wanted. If real history turns out to matter later, the
answer is `git init` in the artifacts directory and a commit after each run — free history,
free diff, tooling everyone already knows, and no schema at all. That option stays open at
zero cost, which is why building a version table now would be paying early for something
that may never be needed.

**Object storage is sync-in / sync-out, not a mount.** Buckets do not bind-mount sensibly —
the FUSE adapters that pretend otherwise have no atomic rename and poor partial writes, and
agents edit files in place constantly. The cloud path instead materializes the directory
before the run and persists changed files after, the way CI restores a cache. So the seam
is "give me this task's directory, take it back when I'm done", with a local implementation
that mounts and a bucket implementation that copies. One interface, two implementations —
not a hybrid, and the agent sees a plain directory either way.

**One run per task at a time**, so two agents never write the same directory concurrently.

## Architecture

```
Telegram (control)  ─┐                                                  ┌─→ worker run (a task)
Web SPA on CF Pages ─┴─→ gateway (VPS: HTTP + SSE) ─→ Postgres ←─ orchestrator ─→ sandboxed runs
                                                                        └─→ manager run (a thread)
```

- **orchestrator** — long-running. Poll + NOTIFY → pool with a lane per role and a
  concurrency cap each, durable lease (survives restart), retry backoff, quota gate. Sole
  owner of container lifecycle, for **both roles**. Ported in concept (not code) from
  existing factory examples, where this part is proven.
- **the role on a run** — `worker | manager`. It selects exactly four things: the system
  prompt, what the run attaches to (a task or a thread), the container image, and the tool
  set. Everything else — dispatch, lease, pool, quota, container, event stream, session,
  transcript, retry ladder, telemetry — is shared, and a role check anywhere in that
  machinery is a bug. The manager is a second interface to the same operations, not a
  lesser one: it turns "read this article and file tickets" into rows, and anything a
  person can do on the board it can do by being asked.
- **gateway** — the API. One contract serves the SPA, the bot, both roles' tools, and
  external agents.
- **telegram bot** — an interface and nothing else: intake, rendering, queueing, buttons.
  No container, no prompt text, no agent runtime. Voice in, approvals, status, summaries +
  links. Does **not** stream raw tool calls for background runs.
- **web app** — Vite + React SPA on Cloudflare Pages, data from the VPS gateway over
  Caddy + a domain. Client bundle from CDN, so opening the dashboard costs no VPS
  round-trip for assets.

## Sandboxing

Every run gets its own Docker container, whatever its role — personal tasks and manager
turns included. Ephemeral: torn down after the run.

**Mounted from host:** the run workspace (rw), the task's artifacts directory (rw), the
project and global artifact folders (ro), and the **provider's agent home (rw)** — one
directory per provider, shared by every run, never copied (see *Session history*). Nothing
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

So: **one system-owned agent home per provider on the host**, mounted read-write into every
container, never copied. `~/.claude-task-management` and `~/.codex-task-management` by
default, overridable by env. The human logs into it once by hand — `CLAUDE_CONFIG_DIR=<dir>
claude`, then `/login` — which is exactly the arrangement several parallel CLI sessions on
one laptop already use. Never the personal `~/.claude`, which holds every transcript from
every project.

Every session's transcript therefore lands in **one tree**, and that tree outlives the
container. The orchestrator ingests it into Postgres, where the manager can query it and
the dashboard can render it. Sharing is also what makes resuming a specific session
possible at all: a per-run home is created empty seconds before a resume, so the provider
cannot find the session id it was handed, while against the shared tree both of its lookups
resolve. There is no per-run and no per-thread home lifetime — nothing to seed, scope,
prune or tear down.

Two costs of the shared tree, accepted and written down rather than fixed. Nothing prunes
it, so a run can read another run's conversation — a capability for the manager role, a
leak for the worker one. And nothing may write a whole file into it: a read-modify-write of
the provider's own config from inside a container is a lost update, and it parks a live
token in the human's login config. Per-run configuration goes on the invocation instead.

The Claude SDK also has an alpha `sessionStore` hook that dual-writes transcript entries
to an external store — the cleaner path to live transcripts in Postgres, worth trying once
the file-ingest path works. Not on the critical path: end-of-turn sync is enough for v1.

**The failure this replaces:** subscription credentials refresh and rotate. Give each
container its own *copy* and the refresh happens inside the copy, dies with the container,
and leaves the source permanently stale — observed with Codex. Copying is the bug, not the
mitigation; short-lived copies are rejected for the same reason. The shared mounted home is
the answer. Codex's own refresh handling is knowingly **not** fixed in v1 and carries a TODO
on its provider; Claude is the provider for chats.

## API surface

Effect all the way, Effect v4 beta, tracking latest.

One typed contract at the gateway, serving four consumers: the SPA, the Telegram bot, the
tools every run gets in either role, and external agents via Executor. Threads and thread
messages are part of it, so a conversation opened in Telegram is readable from the
dashboard and by an agent. Executor runs code-as-tools
against an OpenAPI surface, so an OpenAPI spec derived from the same contract means
**everything the backend can do is available to agents** — projects, tasks, runs,
artifacts — with no second integration to maintain.

Streaming of run events rides alongside as SSE over Postgres NOTIFY.

The surface is Effect **HttpApi**, not Effect RPC — a deviation from `.docs/stack.md`,
argued in `01-api-surface.md`. Short version: OpenAPI derivation and SSE exist only on
HttpApi, and RPC over HTTP is a single opaque endpoint that Executor cannot use.

Scoping: consumers get scoped tokens (read, task-write, admin). Both roles get `task-write`
and the difference is the **binding**, not the scope: a worker run's token names its own
task — write there, read everywhere else, which costs almost nothing to build and stops a
confused agent from editing an unrelated ticket — while a manager run's token names none
and writes across the board. That one field is why the manager's reach is a superset with
no second tool list. Neither role, nor the Executor connector, gets a destructive scope.

## Auth & workspaces

Better Auth in the same Postgres, Drizzle schema, organization plugin as workspaces.
`workspace_id` on every table from the first migration. Single workspace to start; admin
invites others later. Telegram user links to an account via a one-time code.

## Manager agent

The same runtime as a worker, with `role: "manager"` on the run. It differs by prompt,
attachment, image and tool set; nothing else about it is separate.

Threaded like ChatGPT — many threads, new/switch, history listing. There is no `/clear`: a
thread's session is a row, so starting from nothing is a new thread. **A thread is a
first-class listed entity, not a board card**, and the same thread is reachable from
Telegram and from the dashboard through the same API — not Telegram-first-dashboard-later.
The provider session id lives on the session, exactly as it does for a worker, so the
provider can change mid-thread and there is one place it is written.

**Controls running work, through the orchestrator, never directly.** It writes intents —
the same stop, rerun and reorder a human has — and the orchestrator acts. Keeps one owner
of container lifecycle and makes every intervention auditable.

**Nothing on the board is withheld from it.** "Start task B next" and dragging task B to
the top of the column are the same write, and refusing the sentence while allowing the drag
would only move the same decision to a different button. The audit log is what makes this
safe: every mutation records that the manager made it, and on whose instruction.

Parity holds against a **worker** too, not just against a person: the manager can do
everything a worker can, including reading a stuck worker's transcript. It declines repo
work because its prompt says to file a task, not because a tool is missing.

**One live turn per thread.** A message arriving mid-turn is queued and the person told so;
several queued messages coalesce into one prompt on the next turn; an inline button
force-sends by stopping the current turn and appending the message to the session. This
exists in `telegram-claude` — port it, do not design it.

Mid-run steering of a **worker** stays out of scope for v1 — Codex has no clean input path.
Stop, post, rerun, the same way a human interrupts.

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

In `02-build-plan.md`, with an exit test each. One phase list, one place to change it — not
restated here.

## Unresolved questions

1. Repo mirrors: maintain a bare mirror per repo on the host, or just clone from GitHub
   each run and accept the network cost?
2. Concurrency caps on a 4-core / 8 GB box: 2 worker slots + 1 manager slot is the current
   answer. What is the real ceiling, and does it force an earlier move to a bigger host?
3. Does promotion need its own review, or is it a one-click act? A promoted artifact is
   read by every future task in the project, so a bad one propagates quietly.
