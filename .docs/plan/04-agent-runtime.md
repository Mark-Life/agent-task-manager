# Agent Runtime — one runtime, two roles

Why there is no manager service. A run carries a role; almost nothing else about it
differs. Read this before `03-data-model.md`'s `run`, `agent_session` and `chat_thread`
tables, which are this document made storable.

---

## 1. The role, and what it attaches to

`RunRole` is `worker | manager`, a literal union in `domain` beside `RunTrigger`, and
`run.role text not null default 'worker'` in the database.

A worker always has a task; a manager always has a thread. That is **one** fact, not two, so
the orchestrator carries it as a tagged union and `{ role: "worker", thread }` is
unrepresentable:

```ts
type RunAttachment =
  | { readonly role: "worker"; readonly task: Task }
  | { readonly role: "manager"; readonly thread: ChatThread };
```

The dispatch context carries `attached: RunAttachment`, never a bare `task`. Every reader
that wanted a task id now says which role it means.

Storage does not follow the union. `run.task_id` and `run.thread_id` are two nullable
columns with two real composite foreign keys and a check that the set one matches the role.
A polymorphic `(kind, id)` pair cannot be an FK and cannot cascade.

## 2. The subject key

Where the code needs an *identity* rather than a foreign key — a lease filename, the fiber
map a stop command reaches, a quota announce, an error payload — it uses one key:

```
RunSubject = { kind: "task", id } | { kind: "thread", id }
subjectKeyOf → `task:<uuid>` / `thread:<uuid>`   (`-` for `:` when it is a filename)
```

One key is why the interrupt path, the lease, and the startup reconcile of a lost run are
the same code for both roles rather than two copies that drift.

## 3. What both roles share

| Shared | Consequence for a manager turn |
| --- | --- |
| Dispatch and claim order — plan, quota, pool, lease, open | A chat message waits behind a drained subscription like anything else. |
| Lease file, keyed by subject | A crashed manager turn is reconciled as `lost`, not left live forever. |
| Worker pool, two lanes (`work`, `chat`) with separate caps | A chat cannot starve behind two hour-long worker runs, and it still spends a slot. |
| The container, its mounts, its hardening | Same image mechanics; the image itself is a role choice. |
| `run` row, `run_event` stream, `run_command` | Stop, rerun and the SSE timeline work on a chat turn with no new machinery. |
| `agent_session` + the unread watermark | Coalescing is not a feature: it is what a watermark does. |
| Transcript preservation and ingest | A chat turn's tool calls are queryable the same way a worker's are. |
| Retry ladder, `RunStatus`, `RunOutcome`, `attempt` | A failed turn retries and lands one terminus vocabulary. |
| `atm.run` telemetry, with `role` on the row and the metric tag | "What did chat cost this week" is a query, not a project. |

A role check inside the lease, the pool, the quota gate, the retry ladder, run telemetry,
the container turn or event ingest is wrong by construction. If a role needs different
behaviour there, the model is wrong, not the check.

## 4. What a role may change — exactly four things

| | Worker | Manager |
| --- | --- | --- |
| System prompt | task brief, acceptance, unread comments | thread history, unread messages |
| Tool credential | actor `worker_run`, bound to one task id | actor `manager`, bound to the workspace |
| Container image | repo images (`base` / `browser`) | no repo |
| Attachment | `task_id` | `thread_id` |

The tool **list** is identical: one MCP server, one set of tools. The manager's reach is a
superset because a bound task id is a narrower binding of the same token, enforced in the
gateway's access middleware. What keeps the manager out of repo work is its prompt telling
it to file a task — not a missing capability.

One branch in the terminal path reads the attachment: a worker's ending moves its task to
`review`, a manager's has no task and no board move. The run row, the session ending, the
economics and the events are shared.

## 5. The agent home is mounted, never copied

One system-owned directory per provider on the host, mounted read-write into every
container.

