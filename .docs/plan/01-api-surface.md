# Addendum — API surface on Effect v4

Verified against the v4 source checkout (`Effect-TS/effect-smol`) and the installed
beta types. Resolves the open item in `00-high-level.md`.

## Decision

**`HttpApi` is the single public surface. Not Effect RPC.**

This deviates from `.docs/stack.md` ("if using Effect: Effect RPC"). The deviation is
specific to this project's Executor requirement, below.

## Why

**OpenAPI derivation exists only for HttpApi.** `OpenApi.fromApi` emits an OpenAPI 3.1
spec from an `HttpApi`; `HttpApiBuilder` can mount it as a route, plus Scalar/Swagger docs.
The v4 RPC module has no coupling to OpenAPI at all — no derivation, no `RpcGroup → HttpApi`
converter.

**RPC's HTTP transport is one POST for the whole group**, carrying a batched envelope. An
OpenAPI spec describing that is a single opaque endpoint — useless to Executor, which needs
to see each operation to expose it as a tool. This is the decisive point: the whole reason
for the OpenAPI surface is that everything the backend can do becomes available to agents.

**SSE is native to HttpApi and absent from RPC.** HttpApi has a first-class streaming
success schema with a typed event channel *and* a typed error channel; the server handler
returns a stream, the typed client decodes it back into a stream. RPC streams over chunked
NDJSON or msgpack, never `text/event-stream`. Run-event streaming to the dashboard is a
requirement, so this settles it independently of OpenAPI.

**The typed-client argument for RPC has evaporated.** v4 ships an Atom integration for
HttpApi with query/mutation atoms — parity with the RPC equivalent. Nothing is lost on the
SPA side.

RPC keeps an edge on bidirectional websocket / worker / stdio transports. If an internal
high-frequency channel is ever wanted, an RPC server mounts on the *same* router alongside
HttpApi. They compose; they just don't share a spec.

## Consequences for this repo

**Track ≥ beta.81, not beta.78.** HTTP API streaming responses landed in `4.0.0-beta.81`;
`telegram-claude` pins beta.78, which has `OpenApi.fromApi` but no SSE schema. Copying its
`package.json` versions would silently cost the streaming surface. v4 requires matching
versions across all Effect packages — bump them together.

**v4 collapses `@effect/platform` and `@effect/rpc` into the core `effect` package** under
`effect/unstable/*`. `@effect/platform-bun` stays separate. Anything ported from
`telegram-claude` or written from v3 examples needs its imports rewritten.

**v3-era Effect knowledge is actively wrong in places.** `Effect.Service` does not exist in
v4 (it's `Context.Service`, with type arguments before the call). `HttpApiBuilder.serve`,
`.toWebHandler`, `.middleware*` are all removed — serving goes through the router. Endpoint
definitions lost their fluent builders. Several schema classes were renamed. Budget for
this: it is the main friction in phase 4. The `effect` skill bundled with the template
covers schema, services, streams, config, HTTP *clients*, caching, scheduling and testing —
there is no server-side HttpApi or RPC reference to lean on. Writing one is worth a task of
its own.

**Executor needs its own SSE handling.** The spec marks streaming media types with an
Effect vendor extension. A generic OpenAPI consumer sees `text/event-stream` and the event
schema, but nothing tells it to hold the connection open. Plan for run-event streaming to
external agents to be a deliberate integration, not a free consequence of the spec.

**Auth flows into the spec.** HttpApi's bearer/API-key security schemes are emitted into
`components.securitySchemes`, which is how scoped tokens reach Executor and any other
external consumer.

## Not chosen, kept in mind

`@effect/openapi-generator` goes the other direction — Effect schemas and clients generated
*from* a spec. Useful if typed Effect code is ever wanted on the consumer side of a
third-party API.
