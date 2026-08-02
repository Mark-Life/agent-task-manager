# Gateway (`bun run gateway:start`, `bun run gateway:check`)

**One typed contract, four consumers.** `packages/api` declares every operation — projects,
tasks, comments, sessions, runs, run commands, artifacts, conversations — as an Effect `HttpApi` and holds no
handlers at all. `apps/gateway` implements it group by group over the repositories, and
`openapi.json` falls out of the same value. That derivation is the whole reason this is HttpApi
rather than RPC: an external agent reaching the board through [Executor](https://executor.sh)
needs to see each operation to hold it as a tool, and RPC over HTTP is one opaque endpoint.

**The workspace is never addressed.** It is not a path segment and not a body field; it comes
off the credential, so no caller can name a workspace it cannot read and no handler can forget
to scope a query. Everything a task owns nests under `/tasks/:taskId`, which is what lets a
run's task-bound token be checked once, in the access middleware, against the path.

**Two doors, one answer.** A browser sends a Better Auth session cookie; a machine sends a
signed, scoped, expiring bearer token. Both resolve to the same three facts — the actor every
write is attributed to, the scope the credential is good for, and the one workspace it can see.
Scopes are floors, not exact matches: `read` is every GET, `task-write` is ordinary work,
`admin` is the deletes. Tokens are signed rather than stored, so verifying one is arithmetic on
the request thread and there is no revocation short of rotating `BETTER_AUTH_SECRET` — which is
why they are short-lived and why a run's token is bound to its own task.

```bash
bun run gateway:start                                        # serve on GATEWAY_PORT (3100)
bun run gateway:token --scope admin --user me --ttl-days 30  # a bearer token, printed and nothing else
curl -H "Authorization: Bearer $TOKEN" localhost:3100/tasks/board
open http://localhost:3100/docs                              # Scalar, over the derived spec
```

`/openapi.json` and `/docs` carry no credential: the spec describes the door, it does not open
it, and publishing it is how a connector configures itself. `components.securitySchemes` names
the three bearer scopes and the session cookie, one scheme per scope, because OpenAPI has
nowhere else to put a scope on a bearer token.

**Run events stream as SSE over Postgres `NOTIFY`.** One `LISTEN atm_run_event` per process,
multicast to every open stream, so a hundred dashboard tabs cost one connection. A notification
carries ids and never a payload, so every wake-up runs the same cursor query — which makes a
duplicate notice free, a dropped notice recoverable, and replay from an arbitrary `afterSeq` the
same code path as the live tail. A slow tick runs beside the channel for the notification
delivered to nobody.

**Artifacts are metadata in Postgres and bytes on disk.** `list` is a query, `read` is a stream
straight off local disk, and every path is resolved against the task's own folder and refused —
twice, once before `realPath` and once after — unless it stays inside. Promotion copies into the
project's or the global folder, which are read-only mounts everywhere else.

**`atm.request`, one row per request, on every exit path.** Route *pattern* rather than path,
method, status, `durationMs`, workspace, actor kind and id, token scope, bytes out, whether it
held an event stream and for how long, outcome and `errorClass`. `traceId` comes off the
caller's `traceparent` when there is one. A refused credential is `outcome: "rejected"` on that
same row with the reason on it — never a 401 that vanished. Three metrics project the same row
through a bounded vocabulary: `atm_requests_total`, `atm_request_duration_ms`, and an
`atm_sse_connections` gauge.

```bash
bun run gateway:check   # own data root and port, seconds, no model calls
```

`gateway:check` starts the gateway as a child process, drives a whole task lifecycle over a real
socket — file a project, file a task, comment, walk it `ideas → backlog → in progress → review →
done`, list its runs, queue a run command, upload and read an artifact, stream a run's timeline,
then open a conversation belonging to no chat, say something into it, read it and its turns
back, force-send and archive it — then stops it with `SIGTERM` and audits the ledger it flushed: every request left exactly one
row, no row carries a path where a pattern belongs, and each of the four refusals left a row
saying why. Each call mints its own `traceparent`, which is what makes both halves of that
provable at once.

**The trace reaches the run, and both halves are checked.** A card filed into *in progress*
carries the asking request's `traceparent` on `task.dispatch_traceparent`; the loop adopts it
when it claims the card, so the `atm.run` row of the run that follows shares the trace of the
request that asked for it. `gateway:check` claims the stamp is written and cleared on the way
out of the column — so no later run joins a spent request — and `loop:check` claims the run row
carries it.

