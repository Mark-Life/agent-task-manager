# Pointing Executor at this API

Executor turns an OpenAPI document into code-as-tools: one callable per
operation, reachable from its TypeScript sandbox as
`tools.<integration>.<owner>.<connection>.<...>`. That is why this system's
public surface is HttpApi rather than RPC — every operation the backend has
becomes an agent tool with no second integration to build and keep in step.

This is the operator's procedure. Steps 1 and 2 have been run against the real
spec; step 3 onward has not, and the reasons are at the bottom.

## Before you start

**The spec must be reachable from the internet.** Executor fetches it from its
own side; a URL on localhost or behind a VPN gets you nothing. After the deploy
in `deploy/README.md` that URL is `https://<ATM_DOMAIN>/openapi.json`.

**Check what it advertises as its own address.** The gateway stamps
`GATEWAY_PUBLIC_URL` into `servers[0].url`, and that is where Executor sends
every call unless `baseUrl` overrides it:

```sh
curl -s https://<ATM_DOMAIN>/openapi.json | jq '.servers'
```

**Mint the token before the connector, not after.** The scope decides what the
whole connector can do, and it is fixed at mint time — Executor holds one
credential per connection and applies it to every operation.

## 1. Preview the document

Have Executor read the spec before it commits to it. Nothing is saved.

```ts
await tools.executor.openapi.previewSpec({ spec: "https://<ATM_DOMAIN>/openapi.json" });
```

Run against the document this gateway actually served — fetched from
`/openapi.json` on a local run, then put on a temporary public URL because
Executor reads specs from its own network — that returned:

```json
{
  "title": "Agent Task Manager",
  "version": "0.0.1",
  "servers": [{ "url": "http://localhost:3199", "description": "This gateway" }],
  "operationCount": 32,
  "tags": ["artifacts", "health", "messages", "projects", "runCommands", "runs", "sessions", "tasks"],
  "securitySchemes": [
    { "name": "readToken", "type": "http", "scheme": "Bearer", "bearerFormat": "opaque" },
    { "name": "sessionCookie", "type": "apiKey", "in": "cookie", "headerName": "better-auth.session_token" },
    { "name": "taskWriteToken", "type": "http", "scheme": "Bearer", "bearerFormat": "opaque" },
    { "name": "adminToken", "type": "http", "scheme": "Bearer", "bearerFormat": "opaque" }
  ],
  "authStrategies": [
    { "schemes": ["readToken"] }, { "schemes": ["sessionCookie"] },
    { "schemes": ["taskWriteToken"] }, { "schemes": ["adminToken"] }
  ]
}
```

Descriptions elided; the `servers` entry is a local run's. All 32 operations and
all four schemes survive the trip, which is the thing worth confirming: the three
bearer scopes exist in the spec precisely so a scope is legible to a consumer
that only ever sees the document, and here is a consumer reading them.

Executor offers each scheme as its own auth strategy. They are all the same
`Authorization: Bearer` header, so the choice is cosmetic on its side — what
actually decides the connector's reach is which token you paste.

## 2. Which scope, and why not admin

| Connector's job | Scope | What it costs you if the agent is confused |
| --- | --- | --- |
| Read the board, summarise, report | `read` | Nothing. Every mutation 403s. |
| File tasks, post messages, steer runs, clear cards off the board | `task-write` | A wrong task edited — in the audit log, reversible. Or a wrong task *deleted*, with every message, session and run under it: audited, and not reversible. |
| Delete projects | `admin` | A project, and the workspace's own furniture. |

**Read it twice before you hand out `task-write`.** Erasing a task lives under
that scope, not under admin, because the manager agent clears cards off a board
when the person it answers to asks it to — the alternative was minting it a
credential that could delete projects as well. A connector token sits in a vault,
is spent by a model, and is reachable by anyone who can prompt that model, so
what `task-write` now costs at the worst is a card and its whole history. Use
`read` for a connector that only reports; that is one word of configuration and
an entire class of incident that stops being possible.

The gateway still holds a line the operator does not have to remember. A token
carries the actor it speaks as, and every actor kind has a ceiling
(`packages/token/src/tokens.ts`): a connector speaks as `manager`, whose ceiling
is `task-write`, so an admin token for it cannot be minted — the mint refuses,
and a forged one is refused again on verify. Only a `human` actor reaches admin.
Below that ceiling, who may erase a task is asked again of the actor rather than
the scope: a *worker run's* token is `task-write` too, bound to the one task it
was dispatched for, and it is refused with `IllegalDeletion`.

Use `read` for anything that only reports. One word of configuration, and an
entire class of incident stops being possible.

**Minting is the open step.** Tokens are HMAC-signed claims — actor, scope,
workspace, expiry — over a key derived from `BETTER_AUTH_SECRET`, verified
without a database round trip and not revocable before `exp`, which is why they
are short-lived. `TokenSigner.mint` is the only way to make one, and nothing
calls it yet: there is no endpoint and no CLI. Somebody owns writing that before
step 4 can happen. Keep the TTL to hours, not months, and re-mint.

## 3. Add the integration

