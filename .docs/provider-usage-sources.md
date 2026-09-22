# Where the usage numbers come from

The quota gate polls two undocumented account endpoints with credentials out of the agent home:
`GET https://api.anthropic.com/api/oauth/usage` (`quota/claude-usage.ts`) and
`GET https://chatgpt.com/backend-api/wham/usage` (`quota/codex-usage.ts`), once per
`ORCHESTRATOR_QUOTA_POLL_INTERVAL_MS` (5m) per provider. They are passive GETs that generate
nothing, but they are authenticated and against the account, and that is the exposure worth
removing.

The alternative is a reading carried out of a run we already paid for. This is what each provider
actually emits today, checked against the pinned versions, and what replacing the polls with it
would and would not buy.

## What was checked

| | pinned | how it was checked |
| --- | --- | --- |
| Claude | `@anthropic-ai/claude-agent-sdk` **0.3.280** | `sdk.d.ts` in the installed package |
| Codex | `@openai/codex` / `@openai/codex-sdk` **0.146.0** | `codex exec --help`, `codex --version`, the SDK's `index.d.ts`, and the serde field tables in the vendored `codex` binary |

Both are the catalog pins in the root `package.json`, which is what the image builds and what the
harnesses run.

## Claude carries a real reading, and we throw most of it away

The SDK emits `rate_limit_event` whenever the subscription reading changes.
`SDKRateLimitInfo` (sdk.d.ts:5423) carries:

- `status`: `allowed` | `allowed_warning` | `rejected`
- `utilization`: percent of the window used, 0–100
- `resetsAt`: unix seconds
- `rateLimitType`: `five_hour` | `seven_day` | `seven_day_opus` | `seven_day_sonnet` |
  `seven_day_overage_included` | `overage`
- plus overage fields: `overageStatus`, `overageResetsAt`, `isUsingOverage`,
  `overageDisabledReason`, `surpassedThreshold`

`packages/harness/src/claude-events.ts:316` already normalizes the first four onto the usage event
as `rateLimitPct`, `rateLimitResetsAtMs`, `rateLimitStatus`, `rateLimitType`. They survive the whole
way to the `atm.turn` row — `turn-event.ts` folds them into `rateLimitPeakPct`, `rateLimitStatus`,
`rateLimitType`, and `turn-rollup.ts` aggregates them per run.

So this is a per-window percentage *and* its reset, arriving free with traffic we already paid for,
already persisted. It is the same figure the OAuth poll returns.

**Two things are being discarded.**

1. **The gate consumes only the boolean.** `detectRateLimitStatus` in `quota/detect.ts` answers
   true on `rejected` and ignores `rateLimitPct` and `rateLimitResetsAtMs` entirely.

2. **Even the boolean never arrives.** `QuotaGate.noteRateLimit` exists, is documented as the path
   Claude's reading takes, and is called from nowhere but `gate.test.ts`. The run lifecycle calls
   `gate.noteError` with the failure text (`runtime.ts:604`) and nothing else. Claude's error text
   is *not* offered to the prose matcher either — `detectText` is null for Claude by design
   (`gate.ts`), on the stated grounds that the structured field covers it.

   Net effect today: **Claude has no reactive floor at all.** A drained Claude run neither pauses
   the provider nor counts a canary. The proactive OAuth poll is the only thing gating Claude, which
   is the opposite of the layering the gate's own header describes.

   This is a bug independent of anything below, and it is the cheapest thing on this page to fix.

The SDK also exposes `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`
(sdk.d.ts:2901), returning `SDKControlGetUsageResponse` with `rate_limits.five_hour`,
`.seven_day`, `.seven_day_opus`, `.seven_day_sonnet`, `.model_scoped[]` and `.extra_usage`, each
`{ utilization, resets_at }`, plus `rate_limits_available` and `subscription_type`. That is the
whole OAuth body, through the SDK, without us holding the token or the beta header. It is named to
be relied on by nobody and it requires a live query, so it is not a poll replacement — but it is
what a `quota:check` could use instead of a hand-rolled request.

## Codex carries nothing on the path we read

`codex exec --json` is the only JSON surface the harness uses (`JSON_FLAG` in
`packages/harness/src/codex.ts`), and in 0.146.0 `codex exec --help` lists exactly one output flag:
`--json`. There is no `--experimental-json`.

The event set on that stream is fixed and short. From the binary's own tag table, and matching
`codex-sdk`'s `ThreadEvent` union exactly:

```
thread.started · turn.started · turn.completed · turn.failed
item.started · item.updated · item.completed · error
```

`TurnCompletedEvent` carries `usage: { input_tokens, cached_input_tokens, cache_write_input_tokens,
output_tokens, reasoning_output_tokens }` and nothing else. **No rate-limit object reaches
`codex exec --json`.** `packages/harness/src/codex-events.ts:446` nulling the four rate-limit fields
is correct, not an oversight.

