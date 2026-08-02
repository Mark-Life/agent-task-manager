# Data Model — Phase 1

Review gate before any migration is generated. Covers `packages/domain` types and the
`packages/db` schema. No SQL here, but every name, type, nullability and constraint below is
the contract the migration is written from.

Split: `domain` owns branded ids, literal unions, entity schemas, the status machine as
data, `Actor`. `db` owns drizzle tables and derives row schemas from them
(`createSelectSchema` / `createInsertSchema` from `drizzle-orm/effect-schema`), refining
each column with the domain schema. Row schemas never leave `db`; repositories return
domain entities.

Enum-like columns are `text` + a `Schema.Literals` union in domain. No `pgEnum` anywhere —
adding or dropping a value must not need a migration.

Our ids are `uuid` minted app-side as uuidv7 (`uuidv7` package; Postgres 17.6 has no
native `uuidv7()`). Time-ordered, so `id` doubles as a stable tiebreaker on `created_at`.

Better Auth ids are 32-char strings, so every reference to `user` / `organization` is
`text`, not `uuid`.

Two implementation rules that are invisible at the call site and wrong by default:

- **Every timestamp column goes through one helper**,
  `const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })`.
  A bare `timestamp()` emits `timestamp without time zone`; it typechecks, round-trips a
  `Date`, and is wrong only across a DST boundary or a server timezone change.
- **Refine with the function form, always**: `(s) => DomainSchema`, never a bare schema.
  The function form re-wraps a nullable column in `Schema.NullOr`; a bare schema replaces
  the column type outright, silently dropping `| null` from the row type, so the
  conformance test passes and decoding throws on the first NULL.

---

## 1. Domain type inventory

### Branded ids

| Brand | Encoded | Source |
| --- | --- | --- |
| `WorkspaceId` | text(32) | Better Auth `organization.id` |
| `UserId` | text(32) | Better Auth `user.id` |
| `ProjectId` | uuid | uuidv7 |
| `TaskId` | uuid | uuidv7 |
| `CommentId` | uuid | uuidv7 |
| `AgentSessionId` | uuid | uuidv7 |
| `RunId` | uuid | uuidv7 |
| `RunEventId` | uuid | uuidv7 |
| `RunCommandId` | uuid | uuidv7 |
| `ArtifactId` | uuid | uuidv7 |
| `AuditEntryId` | uuid | uuidv7 |

### Literal unions

| Union | Members | Note |
| --- | --- | --- |
| `TaskStatus` | `ideas` `backlog` `in_progress` `review` `done` | The five columns. No failure status by design. |
| `ActorKind` | `human` `manager` `worker_run` `orchestrator` `system` | `orchestrator` writes most rows in the system. `system` = seed only. |
| `SessionProvider` | `claude` `codex` | |
| `SessionStatus` | `running` `finished` `failed` | A session that died producing nothing stays visible. |
| `RunStatus` | `queued` `running` `finished` `failed` `interrupted` | Live-vs-not; the terminus detail is `RunOutcome`. |
| `RunOutcome` | `done` `errored` `interrupted` `timeout` `lost` | The `atm.run` telemetry union minus `parked` and `skipped` — see below. |
| `RunTrigger` | `status_change` `rerun` `research` `manual` | Why the run exists. `research` / `manual` come from a `start_session` command. |
| `RunEventKind` | `started` `assistant_message` `reasoning` `tool_call` `tool_result` `usage` `log` `error` `finished` `failed` `stopped` | Normalized harness events + lifecycle. |
| `RunCommandKind` | `stop` `rerun` `start_session` | Intents; only the orchestrator acts. |
| `RunCommandStatus` | `pending` `consumed` `rejected` | |
| `CommentAuthorKind` | `human` `manager` `agent` `orchestrator` | The orchestrator authors the crash comment: the process that died cannot. |
| `CommentKind` | `message` `fallback` `run_error` | Orthogonal to author. Only `fallback` collapses in the UI. |
| `ArtifactScope` | `task` `project` `global` | Two of the three are read-only mounts. |
| `AuditAction` | `create` `update` `delete` `transition` `promote` | `promote` is queryable on its own, because promotion is a deliberate verb. |
| `AuditEntityType` | `project` `task` `comment` `agent_session` `run` `artifact` | |

`RunOutcome` is deliberately narrower than the `atm.run` event's outcome union.
`parked` is a property of the task, not of a run — a run that trips the park threshold has
outcome `errored` and sets `task.parked_until`. `skipped` describes a dispatch that never
created a run row (quota gate), so there is no row to store it on; it exists on the event
only.

### Composite types

| Type | Shape | Why |
| --- | --- | --- |
| `Actor` | tagged union: `Human { userId }`, `Manager { userId, threadId? }`, `WorkerRun { runId, sessionId, taskId }`, `Orchestrator { loopInstance, runId? }`, `System { reason }` | Carried as an Effect service requirement, not a parameter, so a mutation with no actor does not compile. Flattened onto `audit_entry`. |
| `NextSession` | tagged union: `Latest`, `New`, `Specific { sessionId }` | A view over `task.next_session_id` + `next_session_new`, not a stored value. Total by construction — no second query, no N+1. `Latest` with nothing to resume starts a new session in the dispatcher. |
| `TaskMetadata` | `Record<string, Json>` | Free-form agent writes. Structured inputs live here until a key earns a column. |
| `ArtifactStat` | `{ path, ext, bytes, modifiedAt }` | What a directory rescan produces; the row is this plus provenance. No hash — see `content_hash`. |
| `RunEventPayload` | tagged union keyed by `RunEventKind` | See below. |

