# The pull request state on a card

A card with a `pr_url` draws what that pull request is doing — draft, open,
merged, closed — in GitHub's own icon and colour, in the column and on the open
card. This is where the state comes from, why it is refreshed the way it is, and
what that costs against GitHub's rate limits.

## The recommendation, and the arithmetic behind it

**Conditional REST with ETags.** Not batched GraphQL, and not webhooks yet.

The three candidates and what each is billed for:

| | requests per refresh round | what GitHub bills |
|---|---|---|
| conditional REST | one per live pull request | nothing for a `304`; one request for a `200` |
| batched GraphQL | one for the whole board | one point, every round, unconditionally |
| webhooks | none | nothing |

GitHub's REST documentation is explicit about the first row: *"Making a
conditional request does not count against your primary rate limit if a `304`
response is returned and the request was made while correctly authorized with an
`Authorization` header."*

### The budget

A user-authenticated token gets **5,000 REST requests per hour**, which is 83 a
minute. GraphQL gets **5,000 points per hour**; a query that fetches one pull
request per aliased `repository` field has a node count far under 100 and costs
the **minimum of 1 point** per call. The secondary limits that also apply are
100 concurrent requests and 900 points per minute per REST endpoint; a `GET` is
one point.

### The board this is sized for

Take the worst realistic case: **thirty cards with pull requests visible, all
still open**, and somebody watching the board continuously for an hour. The
refresh floor is two minutes, so that is 30 rounds an hour.

- **Conditional REST.** 30 pull requests × 30 rounds = **900 requests an hour**,
  15 a minute — comfortably inside both the 83/minute implied by the primary
  limit and the 900/minute secondary one. Of those 900, GitHub bills only the
  ones that came back `200`, which is one per pull request per actual change. A
  board where five pull requests change state in an hour is billed **5 requests
  out of 5,000**.
- **Batched GraphQL.** 30 rounds × 1 point = **30 points an hour**, but every
  one of them is billed whether anything changed or not.

Both are far inside the budget, so the rate limit is not what decides this. What
decides it is that the REST path's steady state is *zero* and GraphQL's is not,
plus four things that are not arithmetic:

1. **It composes with stopping.** Merged and closed are terminal, so a card
   leaves the loop permanently once its pull request lands. On a board where
   most cards are done, the live set is a handful and shrinking — the exact
   opposite of the growth curve batching is for. A batched query has to be
   rebuilt each round from whatever is still live anyway.
2. **It degrades per card.** One repository this credential cannot read is one
   card that keeps the plain icon. In a batch, a single unreadable node makes the
   whole response partial and every card in it suspect.
3. **It is one endpoint, already reachable.** `packages/sandbox` holds the
   credential and already talks to REST for `pullRequestForBranch`. GraphQL
   would add a second protocol, a second body shape and a second failure mode
   for an optimisation the numbers do not ask for.
4. **The two do not compose.** GraphQL has no conditional requests, so choosing
   it means giving up the free answer, which is the whole point.

### When to revisit

The crossover is when the number of pull requests that *actually change* per
round exceeds one — that is when GraphQL's flat point per round starts to beat
REST's per-change billing. At a two-minute floor that means more than 30 state
changes an hour on one board, which is a board doing several merges a minute.
Nothing near that exists. If it ever does, the shape to reach for is not
GraphQL: it is **webhooks**, which take the cost to zero and the latency to
seconds. They were left for later because they need a public endpoint, a shared
secret, per-repository setup and a story for missed deliveries — none of which
this board has today, and each of which is work that buys nothing until the
polling actually hurts.

## What is stored, and where

Three columns on `task`:

- `pr_state` — one of `draft`, `open`, `merged`, `closed`, or null.
- `pr_state_at` — when that state was recorded.
- `pr_etag` — GitHub's validator for the response it was read from. Storage
  rather than domain: `decodeTask` drops it, so it reaches nothing above
  `@workspace/db`.

A board renders from these with no network in the path, which is the point of
caching them at all.

### The row is written only when the state changes

