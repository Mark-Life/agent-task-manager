# System review — 2026-08-09

## 1. Verdict

The machine works. Six days, 169 runs, 37 merged PRs, $632.69 of model spend, zero orphan
containers, zero dangling images, and a wide-event ledger that survives interrupts the database
misses. Nothing here is a rescue job. What is wrong is that the system does not learn, does not
back itself up, and does not tell you what it did.

Three things matter, in this order.

**There is no backup of anything.** 84 tasks, 169 runs, 21,788 run events and 13,558 audit rows
exist only inside one 89.62MB docker volume. No `pg_dump` in the repo, no crontab
(`crontab -l` → "no crontab for agent"), one systemd user timer on the box and it is
`launchpadlib-cache-clean.timer`. A live dump measures 3,141,141 bytes — 3.1 MB. This is a
half-hour of work standing between you and losing the entire board with no recovery path.
`.docs/plan/02-build-plan.md:540` already specifies it as Phase 9 item 5; it was never built.

**Disk is the real deadline.** `df -h /` → 75G total, 55G used, 17G free, 77%. ATM accounts for
~20.9GB of that after six days: `.data` 9.8G plus docker 11.1GB. Nothing in the system deletes
anything except the JSONL ledger. At the observed rebuild cadence (two image rounds in six days,
~3.8GB each in images plus build cache) you have roughly 11 days. At the Aug 3-6 write rate you
had under four. The immediate, safe reclaim is ~5.7GB and takes two commands.

**The agents keep re-learning the same facts and you keep retyping the same instructions.** Across
184 transcripts: `python3: command not found` in 52 of 184 runs, 73 of 73 worker runs shell `ls`/
`find` to learn a layout they have learned 72 times before, 25 of 73 never commit at all and the
median first commit lands at 0.863 of the run's span. On your side, "research first, don't build
yet" appears in at least 7 distinct task comment threads and again in chat, and nothing in
`packages/prompts`, the `task` row or the `tasks_create` schema knows the word research exists.
Section 4 is the heart of this document and this is what it is about.

Everything else — observability gaps, prompt gaps, the forked migration chain — is real but
secondary. The single highest-leverage structural change is giving repeated corrections a durable
home, which is what PR #43 is already half of.

---

## 2. Observability

### Health

The wide-event design is the strongest piece of engineering in the repo and it is working.
16,519 rows across four markers, every unit emits exactly once on every exit path, fields are
bounded and sanitized, degraded outcomes carry nulls rather than fake zeros, and the loop's
`onExit` row survives interrupts that the database write misses — 9 of 12 interrupted runs have a
ledger terminus and no `run` row. `bun run logs` already ships four views over it.

Ledger on disk: `gateway.jsonl` 15,670 rows / 12,099,608 B, `loop.jsonl` 566 / 601,383 B,
`bot.jsonl` 281 / 204,822 B. Rotation is the one bounded thing on disk:
`packages/telemetry/src/event-log.ts:16` caps at 67,108,864 B keeping one generation.

Correlation works better than the audit suggested. `audit_entry.trace_id` is populated on all
13,558 rows in the same 32-hex format, a sample of 400 recent gateway traceIds matched 25 audit
rows, and 73 traceIds are shared between `gateway.jsonl` and `loop.jsonl`. The join exists. What
is missing is a reader.

### The three things that break it

**`atm.turn` never reaches the ledger.** It is the only place model, tool counts, tool errors,
subagents and rate-limit headroom exist, and it lands in 184 per-run files under
`.data/runs/<runId>/events/turn.jsonl` because `packages/harness/scripts/turn.ts:56` points
`EVENT_LOG_DIR` at the run mount. `bun run logs stats atm.turn` prints `atm.turn 0` while
`.docs/telemetry.md:13` documents that exact command as a working example, and
`scripts/logs.ts:27` only reads `${DATA_ROOT}/events`. Fix: copy the rows into the service ledger
after ingest (`packages/orchestrator/src/ingest.ts:180` already reads them) or glob
`.data/runs/*/events/*.jsonl` in the reader.

**`foldTurnRows` computes 19 fields and 4 reach the run row.** `runEconomicsOf`
(`packages/orchestrator/src/turn-rollup.ts:275-280`) uses costUsd, durationMs, totalTokens and
turns because `RunTerminusBase` (`packages/orchestrator/src/dispatch-context.ts:225-234`) carries
nothing else. So `atm.run` has no `toolCalls`, no `toolErrors`, no `subagents`, no
`rateLimitStatus`. Two corrections to how this was first written up: `model` is *not* missing —
the Postgres `run` row carries it on 168 of 169 rows, written from a streamed event at
`packages/orchestrator/src/run.ts:438`; only the wide event lacks it. And `oomKilled` /
`peakMemoryBytes` are already captured and emitted on `atm.sandbox`
(`packages/sandbox/src/sandbox-event.ts:292-294`). This is a copy or a join, not new capture,
which makes it cheaper than it looks.

That matters because five runs report outcome `done` while the kernel OOM-killed their container
(joining `loop.jsonl` on runId: `run=done sandbox=oom_killed` 5, `errored` 3, `timeout` 1).
`bun run logs stats atm.run` shows those five as clean successes.

**Nobody can tell who killed a run.** Run `019fdfd0` has `run_command 019fdfd0-3041`
`stop / consumed / human` at 05:19:51 and the run closed at 05:19:54 as
`errored / Unknown / "All fibers interrupted without error"`. A user's own stop is recorded as a
system failure. Twelve ledger terminuses are `interrupted` with no cause detail —
`packages/telemetry/src/telemetry.ts:133-143` maps any interrupts-only cause to a bare
`interrupted`. `container_id` is null on all 169 rows, so you cannot read the logs of a run that
failed, and 10 of 12 failed rows carry no cost and no turns. Note the containerId plumb is real
work, not an added argument: the id only exists on `SandboxResult` when the container exits
(`packages/sandbox/src/spec.ts:196`), though the *name* is known at create time
(`docker-argv.ts:107`, `atm-<runId>-<nonce>`).

### Does the approach need a rethink

Yes, but a small one, and in the opposite direction from adding more.

172 `Effect.fn` named spans and 18 bounded metric declarations are computed on every run and read
by nobody: `OTEL_EXPORTER_OTLP_ENDPOINT=` is blank in
`/home/agent/.config/agent-task-manager/common.env:21`, so
`packages/telemetry/src/otlp.ts:55-72` returns `Layer.empty`. There is no `/metrics` route and no
`Metric.snapshot` reader outside five test files. The quota gate's four counters are the only
record of a quota pause and they evaporate on restart — `loop.jsonl` carries exactly two markers,
`atm.run` and `atm.sandbox`, and no quota, lease-reclaim or stuck-scan event appears anywhere.

The decision is unwritten: `.docs/telemetry.md` is 23 lines about the viewer and records no
position. Write one. The recommendation is to declare the JSONL ledger the system of record and
Postgres `run` a UI cache — which is already true in practice, since the ledger has 196 terminuses
against 169 DB rows, 31 ledger-only including 9 of the 12 interrupts, and the DB vocabulary has no
`interrupted` at all. Then replace the 18 metric declarations with counter fields on the wide
event (which survives restart), keep spans behind a flag, and spend the freed effort on reading —
a `sql` subcommand on the `bun run logs` command that already exists.