### `RunEventPayload` by kind

The `kind` column is the discriminator; the tag is not repeated inside the jsonb.
Repositories decode `{ kind, ...payload }` into the union.

| Kind | Payload |
| --- | --- |
| `started` | `{ provider, model, promptChars, sandboxImage }` |
| `assistant_message` | `{ text, chars, truncated?, originalChars? }` |
| `reasoning` | `{ chars }` — never the reasoning text |
| `tool_call` | `{ toolName, callId, inputChars, summary }` — summary is sanitized, argv never stored |
| `tool_result` | `{ callId, ok, outputChars, summary }` |
| `usage` | `{ costUsd, turns, inputTokens, outputTokens, rateLimitPct }` |
| `log` | `{ level, message }` |
| `error` | `{ errorClass, errorMessage }` |
| `finished` | `{ outcome, durationMs, costUsd, turns, totalTokens }` |
| `failed` | `{ errorClass, errorMessage, exitCode }` |
| `stopped` | `{ requestedByKind, requestedByUserId?, commandId }` |

Free text passes the `telemetry` sanitizer, then a **byte budget, before insert**:
`assistant_message.text` 16 KB, every `summary` / `message` / `errorMessage` 2 KB. A clipped
field carries `truncated: true` and `originalChars` beside it; the full text is in the
transcript on disk. The database enforces the ceiling itself with
`check (pg_column_size(payload) < 65536)`, so a chatty run cannot put megabytes into the WAL
and every backup forever — the same argument that keeps artifact bytes out.

---

## 2. Status machine

Data, not conditionals: one exported list of `{ from, to, actorKinds }`, consumed by every
writer. Anything absent is illegal.

The manager has every move a person has, including the ones that spend a worker slot. This
reverses `00-high-level.md`, which files the manager into `backlog` only. It is a proxy for
the person talking to it, and a manager that can file a task but not start it just moves
the same request to a different button.

| From | To | human | manager | worker run | orchestrator | Why |
| --- | --- | --- | --- | --- | --- | --- |
| `ideas` | `backlog` | ✓ | ✓ | — | — | The idea survived. Manager's landing zone. |
| `ideas` | `in_progress` | ✓ | ✓ | — | — | Skipping preparation. |
| `backlog` | `ideas` | ✓ | ✓ | — | — | Demote. |
| `backlog` | `in_progress` | ✓ | ✓ | — | — | The dispatch trigger. |
| `in_progress` | `review` | ✓ | ✓ | ✓ | ✓ | Run ended — clean, crashed, or gone without a terminal event. Worker's only move; the orchestrator's too. |
| `in_progress` | `backlog` | ✓ | ✓ | — | — | Pull back a stalled or wrongly-started task. |
| `review` | `in_progress` | ✓ | ✓ | — | — | Resume with comments. |
| `review` | `backlog` | ✓ | ✓ | — | — | Not worth continuing now. |
| `review` | `done` | ✓ | ✓ | — | — | Accept the work. |
| `done` | `in_progress` | ✓ | — | — | — | Reopen. |
| `done` | `review` | ✓ | ✓ | — | — | Reopen without spending a slot. |

The orchestrator's single transition covers both the live terminus and the startup
reconcile of a lost run. `system` performs no transitions at all — it is the seed script's
actor.

Rules that fall out: no transition into `ideas` from `in_progress`/`review`/`done`; no
agent ever reaches `done`; every path to `in_progress` is a human act.

**Research from `backlog` spawns a session without a status change** — it is a
`start_session` run command, not a transition, and it is not in this table.

**A `rerun` command is not a back door into the table.** The orchestrator rejects a `rerun`
whose task is not `in_progress`, writing `rejected_reason = 'task not in progress'`. The
human-facing "rerun after review" *is* the `review → in_progress` transition, which
dispatches through the same trigger as everything else. So a live run always implies the
in-progress column, and the board's spinner semantics hold.

---

## 3. Tables

**Every id and enum-like column carries `.$type<…>()`** with the branded id or literal
union from `domain`, so a drizzle query already returns a `TaskId` and passing one entity's
id where another's belongs does not compile — at the query builder, before a decoder is
reached. Encoding for a write strips the brand at the type level only; one helper carries
it back over, so the write side is branded end to end too.

Every table below has, and the per-table lists omit:

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | — | uuidv7, minted app-side. PK. |
| `workspace_id` | text | no | — | Scoping from the first migration. → `organization.id`. |
| `created_at` | timestamptz | no | `now()` | |
| `updated_at` | timestamptz | no | `now()` | Absent on append-only tables (`run_event`, `audit_entry`). Maintained by a `BEFORE UPDATE` trigger, not by application code, so a raw `UPDATE` cannot leave it stale. |

