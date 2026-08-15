# Event ledger (`bun run logs`)

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
```

Each view reads one marker (default `atm.run`) so counts stay about one kind of thing. For a
unit that writes both a `start` row and a terminus, the pair is collapsed to the terminus; a
start with no terminus is reported as `lost` rather than disappearing.

The PROJECT column is a run's `repo` (`owner/name`), falling back to its `projectId` when the
project has no repository; a marker carrying neither shows `-`. The views group by outcome and
nothing else, so any other question is one `jq` away over the same files — the gateway's 404s by
how far they got into the contract, for instance:

```bash
jq -r 'select(.event == "atm.request" and .route == "unmatched") | .pathShape' \
  .data/events/gateway.jsonl | sort | uniq -c | sort -rn
```

A missing `EVENT_LOG_DIR` prints an empty table / zeroed stats instead of crashing. Blank reads
as unset, matching `Config`, so the viewer and the sink always agree on the directory. No
running service required; it only reads files on disk.

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

