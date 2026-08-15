# 09: Filesystem redesign

## Recommendation

Delete the index, keep the disk, and make one tree the whole model. `<DATA_ROOT>/files/`
holds house rules, a free `notes/` directory, and `projects/<projectId>/tasks/<taskId>/`
nested exactly as a container sees it. The `artifact` table goes, the `proposal` table goes,
the promote verb goes, and `ArtifactScope` plus `FileScope` collapse into one root-relative
`FilePath`. A worker gets the tree read-only plus its task directory read-write; the manager
gets the tree read-write, so promotion is `mv` by whoever is looking at the file. The
guardrail with a real threat behind it, the worker's read-only parent bind, is untouched. About 6,000 lines
leave, and the file model drops from 22 concepts to 8.

## How it works today

One set of directories carries two vocabularies: `ArtifactScope` in Postgres (task, project,
global) and `FileScope` on the wire (`workspace`, `manager`, `project:<id>`, `task:<id>`).
Two HTTP groups sit over the same bytes, `artifacts` and `files`, and neither can do the
other's job. Two dashboard editors do the same, with different verbs. Host layout is flat,
container layout is nested, and `slugOf` translates. `artifact` rows are a cache rebuilt by a
rescan at run teardown and on upload, so `artifacts_list` is stale mid-run, and the `global`
scope is never rescanned at all. Promotion is a copy plus two rows plus a 409.
Twenty-two concepts, counted in the audit.

## The three hypotheses

**Over-complicated: yes.** Nothing in the second copy is load-bearing.
`packages/db/src/schema/artifact.ts` says in its own header that the table is a cache the
directory rebuilds, and `apps/gateway/src/handlers/files.ts` already reads and writes those
same directories live, with no index in the path. Scope is stated four times for one fact: a
text column, two check constraints, three partial unique indexes, then again as TypeScript
predicates in `packages/db/src/repositories/artifact.ts`. Containment is implemented three
times at three strengths, and `isUnder(root, child)` and `within(child, root)` take their
arguments in opposite orders.

**Blocks growth: yes, and this is the one the owner feels.** `mountsFor`
(`packages/sandbox/src/mounts.ts:608`) sees exactly one nullable `projectArtifactsDir` in its
`MountSources` (`mounts.ts:500`), a task carries
one nullable `projectId`, and `FileMove` is scope-relative on both ends by schema. There is no
path at any layer by which a run on project A reads project B. A bare notes directory
half-exists: the `workspace` scope is editable from `/files`, but no agent tool can list it,
it is never rescanned, and it doubles as the promotion target and the house-rules directory.
No archive endpoint, no search route, no upload or download in the tree browser.

**Over-guards: partly.** `AdminAccess` on all seven `/files` routes including reads is not a
single-user risk, since a signed-in session already holds `admin`, and a person's own API key
can be issued at that scope (`packages/api/src/security.ts:266-276`). What it locks out is
every narrower credential: a read-scoped key and a run's `task-write` token both meet a 403
with no explanation on a read, while the run's mount already holds the same bytes. The editor
pinning `encoding: "utf8"` means no binary can enter a scope through the UI at all. Two caps
for one disk: `MAX_FILE_BYTES = 4_194_304` (`packages/api/src/schemas/file.ts:40`) against
`MAX_ARTIFACT_BYTES = 67_108_864` (`apps/gateway/src/handlers/artifacts.ts:78`). Against
that, three guards are real and stay: the worker's read-only bind, `relativePathRefusalOf`,
and the `realPath` symlink re-check. The weakest write path in the repo is the artifact
upload, whose `path` is an unbranded `Schema.NonEmptyString`; it dies with its route.

## The target

```
<DATA_ROOT>/
  files/                                  # the namespace. one bind, one git repo, one tar
    .atm-root                             # ATM_ROOT_MARKER, unchanged
    .git/  .gitignore                     # .gitignore holds "projects/*/tasks/" and "tasks/"
    AGENTS.md                             # house rules; CLAUDE.md -> AGENTS.md
    .agents/skills/<name>/SKILL.md
    manager/AGENTS.md                     # was FileScope "manager"
    notes/                                # the free directory. no row, no scope, no route
      groceries.md
    projects/<projectId>/                 # was artifacts/projects/<id>
      AGENTS.md
      .agents/skills/<name>/
      architecture.md
      tasks/<taskId>/                     # was artifacts/tasks/<id>. now inside its project
        handoff.md
        report.md
        .atm/proposals/<name>.md
        <repo-slug>/                      # MOUNT POINT: the checkout, gitignored
    tasks/<taskId>/                       # a task with no project. same shape, one level up

  workspaces/<runId>/                     # checkouts. deliberately outside files/
  runs/<runId>/                           # unchanged. sweep.ts and lease.ts read it flat
  mirrors/ caches/ agent-home/ composed-skills/
```