**Deletion.** Application code never deletes `run_event` or `audit_entry`; the first
migration does `REVOKE UPDATE, DELETE ON run_event, audit_entry FROM <app_role>`, which is
what makes "append-only" a rule instead of a habit. Deleting a `task` or `project` is a real,
deliberate operation and it cascades — including that task's run events. That is what the
verb means: erase this task. The audit log survives it, because `audit_entry.entity_id` has
no FK and `audit_entry.workspace_id` is `restrict`. Referential cascade actions run as the
table owner, so the revoke does not block a legitimate task delete.

### workspace scoping

No table of ours. Better Auth's `organization` **is** the workspace; `member` is
membership. Every table carries `workspace_id text` and every repository query filters on
it. Per-workspace settings (concurrency cap, data root) stay in env while there is one
workspace.

**A child row can never leave its parent's workspace.** `project`, `task`, `agent_session`
and `run` each carry a redundant `unique (workspace_id, id)`, and every FK to them is
composite — `task (workspace_id, project_id) → project (workspace_id, id)`, and so on
through §5. Two extra unique indexes now; a cross-tenant leak that `where workspace_id = $1`
hides, and an unaffordable retrofit, later. Nullable parents are unaffected: `MATCH SIMPLE`
skips the check when any referencing column is NULL.

### `project`

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `name` | text | no | — | |
| `description` | text | yes | — | |
| `repo_url` | text | yes | — | Null = a non-repo project (a trip, an area of life). |
| `repo_default_branch` | text | yes | — | PR base. Null = whatever the clone's HEAD is. |

No `slug` and no `archived_at`: nothing routes by slug (the SPA has ids, the bot has no
URLs) and nothing reads an archive flag. Both come back the day the dashboard has routes.

### `task`

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `project_id` | uuid | yes | — | Tasks may belong to no project. |
| `parent_task_id` | uuid | yes | — | Subtasks, filed by the manager off one article. |
| `status` | text | no | `'ideas'` | `TaskStatus`. |
| `status_changed_at` | timestamptz | no | `now()` | "How long in this column", stall detection. Not derivable without scanning audit. |
| `sandbox_image` | text | yes | — | `base` / `browser`. Null = the default image. The only input that can say "this personal task needs a browser". |
| `title` | text | no | — | |
| `brief` | text | no | `''` | The prompt body. |
| `acceptance` | text | yes | — | Acceptance criteria, appended to the prompt. |
| `repo_url` | text | yes | — | Overrides the project's repo. Null = inherit. |
| `pr_url` | text | yes | — | Rendered by the board; written by the run. |
| `metadata` | jsonb | no | `'{}'` | Free-form agent writes, no migration. |
| `next_session_id` | uuid | yes | — | Resume this session. Null = resume the latest. |
| `next_session_new` | boolean | no | `false` | Start fresh instead of resuming — the one selection an id cannot express. Orchestrator resets both to the default after dispatch. |
| `rank` | double precision | no | — | Position in its column, ascending — and therefore position in the dispatch queue, since the orchestrator spends slots from the top of `in_progress`. Fractional: dropping a card between two others writes the midpoint, one row, no renumbering. Computed inside the write transaction. |
| `parked_until` | timestamptz | yes | — | Set when the retry threshold trips. The dispatcher skips a parked task, so repeated failure stops re-dispatching instead of looping. Cleared by any human transition into `in_progress`. |
| `dispatch_traceparent` | text | yes | — | The W3C header of the write that last asked this card to run, stamped off the ambient span on any landing in `in_progress` and cleared on any landing elsewhere. The orchestrator adopts it as the parent of the dispatch, so the run it opens minutes later is a child of the request rather than a second tree. Unvalidated text: it is read through a total parser, and a refinement would fail the whole row over a telemetry field. |

Check: `not (next_session_new and next_session_id is not null)`.

### `comment`

Append-only: no edit, no delete. That is why there is no `edited_at`.

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `task_id` | uuid | no | — | The conversation belongs to the task, not the session. |
| `body` | text | no | — | |
| `author_kind` | text | no | — | `CommentAuthorKind`. |
| `author_user_id` | text | yes | — | Set for `human` / `manager`. No FK: history outlives accounts. |
| `agent_session_id` | uuid | yes | — | Which session spoke. Makes "from the review session" possible. |
| `run_id` | uuid | yes | — | Which attempt spoke. |
| `kind` | text | no | `'message'` | `CommentKind`. `fallback` = the final-message auto-append, collapsed by the UI. `run_error` = a crashed run's error text, authored by the orchestrator and never collapsed. |

Checks: `(author_kind in ('human','manager')) = (author_user_id is not null)`;
`(author_kind = 'agent') = (agent_session_id is not null)`.

Review comments left on the GitHub PR itself do **not** enter this table in v1 — the agent
reads them with `gh pr view --comments`, and the prompt template says so. Ingesting them
means a `source` + `external_ref` pair and a loop-prevention rule; see §8.

### `agent_session`