```ts
await tools.executor.openapi.addSpec({
  spec: { kind: "url", url: "https://<ATM_DOMAIN>/openapi.json" },
  slug: "atm",
  name: "Agent Task Manager",
  baseUrl: "https://<ATM_DOMAIN>",
  healthCheck: { operation: "health.check" },
});
```

`baseUrl` is passed explicitly rather than inherited from `servers[0]`: a
gateway whose `GATEWAY_PUBLIC_URL` was wrong at boot would otherwise hand every
future tool call a bad host, and a saved connector is a bad place to discover
that. `authenticationTemplate` is omitted so the auth methods are derived from
the four schemes above. `health.check` is the one operation with no credential,
which makes it the honest probe: it answers whether the host is up without
saying anything about whether the token is good.

## 4. Attach the token

Do not paste the token into a chat or into `execute` code. Get a browser handoff
and type it into the Executor UI:

```ts
await tools.executor.coreTools.connections.createHandoff({
  integration: "atm",
  owner: "org",
  label: "ATM task-write",
});
```

Pick the `taskWriteToken` strategy in that form and paste the token there. Then
confirm the connection exists and what its address is — that address is the
prefix of every tool call:

```ts
await tools.executor.coreTools.connections.list({});
```

Optional guardrail, worth the one line if the connector is autonomous:

```ts
await tools.executor.coreTools.policies.create({
  owner: "org",
  pattern: "atm.*.projects.delete",
  action: "block",
});
```

## 5. Smoke test

Discover the tool path, do not guess it. Our operation ids are dotted
(`projects.list`, `tasks.create`) and how Executor renders those into a path is
its business, not ours:

```ts
const { items } = await tools.search({ namespace: "atm", query: "list projects" });
const path = items[0]?.path;
const detail = await tools.describe.tool({ path });   // input/output shapes
const result = await tools[path]({});
if (!result.ok) return result.error;                  // { code, message, status }
return { status: result.http?.status, projects: result.data };
```

Three answers and what each means. A list of projects: the connector works, end
to end. `401`: the token did not verify — wrong secret, malformed, or expired,
and tokens here expire quickly by design. `403`: it verified and its scope is
below what the operation asked, so it was minted at `read` and you called a
write.

Then one write, because reads passing proves less than people think:

```ts
const created = await tools["<atm write path>"]({ title: "connector smoke test", kind: "chore" });
```

The workspace is deliberately absent from every request. It comes off the
credential, so a token cannot name a workspace it cannot read, and the same tool
call means different rows for different connections.

## What will not work

**The SSE stream.** `GET /tasks/{taskId}/runs/{runId}/events/stream` responds
`text/event-stream`, marked in the document with `x-effect-stream: { encoding:
"sse" }`. Nothing in OpenAPI tells a generic consumer to hold that connection
open, and Executor's sandbox forbids `fetch` outright — every call goes through
`tools.*`, which is request/response. Expect a call that returns whatever
happened to be buffered, or an error, and treat live streaming as a deliberate
integration if it is ever wanted. **Poll instead**:
`GET /tasks/{taskId}/runs/{runId}/events?afterSeq=&limit=` returns
`{ events, nextSeq }` — carry `nextSeq` into the next call and you have the same
information a few seconds later, which for an agent is the same information.

**Artifact bytes.** `GET …/artifacts/{artifactId}/content` streams raw
`Uint8Array`. Whether Executor materialises that as a `ToolFile` or as an opaque
blob is untested. List artifacts to see what a run produced; do not build on
reading their contents through this path until somebody has.

**Artifact upload.** `POST /tasks/{taskId}/artifacts` is `multipart/form-data`.
Untested through Executor's HTTP layer.

**The session cookie.** `sessionCookie` is the dashboard's credential and appears
in the spec beside every bearer scheme. It is not for Executor; ignore the
strategy.

**Promotion.** `POST …/artifacts/{artifactId}/promote` is in the contract and
its handler cannot finish the job — nothing in `packages/db` creates the
project- or global-scoped destination row. It will not do what its description
promises until that lands.

## Verified, and not

**Verified**, against the running gateway and this Executor account:

- The gateway serves the derived document at `/openapi.json` and it is valid
  OpenAPI 3.1 — `redocly lint --extends=minimal`: *Your API description is
  valid*, two style warnings, no structural error.
- `previewSpec` ingested that exact document and reported 32 operations, 8 tags
  and all four security schemes, as pasted in step 1.
- Executor's own contract for the rest: `addSpec`, `connections.createHandoff`,
  `policies.create` and the `tools.search` / `tools.describe.tool` discovery flow
  are quoted from their live tool descriptions, not from memory.

**Not verified**, and not dressed up as such: **no connector was registered and
no tool call was made against this API.** `addSpec` writes an integration into
the operator's Executor catalog, and the connection behind it needs a credential
only the operator can enter, so steps 3 through 5 are written and unrun. Two
things would have blocked them anyway — the gateway was on localhost while
Executor fetches specs from its own network, and there is still no way to mint a
token (step 2). Run step 5 the day a mint path lands: it is the exit criterion
for this phase, not a formality.