Container mounts, worker on a task in a project:

```
/workspace                                        ro   <- files/
/workspace/projects/<pid>/tasks/<tid>             rw   <- files/projects/<pid>/tasks/<tid>
/workspace/projects/<pid>/tasks/<tid>/<repo>      rw   <- workspaces/<runId>   (cwd)
```

Manager turn: `files/` read-write at `/workspace`. One flag, exactly as today.

Container path is `/workspace` plus the `files`-relative host path. Not the same absolute
string, but one suffix that host and container agree on, which is what kills `slugOf`,
`runTreeOf`, `RunLabels` and the second layout. The project bind disappears: the write bind
sits at the task directory, and project material arrives by proposal (step 7) or by raising
the write root on the card. `SCRATCH_SEGMENT` survives unchanged for a run with no
repository. `nestedMountPointsOf` survives too: `packages/orchestrator/src/chat-turn.ts:248`
and `packages/sandbox/src/workspace.ts:406` both call it, and the checkout mountpoint still
has to be pre-created.

Postgres keeps what has a lifecycle, an actor and a query: `project`, `task`, `run`,
`run_event`, `comment`, `agent_session`, `session_usage`, `api_key`, `audit_entry`, the auth
tables,
and `project_env` (sealed bytes must stay out of a tree that is git-committed and tarred in
the clear). It keeps nothing file-shaped. Disk keeps every byte and every fact a `stat`
answers. History is git, one repository at `files/` instead of one per shared scope, with task
directories ignored, which is what they get today anyway. Backups are unchanged in kind:
`scripts/backup.ts` already tars `<DATA_ROOT>/artifacts`, and now tars `<DATA_ROOT>/files`.

## Access

A run is described by two paths and nothing else: the read root, bound read-only at
`/workspace`, and the write root, the same tree bound again read-write at its nested container
path. The read root defaults to the whole tree, so cross-project reading needs no schema, no
tool and no link type: it is where the read-only bind sits. The write root is the task's own
directory, `projects/<pid>/tasks/<tid>`, or `tasks/<tid>` for a task with no project; a run
whose job is project-wide editing gets its write root raised on the card. The manager is the
same function with a write root of `""`, which is the only thing `managerMountsFor` ever
expressed.

The user widens by moving the file, or by pointing the write root higher on the card. The
manager moves a file out of a task folder into the project or into the house rules with its
own `Bash`, because its bind is read-write. The person does the same in the browser, where a
move is now legal across directories because `FileMove` stops being scope-relative. There is
no promote route, no `PromotionScope`, no 409, no `promoted_at`, and no separate "the actor
must be human" check, which existed only because a run's `task-write` token reached the
promote route.

Still enforced, and by what. The read-only parent bind is enforced by the Docker daemon: a
worker clones untrusted repositories, and a hostile README that rewrites `AGENTS.md` poisons
every later run on every project, which no backup undoes. `relativePathRefusalOf`, wrapped by
one `FilePath` brand, refuses `..`, a leading slash, control characters and a `.git` segment
at the edge, on every route including the upload that has no brand today. One containment
function does the `realPath` re-check, because the gateway runs on the host with the host's
reach while the symlink was planted inside a container. Files reads drop from `AdminAccess` to
`ReadAccess`, and that means the whole tree. `ReadAccess` is satisfied by any credential that
resolves, including a run's task-bound token pointed at another task
(`packages/api/src/security.ts:210-215`), and `checkBinding` exempts reads outright
(`apps/gateway/src/auth/principal.ts:396-399`). Holding a run token to paths under its
`boundTaskId` would be the first read restriction on one anywhere in the repo, over bytes its
mount already grants. Writes, moves and deletes stay admin.

## What this deletes

Counts are `wc -l` on the files named, run in this repo.

- The `artifact` half: `packages/db/src/schema/artifact.ts` 103, `repositories/artifact.ts`
  550, `rows/artifact.ts` 55, `packages/orchestrator/src/artifacts.ts` 243,
  `apps/gateway/src/handlers/artifacts.ts` 626, `packages/api/src/groups/artifacts.ts` 138,
  `schemas/artifact.ts` 63, `apps/dashboard/src/api/artifacts.ts` 119. That is 1,897 lines,
  one table, four endpoints, two check constraints and three partial unique indexes.