Named `agent_session` because Better Auth owns `session`.

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `task_id` | uuid | no | — | Many sessions per task; this is the link. |
| `provider` | text | no | — | `claude` / `codex`. |
| `provider_session_id` | text | yes | — | Unknown until the harness reports it; stored apart so the provider can change. |
| `status` | text | no | `'running'` | `SessionStatus`. |
| `comment_watermark_id` | uuid | yes | — | Last comment this session has seen. No FK — a watermark is a position, not a reference. |
| `comment_watermark_at` | timestamptz | yes | — | Compared with the id as a `(created_at, id)` tuple, so a same-millisecond tie can't skip a comment. |
| `error_message` | text | yes | — | Why a failed session failed, without opening the run. |
| `ended_at` | timestamptz | yes | — | When the last run on this session terminated. `status` says whether it can be resumed. |

Checks: `(status = 'running') = (ended_at is null)`;
`(comment_watermark_id is null) = (comment_watermark_at is null)`.

**Resumable** means `status <> 'failed'`. A cleanly finished session is the normal resume
target — that is what "continue the task's latest session" means, and `ended_at` being set
is not a disqualification.

**The watermark advances at prompt-build time** to the newest comment on the task,
including comments this session's own previous run posted. Without that, a resumed run
re-reads its own fallback comment as new input.

No `agent_home_path` here: the agent home is per run (see `run`). Resuming seeds from the
most recent run of the session being resumed.

### `run`

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `task_id` | uuid | no | — | |
| `agent_session_id` | uuid | no | — | Every run belongs to a session; that is what resume means. The session row is written first, by its own repository, in its own transaction — one aggregate per repository, and a process that dies in between leaves a running session with no runs, which the orchestrator's startup reconcile marks failed. A session visible as failed is a state this model already names; a cross-aggregate write would be a new one. |
| `status` | text | no | `'queued'` | Live-vs-not, which the board shows separately from task status. |
| `outcome` | text | yes | — | Null while live. Never a fabricated value. |
| `trigger` | text | no | — | `RunTrigger`. |
| `attempt` | integer | no | `1` | Retry backoff, park threshold. |
| `provider` | text | no | — | |
| `model` | text | yes | — | Unknown until the harness reports it. |
| `sandbox_image` | text | yes | — | Which image actually ran, against `task.sandbox_image` which selects it. |
| `container_id` | text | yes | — | Teardown and post-mortem `docker logs`. |
| `agent_home_path` | text | yes | — | This run's agent-home dir, **relative to the data root** like `artifact.path`. Where the transcript landed; post-run ingest reads it off this row. Per run, not per session, because parallel containers sharing one credentials file invalidate each other. |
| `branch` | text | yes | — | Branch the run pushed; the PR's head. |
| `started_at` | timestamptz | yes | — | Null while queued: queue wait is `started_at - created_at`. |
| `finished_at` | timestamptz | yes | — | |
| `exit_code` | integer | yes | — | Distinguishes crash from clean finish. |
| `error_class` | text | yes | — | Sanitized. |
| `error_message` | text | yes | — | Sanitized, clipped. |
| `cost_usd` | numeric(12,6) | yes | — | `mode: 'string'` in drizzle, decoded to a branded value in domain. Exact; the awkwardness is one decode. Null on degraded outcomes, never 0. |
| `turns` | integer | yes | — | |
| `total_tokens` | integer | yes | — | |
| `duration_ms` | integer | yes | — | |
| `trace_id` | text | yes | — | Joins the row to the `atm.run` ledger event. |

Checks, so liveness cannot be encoded three ways that disagree:
`(outcome is null) = (status in ('queued','running'))`;
`(finished_at is null) = (status in ('queued','running'))`;
`status <> 'running' or started_at is not null`;
`status <> 'queued' or started_at is null`.

### `run_event`

Append-only, enforced by revoked privileges, not by the absence of an `updated_at` column.

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `run_id` | uuid | no | — | |
| `task_id` | uuid | no | — | Denormalized: an SSE subscriber filters a task's stream without a join. |
| `seq` | integer | no | — | **The 0-based line ordinal of the event in the container's event file**, not a counter. Re-ingesting the same file therefore collides on `(run_id, seq)` by construction, which is what makes re-ingest idempotent. |
| `kind` | text | no | — | `RunEventKind`, the payload discriminator. |
| `payload` | jsonb | no | `'{}'` | Per-kind shape, decoded by the union. Clipped before insert; `check (pg_column_size(payload) < 65536)`. |
| `occurred_at` | timestamptz | no | — | Harness clock, inside the container. |
| `created_at` | timestamptz | no | `now()` | Insert clock, on the host. The two differ and both matter. |

### `run_command`

The stop / rerun / research intents. Written by anyone, acted on only by the orchestrator.

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `task_id` | uuid | no | — | A command can target a task with no live run yet. |
| `run_id` | uuid | yes | — | Null = whichever run is live. |
| `kind` | text | no | — | `RunCommandKind`. |
| `payload` | jsonb | no | `'{}'` | Rerun extras, and `{ trigger }` for `start_session`. |
| `status` | text | no | `'pending'` | `RunCommandStatus`. |
| `actor_kind` | text | no | — | Every intervention is attributable. |
| `actor_user_id` | text | yes | — | No FK, same rule as everywhere else. |
| `actor_run_id` | uuid | yes | — | Parity with `audit_entry`: a worker run holding a task-scoped token can write commands too. |
| `actor_session_id` | uuid | yes | — | |
| `consumed_at` | timestamptz | yes | — | |
| `rejected_reason` | text | yes | — | "No live run" and "task not in progress" are outcomes, not silence. |
| `traceparent` | text | yes | — | Same header as `task.dispatch_traceparent`, for the triggers that move no card: a rerun or a `start_session` carries the asking request's span on its own row. A command's header wins over the task's when both are present. |