Two more, cheap. The gateway ledger is 70% dashboard polling: 10,944 of 15,695 rows (69.7%) are
`/tasks/:taskId` and `/tasks/board`, 92.9% are GET+200 with p50 26ms, exactly one request of
15,695 exceeded 1s. Measured 2,569 rows/day at 772 B/row rotates the 64 MiB cap in 34 days against
a code comment (`event-log.ts:6-14`) that assumes several months — off by ~10x, exactly the
trigger the comment names. The predicate is already specified in
`.docs/plan/02-build-plan.md:548-550`; implement it rather than reinvent it. The dashboard half is
mostly already handled: `refetchIntervalInBackground` is unset so a hidden tab already stops
polling, `detail.tsx:165-168` already stops on a settled task and `runs.ts:68` on a complete run.
The rows actually being produced come from `board.tsx:154` (5s, one read per in-progress card,
unconditional), `board.tsx:221` (10s) and `transcript.tsx:81` (15s).

And four one-line reader fixes that are pure loss today: `scripts/logs.ts:59,196,215` render a
`project` field no schema emits (the ledger has `repo` and `projectId`), so the PROJECT column is
`-` on every row of `bun run logs errors`; `Skill` is absent from `TOOL_SUMMARY_FIELD`
(`packages/harness/src/claude-events.ts:59-68`) so all 61 recorded skill calls have empty
summaries; `COMMAND_LABEL_WORDS = 2` collapses `bun run typecheck` and `bun run build` into 136
indistinguishable `bun run` rows; and 560 `unmatched` 404s carry a null errorMessage by deliberate
suppression (`request-event.ts:291-317`) with no low-cardinality `pathShape` to count them by.

---

## 3. Infra and disk

### The numbers and the deadline

`df -h /`: 75G, 55G used, **17G free, 77%**. ATM: `.data` 9.8G + docker 11.1GB = ~20.9GB in six
days.

`.data` breakdown: `caches` 9.1G (bun 8.8G across 3,259 top-level entries, npm 311M), `runs` 417M
across 191 directories, `mirrors` 232M (7 bare clones, `vohtaski/pickart-app.git` alone 213M),
`events` 13M, `bin` 4.5M, `artifacts` 3.5M, `loop-check` 3.0M, `workspaces` 4.0K.

Docker: Images 7 / 7.211GB with 3.307GB reclaimable, Build Cache 27 entries / 3.787GB with 0
active, one volume 89.62MB, one container.

Bytes written into `.data` by file mtime day, Aug 3-9 (GiB): 0.10, 0.02, 2.21, 5.44, 0.31, 0.81,
0.01. Last ~2.2 days: 1.13 GiB, i.e. 0.51 GiB/day. Two image rebuild rounds in six days at ~1.9GB
of image layers plus ~1.9GB of build cache each.

Days to fill 17G: **~33 with no further image rebuilds, ~11 at one rebuild per three days, ~3.6 at
the Aug 3-6 burn rate.**

### What is not leaking

Containers. Right now `docker ps -a` shows only `agent-task-manager-postgres-1`, zero dangling
images, one volume, four stock networks. The label-scoped sweep in `packages/sandbox/src/reap.ts:37-42`
joined against `runs.listLive` at `runtime.ts:912-933`, called at boot from
`apps/loop/src/main.ts:40`, correctly closes the SIGKILL gap. `atm-loop.service` is
`Restart=always` with `NRestarts=0`.

Containment is correct and worth not touching: `--pids-limit=512`, `--memory=4096m` with
`--memory-swap` pinned equal so there is no swap, `--cpus=1.5`, `--security-opt=no-new-privileges`,
cap-drop list, `--tmpfs=/tmp:size=512m`, 1h run cap, concurrency 1. `--rm` is deliberately not used
so the OOM verdict survives to `docker inspect`. One correction to a widely repeated belief:
`DEFAULT_READ_ONLY_ROOTFS = false` (`packages/sandbox/src/hardening.ts:47`) — the rootfs is not
read-only. The live memory ceiling is 4096m by override; the default is
`DEFAULT_MEMORY_MB = 2048` and nine runs are already `oom_killed`.

### What is leaking, in order of size

**`.data/caches` — 9.1G, by explicit design.** `packages/sandbox/src/workspace.ts:78-80`:
"Nothing evicts from it. When the disk gets tight the answer is to delete the directory and take
one cold install, which is why there is no per-run or per-project scoping to unpick first." That
is a defensible decision written in the only place an operator will never look. It belongs in a
runbook with a threshold. It is also bigger than everything docker would give back.

**Docker images and build cache — ~3.8GB per rebuild round, never reclaimed.**
`scripts/build-images.ts:201-204` tags the dated ref and `latest` and never removes anything; grep
for `prune|rmi|remove` in that file, and repo-wide across `scripts/`, `deploy/`, `.docs/`, finds
nothing. Both the 2026-08-03 and 2026-08-05 pairs are still present.

Important correction to the obvious fix: **`docker image prune` reclaims zero here** —
`docker images -f dangling=true` is empty. The 3.307GB needs `-a`, which would delete
`atm.local/base:latest` and `atm.local/browser:latest`, and there is no pull fallback because
`atm.local` is a registry that deliberately does not exist (`docker/README.md:11`) and nothing in
`packages/sandbox` pulls. `-a` would break the next run until a rebuild. The safe one-shot is:
remove the two 2026-08-03 tags **by name** (~1.9GB) and `docker builder prune -af` (3.787GB) —
**~5.7GB**.

The proposed pin-safety filter ("check `sandbox_image` before removing") protects nothing today:
all 84 task rows have `sandbox_image` null and all 168 run rows record `atm.local/base:latest`,
never a dated tag. Keep the filter for later, but it is not what makes this safe.

**`.data/runs` — 417M over 191 dirs, and 321M of it (77%) is 184 copies of `agent-mcp.js`** in
only 4 distinct md5s (125 + 51 + 5 + 3). `packages/orchestrator/src/agent-token.ts:116`
`copyAgentBundle` does a plain `fs.copyFile` per run; the code comment argues one file copy costs
less than another mount entry. Bind-mounting a single `.data/agent-mcp/<digest>.js` read-only
drops the directory from 417M to ~96M and stops it growing with run count. This is the single
cheapest reclaim in the system. (`packages/sandbox/src/mounts.ts` is in PR #43's file list — expect
a rebase.)

**No sweeper for run or workspace directories.** 191 dirs against 169 `run` rows: 26 on disk with
no row, 4 rows with no dir. The workspace cleanup is an `Effect.acquireRelease`
(`workspace.ts:314-322`, `chat-turn.ts:165-177`) — the same construct `reap.ts` says cannot survive
SIGKILL — with no boot sweep. `.data/workspaces` is currently 4.0K and empty, so nothing is
stranded right now, but a SIGKILL mid-run leaves a full repo clone with project env files inside
it and nothing will ever remove it. Extend the boot reconcile that already joins containers
against `runs.listLive` to do the same join over the two directories.

Do **not** age out `transcript.jsonl` as part of that sweep.
`packages/orchestrator/src/transcript-ingest.ts:22-26` says the opposite of what was assumed:
run_event rows are clipped, the transcript is written to `run_event` only when the event stream
left none, and "Durable on disk, and nowhere else, is the whole conversation at full length in the
run directory: no query returns it, and removing the run directory removes it." On top of that,
`GET /tasks/:taskId/sessions/:sessionId/transcript` is already in the contract
(`packages/api/src/groups/sessions.ts:53-63`) and served `pending`
(`apps/gateway/src/handlers/sessions.ts:130`). Deleting transcripts deletes the backing store for
an endpoint whose shape has shipped.

**Git mirrors grow per project with no deletion path.** 232M today, one bare clone per repo the
board has ever touched; `packages/sandbox/src/repo.ts:12-25` creates and refreshes, nothing
removes. Deleting a project in the dashboard leaves its mirror forever.

### Backup

Nothing. Not a single `pg_dump`, no timer, no WAL archive, no replica —
`docker-compose.yml` declares one named volume `atm_postgres_data` and that is the entire
durability story. `deploy/user/` already holds three systemd user units (`atm-loop`,
`atm-gateway`, `atm-bot`), so the pattern is right there.

