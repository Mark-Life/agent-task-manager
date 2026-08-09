# Agent filesystem — what was decided

Settles the unresolved list in `08-agent-filesystem.md`. Read that first; this is the delta.

Two research findings changed the design rather than confirming it. Both are recorded under D4 and D6.

## The tree, as built

Worker run:

```
/workspace/                              workspace scope, READ-ONLY to a worker
│   .atm-root  CLAUDE.md  AGENTS.md        host: <dataRoot>/artifacts/global
├── manager/                              manager scope (a worker never walks into it)
├── worker/<project>/                     project scope, RW
│   │   CLAUDE.md  AGENTS.md               host: <dataRoot>/artifacts/projects/<id>
│   └── <task>/                           task scope, RW
│       │   CLAUDE.md  findings.csv        host: <dataRoot>/artifacts/tasks/<id>
│       └── <repo>/                       the clone, RW — cwd
│               .git/  AGENTS.md           host: <dataRoot>/workspaces/<runId>
```

Manager turn:

```
/workspace/                              workspace scope, READ-WRITE to a manager
└── manager/                              manager rules, RW — inside the workspace bind
    └── scratch/                          dies with the turn — cwd
```

## D1 — no `<user>` segment

Dropped. Exactly one user's directory is ever mounted into a run, so the segment is a constant, and
a constant in every path answers no question. Who owns the tree is decided by which host directory
the mount points at. Multi-user changes that host path, not the container path.

One constant to flip if this turns out wrong.

## D2 — a task with no project gets a shallower path

`/workspace/worker/<task>/`, not `worker/_/<task>/`. The existing code already refuses to mount a
placeholder at the project artifacts path, on the grounds that an empty directory the agent can open
is a lie it can read. Same rule, same reason.

## D3 — workspace scope is read-only to a worker, read-write to the manager

Project and task scope are read-write to both.

The governance table already says a worker's write above its own task scope is a proposal. A mount
flag enforces that by construction; a rule in a prompt does not. A worker clones arbitrary
repositories, so this is the one scope where the difference matters.

A worker proposes by writing into its own task scope, which it can write. See D11.

Unchanged from today in practice: the global artifacts folder is already mounted read-only. What
changes is the manager, which gains write access to it.

## D4 — raise `project_doc_max_bytes`, and warn at write time

Codex spends one 32 KiB budget across every `AGENTS.md` it collects, **root first**
(`codex-rs/core/src/agents_md.rs:58,76`). So with four levels stacked, the deepest and most specific
document — the task's — is the first thing truncated. That is backwards from what the nesting is for.

Truncation is silent. The only signal is a `tracing::warn!`, and `codex exec` filters stderr at
`error` by default (`codex-rs/exec/src/lib.rs:165`), so nothing reaches a non-interactive caller.

Both halves, because neither is enough alone:

- `project_doc_max_bytes = 262144` in `$CODEX_HOME/config.toml`. There is no upper clamp. The cost is
  context, not correctness.
- A warning when the combined size of a run's instruction files passes 32 KiB, emitted where a person
  writing them can see it. A raised cap moves the cliff; it does not remove it.

`$CODEX_HOME/AGENTS.md` is read with no cap and does not count against the budget. It is still the
wrong home for anything scoped — it is per-install and the vendor rewrites the directory in place.

## D5 — `project_root_markers = [".atm-root"]`, in `config.toml`, not on the command line

Two things the source settles:

- **Not `-c`.** The exec-server config path derives markers from the system and user `config.toml`
  only and ignores CLI overrides (`codex-rs/config/src/loader/local.rs:114-134`). The key goes in
  `$CODEX_HOME/config.toml`.
- **Replaced, never extended.** `[".atm-root", ".git"]` defeats itself: the walk is
  nearest-ancestor-first, so the checkout's own `.git` matches before any marker above it.

Four consumers, all checked: `AGENTS.md` collection, `.codex/` config-layer discovery (which carries
hooks and exec policies), the project-trust key, and `.agents/skills` roots. Widening the walk adds
the three directories this system owns. The repo clone already contributed its own `.codex/` under
the old marker, since it was both the project root and the working directory, so nothing new is
exposed from the untrusted side.

Sandbox writable roots, the turn-diff root and worktree hook redirection all hardcode `.git` and are
unaffected.

## D6 — skills: the layout lands, and Claude is handed a composed copy