`start_session` is how a research or manual session is requested — from the dashboard or the
manager — so run creation stays solely with the orchestrator and the request rides the
`atm_run_command` channel that already exists. No `consumed_by`: there is exactly one
orchestrator, and it owns container lifecycle by design.

### `artifact`

A cache of the filesystem. Never bytes.

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `task_id` | uuid | yes | — | The **owning** task, set only for `scope = 'task'`. Null on promoted and global rows, so they survive the producing task's deletion. |
| `project_id` | uuid | yes | — | Set only when `scope = 'project'`. |
| `scope` | text | no | `'task'` | `ArtifactScope`. |
| `path` | text | no | — | Relative to the scope root. The natural key. |
| `ext` | text | yes | — | Dashboard picks a renderer. |
| `bytes` | bigint | no | — | `mode: 'number'` in drizzle — the mode is required and file sizes are far inside 2^53, where `bigint` mode would give a value the API cannot serialize. |
| `modified_at` | timestamptz | no | — | From `stat`, not from us. |
| `content_hash` | text | yes | — | The bytes as of promotion or copy; null on every other row. A rescan does not hash — size and modified time already answer "did this change", and hashing the tree every run buys nothing more. The hash answers a different question, "are these two files the same bytes", which only arises when copying. |
| `last_run_id` | uuid | yes | — | Which run last touched the file. |
| `promoted_at` | timestamptz | yes | — | When, for the UI. The `promote` audit row is the trail. |
| `source_artifact_id` | uuid | yes | — | The row this file was copied from — promotion *or* cross-project reuse, since reuse is always a copy. Which one it was is the audit action. Makes "how often was this copied" a query. |

Checks: `(scope = 'task') = (task_id is not null)`;
`(scope = 'project') = (project_id is not null)`.

Rescan is an upsert keyed per scope — `(task_id, path)`, `(project_id, path)`,
`(workspace_id, path)` — plus a delete of rows whose file is gone. Drift is fixed by
rescanning; no reconciliation logic. **The rescan path writes no audit rows**: it is a cache
refresh, not a mutation, and auditing it would bury the mutations the log exists for.
`AuditEntityType.artifact` appears only for promotion and manual delete.

### `audit_entry`

Append-only, enforced by revoked privileges. Written in the same transaction as the mutation
it describes, inside the repository, so a mutation cannot skip it.

| Column | Type | Null | Default | Why |
| --- | --- | --- | --- | --- |
| `entity_type` | text | no | — | `AuditEntityType`. |
| `entity_id` | uuid | no | — | No FK: history outlives its subject. |
| `task_id` | uuid | yes | — | Denormalized so a task's activity feed is one index scan. |
| `action` | text | no | — | `AuditAction`. |
| `actor_kind` | text | no | — | Flattened `Actor`. |
| `actor_user_id` | text | yes | — | |
| `actor_run_id` | uuid | yes | — | A worker write names its run. |
| `actor_session_id` | uuid | yes | — | |
| `actor_thread_id` | text | yes | — | Which manager chat thread caused this. No FK — the thread table lands in Phase 6. Without it, "which conversation edited this task" is unanswerable and the bot cannot reply in the right thread. |
| `from_status` | text | yes | — | Transitions are queried directly, not dug out of `changes`. |
| `to_status` | text | yes | — | |
| `changes` | jsonb | no | `'{}'` | `field → { from, to }` for the non-status fields. |
| `trace_id` | text | yes | — | Joins the mutation to the request or run that caused it. |

---

## 4. Indexes

The board and dispatcher both read a column as `order by rank asc, created_at asc, id asc`
— board order *is* queue order, and `created_at` breaks the tie when two cards were dropped
into the same gap at once. The index below matches that order exactly.

A placement writes one row: `rank = (rank of the card above + rank of the card below) / 2`,
with `± 1024` at either end of the column, both neighbours read inside the same transaction.
Repeated drops into one gap halve a double's mantissa, so after ~50 consecutive drops between
the *same* pair the midpoint stops separating them and the tie falls to `created_at` —
ordered, just not where it was dropped. A renormalizing pass over one column is the fix if
that is ever observed; building it now would be paying for a case that needs 50 drags into
one two-card gap with nothing else moving.