A live dump is 3.1 MB. 14 daily plus 4 weekly is ~57 MB against 17G free. Cover `.data/artifacts`
(3.5 MB) too, as the plan item says. Put the units in `deploy/user/` beside the other three or
they drift out of the repo. And be honest about verification: `pg_restore --list` reads the
archive table of contents, it is not a restore — either restore into a scratch database or call it
a readability check and stop using the word restore.

---

## 4. What the agents keep getting wrong

This is the section with the most leverage. Everything below is a thing that is paid once per run,
out of $588.35 of worker spend across 77 runs (avg $8.81, max $39.50, 6,489 turns), plus $44.34
across 92 manager runs.

First, the reassuring part, because it tells you where *not* to spend effort. Exact-duplicate tool
calls: 25 across 20 runs, worst run has 3. Grep/rg searches returning nothing: 5 of 1,853. Edit
failures: 7 of 1,346 (0.5%). Read failures: 8 of 830 (1.0%). `bun install` ran in only 34 runs,
median 12.7s. The agents are not thrashing, not looping, not fighting the tools. Retry-loop
detection, search heuristics, dependency caching and edit reliability are all solved. The waste is
somewhere else entirely.

### 4.1 You repeat yourself, and there is nowhere for the instruction to land

**"Research first, don't build yet."** This is your most repeated instruction. Regex over human and
manager comments finds it on 7 distinct tasks; the corpus pass counted 8 including chat threads,
which could not be attributed per task. Your own words:

> "before implementing, explain why and how hard would be to implement build for this target?"
> (PeekTrace, 08-04)

> "first just research on zod usage on this projects and tell me in comments breafly... is it worth
> it?" (swap zod to valibot, 08-05)

> "so for now only like research stage." (oRPC bridge, 08-08)

> "so make such artifact. Again, don't commit anything, do just artifact file artifact."
> (PickArt videos, 08-08)

Note the word "Again".

`grep -niE "research|plan only|do not implement|explore" packages/prompts/src/*.ts` returns
nothing. `\d task` has no mode column. The `tasks_create` description
(`packages/agent-tools/src/tools.ts:151`) says only "Create a task. File new work into `backlog`".
The concept does not exist anywhere in the system.

**And then you have to undo it.** The mirror instruction appears twice in comments, both confirmed
with timestamps:

> "I want you to turn this PR4 from research to actual implementation. So the expected result is
> like you do everything and then you drop and like remove this research file at the final end."
> (oRPC bridge, 2026-08-08 18:58:43)

> "change this pr to be implementation rather then just plan" (Upvotes, 2026-08-09 00:56:11)

Both of those tasks carry a `pr_url` — `webMCP-example/pull/4` and
`andrey-markin-website/pull/162` — so repo-bearing research runs really did open PRs full of plan
documents. That is not the agent being dense: `artifactRulesOf`
(`packages/prompts/src/rules.ts:180`) keys the artifact rule off `hasRepo`, so a run with a
checkout is told a committed document belongs in a pull request, full stop. Repo-less research runs
(agent harness, model API shapes, PickArt videos) delivered clean artifact bundles and needed no
correction at all. The rule is keyed on the wrong thing.

**Scope narrowing, and a narrowing that had to be publicly revoked.**

> "for now only do backend part. do not update dashboard UI" (usage limits, 2026-08-07 11:32:30)

> "Second part: the dashboard rendering is now in scope. Ignore the 'backend only, do not update
> dashboard UI' comment above — that was there because the dashboard was being reworked at the same
> time and we did not want the conflicts" (manager, 2026-08-07 21:02:36)

A comment ages into a false instruction that the next run reads as current. That is exactly what
happened. Scope is state, not conversation.

The base-branch case is the one that should never recur, and it reads as the most annoyed thing on
the board: **"use mvp branch as starting point obiusly"** (08-03 14:37). That is fixed in code now
(per-task `repoUrl` and default branch, PR #17).

### 4.2 A resumed run destroys its own pushed work

`packages/sandbox/src/repo.ts:474` is verbatim
`args: ["checkout", "--no-track", "-B", source.branch, source.baseRef]`, and `baseRef` can only
ever be the base (`baseRefOf`, repo.ts:156-161). The mirror is fetched with a prune-fetch, so
`origin/atm/task-<id>` is present and then immediately thrown away. Three separate runs
documented the recovery, in their own words:

> "the container came back with a fresh clone at the base commit (6f35e76), not at my pushed work.
> `git fetch origin <branch> && git reset --hard origin/<branch>` restored it"
> (Theme toggle, 2026-08-07 11:01:24)

> "this run started from the base commit with my previous commit only on origin, and a
> `bun install` was needed before any gate would run" (dashboard shortcuts, 2026-08-08 08:45:37)

> "this run **again** started from the base commit with the earlier push present only on origin —
> `git reset --hard origin/<branch>` then rebase recovered it"
> (webmcp-example, 2026-08-08 11:27:53)

All three postdate PR #17 (merged 2026-08-06T12:08:20Z), which fixed a different cause. Three
agents wrote a note for a "next session" that is a different container with no way to read it. A
run that does *not* notice silently rebuilds work already on origin. `repo.ts` is in no open PR's
file list. This is an S-sized fix and it is the best line-for-line change on this list.

(Naming nit for whoever picks it up: line 474 is inside `materializeRepo`, not
`cloneIntoWorkspace`, which is the thin layer wrapper at repo.ts:544.)

### 4.3 Every run rediscovers the container

Across the 73 worker transcripts: 73/73 run `ls`/`find` to learn the layout, 61/73 run `git log`,
63/73 grep into `node_modules` to read a library's types (56 calls into `effect/dist`, 52 across
`@orpc/*`, 35 into `@base-ui/react`), 58/73 read `package.json` for script names, 58/73 call
`gh`. Only 25/73 read `AGENTS.md` or `CLAUDE.md` at all. **Median 34 tool calls and 4.9 minutes
elapse before the first `Edit` or `Write`** (worst: 79 calls, 18.4 min).

Missing binaries are paid over and over. `python3: command not found` appears in 52 of 184 runs
(28%), `jq` in 10, `turbo` in 8, `bc` in 5. `docker/base.Dockerfile:100-112` installs
ca-certificates, curl, git, less, libgcc-s1, libstdc++6, openssh-client, procps, unzip, xz-utils,
then node, bun, gh and ripgrep. No python, no jq, no bc. Run 019fcca3 ran a `python3` one-liner at
12:00:27, failed, and rewrote it as `bun -e` at 12:00:31 — four seconds, 52 times.

Ten tasks say some version of "no Postgres here — I stood up embedded-postgres", complete with the
recipe:

> "There is no Postgres in the worker container. `embedded-postgres` works if you symlink its
> unversioned `.so` names (`libpq.so.5` → `libpq.so.5.18`...) and export `LD_LIBRARY_PATH`"
> (API keys, 08-06)

Twelve tasks end with a manual browser check owed to a human. **But the headless browser already
exists.** `docker/browser.Dockerfile:57-64` has installed `chromium`, `fonts-liberation` and
`fonts-noto-color-emoji`, `:66-70` installs agent-browser, `:86-88` sets
`AGENT_BROWSER_EXECUTABLE_PATH` and launch flags — since commit `7ef5365` on 2026-08-04, and
`atm.local/browser:2026-08-05-e9fc0844e85a` is on the host now. The gap is *selection*: all 84 task
rows have `sandbox_image` null, so `sandboxImageFor` (`packages/sandbox/src/images.ts:82`) hands
every run `atm.local/base:latest`. The dashboard already exposes the field
(`features/task/properties.tsx:135`, `draft.tsx:205`). Nobody picks it. That is a routing and UX
problem costing zero disk, not a Dockerfile problem.

