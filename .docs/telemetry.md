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

A missing `EVENT_LOG_DIR` prints an empty table / zeroed stats instead of crashing. Blank reads
as unset, matching `Config`, so the viewer and the sink always agree on the directory. No
running service required; it only reads files on disk.