| Table | Index | Query it serves |
| --- | --- | --- |
| `project` | unique `(workspace_id, id)` | Composite-FK target. |
| `task` | unique `(workspace_id, id)` | Composite-FK target. |
| `task` | `(workspace_id, status, rank, created_at)` | Board column load; dispatcher's scan of `in_progress`. |
| `task` | `(workspace_id, project_id, status)` | Board filtered by project; covers the composite FK to `project`. |
| `task` | `(workspace_id, status, status_changed_at)` | Stall detection: how long in this column. |
| `task` | `(parent_task_id)` | Subtasks of a task. |
| `task` | `(project_id)` | FK check on project delete — the composite index leads with `workspace_id` and cannot serve it. |
| `task` | `(next_session_id)` | FK check on session delete. |
| `comment` | `(task_id, created_at, id)` | Thread render, and "comments since this session's watermark". |
| `comment` | `(agent_session_id)` | FK check. |
| `comment` | `(run_id)` | FK check. |
| `agent_session` | unique `(workspace_id, id)` | Composite-FK target. |
| `agent_session` | `(task_id, created_at)` | Session list; "the latest session" for the default resume. |
| `run` | unique `(workspace_id, id)` | Composite-FK target. |
| `run` | `(task_id, created_at)` | Run history on a task. |
| `run` | unique partial `(task_id) where status in ('queued','running')` | Enforces one live run per task — two agents never share an artifacts dir. |
| `run` | partial `(workspace_id, created_at) where status in ('queued','running')` | Orchestrator startup reconcile; the board's spinner. |
| `run` | `(agent_session_id)` | Runs belonging to a session. |
| `run_event` | unique `(run_id, seq)` | Replay in order; idempotent re-ingest of the container's event file. |
| `run_event` | `(task_id, id desc)` | Task timeline across runs; SSE catch-up from a cursor. |
| `run_command` | partial `(workspace_id, created_at) where status = 'pending'` | The orchestrator's poll — the only rows it wants. |
| `run_command` | unique partial `(task_id, kind) where status = 'pending'` | A double-clicked Stop becomes a no-op conflict, not a second command that lands as `rejected` noise. |
| `run_command` | `(task_id, created_at)` | Command history on a task. |
| `run_command` | `(run_id)` | FK check. |
| `artifact` | unique partial `(task_id, path) where scope = 'task'` | Rescan upsert key. |
| `artifact` | unique partial `(project_id, path) where scope = 'project'` | Promoted-folder upsert key. |
| `artifact` | unique partial `(workspace_id, path) where scope = 'global'` | Global-folder upsert key. Without it every rescan of the global root appends duplicates forever. |
| `artifact` | `(task_id, modified_at desc)` | Artifacts panel. |
| `artifact` | `(project_id)` | FK check — the partial index cannot serve it. |
| `artifact` | `(last_run_id)` | FK check. |
| `artifact` | `(source_artifact_id)` | FK check, and "how often was this copied". |
| `audit_entry` | `(entity_id, created_at desc)` | History of one entity. `entity_id` is a globally unique uuidv7, so leading with `entity_type` would buy nothing. |
| `audit_entry` | `(task_id, created_at desc)` | "Who changed this task" feed. |
| `audit_entry` | `(workspace_id, created_at desc)` | Workspace activity log. |

`workspace_id` leads every multi-column index it appears in, so a single-tenant scan today
becomes a scoped scan later with no index change. Postgres does not index the referencing
side of a foreign key, so every referencing column above either leads an existing index or
gets a plain one — otherwise deleting one project sequentially scans `task`, `artifact` and
`comment` while holding locks.

---

## 5. Foreign keys

Composite FKs carry `workspace_id` as their first column and target the
`unique (workspace_id, id)` above.

| Column(s) | References | On delete | Why |
| --- | --- | --- | --- |
| every `workspace_id` | `organization.id` | **restrict** | Better Auth deletes an organization through an ordinary adapter DELETE. Cascade would let a click in someone else's library erase every task, run and audit row. Workspace deletion becomes an explicit operation we own. |
| `task (workspace_id, project_id)` | `project (workspace_id, id)` | set null | Deleting a project must not delete its tasks. |
| `task.parent_task_id` | `task.id` | set null | Orphan the child, don't delete it. |
| `task.next_session_id` | `agent_session.id` | set null | Selection falls back to resuming the latest session. |
| `comment (workspace_id, task_id)` | `task (workspace_id, id)` | cascade | The thread is part of the task. |
| `comment.agent_session_id` | `agent_session.id` | set null | |
| `comment.run_id` | `run.id` | set null | |
| `agent_session (workspace_id, task_id)` | `task (workspace_id, id)` | cascade | |
| `run (workspace_id, task_id)` | `task (workspace_id, id)` | cascade | |
| `run.agent_session_id` | `agent_session.id` | cascade | A run without its session is unresumable noise. |
| `run_event (workspace_id, run_id)` | `run (workspace_id, id)` | cascade | |
| `run_event.task_id` | `task.id` | cascade | |
| `run_command (workspace_id, task_id)` | `task (workspace_id, id)` | cascade | |
| `run_command.run_id` | `run.id` | cascade | |
| `artifact.task_id` | `task.id` | cascade | Only task-scoped rows carry it, and they die with their task. Promoted rows carry null and survive. |
| `artifact.project_id` | `project.id` | cascade | Not `set null`: a NULL never conflicts in a unique index, so one `set null` would silently switch off the `(project_id, path)` upsert key and every later rescan would append duplicates. |
| `artifact.last_run_id` | `run.id` | set null | Provenance is nice-to-have, not load-bearing. |
| `artifact.source_artifact_id` | `artifact.id` | set null | The copy origin, if it still exists. |