This is the one decision worth arguing, because it is not what the shaping card
described. Every write to `task` carries an audit row in the same transaction —
that is the guarantee three kinds of writer sharing one database rest on. If the
refresh stamped `pr_state_at` on every check, ten open pull requests watched for
an eight-hour day would leave about 2,400 audit rows saying "checked, still
open", against a board whose real activity is perhaps a hundred. The log's whole
value is that it is not noise.

So the row records **transitions** — which are things that happened to the card
and belong in the log — and how recently GitHub was *asked* lives in the
gateway's memory (`apps/gateway/src/pr-state.ts`), alongside the newest ETag
seen. `pr_state_at` is therefore a **lower bound on freshness**, not the last
check, and it is used as exactly that: the floor a freshly restarted gateway
starts from, so a restart does not re-ask about every card on the board.

The ETag is kept in both places for the same reason. Editing a pull request's
title changes its ETag without changing its state, so the row's copy — written
with the last state change — can be older than the one in memory. The memory
copy is what makes the next request a `304`; the row's copy is what makes the
first request after a restart one.

## When a refresh happens

`apps/gateway/src/pr-state.ts` owns this, and every rule in it is about not
asking.

- **A board read is the trigger, and the only one.** `GET /tasks/board` and
  `GET /tasks/:id` queue whatever they just showed somebody. There is no timer:
  a card in a column nobody has open is never asked about, however stale.
- **Two minutes per card, at the very most.** The dashboard polls the board every
  ten seconds; without a floor that would be six lookups a minute per pull
  request.
- **Nothing after merged or closed.** Those are terminal, so the card leaves the
  loop for good.
- **Behind the request, never inside it.** `observe` offers to a bounded
  dropping queue and returns; a single fiber drains it four at a time. A board
  read never waits for GitHub, and a GitHub that is down costs a card its
  freshness and nothing else.

### The one thing this gets wrong on purpose

A closed pull request that somebody **reopens** keeps drawing red. Closed is
treated as terminal, so nothing asks again. The state corrects itself the moment
the card's `pr_url` is written — which is what the run that pushes more work to
the branch does — and the link on the card is right either way. Making `closed`
a long-TTL state rather than a terminal one is a one-line change in
`isTerminalPrState` if that turns out to matter.

## What is deliberately not shown

Review state (approved, changes requested) and CI checks (passing, failing,
pending) were both considered and left out of the first version.

Neither is on the pull request resource this reads. Review decision is a GraphQL
field or a second REST call to `/pulls/{n}/reviews`; checks are a third call to
`/commits/{sha}/check-runs`. So each one **doubles or triples the request count**
per card — and worse, neither is terminal: checks churn while a pull request is
open, so the "stop once it lands" rule that keeps this cheap would cover less of
the traffic. They also multiply the icon vocabulary at exactly the moment the
state icon is meant to be readable without a legend.

If one is added later, the cheap one is a **single checks dot** beside the state
icon — three colours, one extra conditional request on the head commit's status —
rather than a review-state icon, since "did it pass" is the thing that is asked
about a pull request that is already open.

## Where the pieces are

| | |
|---|---|
| `packages/domain/src/pull-request.ts` | the four states, `parsePrUrl`, and GitHub's three fields mapped to one of ours |
| `packages/sandbox/src/pr-state.ts` | the conditional request, and the three answers it can give |
| `packages/db/src/repositories/task-pr.ts` | the cache read and the guarded, change-only write |
| `apps/gateway/src/pr-state.ts` | when a refresh happens and when it does not |
| `apps/dashboard/src/components/pr-state.tsx` | the icon, in both places it appears |
| `packages/ui/src/styles/globals.css` | the four colours, taken from GitHub's Primer palette |

## The credential

The same one everything else uses: `ATM_GITHUB_TOKEN`, read by
`readGithubToken`. With none configured, or for a repository the token cannot
see, or for a `pr_url` that is not a GitHub pull request, the lookup answers
"unavailable" and the card draws the plain outline icon it drew before any of
this existed. Nothing here can fail a board read.