- The proposal subsystem: 17 files, roughly 2,900 lines with tests (2,036 outside them),
  across `packages/orchestrator`,
  `apps/gateway`, `packages/api`, `packages/db`, `packages/domain` and `apps/dashboard`, plus
  the `proposal` table and its trigger migration `20260809111400_proposal_trigger`.
- The duplicate dashboard: `features/task/file-viewer.tsx` 480, `features/task/artifacts.tsx`
  208, `features/task/artifact-preview.tsx` 173, `features/task/promote.tsx` 106,
  `features/projects/project-files.tsx` 101. That is 1,068 lines, and one of the two editors.
- The vocabulary: `ArtifactScope` (3 values) and `FileScope` (4 cases) from
  `packages/domain/src/enums.ts` and `file-scope.ts` (177 lines down to roughly 40), and
  `slugOf`, `FALLBACK_SLUG`, `runTreeOf`, `RunLabels`, `WORKER_SEGMENT` from
  `packages/sandbox/src/mounts.ts`. `RunLabels` is not local to that file: it is a required
  field of `MountSources` (`packages/sandbox/src/mounts.ts:498`) and of `MaterializeInput`
  (`packages/sandbox/src/spec.ts:356`),
  `runTreeOf` builds the placement the run prompt prints
  (`packages/orchestrator/src/prompt.ts:51,100`), and `scripts/sandbox-check.ts:93-198,526` is
  built on all three. Deleting the type edits three packages and rewrites that script.
- The spare containment: `containPath` and `resolveExisting` in the artifacts handler, and the
  private `isUnder` in `packages/sandbox/src/env-files.ts:80`. Three implementations become
  one, with two roots.
- One number: `MAX_FILE_BYTES = 4_194_304`. The 64 MiB cap moves onto the files routes.

## Migration

1. Remove a deleted task's directory. Ships first and on its own, because the bug is already
   there: the `artifact.task_id` cascade dropped index rows and nothing else
   (`packages/db/src/repositories/task.ts:370-373`), so `artifacts/tasks/<id>` survives every
   task delete today and the tree is accumulating orphan folders. Add the directory removal to
   the delete path (`apps/gateway/src/handlers/tasks.ts:182` and the repository behind it).
2. Move containment into `@workspace/domain`, beside `relativePathRefusalOf`, which is the one
   home the gateway, the sandbox and the dashboard all reach. `within` and `resolveInScope` from
   `apps/gateway/src/handlers/scope-paths.ts:114,211`, `realPath` re-check kept. Not a straight
   lift: `resolveInScope` fails through `escaped()`, which builds a `Forbidden` from
   `@workspace/api` (`scope-paths.ts:29,67`), and `packages/sandbox` does not depend on that
   package. The error channel becomes caller-supplied — the function reports that the path left
   its root, the caller names the failure, `scope-paths.ts` keeps its `Forbidden`.
   `packages/sandbox/src/env-files.ts` drops its private `isUnder` for `within`, still rooted at
   `input.workspaceDir` (the checkout, not the tree). No behaviour change.
3. Relax the files routes. `packages/api/src/groups/files.ts`: `ReadAccess` on `list` and
   `read`, `AdminAccess` on the five mutations. `apps/gateway/src/handlers/files.ts`: replace
   the `editorOf` `Forbidden` branch (lines 129-142) with a loop-identity committer fallback.
   No path filter goes with it — a read reaches the whole tree, for the reason in "Access".
   Roughly 20 lines. Ships alone.
4. Delete promotion. The route in `packages/api/src/groups/artifacts.ts`, `PROMOTION_SCOPES` /
   `PromotionScope` / `ArtifactPromotion` in `schemas/artifact.ts`, `ArtifactAlreadyPromoted`
   in `packages/api/src/errors.ts`, `promotionTargetOf` and `promoteTaskArtifact` in
   `apps/gateway/src/handlers/artifacts.ts`, `promote` / `conflictOf` / `globalScoped` in
   `packages/db/src/repositories/artifact.ts`, `auditPromote`, `promoteArtifact` in
   `packages/sandbox/src/artifacts.ts`, `features/task/promote.tsx` and the badges and error
   strings that name it. Migration drops `promoted_at`, `content_hash`,
   `source_artifact_id`, `artifact_source_artifact_id_idx` and
   `artifact_workspace_id_path_uidx`.
5. Dashboard before server. Point the task Files tab and the Projects screen at the existing
   `apps/dashboard/src/features/files/browser.tsx`, pinned to `task:<id>` and `project:<id>`,
   and delete the five components in the list above. This is what makes step 6 a deletion
   rather than a rewrite, and it closes "no action at all on project files" on the way past.