The reading does exist in the binary, on a protocol we do not speak. The serde tables carry:

```
RateLimitWindow  { used_percent, window_minutes, resets_at }
   used_percent   "Percentage (0-100) of the window that has been consumed."
   window_minutes "Rolling window duration, in minutes."
   resets_at      "Unix timestamp (seconds since epoch) when the window resets."

RateLimitSnapshot { limit_id, limit_name, primary, secondary, credits,
                    individual_limit, spend_control_reached, rate_limit_reached_type, plan_type }

TokenCountEvent  { info, rate_limits }
```

`token_count` is an `EventMsg` variant — the legacy/core protocol behind `codex app-server`,
`codex mcp-server` and `codex proto`. It is not in the `exec` tag table. So a `codex exec` run
cannot be made to report its windows by parsing harder; it would take moving the harness onto the
app-server protocol, which is a different transport, a different lifecycle and an
`[experimental]`-flagged surface in this release.

Worth noting: the binary contains `/wham/usage` and `/api/codex/usage` itself. The endpoint the
orchestrator polls is the endpoint the CLI polls. Nothing about that read is more exotic than what
the vendored binary already does with the same token.

## Recommendation

**Do the free thing first, and it is not the source change.**

1. **Wire `noteRateLimit`.** Claude's `rate_limit_event` reading already lands on the turn row. The
   fold that reads it back on the host is `ingestTurnLedger` in `run.ts:891`, and its `TurnRollup`
   carries `rateLimitStatus`, `rateLimitPeakPct` and `rateLimitType` — but the rollup is consumed
   there for economics and does not reach `onClose`, which is where `runtime.ts` calls `noteQuota`.
   So the change is: add the rollup (or just its rate-limit fields) to the `onClose` payload, and
   have `noteQuota` offer `rateLimitStatus` to `gate.noteRateLimit` alongside the error text it
   already offers to `noteError`.

   This closes a hole that exists today whatever happens to the polls. Do it whether or not
   anything below is done. It touches the run close contract, so it is its own change and not a
   rider on a panel one.

2. **Feed the gate Claude's run-carried percentage, alongside the poll.** `rateLimitPct` +
   `rateLimitResetsAtMs` + `rateLimitType` is enough to build a `ProviderUsage` — `five_hour` maps
   to `primary`, the `seven_day*` family to `secondary`, on the same "worst weekly window" rule
   `claude-usage.ts` already applies. Treat it as a reading like any other: it advances the last
   good reading and the panel stale-dates it exactly as it does a polled one. The machinery for
   that landed with this change; what is missing is the reading arriving.

3. **Then, and only then, consider dropping the Claude poll.** With (2) in place the poll becomes
   redundant *while Claude is running*, which is the point and also the whole cost: a run-derived
   reading refreshes only when that provider runs. An idle board learns nothing. Concretely, what
   is lost by dropping it:

   - **Freshness on an idle board.** The panel would show `read 3d ago` on a quiet weekend rather
     than a current figure. This is now an honest state rather than a blank one — that is what the
     stale-dating in this change is for — but it is still less than the poll gives.
   - **A drain that lifts while nothing runs.** The proactive read is the only thing that knows the
     exact reset and resumes a still-drained provider precisely (see the cooldown note in
     `quota/gate.ts`). Without it a provider comes back on the reactive ladder's schedule.
   - **Pre-flight gating on a cold start.** The first run after a restart would dispatch with no
     reading at all, i.e. fail open, until it produces one.

   A middle setting is available and is probably the right one: keep the poll, drop its cadence
   hard (hourly rather than every five minutes), and let run-carried readings do the refreshing in
   between. That cuts the account-facing request rate by ~12× without losing the idle-board answer.

4. **Codex: no source change is available in 0.146.0.** The recommendation is to leave the
   `wham/usage` poll as the only proactive source for Codex, and to keep the error-text matcher in
   `quota/detect.ts` as its reactive floor, until either the exec JSON stream grows a rate-limit
   event or the harness moves to the app-server protocol for other reasons. Re-check on each CLI
   bump: the field names to grep the binary for are `rate_limits` and `used_percent`, and the
   question is whether they appear in the `exec` tag table alongside `turn.completed`.

## Re-running this audit

```
# Claude: the event and the /usage control response
grep -n "SDKRateLimitInfo\|SDKControlGetUsageResponse" -A 25 \
  node_modules/.bun/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts

# Codex: the exec stream's whole event set
node_modules/.bun/node_modules/@openai/codex-sdk/dist/index.d.ts   # ThreadEvent union
"$(bun pm ls --all | grep -o '[^ ]*@openai/codex/vendor[^ ]*bin/codex')" exec --help
```

For the binary's field tables, search the executable for `used_percent` and read the surrounding
bytes; Rust's serde puts each struct's field names adjacent to `struct X with N elements`, so the
shape reads off directly.
