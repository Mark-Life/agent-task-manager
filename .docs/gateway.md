# Gateway (`bun run gateway:start`, `bun run gateway:check`)

**One typed contract, four consumers.** `packages/api` declares every operation — projects,
tasks, task messages, sessions, runs, run commands, artifacts, proposals, conversations, provider usage — as an Effect `HttpApi` and holds no
handlers at all. `apps/gateway` implements it group by group over the repositories, and
`openapi.json` falls out of the same value. That derivation is the whole reason this is HttpApi
rather than RPC: an external agent reaching the board through [Executor](https://executor.sh)
needs to see each operation to hold it as a tool, and RPC over HTTP is one opaque endpoint.

**The workspace is never addressed.** It is not a path segment and not a body field; it comes
off the credential, so no caller can name a workspace it cannot read and no handler can forget
to scope a query. Everything a task owns nests under `/tasks/:taskId`, which is what lets a
run's task-bound token be checked once, in the access middleware, against the path.

`GET /usage` is the one read that is not a workspace's: it reports what is left on the
subscriptions this machine runs agents with, per rolling window, and two workspaces on one host
draw down the same five hours. The gateway does not poll the providers — the loop does, and
publishes to `${DATA_ROOT}/quota/usage.json`; this serves that file, answering an empty provider
list when nothing has been published yet, which is also the honest answer while the loop is
down. A credential is still required.

**Three doors, one answer.** A browser sends a Better Auth session cookie; the system's own
agents send a signed, scoped, expiring bearer token; a person's script or agent sends an API key
that person issued, in `x-api-key`. All three resolve to the same three facts — the actor every
write is attributed to, the scope the credential is good for, and the one workspace it can see.
Scopes are floors, not exact matches: `read` is every GET, `task-write` is ordinary work
including erasing a task, `admin` is deleting a project, reading a project's environment files,
and confirming a proposal. That last one is the whole reason the proposals group exists at that
scope: an agent's credential has a `task-write` ceiling and can never be minted higher, so
"a person, and only a person, may change the directory a worker could not write" is arithmetic on
a token rather than a check a handler remembers. Who may erase a task is then a second
question asked of the actor rather than the scope — a run's token reaches every write on its own
card and still may not delete it, which a scope alone cannot express.
Tokens are signed rather than stored, so verifying one is arithmetic on
the request thread and there is no revocation short of rotating `BETTER_AUTH_SECRET` — which is
why they are short-lived and why a run's token is bound to its own task.

**A user key is the opposite kind of thing, on purpose.** It is stored (hashed, by Better Auth's
API key plugin), revocable from the dashboard's *API keys* screen, and it resolves to the
`human` actor of whoever issued it — so anything it changes is attributed to that person, with
the scope they chose at creation and no more. The scope and the workspace ride in the key's
metadata, which a browser may write, so both are checked on every request: the scope against the
ceiling a person holds, the workspace against that person's memberships *now*. A key naming a
board its owner has left, or belonging to a deleted user, stops working on the next request.
Keys carry a per-key quota (600 requests a minute) and a spent one is a 429 with
`key_rate_limited` rather than a 401 — the credential is fine and the repair is to wait.
**Revoking every key a person owns stops that person's integrations and leaves every worker on
the board running**, because an agent's credential is minted from the signing secret and never
from a key; nothing in that path reads the `apikey` table.

```bash
bun run gateway:start                                        # serve on GATEWAY_PORT (3100)
bun run gateway:token --scope admin --user me --ttl-days 30  # a bearer token, printed and nothing else
curl -H "Authorization: Bearer $TOKEN" localhost:3100/tasks/board
curl -H "x-api-key: $KEY"              localhost:3100/tasks/board   # a key issued in the dashboard
open http://localhost:3100/docs                              # Scalar, over the derived spec
```

`/openapi.json` and `/docs` carry no credential: the spec describes the door, it does not open
it, and publishing it is how a connector configures itself. `components.securitySchemes` names
the three bearer scopes, the session cookie and `userApiKey`, one scheme per scope, because
OpenAPI has nowhere else to put a scope on a bearer token — and every operation lists all three
credentials, so a client generated from the spec can satisfy it with a key alone.

Keys are created, listed and revoked through the auth library's own routes under `/api/auth`,
not through this contract — the same reason signing in is not in it: they are how a caller
obtains a credential rather than something done with one, and the plugin already refuses to
touch a key belonging to anybody but the session holder.

**Run events stream as SSE over Postgres `NOTIFY`.** One `LISTEN atm_run_event` per process,
multicast to every open stream, so a hundred dashboard tabs cost one connection. A notification
carries ids and never a payload, so every wake-up runs the same cursor query — which makes a
duplicate notice free, a dropped notice recoverable, and replay from an arbitrary `afterSeq` the
same code path as the live tail. A slow tick runs beside the channel for the notification
delivered to nobody.

**Artifacts are metadata in Postgres and bytes on disk.** `list` is a query, `read` is a stream
straight off local disk, and every path is resolved against the task's own folder and refused —
twice, once before `realPath` and once after — unless it stays inside. Promotion copies into the
project's folder or the global one. The global folder is a read-only mount to every worker, and a
run's own token reaches this route — `task-write` is what promoting into a project needs — so the
global destination is refused to anything but a person: otherwise a run could write a file into
its own folder and promote it into the directory every later run reads, and the proposal a person
has to accept would be the long way round a door standing open. Two folders are listable, `GET /tasks/:taskId/artifacts` and
`GET /projects/:projectId/artifacts`: the project's is mounted read-write into every run on it, so
a research task leaves a document there for the next task, and without the second listing that
document is reachable only by somebody who already knows its path. It answers a run's own writes
and the copies a promotion made as one list, because they are one folder. The bytes are still a
task-folder read — a project file is opened by a run through its mount, not through this API.

**`atm.request`, one row per request, on every exit path.** Route *pattern* rather than path,
method, status, `durationMs`, workspace, actor kind and id, token scope, bytes out, whether it
held an event stream and for how long, outcome and `errorClass`. `traceId` comes off the
caller's `traceparent` when there is one. A request that matched nothing also carries
`pathShape` — how far the path got into the contract before it stopped matching, `/tasks/:taskId/*`
or just `/*` — which is what tells a probe from a client calling a real endpoint the wrong way,
since a 404's message is suppressed and the path itself never reaches a row. A refused credential is `outcome: "rejected"` on that
same row with the reason on it — never a 401 that vanished. Three metrics project the same row
through a bounded vocabulary: `atm_requests_total`, `atm_request_duration_ms`, and an
`atm_sse_connections` gauge.

```bash
bun run gateway:check   # own data root and port, seconds, no model calls
```

`gateway:check` starts the gateway as a child process, drives a whole task lifecycle over a real
socket — file a project, file a task, post a message, walk it `ideas → backlog → in progress → review →
done`, list its runs, queue a run command, upload and read an artifact, stream a run's timeline,
then open a conversation belonging to no chat, say something into it, read it and its turns
back, force-send and archive it — then stops it with `SIGTERM` and audits the ledger it flushed: every request left exactly one
row, no row carries a path where a pattern belongs, and each of the five refusals left a row
saying why. Each call mints its own `traceparent`, which is what makes both halves of that
provable at once.

**The trace reaches the run, and both halves are checked.** A card filed into *in progress*
carries the asking request's `traceparent` on `task.dispatch_traceparent`; the loop adopts it
when it claims the card, so the `atm.run` row of the run that follows shares the trace of the
request that asked for it. `gateway:check` claims the stamp is written and cleared on the way
out of the column — so no later run joins a spent request — and `loop:check` claims the run row
carries it.