Ten tasks re-bisect the same pre-existing test failures against a stashed tree to prove they are
not theirs. Five say deps are not pre-installed. One trap was written up independently twice:

> "`bun test` needs `CLAUDE_CONFIG_DIR` unset in this container, or two unrelated `AgentRegistry`
> tests in `packages/core` fail" (AI Elements, 08-08; same finding on PeekTrace, 08-06 16:33)

And a self-inflicted one worth a single line of rules: 20 tool results end in `Exit code 144`
across 12 runs, and **every one of the 20 commands contained `pkill`**. `pkill -f <pattern>` inside
a bash string that contains the pattern kills the shell running it, so the agent loses output it
had already produced and re-runs the command.

### 4.4 Verification is a mess of pipes, and often does not happen

773 Bash calls matched typecheck/test/check; 744 (96%) went through `| head`, `| tail` or `| grep`;
279 were back-to-back re-runs of the same verification with a different filter. Run
`019fe23b-dae9-75a1-a709-594dcbfcf5a4` has five consecutive `bun run check` calls at Bash indices
132-137 differing only in the grep and `--max-diagnostics` (100, 200, 50). Wall time: typecheck
113.3 min over 194 calls, test 58.2 min over 378, lint 39.9 min over 200 — **3.5 of the 6.81 hours
of total Bash wall time**. The agent truncates because the output is too big, then re-derives what
it truncated away.

And the gate does not exist. `grep -niE "test|typecheck|lint|verif"` over
`packages/prompts/src/rules.ts` finds no rule about running anything; the sole hit is "something
you could not verify" as a comment item (rules.ts:261). The only per-turn enforcement in the whole
system is the comment marker in `decideStop` (`packages/harness/src/stop-hook.ts:272-286`).

**Correct the headline number here**, because the first pass had it inverted. Over finished worker
runs with Bash tool calls (64): 49 invoked `gh pr`, 34 ran any `bun run`/`bun test`, and the
intersection is 30. So 30 of the `gh pr` runs *did* verify and **19 of 49 (39%) opened a PR having
run neither** — 12 if any `bun` command counts. The problem is real at 39%, not 61%.

### 4.5 The work is not durable until 86% of the way through the run

Across the 73 worker transcripts: **25 never ran `git commit` at all**; of the 48 that did, 36
committed exactly once; the median first commit lands at **0.863 of the run's span**. Every
infrastructure failure before that mark destroys everything.

The worst case is on the record. Run `019fcca3` on task 019fc918 ("User-scoped API keys") ran 59.1
minutes, produced 577 assistant messages and 390 tool calls, committed nothing, and died on
`TimedOut: exceeded the 3540000ms cap`. Its timeline at index 350-394 shows it fixing lint nits at
12:56 — three minutes from done. `019fc87c`: 17.9 min, 113 calls, SIGKILL, zero commits.

And then it could not be resumed. `packages/domain/src/agent-session.ts:55` is
`export const isResumable = (session) => session.status !== "failed"` under the doc line "Only a
failure does", consumed at `open-run.ts:161`. Session `019fcca3-50a8` has `status=failed` and a
non-null `provider_session_id`. The retry `019fd87e` got `resumeSessionId: null` in its
`turn-spec.json` and cost **$32.61 over 271 turns**. The resume machinery is fully wired
(`harness/claude.ts:332`, `codex.ts:155`, `turn-spec.ts:205`) — only the gate is wrong.

Two honest qualifiers. The commits were not lost: `branchForTask` (`repo.ts:171`) keys the branch
on the task alone, both runs carry `atm/task-019fc918-1036…`, so the retry inherited whatever had
been pushed. What was lost is the conversation. And this has fired exactly once — across 169 runs
the outcomes are 157 done, 9 errored, 2 lost, 1 timeout. One $32.61 event. Worth fixing, not
urgent.

### 4.6 The best source of new work is the one actor that cannot file it

Six runs (`019fca86`, `019fcad4`, `019fd6b1`, `019fd8f2`, `019fdbac`, `019fe1f0`, covering 5
distinct tasks) hit
`tasks_create - Forbidden: {"reason":"unscoped_route","required":"task-write"}`. Eight distinct
tasks carry a complete follow-up card brief in a comment. The refusal always lands at the end of
the turn, when the run has just read the code and knows exactly what should happen next.

> "**Backfill — cheap, and worth filing.** I could not file it: this run's board token is
> task-scoped and `tasks_create` came back `Forbidden: unscoped_route, required task-write`"
> (task 019fd258, with the exact GitHub query to run)

Nobody pasted it. Result: 27 of 84 tasks carry a `pr_url`, and 32 `done` tasks have none.

The cost of the gap, in a run's own words:

> "'Settle which repo URL format projects should use' is `done` on this board but landed nothing in
> the repo: no branch, no PR, no artifacts... The card is worth reopening or re-filing."

The mechanism is structural, not a scope flag: `checkBinding`
(`apps/gateway/src/auth/principal.ts:399-412`) lets a bound token write only on routes nested under
its `:taskId`, and `POST /tasks` has no such param. So the fix is a task-nested route
(`POST /tasks/:taskId/children`), not a looser scope. Useful discovery:
`creatableStatuses("worker_run")` (`status.ts:143-155`) already returns `ideas` and `review` — the
status machine already contemplates a run filing a card into `ideas`, needing no new transition
row. `task.parent_task_id` exists and two rows already use it.

Meanwhile the tool table advertises `tasks_create` to workers and refuses it every time. The full
19-tool table serialises to 13,135 characters — more than the manager's entire assembled prompt
(5,159) and three times the worker's (3,948) — and 1,391 of those characters are `$defs` that
duplicate the already-resolved root with no `$ref` pointing at them (`tasks_create` alone is 1,059
characters of dead schema).

### 4.7 Nothing carries forward, so the agents invented their own memory

The designed channel is empty: `artifact` has exactly 2 promoted rows, both fixtures named
`shared.md`, and `.data/artifacts/global` and every project artifacts directory contain no files.
`AGENT_TOOLS` (`tools.ts:392-412`) has `artifacts_list` and `artifacts_read` and **no write verb**.

So they adopted Claude's own memory directory. `/agent-home/projects/-workspace/memory/MEMORY.md`
is the second most-read path in the whole ledger — 22 transcripts name it, 38 reference the
directory. On the host it holds 19 files written since Aug 3 under one key, because `cwd` is always
`/workspace` (`packages/harness/src/claude.ts:316`) and the agent home is mounted read-write and
shared across every run (`packages/sandbox/src/mounts.ts:352-357`). So
`peektrace-two-react-copies.md` sits beside `atm-worker-token-is-task-scoped.md` and both reach
every run on every project. One entry contradicts the prompt in writing:

> "/artifacts/project is ephemeral — only /artifacts/task survives a container run, despite what
> the brief says... even though it is writable and the run brief describes it as a read-only
> reference directory"