6. Delete the artifact table and the rescan. The eight files in the deletes list, plus
   `scanArtifacts` / `statArtifact` / `SCAN_SKIP_DIRS` / `copyArtifact` from
   `packages/sandbox/src/artifacts.ts`, `Artifact` and `ArtifactStat` from
   `packages/domain/src/artifact.ts` (keep `HANDOFF_FILENAME`), `ArtifactsGroup` from
   `packages/api/src/api.ts` and `ArtifactRepo` from `packages/db`. Repoint `artifacts_list`
   and `artifacts_read` (`packages/agent-tools/src/tools.ts:324-383`) at `client.files.list` /
   `client.files.read`: same two names, same 19-tool table, a path instead of an id. Migration
   drops `artifact`. `artifactClaims` (`scripts/gateway-check-claims.ts:580-620`) asserts the
   OpenAPI carries `/tasks/{taskId}/artifacts` and then exercises upload, list and read, so it
   goes with its call site at `scripts/gateway-check.ts:369`, and `openapi.json` is regenerated.
7. Delete the proposal subsystem, keep the convention. The 17 files, the table and the
   trigger. `packages/prompts/src/rules.ts` keeps two sentences: write
   `.atm/proposals/<name>.md` in your own directory with one `to:` key naming a `FilePath`,
   and say in your message that you did. The file browser shows it and the manager can move
   it, which is what the panel was for. The eight refusal reasons go. The accepted/declined
   record stays without a table: the files `move` and `remove` handlers write an `audit_entry`
   row when the path is under `.atm/proposals/`, so accepting (`mv`) and declining (`rm`) each
   leave one line.
8. One namespace, one layout, one mount table. This is the big one and it cannot be split,
   because the bytes and the mounts move together. Rename `ARTIFACTS_SEGMENT` to `files` and
   move the tree: `mv artifacts files`, `mv files/global/* files/`,
   `mv files/tasks/<id> files/projects/<pid>/tasks/<id>` per task with a project,
   `mkdir files/notes`. Collapse `packages/domain/src/file-scope.ts` to one root-relative
   `FilePath`. Rewrite `mountsFor` and `managerMountsFor` onto the read-root / write-root
   shape and delete `slugOf`, `FALLBACK_SLUG`, `runTreeOf` and `RunLabels`; keep
   `nestedMountPointsOf`. Deleting `RunLabels` reaches past `mounts.ts`: it leaves
   `MountSources` (`packages/sandbox/src/mounts.ts:498`) and `MaterializeInput`
   (`packages/sandbox/src/spec.ts:356`),
   `packages/orchestrator/src/prompt.ts:51,100` stops calling `runTreeOf` and reads the two
   roots instead, and `scripts/sandbox-check.ts:93-198,526` is rewritten around them.
   `scripts/loop-check.ts:171,258` computes a task directory with `taskArtifactsDirOf`, which
   now needs the project.

   Delete the per-project git repositories rather than grafting them.
   `packages/sandbox/src/history.ts:412-418` inits one repository per shared scope (the scope
   directories come from `history.ts:171-201`), so
   `artifacts/projects/<pid>/.git` exists today, and after the `mv` git reads each one as a
   gitlink whose contents the root repository never tracks. Grafting means rewriting every path
   in every commit of every project; what those histories hold is a few weeks of edits to
   shared notes, so they are worth less than the rewrite. Point `history.ts` at the one
   repository at `files/` and let it take the first commit.

   Every sentence that states the mount boundary changes, and
   `packages/prompts/src/render.ts:98-128` is not the only one. `artifactRulesOf`, `scopeLines`,
   `SCRATCH_RUN_ARTIFACTS`, `REPO_RUN_ARTIFACTS` and `PROPOSAL_RULES` in
   `packages/prompts/src/rules.ts`, and `NO_MESSAGE_REFUSAL` in
   `packages/harness/src/stop-hook.ts:249`, all name "your task's artifacts directory" and all
   describe a shared directory the run cannot write.

   The reparent move lands in this same change, not after it: once a task's path is computed
   from its `projectId`, two ordinary edits strand a directory. `TaskPatch` carries `projectId`
   (`packages/api/src/schemas/task.ts:84`), so reparenting a card leaves
   `files/projects/<old>/tasks/<tid>` behind while every reader resolves the new path, and
   deleting a project nulls `project_id` instead of cascading
   (`packages/db/src/schema/task.ts:85`, `packages/db/src/repositories/project.ts:186`), so
   its tasks all resolve to `files/tasks/<tid>` with their files under a project that is gone.
   Both paths `mv` the directory in the transaction that writes the row — same filesystem,
   refuse if the destination exists. Shipped apart, an edit nobody reads as destructive loses
   files.

   Also update `packages/sandbox/src/instruction-budget.ts` (`levelsOf` gains one level),
   `apps/gateway/src/handlers/scope-paths.ts`, `packages/api/src/groups/files.ts` and
   `schemas/file.ts` (no `:scope`, `FileMove` no longer scope-relative),
   `apps/dashboard/src/features/files/scopes.ts` and `lib/scope-path.ts`, and `ARTIFACTS_FILE`
   in `scripts/backup.ts`; `packages/orchestrator/src/seed.ts` creates `files/notes/`. Delete
   the dead mount points at `docker/base.Dockerfile:252`:
   `/artifacts/task`, `/artifacts/project` and `/artifacts/global` are pre-created there and
   nothing has mounted on them since `mountsFor` put the scopes under `/workspace`. Run with
   the loop stopped, from a backup.
