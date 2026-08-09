# Disk (`DATA_ROOT`, default `.data`)

Everything this system keeps outside Postgres is under one root. This page says what each
directory is, **what removes it**, and what to do when the disk gets tight — because for two of
these the answer is "nothing removes it, by design", and a design decision an operator cannot
find is indistinguishable from a leak.

| Path | What | What removes it |
| --- | --- | --- |
| `runs/<runId>` | the turn spec, the normalized event file, and the run's transcript at full length | the boot sweep, once the run has no row |
| `workspaces/<runId>` | the run's checkout: a full repo clone, with the project's env files in it | the run's own teardown; the boot sweep after a kill |
| `composed-skills/<runId>` | the skills that run was handed, copied out of the scopes | the run's own teardown; the boot sweep after a kill |
| `mirrors/<host>/<owner>/<name>.git` | one bare clone per repository, cloned once and fetched per dispatch | the boot sweep, once no project and no task names the repo |
| `caches` | the package store every worker run shares | **nothing** — see below |
| `artifacts/{global,projects/<id>,tasks/<id>}` | promoted work, the house rules, the skills | **nothing** — this is the output |
| `leases` | one file per claimed task or conversation | the loop, at boot and on every ordinary ending |
| `events` | the wide event ledger, one file per service | itself, at 64 MiB a file, keeping one previous generation |
| `bin` | `turn.js` and `agent-mcp.js`, one file each | `bun run entrypoint:build` / `agent-mcp:build`, which rename over them |
| `quota/usage.json` | the last quota reading, which the gateway serves | itself, rewritten per poll |

Backups are **not** in here. `atm-backup.timer` writes to `<DATA_ROOT>-backups`, deliberately
beside it, so the `rm -rf` that takes the data root does not take its backups with it —
`deploy/README.md` covers the restore.

## The boot sweep

The loop reconciles the data root at boot, in the same pass that reclaims stale leases and
removes the containers a killed process left behind (`.docs/orchestrator.md`). Each tree is
joined against the database, and the three joins are different questions:

- **A run directory is kept while its row exists**, live or finished a year ago. Not while the
  run is live — the transcript on disk is the whole conversation at full length, `run_event`
  rows are clipped, and `GET /tasks/:taskId/sessions/:sessionId/transcript` promises it back. So
  the only run directory this removes is one whose row is gone, which is what a deleted task
  leaves behind: the rows cascade, and nothing used to follow them onto disk.
- **A checkout and its skills composition are kept while the run is live.** Both are scratch that
  the run's own teardown removes on every ordinary ending. The sweep is for the ending a
  teardown cannot survive — a `SIGKILL` to the loop, a host that reboots — which otherwise leaves
  a repo clone with the project's environment files in it and nothing that will ever remove it.
- **A mirror is kept while any project or task still names its repository.** Deleting a project
  in the dashboard used to leave its mirror forever. A mirror is a cache, so the worst case of
  removing one somebody wants back is a single cold clone on the next dispatch.

Two safety rules are worth knowing before you read a boot log:

- **A directory it cannot attribute is left alone.** Under `runs/`, `workspaces/` and
  `composed-skills/` a directory is only ever removed when its name is a run id; under `mirrors/`
  only a `*.git` directory at the host/owner/repo depth is a candidate, which is also what keeps
  it off the staging directory an interrupted `git clone --mirror` leaves.
- **A read that failed cancels the join it fed.** A keep set built from an unreachable database
  is a keep set missing entries, and every missing entry is a directory that would be deleted —
  so an incomplete answer sweeps nothing and warns. A boot that reclaims no disk costs you a
  `du`; the other way round costs a run.

What it says, every boot:

```
recovered — 0 stale leases reclaimed, 0 runs closed as lost, 0 orphan containers removed
swept — 26 run directories, 4 checkouts, 4 skills compositions, 1 repository mirrors
```

Anything it actually removed is named at `INFO` with its full path on the line above, so a
mirror or a checkout that went is greppable after the fact.

## When the disk gets tight

**`caches` is the first thing to look at, and deleting it is the supported answer.** It is the
package store `/cache` points every package manager at, shared by every worker run because that
sharing is where the dedupe comes from. Nothing evicts from it and nothing ever will: there is
no per-run or per-project scoping to unpick, and the whole point of the directory is to be warm.
On the first host measured it was 9.1G against 232M of mirrors and well under a gigabyte of
everything else, so it is not a close call — it is the only directory here that grows without
bound in normal operation.

**Act at 10G, or when the filesystem holding `DATA_ROOT` drops under 15% free, whichever comes
first.**

```bash
du -sh "${DATA_ROOT:-.data}"/*        # confirm it is caches and not something new
bun run service:stop                  # or wait for the board to be idle
rm -rf "${DATA_ROOT:-.data}/caches"
bun run service:start
```

Stop the loop first, or do it when nothing is running. The directory is bind-mounted into every
live container, and deleting it under a run that is mid-`install` fails that run. The cost of the
delete is one cold install on the next run per package manager it uses; the loop recreates the
directory itself.

Everything else has an owner. If `du` says the weight is somewhere other than `caches`:

- **`artifacts` is the output**, and nothing here will ever delete it. A task's folder is deleted
  with its task; a project's with its project.
- **`runs` is bounded by the run table.** If it is large and the sweep is removing nothing, the
  rows exist and the transcripts are wanted. Deleting the tasks deletes the rows, and the next
  boot takes the directories.
- **`mirrors` is one bare clone per repository in use.** A single large monorepo is the usual
  answer, and it is load-bearing — deleting it costs a cold clone on the next dispatch, no more.
- **`events` is bounded at roughly 128 MiB per service** by its own rotation. If it is bigger
  than that, `EVENT_LOG_DIR` is pointed somewhere shared and something else is writing there.