That is unversioned, invisible in the dashboard, cross-project, and correct. It also falsifies
`.docs/agent-prompts.md:17` ("Nothing here is stored in a database or read off an operator's
disk").

Related: the repo's own skills barely load. 74 Skill invocations across 184 runs — `pr-issue` 44,
`quality-code` 17, `agent-to-human` 11, `effect` 2. `AGENTS.md` says "when coding in typescript,
always load quality-code skill"; it fired in 17 of 77 worker runs (22%). The `effect` skill loaded
twice while 63 runs shelled into `node_modules` to read type definitions. A rule stated in a file
the agent may or may not read is not a rule.

### 4.8 Smaller recurring things worth one line each

- 391 `ToolSearch` calls across 178 of 184 runs, top query `select:mcp__atm__comments_add` 42
  times — for a tool the stop hook (`stop-hook.ts:285-296`) *requires* before the turn can end.
- 23 of 77 worker runs hit `stop refused: the run has posted no comment`; three hit it twice.
- 14 of 73 agent comments are `fallback`, and 8 of those are under 250 characters of mid-thought:
  "half a thought", "Now let me find the manager thread / prompt code.", "I'll wait for the first
  sections to land." That last one is the entire visible result of a 37-turn, $15.26 run.
- Six tasks open by correcting their own card's premise: "The brief lists five Recharts charts.
  That's true of `package.json`, not of the code... `viz-surface.tsx`, named as a consumer, **does
  not exist**" (TanStack spike, 08-08). The strong runs do this unprompted; it should be the floor.
- Four test-fixture cards (`clean run`, `failing run`, `truncated stream`, `loop:check — dispatched
  and finished in a container`) live on the production board. The manager's first-ever comment was
  filed onto `truncated stream` on 2026-08-03 12:58:42 — "filed here as this is the only task on
  the board". `truncated stream` has sat in `review` for 7 days.
- 96.6% of tokens are unattributed: across 184 turn rows `totalTokens` sums to 825,508,160 while
  `inputTokens` 56,480 + `outputTokens` 3,499,046 = 0.43%. There are no cache-read or
  cache-creation fields on `TurnEvent`. Worker runs show 1,473,535,725 cache-read against 7,801,106
  output — 0.52% of all tokens are output. Cost is a function of how much undigested output sits in
  the window, and of the 12.3M characters of tool output pulled into worker contexts, Bash is 52.1%
  and Read 39.3%; all board tools together are under 4%.

---

## 5. Prompt, context and tooling changes

Split cleanly into two piles, because they fail differently.

### Add a rule (the concept does not exist yet)

**A deliverable field on the task.** Store `metadata.deliverable` (`research` | `build`, default
`build`) — `task.metadata` is jsonb with `TaskMetadata = Schema.Record(Schema.String, Schema.Json)`
and is already patchable through `TaskCreate`/`TaskPatch`
(`packages/api/src/schemas/task.ts:61,82`), so **no migration**, which matters while #41 and #43
have forked the drizzle chain. Render it as a prompt section. Change `artifactRulesOf`
(`rules.ts:180`) to key off the deliverable rather than `hasRepo`: research writes to
`/artifacts/task` even with a checkout and does not open a PR; build commits. Add the field to
`tasks_create` and `tasks_edit` with a description, and one line in `MANAGER_RULES`.

Do not call it `mode` — `WorkerPromptInput.mode` is already `PromptMode` = fresh|resumed
(`worker.ts:139`). The tool is `tasks_edit`, not `tasks_update`. Plumbing is cheap: `attachment.task`
(the full row, metadata included) is already passed at `prompt.ts:190`; only the `Pick` on
`WorkerPromptInput.task` needs widening. Land after #43, which rewrites `artifactRulesOf` whole.

**An out-of-scope field.** Same mechanism, `metadata.outOfScope`, rendered beside acceptance and
editable in the dashboard next to it. One caveat for the build: a metadata PATCH replaces the whole
object and 8 tasks already keep `githubIssue`/`githubIssueUrl` there, so the editor must merge.
Sequence after #42, which refactors `features/task/brief.tsx`.

**Acceptance as the filing standard.** `MANAGER_RULES` (`rules.ts:255-330`) never says the word
acceptance, and the rendered schema the model actually reads is
`"acceptance":{"anyOf":[{"type":"string"},{"type":"null"}]}` with no description — no field in
either schema carries one. So the JSDoc explaining it ("Acceptance criteria, appended to the
prompt", `packages/domain/src/task.ts:49`) never reaches a model, and
`.docs/agent-prompts.md:263` is wrong when it claims doc comments are agent-visible.

The correlation is strong and reproduces exactly: over the 57 tasks with runs, no acceptance plus a
brief under 1500 chars gives 9 tasks averaging 1.78 runs and 1.11 human/manager comments; with
acceptance, 48 tasks averaging 1.20-1.31 runs and 0.23-0.40 comments. Worst case, "PeekTrace for my
vps": 197-char brief, null acceptance, 4 human comments, 4 runs, 160 turns, $12.03. Call it
correlation — acceptance-bearing cards are also the bigger ones — and do it on its own merits.

**Three sentences the worker is never told**: how long it has (`ORCHESTRATOR_RUN_TIMEOUT_MS`,
live 3,600,000 ms, appears in no prompt), that ending the turn with a question *is* how it asks
because `AskUserQuestion` is denied on every run (`claude-settings.ts:84-96`) with no substitute
named, and that stopping with a clear question beats guessing.

**Commit early.** One line in `WORKER_RULES`: commit to the already-checked-out branch as soon as
anything works and push; the branch is the only thing that survives the container. That line is S
and worth doing alone. The harness checkpoint behind it is M and carries hazards worth naming — a
background committer racing the agent's own git calls hits `index.lock`, commits half-written
trees, and mutates `git status` under a model reasoning about it. Push to a `wip/` ref rather than
the task branch if you build it.

**A per-project repo card**: default branch and base ref, the exact verify command, workspace
layout, the PATH inventory (bun, node, git, gh, rg, curl — no python3, no jq, use `bun -e`), "kill
by pid file, never `pkill -f` a pattern your own command line contains", and the skills to load by
trigger. The delivery slot exists: PR #43's `packages/prompts/src/instructions.ts` deliberately
leaves `WORKSPACE_CONVENTIONS` empty pointing at `worker/<project>/AGENTS.md`, and
`.docs/plan/08-agent-filesystem-decisions.md:107` notes Claude's CLAUDE.md walk has no repo-root
stop. Budget it: line 60 of the same doc says Codex spends one 32 KiB budget across every
`AGENTS.md` it collects, root first.

One correction to carry: **peektrace already has both a root `AGENTS.md` and a root `CLAUDE.md`**,
and that CLAUDE.md carries the exact typecheck rule ("Typecheck with `bun run typecheck` … never
`tsc -b`"). Do not add a third instruction file there. `webMCP-example` genuinely has neither.

### The rule exists and was ignored — enforce it in code

**Verification.** This is the one that needs machinery, because prompt text has already been tried:
`rules.ts:219-228` is the stop-hook rationale arguing exactly that. But the obvious design fights
the code. `packages/harness/scripts/stop-hook.ts:6-12` says the hook "runs inside the sandbox
container, on the critical path of every turn ending, so it stays a filesystem read and a
`switch`. No database, no gateway call, no telemetry." A multi-minute build does not go there.
It goes in the orchestrator's terminus path or a harness step before the hook. There is also no
project verify command to run: `\d project` is created_at, id, workspace_id, updated_at,
description, name, repo_default_branch, repo_url — the field has to be invented first. New column,
plus a runner, plus marker plumbing: this is **L**, not M, and it should be sequenced behind the
declaration half.

The declaration half is buildable now and separately useful: add `project.verifyCommand`, add
`bun run verify --json` to *this* repo (runs typecheck, lint and tests, prints only failures as a
bounded JSON list, truncated at N with a count), and name it in the repo card. Scope honestly —
the board has six repos with mirrors and ATM can only add the script to itself; the other five each
need their own PR, and `vohtaski/pickart-app` is another owner's repo on branch `development`.

**Skills.** `quality-code` fires in 22% of worker runs against an `AGENTS.md` that says "always".
Either the harness loads the matching skill for the repo up front, or `rules.ts` names skills by
trigger. Also add `Skill` to `TOOL_SUMMARY_FIELD` so you can measure it at all — a skill name is
not a credential.

**The vendor memory directory.** Decide, then enforce. The SDK `Settings` already carries
`autoMemoryEnabled` and `autoMemoryDirectory`, and `DEFAULT_CLAUDE_SETTINGS`
(`packages/harness/src/claude-settings.ts:113`) is exactly where to set one. Either give it a
per-project key or disable it the way `disableBundledSkills` disables skills. This is S and
independent of everything else.

A `notes_append` tool is largely redundant once #43 lands, because a worker can write a file into
the project directory and `PROJECT_SCOPE` on that branch already says "The project directory is
durable material a later task on the same project reads. Yours to write, and every task in this
project sees what you leave there." What a tool would add over that is the audit row and dashboard
visibility. Justify it on those two or drop it.

**The tool table.** Filter the *listing* by role and drop the 1,391 characters of duplicated
`$defs`. One correction: "the binding already knows which role it is" is false —
`makeManagerMcpServer` takes only a `GatewayClient` (`server.ts:96`) and `readGatewayConfig` reads
only `ATM_GATEWAY_URL` plus a token (`config.ts:27-34`). No role reaches the process; it needs a
new env var written in `provider-config.ts` `stdioEnv`. And `tools.ts:10-16` argues explicitly for
one table ("a second tool table would be a second place for that rule to drift") — filtering the
listing does not touch authorization, so the objection is answerable, but answer it rather than
ignore it.

The cheap half is better specified than the expensive one: the SDK exposes `alwaysLoad` per stdio
server (`sdk.d.ts:1046`), unset today, so eager-loading the board tools is one field in
`claudeManagerMcpServers` (`provider-config.ts:79-92`). Claude path only; Codex has its own config
block. That alone removes most of the 391 `ToolSearch` calls.

**Two prompt statements that are simply false and should be corrected while you are in there.**
`MANAGER_RULES:291` says "Do not list your tool calls. The person watching sees them while you
work." The Telegram surface does not — `apps/bot/src/notify/summary.ts:20-22`: "no tool calls, no
transcript, no argv". And `WORKER_RULES:259` asks for "a link to where the detail lives" while
nothing puts a dashboard or gateway URL in the container's environment.

---

## 6. How work is structured

**There is no CI.** `.github/` does not exist. `gh pr checks` on all six open PRs returns "no
checks reported". Every `MERGEABLE` flag means only "no textual conflict with main", and every
typecheck/test claim in a PR body is self-reported by the agent that wrote it.

**The queue is already broken in a way git will not catch.** Six open PRs, all branched from
`f0db342`, all reporting MERGEABLE, and three collide badly with each other:

- **#40 × #43 share 49 files**, including all of `packages/prompts/src/*`, the harness stop hook,
  `packages/orchestrator/src/{prompt,run,runtime,run-telemetry}.ts`, `agent-tools/src/tools.ts` and
  `openapi.json`. Both are semantic rewrites of the same text. They cannot both merge without a
  hand-resolved rebase.
- **#41 and #43 fork the migration chain at the same parent.** Main's head snapshot
  `20260807084941_system_notices` has id `d3dc262e-14d4-4bd8-9163-6710c8716781`; #41's
  `20260808165848_session_usage` and #43's `20260808150704_proposals` both carry it as `prevIds`.
  Different filenames, so git merges both silently and the next `drizzle generate` diffs against
  the wrong head. There is no `drizzle/meta` journal. Bonus: #43's own two snapshots carry the
  *same* id `e23107a9-eca0-4d44-9ece-2c4bae178077`, so its chain is not internally linear either.
- **#39 and #42 touch nothing anyone else touches** and can merge today in any order. #44's only
  collisions are two files shared with #40.

`scripts/check-migrations.ts` — assert every snapshot's `prevIds` chain is linear and terminates at
a single head — is pure file reads, needs no services, and would catch this today. Ship it as its
own S-sized job. The full test job is the M behind it, and note that `bun test` needs a live
Postgres (`packages/db/src/testing/root-env.ts` preloads the repo `.env` for `DATABASE_URL` before
any test module), so the workflow needs a service container plus migrate and seed. There is also no
`verify` entry point to reuse — root `package.json` has `typecheck`, `test` and `check` and grep
for "verify" returns nothing.

**Merge order, stated once:** #39 and #42 now. #40 next (smaller, mechanical). #44 after a two-file
check against #40. #41 with a regenerated snapshot. #43 last, rebased, with its own chain
straightened. No new proposal should touch `packages/prompts/src/rules.ts`,
`packages/harness/src/stop-hook.ts`, `packages/orchestrator/src/prompt.ts` or add a table until
that is done.

**PR #43 is not on the board.** Card `019fe08f-44a8-76ff-8dfd-04a9f23f3bb9` ("Agent filesystem")
is still `backlog` with a null `pr_url`, and #43's branch is `atm/agent-filesystem`, not the
`atm/task-<uuid>` shape everything else uses. A proposer reading the board today would happily
re-propose 36,247 added lines that already exist. Link it or move it.

**The queue is not ATM work.** Ideas by project: My Website 14, Peektrace 1, none 1, Agent Task
Manager 0. Thirteen of the fourteen open with "From GitHub issue #NNN". The only ATM-project queued
cards are the agent filesystem (= #43) and the Obsidian vault, which is explicitly parked behind
it. Direction of travel over 37 merged PRs: dashboard/UI 8, sandbox/credentials 7, bot 6,
orchestrator/harness 6, auth/API 2, infra 2, prompts 1. `packages/telemetry` has 2 commits ever,
both wholesale; `apps/dashboard` took 95 file touches in the last 30 commits and
`packages/telemetry` took 0.

**Fixtures off the live board.** Half of this is already done — `scripts/loop-check.ts:97-106` and
`scripts/bot-check.ts:101` already redirect to `${DATA_ROOT}/loop-check`, and that directory exists
on disk. The writer of the four fixture cards is the **test suite**:
`packages/orchestrator/src/run.test.ts:589` creates the task titled "truncated stream", and
`seedTask` (run.test.ts:289-306) takes `workspaces.list()[0]` — the first workspace in the live
database — with an `afterAll` delete that evidently did not finish on some Aug 2/3 run. The fix is a
fixture workspace the tests create for themselves plus a test `DATABASE_URL`, not a DATA_ROOT
redirect that already exists. Flag anything already stranded with `metadata.fixture=true` and
filter board queries, including the rollup #39 is designing.

**Resume after a non-agent failure.** Gate `isResumable` on the last run's outcome rather than the
session status. Note `oom_killed` is not an outcome — `RUN_OUTCOMES`
(`packages/domain/src/enums.ts:71-77`) is done/errored/interrupted/timeout/lost — and
`AgentSession` carries no failure cause, only `errorMessage`, so this cannot be a change to
`isResumable` at its current signature; it needs the outcome fetched at the open-run site. Name the
risk the proposal skips: resuming a 577-message session replays a context that already hit the wall
clock.

---

## 7. Automatic idea generation

The point of this section: every insight in this document came from a human-triggered
investigation. Nothing in the system notices its own repeated failures. Build it in two pieces, and
build the deterministic one first.

### 7.1 `scripts/evidence-pack.ts` — the deterministic half

A read-only script emitting one bounded pack: ledger rollups by marker and outcome (from
`.data/events/*.jsonl` plus the per-run turn files), top error classes and counts, cost
distribution, repeated tool-error strings clustered by message (`command not found`,
`Forbidden: unscoped_route`, `Exit code 144`), the most-repeated human and manager comment
phrasings, tasks needing more than one run, disk and docker footprint, and the open PR and branch
inventory. Bound every section to top-N.

Everything it computes was computed by hand for this document and none of it is repeatable today.
`scripts/logs.ts` has four views over one marker and nothing aggregates transcripts, disk, cost or
comment phrasings. Reading 184 transcripts (417M) is the whole cost, so keep it off the loop's box
or behind a flag. This is worth building even if nothing else in this section happens — it is the
input to your own next investigation.

### 7.2 The repeated-correction detector

Narrow, deterministic, inside the pack: cluster `comment` rows with `author_kind='human'` (plus
manager relays) by normalised phrase, and flag any cluster spanning three or more distinct tasks.
Output a fixed shape: where the instruction should live — a rule in a seeded instruction file, a
task field, a tool, or a gate — citing the task ids.

Be precise about what this can and cannot see. The corpus is 20 human comments and 12 manager
comments out of 117; regex over them gives 7 distinct tasks for research-first (not 8) and 2 for
"turn this PR into implementation" (not 3). The column is `author_kind`, not `kind` — `kind` is
message/fallback/run_error. And "browser check owed 12", "no Postgres 10", "pre-existing test
failures 10" are **transcript** findings, not comments; a pass over 20 comment rows will never
surface them. Two different detectors, or one that reads both corpora.

The destination is already half-built. PR #43 adds a `proposal` table
(`packages/db/drizzle/20260808150704_proposals/migration.sql`) with path/scope/state
pending→decided_by over seeded instruction files — a run proposes a rule change and a person
decides. Feed the detector into that, not into a parallel card-filing path. Also note #40 renames
comment→task message across the API surface, so write the detector against the table, not the
entity name.

### 7.3 The reflector, and why it is last

Design as proposed: a run on a recurring task, evidence pack mounted read-only, output rows in
`task` with status `ideas`, `metadata.proposedBy='reflector'`,
`metadata.evidence=[{source,ref,count}]`, `metadata.fingerprint=<hash>`, `metadata.runId`;
acceptance non-null; dedupe by fingerprint against every existing task including `done` and
dismissed; cap 3 cards/day; skip entirely if ATM `ideas` already holds 10; Telegram digest with
accept/dismiss, dismissal writing `metadata.dismissed=true` so a fingerprint never returns. It must
read open PRs and branches, not just tasks — otherwise it re-proposes #43.

Four corrections before anyone builds it.

Agents already file cards: `mcp__atm__tasks_create` appears 83 times in `run_event` tool calls, and
creation can already set `metadata` and `parentTaskId`. The missing pieces are the trigger, the
fingerprint dedupe and the cap. Pitch it as that, not as a new capability.

"A manager-role run on a synthetic recurring task" is not dispatchable. `manager` in this codebase
means attached to a chat thread, not a task (`packages/orchestrator/src/subject.ts:60-63`,
`runtime.ts:343`), and the loop only dispatches tasks in `in_progress`
(`packages/db/src/repositories/task.ts:71`) with no scheduler. Daily tick and re-queue are both new
machinery. Make it a worker-role run on a real task, or loop-side code.

PR #39 is a closer conflict than it looks. It already builds "the loop files one card" inside
`sweep`, and `.docs/plan/09-rollup.md:8` argues in writing against exactly this shape: "Nothing
here is a manager run... a model in the loop for count the columns buys nothing and costs a
container." Follow that precedent — anything answerable with a query should be a query.

Effort L is optimistic. Build 7.1, then 7.2 into #43's proposal table, then decide whether 7.3 is
still worth a container.

---

## 8. Proposed task queue

Ordered by impact over effort, quick wins first. "PR" marks an overlap with an open pull request.

| # | id | Title | Eff | Impact | Why | PR |
|---|----|-------|-----|--------|-----|-----|
| 1 | `resume-checks-out-pushed-branch` | Check out `origin/atm/task-<id>` instead of resetting to base in `materializeRepo` (repo.ts:474) | S | high | Three runs documented recovering their own discarded work; a run that misses it rebuilds silently. `repo.ts` in no open PR | — |
| 2 | `prune-images-and-build-cache` | Remove the two 2026-08-03 tags by name + `docker builder prune -af`; add prune to `build-images.ts` | S | high | ~5.7GB back today; nothing has ever pruned. Do **not** use `image prune -a` — it deletes `latest` and `atm.local` has no registry | — |
| 3 | `pg-dump-timer` | `scripts/backup-db.ts` + units in `deploy/user/`, 14 daily + 4 weekly, cover `.data/artifacts` | S | high | Zero backups exist; the whole board is one 89.62MB volume. Dump is 3.1 MB. Phase 9 item 5, never built | — |
| 4 | `commit-early-rule` | One line in `WORKER_RULES`: commit and push as soon as anything works | S | high | 25/73 runs never commit; median first commit at 0.863 of the span | #40 #43 |
| 5 | `bundle-bind-mount` | Bind-mount one `.data/agent-mcp/<digest>.js` instead of `copyAgentBundle` (agent-token.ts:116) | S | high | 321M of 417M is 184 copies in 4 md5s; `.data/runs` drops to ~96M and stops growing | #43 (mounts.ts) |
| 6 | `check-migrations` | `scripts/check-migrations.ts`: assert the `prevIds` chain is linear with one head | S | high | #41 and #43 already fork at `d3dc262e`; git merges both silently. Pure file reads, no services | — |
| 7 | `manager-token-env` | Set `ATM_MANAGER_GITHUB_TOKEN` to a read-only token in `loop.env`; add a startup warning + doc note | S | high | Manager holds a push-capable token to every repo you can write, held back by one bullet of prose. Minting is a human step; the equality branch in runtime.ts:1099 is silent today and `.docs/agent-access.md:57-66` documents the default deliberately, so do not make it fatal | — |
| 8 | `vendor-memory-scope` | Set `autoMemoryDirectory` per project or disable it (`claude-settings.ts:113`) | S | med | 19 files under one `-workspace` key; a peektrace note reaches every ATM run | — |
| 9 | `logs-cli-fixes` | `repo ?? projectId` in logs.ts; `Skill` in `TOOL_SUMMARY_FIELD`; allow-list script names; `pathShape` on atm.request | S | med | Four one-liners; the PROJECT column is `-` on every row and 61 skill calls have empty summaries | — |
| 10 | `eager-load-board-tools` | Set `alwaysLoad` on the atm stdio server (`provider-config.ts:79-92`) | S | med | 391 ToolSearch calls in 178 runs, mostly for `comments_add`, which the stop hook requires | #40 #43 |
| 11 | `out-of-scope-field` | `metadata.outOfScope`, prompt section + dashboard field beside acceptance | S | med | A scope comment aged into a false instruction the manager had to publicly revoke. No migration; merge metadata, don't overwrite | #42 |
| 12 | `fixtures-off-the-board` | Fixture workspace + test `DATABASE_URL` in `run.test.ts`; `metadata.fixture=true` filter | S | med | 4 fixture cards on the live board; `loop:check` already redirects, the test suite does not | #43 (loop-check.ts) |
| 13 | `pr-url-backfill` | `scripts/backfill-pr-urls.ts` matching `head=<owner>:atm/task-<id>` | S | low | 32 done tasks with no link; the script was written in a comment and never filed. Realistic ceiling ~24 rows | — |
| 14 | `sandbox-binaries` | Add python3, jq, bc to `docker/base.Dockerfile` | S | high | 52 of 184 runs hit `python3: command not found`. Sequence after #2 (disk) | — |
| 15 | `browser-image-reachable` | Make `sandbox_image` selectable/defaulted so browser runs get `atm.local/browser` | S | high | The browser is already built and on the host since 7ef5365; all 84 tasks have `sandbox_image` null so every run gets `base:latest`. 12 tasks owed a human a manual check | — |
| 16 | `task-deliverable-mode` | `metadata.deliverable` research\|build, prompt section, `artifactRulesOf` keys off it | M | high | Your most repeated instruction, encoded nowhere; and research on a repo-bearing project opens a plan-doc PR you then convert by hand | #43 |
| 17 | `acceptance-standard` | MANAGER_RULES bullet + schema field descriptions + gate in `repositories/task.ts:279` | M | high | 31 of 84 cards have no definition of done; the gate cannot live in `status.ts` (pure table) and `IllegalTransition` has no message field. Board `rank.ts` needs teaching too | #43 |
| 18 | `evidence-pack-script` | `scripts/evidence-pack.ts`, read-only, bounded sections | M | high | Every number in this document was hand-derived and none of it is repeatable | — |
| 19 | `repo-card` | Per-project repo card into `worker/<project>/AGENTS.md` (branch, verify cmd, layout, PATH, skills) | M | high | Median 34 tool calls and 4.9 min before the first edit. peektrace already has two instruction files — skip it; webMCP-example has none | #43 (mechanism) |
| 20 | `worker-files-followups` | `POST /tasks/:taskId/children` into `ideas`, capped, `metadata.filedBy='worker'` | M | high | 6 runs refused at end of turn; 8 tasks carry an unfiled follow-up brief. `creatableStatuses("worker_run")` already allows `ideas` | #40 #43 |
| 21 | `failure-attribution` | `stopped` outcome, `interruptReason`, containerName at start, cost/turns on the failure path | M | high | A human stop reads as `errored/Unknown`; container_id null on 169/169; 10 of 12 failures record no cost | #40 #43 |
| 22 | `run-row-carries-rollup` | Ledger the turn rows; widen `RunTerminusBase`; join sandbox `oomKilled` onto atm.run | M | high | `logs stats atm.turn` returns 0 while 184 files exist; 5 runs read `done` with an OOM-killed container. `model` is already on the DB row; cache tokens overlap #41 | #40 #43 #41 |
| 23 | `verify-command-declaration` | `project.verifyCommand` + `bun run verify --json` in this repo + name it in the repo card | M | high | 94% of verification output is piped and re-derived; 3.5 of 6.81 Bash hours. Other five repos are separate PRs | — |
| 24 | `data-reapers` | Boot sweep over `.data/runs` and `.data/workspaces` joined against `runs.listLive`; caches runbook | M | med | 26 orphan dirs; a SIGKILL strands a full clone with env files. **Do not age out transcripts** — the run dir is the only full copy and a shipped endpoint reads it | — |
| 25 | `ci-workflow` | `.github/workflows/ci.yml`: install, typecheck, check, test, with a postgres service | M | med | Zero checks on six open PRs; every claim is self-reported. Needs migrate + seed; there is no `verify` script to reuse | — |
| 26 | `gateway-tail-sampling` | Sampling predicate in `event-log.ts` + fix `board.tsx:154`/`:221`, `transcript.tsx:81` | M | med | 69.7% of the ledger is polling; rotates in 34 days not months. Phase 9 item 8. Hidden-tab backoff already works | — |
| 27 | `otel-decide-or-delete` | Write the decision in `.docs/telemetry.md`; drop or convert the 18 metrics; add `logs sql` | M | med | 172 spans and 18 metrics feed nothing; quota pauses have no record at all. traceId **does** join to `audit_entry` — build the viewer | — |
| 28 | `resume-after-non-agent-failure` | Gate resume on the last run's outcome, not session status | M | med | Fired once for $32.61; branch survived, conversation did not. `oom_killed` is not an outcome | — |
| 29 | `repeated-correction-detector` | Cluster human/manager comments, feed #43's `proposal` table | M | med | Nothing counts your repetitions. Comments-only corpus is 20 rows — transcript themes need a second pass | #43 |
| 30 | `role-scoped-tool-table` | Role env var in `stdioEnv`, filter the listing, drop `$defs` | M | low | 13,135 chars of tool table on every turn, 1,391 of it dead schema. The binding does not know the role today | #40 #43 |
| 31 | `verify-gate-at-turn-end` | Enforced verify on the terminus path (not the stop hook), gated on touched source files | L | high | 19 of 49 gh-pr runs verified nothing. Needs the project field, a runner and marker plumbing; the stop hook is deliberately filesystem-only | #40 #43 |
| 32 | `reflector-run` | Fingerprinted, capped, evidence-citing proposer into `ideas` with a Telegram accept/dismiss | L | med | The end state. Build 18 and 29 first and re-evaluate; #39 argues against a model in the loop for anything a query answers | #39 #43 |

---

## 9. Deliberately not proposed

- **A headless browser layer for the sandbox** — already built. `docker/browser.Dockerfile:57-88`
  has had chromium, fonts and agent-browser since `7ef5365` (2026-08-04). The gap is image
  selection, which is item 15.
- **Retry-loop detection, search-quality heuristics, dependency caching, edit-tool reliability** —
  the transcripts say all four are fine (25 duplicate calls in 184 runs, 5 empty searches in 1,853,
  0.5% edit failures, `bun install` in 34 runs at 12.7s median).
- **Pointing `loop:check` at its own DATA_ROOT** — already done,
  `scripts/loop-check.ts:97-106` and `bot-check.ts:101`; `.data/loop-check` exists.
- **A new ledger reader** — `bun run logs` exists with four views; the ask is a `sql` subcommand.
- **"traceId joins to nothing"** — false. `audit_entry.trace_id` is populated on all 13,558 rows
  and 73 traceIds are shared between `gateway.jsonl` and `loop.jsonl`. The join works; the viewer
  is missing.
- **Hidden-tab poll backoff in the dashboard** — TanStack already gates every interval on
  `focusManager.isFocused()`, and `detail.tsx:165` / `runs.ts:68` already stop on settled entities.
- **`docker image prune -a` as a quick win** — reclaims 0 without `-a`, and with `-a` deletes
  `atm.local/*:latest` from a registry that deliberately does not exist, breaking the next run.
- **Ageing out `transcript.jsonl`** — the run directory is the only full copy
  (`transcript-ingest.ts:22-26`) and `GET /tasks/:taskId/sessions/:sessionId/transcript` already
  ships its shape.
- **Documenting or indexing the prompts an agent sees** — `.docs/agent-prompts.md` exists (PR #37
  was closed as folded into #38) and both #40 and #43 rewrite it.
- **The agent filesystem, rules-as-files, dashboard file browser, artifact-promote scoping** —
  all PR #43, 36,247 added lines already written.
- **A review-queue or PR-batching mechanism** — PR #39, `.docs/plan/09-rollup.md`, docs-only,
  mergeable today.
- **Re-parsing transcripts for cost or context-window pressure** — PR #41 adds
  `agent_session_usage` with cache split and a dated price table. Build on it.
- **Adding `.claude/CLAUDE.md` to peektrace** — it already has both `AGENTS.md` and `CLAUDE.md`
  with the typecheck rule in it. Only `webMCP-example` has nothing.
- **Making the manager/worker token equality check fatal** — it would break every manager turn on
  every install without a minted token, including this one, and reverses
  `.docs/agent-access.md:57-66`. Warn, and mint the token by hand.
- **`notes_append` as a standalone win** — once #43 lands, `PROJECT_SCOPE` already makes the
  project directory writable and durable. Only justify the tool on the audit row and dashboard
  visibility.
- **Deleting the fixture cards** — flag them; deleting loses the only record of some early runs.

### Not checked

`.data/caches` eviction was not attempted or measured — the 8.8G bun figure is a `du` reading, not
an analysis of what is cold. The "~21GB in six days" ATM footprint is a sum of current sizes, not a
measured growth series. The eight-task count for "research first" could not be fully attributed:
7 are in comments, the rest are in `chat_message`, which has no per-task join. No service was
started, stopped or restarted, no container was touched, and nothing outside this file was written.
