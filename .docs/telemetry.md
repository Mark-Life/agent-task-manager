# Telemetry: what is the record, and what reads it (`bun run logs`)

**The JSONL ledger is the system of record. Postgres `run` is the board's cache of it.** That is
already true in practice and this file is where it becomes a decision rather than an accident, so
that the next change to either one knows which of them it is allowed to lose.

Everything below is about one box running one factory. The numbers attributed to *the factory
host* were counted there and are not reproducible from this repository; everything else is
checkable from the code, and the position does not depend on the counts being current.

## The position

**1. The ledger is the record. The `run` row is a cache, and it is allowed to be behind.**
`withWideEvent` hangs the emit off `Effect.onExit`, so a clean finish, a typed failure, a defect
and an interrupt each write their row; the database write is ordinary work on the close-out path
and an interrupt is exactly the ending it may not survive. The drift is visible: 196 terminuses
in the ledger against 169 `run` rows on the factory host, 31 of them ledger-only, and 9 of the
12 interrupts among the 31. The two stores also do not spell the same endings —
`RUN_EVENT_OUTCOMES` adds `parked` and `skipped`, which `RUN_OUTCOMES` cannot say at all
(`packages/orchestrator/src/run-telemetry.ts:103`, `packages/domain/src/enums.ts:85`). A run
parked after exhausting its attempts is a ledger fact with no column to land in.

What follows from this: a question about what happened is answered from the ledger. The board
reads `run` because a card needs a spinner and a cost, not because the table is authoritative.
Backups protect `${EVENT_LOG_DIR}` as well as the database, and a rebuild of `run` from the
ledger is a legitimate repair — the reverse is not.

**2. A counter that only exists in memory is not a record.** There are 18 metric declarations
(17 through `boundedCounter` / `boundedHistogram`, plus the SSE gauge at
`apps/gateway/src/request-metrics.ts:198`). `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so
`otlpLayer` returns `Layer.empty` and nothing exports; there is no `/metrics` route; and
`Metric.snapshot` appears in five test files and nowhere else. Every one of them is a number
that exists until the process restarts and is then gone.

They are not all the same, and the inventory is the decision:

- **Twelve are a second projection of a row already on disk** — the seven in `run-telemetry.ts`,
  `atm_sandbox_runs_total`, and the two apiece in the gateway and the bot. Every tag they carry
  (`kind`, `outcome`, `provider`, `role`, `route`, `method`, `statusClass`) is a field on the
  matching event, and every histogram is a column on it. `select outcome, count(*) from events
  where event = 'atm.run' and phase = 'end' group by 1` *is* `atm_runs_total`, over data that
  survives a restart and can be grouped by the repo and the task id the metric was forbidden to
  carry. Delete them.
- **One has a durable source that is not the ledger.** `atm_run_commands_total` counts what the
  `run_command` table already records — the row carries the kind, the result and the rejection
  reason. Delete it; the query goes to Postgres.
- **Four have no durable record anywhere.** The quota gate's counters
  (`packages/orchestrator/src/quota/metrics.ts`) are the only trace that a pause was set, that a
  usage read produced nothing, that the drain matcher could not form an opinion, and how full a
  window was. `loop.jsonl` carries `atm.run` and `atm.sandbox` and nothing else, so "was the
  factory idle overnight, or quota-paused overnight" is a question the disk cannot answer. These
  are the ones that must become events before they are deleted: a wide event per pause episode
  and per read, with the provider, the window and the utilization as fields.
- **One is not a count and cannot become a field.** `atm_sse_connections` is a level — how many
  streams are open right now — and a leak is a number that stops coming back down. It also does
  not work today, because nothing reads it. `atm.request` writes only `phase: "end"`
  (`apps/gateway/src/request-event.ts:486`), so a stream that is still open has no row at all.
  Give a stream a `phase: "start"` row and the level becomes the same start-without-terminus
  query the loop already uses for a lost run; then the gauge goes too.

**3. Spans stay. What is behind a flag is export, and it already is.** This reverses the obvious
reading of "172 spans computed on every run and read by nobody", and the reason is that they are
read — as the join key, by everything.

`audit_entry.trace_id` is not passed in by a caller. It is `Effect.currentSpan`, read at the
mutation (`packages/db/src/repositories/audit.ts:409`), and `currentTraceIds` on the wide event
is the same read. Effect's default tracer mints real ids with no exporter configured and no
tracing layer present — `Effect.withSpan("probe")` under a bare `Effect.runPromise` yields a
32-hex `traceId` and a 16-hex `spanId`. So the correlation that
already works, on all 13,558 audit rows on the factory host and on the 73 trace ids shared
between `gateway.jsonl` and `loop.jsonl`, is manufactured by exactly the spans that look like
waste. Stop opening them and `trace_id` goes null on every audit row and every event, the join
in `bun run logs sql` returns nothing, and the only way back is to mint and thread a correlation
id by hand — which is the same span with worse ergonomics.

The cost was measured rather than assumed, in this repository's container (arm64, bun 1.3.14,
200k iterations): a span with no exporter costs ~6.9µs, ~8.3µs annotated; a bounded counter
increment ~4.1µs. At 172 spans that is ~1.2ms per run, against runs that last minutes. **Neither
the spans nor the metrics are a cost worth reclaiming.** The metrics go because a number that
dies at restart is not a record and a second projection is a second thing to keep true, not
because of CPU.

Span *export* stays gated on `OTEL_EXPORTER_OTLP_ENDPOINT`, which builds no HTTP client when
unset. If a future flag turns span *creation* off, it has to be one switch with the ledger's
`traceId` and `audit_entry.trace_id` behind it, and turning it on has to be the documented
precondition for the join.

**4. The half that was missing is reading.** See below.

## Reading it

Every unit of work (agent turn, container run, HTTP request, ...) emits one wide JSON line to
`${EVENT_LOG_DIR}/<service>.jsonl` — one file per service (`loop.jsonl`, `gateway.jsonl`), with
the `event` field naming the unit inside it. Read it with:

```bash
bun run logs                  # same as: bun run logs runs atm.run
bun run logs runs             # one row per unit, newest last
bun run logs errors           # every non-done outcome, with class + message
bun run logs stats            # counts per outcome, total cost, total wall time
bun run logs follow           # poll-tails all ledger files, prints new rows as they land
bun run logs stats atm.turn   # any view takes a marker; `all` reads every atm.* marker
bun run logs sql "<query>"    # everything else, including the join to the database
```

The first five read one marker (default `atm.run`) so counts stay about one kind of thing. For a
unit that writes both a `start` row and a terminus, the pair is collapsed to the terminus; a
start with no terminus is reported as `lost` rather than disappearing.

The PROJECT column is a run's `repo` (`owner/name`), falling back to its `projectId` when the
project has no repository; a marker carrying neither shows `-`.

A missing `EVENT_LOG_DIR` prints an empty table / zeroed stats instead of crashing. Blank reads
as unset, matching `Config`, so the viewer and the sink always agree on the directory. No
running service required; it only reads files on disk.

### `sql`

Loads every `atm.*` row into a scratch in-memory SQLite database and runs one query against it.
It takes a query rather than a marker; with no query it prints the schema and a set of examples,
and it reads the query from a pipe when one is there.

```bash
bun run logs sql                                   # the columns your ledger actually has
bun run logs sql "select ..." --json               # one JSON object per row, for jq
bun run logs sql < question.sql
```

- **`events`** is every row from every file. Its columns are the union of the keys on disk, not a
  list in the source, so a field added to a wide event is queryable the next time one is written.
  `service` is added by the loader from the filename. A marker's own fields are null on rows from
  other markers, and a column no row has ever carried does not exist — `no such column` there
  means nothing has written it yet.
- **`audit_entry`**, **`run`** and **`task`** are copied out of Postgres, and only when the query
  names one. `DATABASE_URL` supplies the connection. `run_event` is deliberately not offered: it
  is hundreds of rows per run and copying it whole to ask about one run costs more than the
  answer is worth.
- Each table keeps its own store's column names, so the join reads
  `on a.trace_id = e.traceId`. `run.cost_usd` arrives as text, as it is stored — `sum(cast(
  cost_usd as real))` to add it up.
- Your SQL never reaches Postgres. What goes there is `select * from <table>` for a table on the
  allow-list, chosen by matching the query text against that list; everything you type runs
  against the local copy, which is gone when the process exits.

The join that motivated the view — what one run changed, over the trace id both stores already
carry:

```sql
select e.ts, e.outcome, a.action, a.entity_type, a.from_status, a.to_status
from events e join audit_entry a on a.trace_id = e.traceId
where e.event = 'atm.run' and e.phase = 'end' order by e.ts;
```

The ledger against its cache, which is the drift in decision 1 as a number you can re-run:

```sql
select (select count(*) from events where event = 'atm.run' and phase = 'end') as ledger,
       (select count(*) from run where outcome is not null) as db;