No FK on any `*_user_id` — `comment.author_user_id`, `run_command.actor_user_id`,
`audit_entry.actor_user_id` — one rule everywhere: attribution outlives accounts.
`audit_entry.entity_id` has **no** FK on purpose, for the same reason: the log must survive
the row it describes. `agent_session.comment_watermark_id` has no FK either; it is a
position, not a reference, and an FK there would null the id while leaving
`comment_watermark_at` set, whereupon the `(created_at, id)` tuple comparison involves a
NULL, evaluates to NULL for every row, and the resumed run silently sees no feedback at all.

One cycle remains, broken by nullability, so insert order is free:
`task.next_session_id ↔ agent_session.task_id`.

---

## 6. NOTIFY triggers

Two `AFTER INSERT ... FOR EACH ROW` triggers and one `AFTER INSERT OR UPDATE`. Payloads are
pointers, never content. `pg_notify` does not truncate past 8000 bytes — it raises
`payload string too long`, and because these fire `AFTER INSERT` that error aborts the
inserting transaction. The ids-only payload is what stops a large tool result from failing
the `run_event` insert outright. Every listener re-reads the row.

| Trigger | Channel | Payload |
| --- | --- | --- |
| `AFTER INSERT ON run_event` | `atm_run_event` | `{ id, runId, taskId, workspaceId, seq, kind }` |
| `AFTER INSERT ON run_command` | `atm_run_command` | `{ id, taskId, runId, workspaceId, kind }` |
| `AFTER INSERT OR UPDATE ON task WHEN (new.status = 'in_progress' and (TG_OP = 'INSERT' or old.status is distinct from new.status))` | `atm_task_dispatch` | `{ taskId, workspaceId, rank }` |

Insert-or-update on the third, because the seed script and the manager can both create a
task directly in `in_progress`, and an update-only trigger would drop it on the floor.

The first feeds the gateway's SSE endpoint: the connection fans events to subscribers
filtered by `runId` / `taskId`, catching up from a cursor over `(run_id, seq)` before
listening. The second and third feed the orchestrator, which listens for immediacy and
polls slowly as a safety net — so a missed NOTIFY costs latency, never a lost task.

**Operational rule for the listener**: one dedicated connection, reaped and reconnected. A
listener that stops draining fills the shared 8 GB notify queue and eventually blocks every
committing transaction in the database.

The trigger functions, their `CREATE TRIGGER`, the `updated_at` trigger and the `REVOKE`
live in the migration the human writes. Drizzle manages the tables, indexes, FKs and every
CHECK — `check()` inside `pgTable`, so the constraints are in the snapshot the next
`drizzle-kit generate` diffs against instead of being dropped by it.

---

## 7. Better Auth alongside our tables

Better Auth 1.7.0-rc.2 with `@better-auth/drizzle-adapter/relations-v2` owns seven tables in
the same database and the same drizzle schema object: `user`, `session`, `account`,
`verification`, `organization`, `member`, `invitation`. We never write them directly — only
through Better Auth.

**Who creates them.** `bunx @better-auth/cli generate` is run **once**, into a checked-in
`auth-schema.ts` that is part of our drizzle schema. drizzle-kit then owns all sixteen
tables in one migration chain, so the `organization` rows our FKs target exist before our
first migration needs them. Better Auth's own `migrate` command is never used. "We never
migrate them by hand" means: never hand-edit the generated file — regenerate it.

| Their name | Our reading | Collision handling |
| --- | --- | --- |
| `organization` | The workspace. | No `workspace` table of ours; `workspace_id text → organization.id`, `on delete restrict`. |
| `member` | Workspace membership. | Authorization reads it; no mirror. |
| `session` | A browser login session. | **Collides** with our agent-conversation Session. Ours is `agent_session`, domain type `AgentSession`, repository `AgentSessionRepo`. The word "session" unqualified in code means Better Auth's. |
| `user` | The human. | `author_user_id`, `actor_user_id` are `text`, not uuid. |
| `account`, `verification`, `invitation` | Untouched. | |

Their `member` table indexes `organization_id` and `user_id` separately and declares no
composite unique, so the same user can be a member of the same organization twice with
different roles. We add `unique index member_org_user_uq on member (organization_id,
user_id)` — it is our database even where the table is theirs — and the authorization query
asserts one row rather than taking the first.

Not by hand and not in the migration: `auth:generate` runs the generator and then
`packages/db/scripts/auth-schema-index.ts`, which writes that index into the generated
table declaration. So drizzle-kit owns it like every other index and a regeneration cannot
quietly drop it. `src/schema/auth.test.ts` fails if the script ever does not run.

One `pg.Pool`, two drizzle handles over it, one shared `relations` object built with
`defineRelations` / `defineRelationsPart`: `PgClient.fromPool` → `PgDrizzle.makeWithDefaults`
for our Effect code, `drizzle({ client: pool, relations })` from `drizzle-orm/node-postgres`
for Better Auth's promise API.

---

## 8. Deliberately no table yet