Real files at `<scope>/.agents/skills/<name>/`, a **relative** symlink at
`<scope>/.claude/skills/<name>` pointing at `../../.agents/skills/<name>`. Codex reads the real path,
Claude reads the link, one thing to edit.

**Claude cannot walk the tree, and the plan was wrong about this.** Claude's project-skill scan runs
from the working directory up to *the repository root* and stops. The working directory is the clone,
so every scope directory sits above the stop. Verified live, not read off a page: a skill one level
above a `git init` did not load while four inside it did.

Claude's CLAUDE.md walk has no such stop — it reaches the filesystem root, past the repo and past
`$HOME` — so instruction files at every level work on both providers. Skills are the asymmetry.

**Corrected in this build.** The walk happens on the host instead. Materialization composes one
directory per run out of the agent home's own `skills`, the install's shared directory and each
scope's two spellings, and mounts it read-only at `/agent-home/skills` — the one path Claude's
personal scan reads whatever its working directory is. Broadest first, so a name defined twice
resolves to the narrowest level, and the operator's own skills are a source rather than something the
mount hides. Nothing about the on-disk layout moved.

## D7 — nothing on the host moves, and there is no migration

The nesting is a remapping of container destinations. Host layout is untouched:
`<dataRoot>/artifacts/{global,projects/<id>,tasks/<id>}` and `<dataRoot>/workspaces/<runId>` stay
exactly where they are, keyed exactly as they are.

Artifact rows are keyed by a path relative to the scanned root, and the scan reads the task's host
directory — which is not the one the clone is mounted into. No row, no URL and no index changes.
Existing artifacts on the running install need nothing done to them.

One consequence to know about: docker creates a nested bind's destination directory through the
parent bind, so each scope directory acquires one empty child naming the level below it — a `worker/`
inside the global folder, a `<task>/` inside a project folder. They hold nothing. `scanArtifacts`
drops directories, so they produce no rows.

**Built differently:** the file browser does not hide them. The API cannot tell a mount point from an
empty folder a person made, and inventing a name blacklist would hide a real `worker/` somebody wrote.
They draw as empty folders and the pane says so.

Because the workspace scope is read-only (D3), those mount points cannot be created by the daemon at
start time. `materialize` pre-creates them from the mount list itself.

## D8 — the working directory stays the repo clone

Deepest level, so both providers walk the whole tree at launch. A run with no repository starts in its
task scope instead. Claude loads a nested `CLAUDE.md` below its working directory only on demand, so
starting anywhere shallower would leave the specific rules unread.

## D9 — path segments are slugs, not ids

`<project>` and `<task>` are slugs of the project name and the task title. Exactly one of each is ever
mounted, so two projects sharing a slug can never collide inside one container. Ids stay out of paths
a transcript can leak, which is the rule `/workspace` already follows. A rename relabels the next run
and moves nothing, because the host directory is keyed by id.

## D10 — local sandbox mode keeps the rules in its prompt

A local turn runs as a host process with no mounts, so it has no tree to walk: its working directory
is `<dataRoot>/workspaces/<runId>`, whose parents hold nothing. Moving house style onto disk would
silently drop it for that mode.

So the prompt builders take `instructionsOnDisk`, and state the writing rules only when it is false.
The rule is explicit rather than implied: the prompt carries house style exactly when the filesystem
cannot.

## D11 — a worker proposes with a file, because it cannot write the scope

`<taskScope>/.atm/proposals/*.md`, front-matter naming the target path. The loop reads them after the
run and records them pending and inert. This is the shape the handoff file already uses, and it falls
out of D3 rather than being invented beside it.

## D12 — revisions are git, not a table

The brief asks for append-only revisions with an author and the run that raised them. The shared
scopes are git repositories snapshotted before and after every run, so that already exists: the
author is the committer, the run id is the message, and `git log` is the query. A second revision
store would be a worse copy of it.

What went on the run row is the commit each shared scope was at when the run started. That points at
bytes somebody can still read, which a content hash would not.

## Still open

- Vault sync, and secrets in the vault. Untouched by this build, by the card's own scope.
- Where the vault sits relative to `.atm-root`. It is a hole in the tree the later card fills.
- The composed skills directory sits under the run directory, which is also bound read-write at
  `/run`. A run can edit its own copy there; the mount every later run reads is composed fresh.
- A skill whose only spelling is a link under a *different* name is composed twice, once per name.
  Deduplication is by name, and the copies are separate directories.
- A person's commit is authored as their user id rather than a name and mailbox.