9. Skills onto the same vocabulary. `packages/api/src/groups/skills.ts` (170) drops
    `FileScopeAddress` and the `/skills/:scope` segment for a `path` query;
    `apps/gateway/src/handlers/skills.ts` (689) swaps `scopeRootOf` for one path resolve at its
    five call sites; `apps/gateway/src/handlers/skills.test.ts` (479),
    `apps/dashboard/src/api/skills.ts` (136) and the three components under
    `apps/dashboard/src/features/skills/` follow. Roughly 1,500 lines, and no proposal in the
    batch had budgeted a line for it.
10. Correct the record. `.docs/plan/08-agent-filesystem.md`: drop the vault section (no code
    behind it) and the hash-compare overwrite promise at lines 115-117 (never built).
    `.docs/plan/00-high-level.md:239,270-272`: the promotion tool never existed, and the
    manager mounted `artifacts/global` rather than the root, which step 8 makes true.
    `.docs/plan/03-data-model.md:75`: no artifact table, no scopes.

`runs/<runId>` stays flat and outside the tree. `packages/sandbox/src/sweep.ts` joins on that
shape and `packages/orchestrator/src/lease.ts` reads the event log from it; moving it buys a
per-task tarball and costs both.

Archive, streaming download, multipart upload, the binary editor and search are additions,
not deletions, and they get a follow-up plan after step 10 lands. The archive route's
subprocess question — `tar` spawned from the process holding the GitHub token and the
database credentials — is decided there, not here.

## What gets worse

A worker cannot hand a document straight to the project: its write bind stops at its own task
directory, so project material moves by proposal plus a manager `mv`, or by a person raising
the write root on the card. That is one hop more than a shared writable directory. The trade
bought is that a prompt injection in a cloned README cannot overwrite a sibling task's
evidence or the project's `AGENTS.md`.

A worker can read every task folder and every project, because the read-only bind moved up to
the tree root. That is the cross-project win and the exfiltration risk in one line.

Provenance dies. `last_run_id` answered "which run last touched this file"; after this, git
history answers it for the shared directories and nothing answers it for a task folder. So do
`content_hash` and `promoted_at`: "have these two copies parted company" and "when did somebody
decide to keep this" need a diff by hand.

The eight proposal refusal reasons go. Git records what landed, and accept and decline each
leave one `audit_entry` row (step 7), but what a run asked for and why it was declined stops
being structured. Pending proposals that were never decided are gone at the migration.

No SQL over files. "Every file over 1 MB", "files touched by run X", "everything modified this
week" become directory walks. Listing a folder is a `readdir` plus a `stat` per entry on every
request, which is fine for one owner's board and slow for a folder holding ten thousand
scraped files.

Directory names become ids. `projects/<projectId>/tasks/<taskId>` is computable from an id
with no lookup and survives a rename, but a person in a shell sees uuids, and the uuid now
appears in container paths and therefore in transcripts, which `slugOf` avoided on purpose.
The dashboard decorates the rows from `apps/dashboard/src/api/board-cache.ts`. A slug instead
would mean a directory move on every rename — the failure class step 8's reparent handling
exists to contain — so ids stay.

A worker's cwd gains one path level, paid in tokens on every bash line of every run.

One git repository serialises every commit, and grows monotonically with nothing pruning it.
The per-project histories it replaces are deleted rather than carried across, so every edit to
a project's shared notes before the migration is unrecoverable from git.

Step 8 moves bytes and schema together with the loop stopped. The rollback is the backup, not
a revert.

## Open questions

None. The four from the first draft are decided in the body: the write bind sits at the task
directory ("Access"), accept/decline is an `audit_entry` row (step 7), directories are ids
not slugs ("What gets worse"), and archive, upload and search wait for a follow-up plan
(noted after the steps).