| Thing | Why not now |
| --- | --- |
| Transcript / message rows | Shape is whatever the normalized harness event model turns out to be. Phase 2 owns it; guessing now means migrating twice. |
| Manager threads and thread messages | Phase 6. `audit_entry.actor_thread_id` records the id already, without an FK, so the trail exists before the table does. |
| `comment.source` / `external_ref` | PR-thread comments are read by the agent through `gh`, not ingested. Ingest needs a loop-prevention rule as much as a column, so both land together or not at all. |
| Scoped API tokens | Phase 5. Likely a Better Auth plugin table, not ours. |
| Telegram account link codes | Phase 6. |
| Run lease | The lease is a heartbeated file on the host, by design. A lease table would be a second source of truth for container ownership. |
| Artifact versions | No versioning by design. If history is ever wanted the answer is `git init` in the artifacts directory — zero schema. |
| Artifact bytes | Filesystem. Large values bloat the WAL and every backup, forever. |
| Job queue | `run.status` plus NOTIFY. No broker at this scale. |
| Provider quota state | Phase 4, in-memory first; the telemetry ledger already records rate-limit utilization. |
| Workspace settings (concurrency cap, data root) | Env, while there is one workspace. |
| Labels / tags | `task.metadata` until a key proves itself worth a column. |
| Stuck-run heuristic state | Derived from `run_event` timestamps. A second counter would drift from the first. |
| `run_event` partitioning | Rejected for now — see the note under the unresolved questions. The payload size cap is the day-one bound. |

---

## 9. Requirement → where it lives

| Requirement | Where |
| --- | --- |
| Many sessions per task | `agent_session.task_id`, no uniqueness. |
| Next-session selection, cleared after dispatch | `task.next_session_id` + `next_session_new`; orchestrator resets both to null / false after claiming. |
| The review loop: a new session reviews the PR, the original resumes | `next_session_new = true` for the review session; then `next_session_id` naming the original for the resume. What each session is for lives in its prompt, not in a column. |
| Session comment watermark | `agent_session.comment_watermark_id` + `_at`, compared as a `(created_at, id)` tuple against `comment`, advanced at prompt-build time. |
| Comment authorship incl. session and run | `comment.author_kind` / `author_user_id` / `agent_session_id` / `run_id`. |
| Auto-generated comment collapses, crash comment does not | `comment.kind` — `fallback` collapses, `run_error` does not. |
| Run lifecycle events kept out of comments | `run_event` table, separate `kind` union; the dashboard interleaves at read time. |
| "A run is live" is not "the task is in progress" | `run.status in ('queued','running')` + the partial index; the board reads the run, not the column. |
| A failed session is visible as failed, not absent | `agent_session.status = 'failed'` + `error_message`. |
| Stop and rerun consumed by the orchestrator | `run_command` + the `atm_run_command` NOTIFY + the pending partial index. |
| Research spawned from backlog without a status change | `run_command.kind = 'start_session'`, payload `{ role, trigger }` → `run.trigger = 'research'`. |
| Artifact index derivable, never bytes | `artifact` — path, size, mtime, ext, hash, `last_run_id`; three per-scope upsert keys. |
| Artifact scope and read-only shared mounts | `artifact.scope` + the scope CHECKs; the mounts are the sandbox's job. |
| Promotion is an auditable verb | `audit_entry.action = 'promote'` on `entity_type = 'artifact'`, plus `artifact.promoted_at` / `source_artifact_id`. |
| Free-form metadata | `task.metadata` jsonb. |
| PR link | `task.pr_url`, with `run.branch` recording which attempt produced the head. |
| Parent task | `task.parent_task_id`. |
| One run per task at a time | Partial unique index on `run(task_id)` where status is live. |
| Actor on every mutation | `audit_entry`, written in the mutation's transaction; `Actor` is an Effect requirement; `ActorKind` includes the orchestrator, which writes most of them. |
| Crash posts a comment and moves to review | `comment` with `kind = 'run_error'`, authored by the orchestrator, + `agent_session.status = 'failed'` + the `in_progress → review` transition. |
| Per-run transcript location | `run.agent_home_path`, relative to the data root. |
| A request's trace reaches the run it caused | `task.dispatch_traceparent` on the card, `run_command.traceparent` on the intent; the orchestrator parses whichever the row carried and dispatches under it, so `run.trace_id` and the `atm.run` event land in the request's trace. |

---

## Unresolved questions

None outstanding. Two closed since the review:

- **`artifact.content_hash`** — written on promotion and copy only, never by a rescan.
- **`run_event` retention** — kept forever. The per-row payload cap is the only bound, and at
  single-operator volume the row count is single-digit GB a year. A deletion policy lands the
  day the table is actually felt, not before.

### Rejected review findings

- **Partition `run_event` by month from the first migration.** Rejected. Partitioning forces
  `created_at` into every unique key, so the PK becomes `(id, created_at)` and `run_event`
  stops matching the uniform `id` PK that every repository, decoder and audit path assumes —
  a real cost on every read, paid today, against a rewrite that at single-operator volume is
  a minutes-long lock. Revisit at ~10M rows; question 2 is the cheaper first move.