| | |
| --- | --- |
| Directories | `~/.claude-task-management`, `~/.codex-task-management` |
| Override | `ATM_AGENT_HOME_DIR_CLAUDE`, `ATM_AGENT_HOME_DIR_CODEX`, read in the orchestrator's config only |
| Mount | `/agent-home`, top level, read-write, `purpose: "agent_home"` |
| Told to the container | `CLAUDE_CONFIG_DIR=/agent-home` or `CODEX_HOME=/agent-home` |
| Bound | the run's own provider only — mounting the other's credentials is a leak with no purpose |

**Copying the credential is the bug.** A refresh inside a private copy is thrown away with
the container and leaves the host's source permanently stale; this has already happened with
Codex. Several parallel CLI sessions on one laptop share one home and work, which is the
arrangement being copied.

The human logs in once, by hand: `bun run agent-home:login <claude|codex>` creates the
directory at `0700`, then `CLAUDE_CONFIG_DIR=<dir> claude` and `/login`. **Nothing on the run
path creates it.** An auto-created empty directory boots a container that reports an auth
error indistinguishable from an expired token, so a missing directory is
`MountSourceMissing{purpose: "agent_home"}` and the check script says which path and which
login line.

Ownership needs nothing: the container runs as the host uid, a bind mount carries host
ownership through, and the kernel compares numbers.

Codex's refresh-token problem is knowingly not fixed. It carries a TODO on the Codex
provider; Claude is the provider for chats.

## 6. How a conversation resumes a provider session

`agent_session.provider_session_id` is the **only** place a provider session id lives.
Resuming is: point the provider at the shared home, pass the id. Both of the provider's
lookups resolve there — the container's cwd is a constant `/workspace`, so the cwd-keyed
branch lands in the one tree every session writes to, and the fallback branch scans
`projects/*` for `<sessionId>.jsonl` regardless.

So there is no per-run and no per-thread home lifetime, and nothing seeds, scopes, prunes or
tears one down. A shared home is also what makes a **worker's** cross-run resume work: a
private home created empty seconds before the turn never had the conversation being resumed.

Three rules survive, none of them a lifetime rule:

- **A transcript is located by session id only.** Newest-file-by-mtime against a shared tree
  is a *neighbouring* run's conversation, copied in and ingested as this run's timeline. A
  run that crashed before naming a session gets no transcript rather than the wrong one.
- **The per-run transcript copy stays.** It is what makes re-ingest stable and the only bound
  on how much of the shared tree has to be kept.
- **Nothing writes a whole file into the shared home.** MCP servers and provider config go in
  as query options and `-c key=value`; a read-modify-write of the login config is a
  lost-update race and a permanent write of a live bearer token into the human's own config.

Two things are unverified and carried as TODOs on the code they concern: whether Claude's
background-agent registry refuses `--resume` for a headless session, and whether Codex's
SQLite `-wal`/`-shm` files survive a bind mount over Docker Desktop's virtiofs.

Accepted and written down: nothing prunes the shared transcript tree, so any run can read any
other run's and any thread's conversation. For the manager that is a capability; for a worker
it is a leak with no cheap fix short of a home per role.

## 7. One live turn per thread

Three guards, in the order the claim already runs: the partial unique index on live runs per
thread (durable, cross-process), the lease file keyed by `thread-<id>`, and the in-process
fiber map. The bot enforces nothing.

A message arriving mid-turn is stored and the person is told "queued", because the database
says a run is live. It is not held anywhere: the next turn's prompt is everything past the
session's watermark, so several queued messages coalesce by themselves.

**Force send** files a `stop` run command naming the thread. The live run is interrupted and
closes as `interrupted`; the messages that arrived after it built its prompt are still
unread, so the next dispatch resumes the same provider session with them appended. One
accepted loss, identical to a worker's: whatever the stopped turn had already read past its
watermark is not shown again.

## 8. Why there is no manager service

Every alternative forks the ledger. A second runtime needs a second dispatch, a second lease
reconcile, a second pool, a second `run_event`, a second telemetry event and a second live-run
index — and each of those is a place where chat quietly stops getting a fix the worker path
got. The manager is a run. The four differences above are the whole of it.