```

Anything the view will not do is still one `jq` away over the same files.

## What is on disk, and what is only counted

Each file is capped at 64 MiB and rotated to `<service>.1.jsonl`, one generation kept.

`atm.request` is the one marker that is **sampled**, because its volume follows a dashboard
being open rather than work being done: the two board reads were 69.7% of the ledger before
this landed. Every failure, every event stream and every request above its own route's p99 is
stored; the rest is stored one in twenty. Each stored row carries `sampleRate` — the number of
requests it stands for — so a count over the marker is a count of the sample until it is
multiplied by that. `stats` already does, printing the stored count and the estimate beside it;
a `jq` of your own has to:

```bash
# requests answered, reconstructed from the sample
jq -s 'map(select(.event == "atm.request") | .sampleRate // 1) | add' \
  .data/events/gateway.jsonl
```

The exact figure is on the metric rather than in the file: `atm_requests_total` and
`atm_request_duration_ms` are updated above the predicate and describe every request.
`GATEWAY_SAMPLE_ONE_IN=1` stores every row instead — the tail and failure rules only ever add,
so nothing else changes. Every other marker is unsampled: a run, a turn, a sandbox and a chat
are units of work a person asked for, and each is worth a row.

## What this leaves open

- The four quota events, the `run_command` query and the SSE start row are the work decision 2
  names, and none of it has been done. Deleting the twelve derived metrics before their
  replacements exist is safe — the rows are already on disk — but the four quota counters are
  the only record of a pause and must be replaced before they are removed.
- Retention beyond one rotation. The ledger is now the store you are not allowed to lose, and
  nothing copies it anywhere; the rotated generation is dropped when the next one fills.
  `.docs/disk.md` covers the volume; the archive policy is unwritten.
- Sampling beyond `atm.request`. Every other marker is kept whole, deliberately. The trigger to
  revisit is a ten-fold rise in rows per day, not a size on disk.
