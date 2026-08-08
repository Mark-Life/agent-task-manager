# Agent filesystem — one nested tree, scoping by path

No abstraction over rules. One nested filesystem per run, where **directory depth is the scope**,
because both providers already read instruction files along the path and concatenate them root-down.

A developer who knows how `CLAUDE.md` and `AGENTS.md` work already knows this system. That is the
point of choosing it over a rule store.

Serves three backlog cards at once: runtime-editable rules, the shared global filesystem with the
Obsidian vault, and project-level artifacts a later task can reference.

## What the providers actually do

Verified before designing on it. Claude from the docs; Codex from source.

**Claude Code** walks **up** from cwd and concatenates root-down to cwd — deepest file last, so it
wins by position. `CLAUDE.local.md` is appended after `CLAUDE.md` in each directory. Files in
subdirectories below cwd load on demand, when a file in that subtree is read. Imports work with
`@path`, relative to the importing file, max four hops. `$CLAUDE_CONFIG_DIR/CLAUDE.md` is injected
(confirmed from use; the docs only mention `~/.claude/CLAUDE.md`). Claude does **not** read
`AGENTS.md`. Skills come from `.claude/skills/` at cwd and every parent up to the repo root.

**Codex** walks up until it finds a `project_root_markers` entry, default `[".git"]`, then collects
every `AGENTS.md` from that root down to cwd. **No marker found means cwd only** — no parent
traversal at all. Concatenated, deepest wins by position. `$CODEX_HOME/AGENTS.md` is prepended,
separated by `--- project-doc ---`. `project_doc_max_bytes` caps project docs at **32 KiB combined**,
truncating mid-file with a warning invisible in the TUI. Skills come from `.agents/skills` root-down
plus `$HOME/.agents/skills`; `$CODEX_HOME/skills` is the deprecated path.

Sources: `codex-rs/core/src/agents_md.rs`, `codex-rs/codex-home/src/instructions/mod.rs`,
`codex-rs/ext/skills/src/host_roots.rs`, `code.claude.com/docs/en/memory.md`.

## The tree

Worker run:

```
/workspace/<user>/                    workspace scope, RW
│   .atm-root                           the Codex marker
│   CLAUDE.md  AGENTS.md                house rules, every run
│   vault/                              the Obsidian vault
├── worker/<project>/                  project scope, RW
│   │   CLAUDE.md  AGENTS.md            per-repo conventions
│   │   research-2026-08.md             durable, a later task references it
│   └── <task>/                        task scope, RW
│       │   CLAUDE.md  AGENTS.md        rare, but free
│       │   findings.csv                this run's output
│       └── <repo>/                    the clone, RW
│               .git/  AGENTS.md  .claude/CLAUDE.md
```

Manager turn:

```
/workspace/<user>/                    workspace scope
│   .atm-root  CLAUDE.md  AGENTS.md  vault/
└── manager/<session>/                scratch, deleted with the turn
        CLAUDE.md  AGENTS.md            manager-only rules
```

The manager's cwd sits under `manager/`, never under a project — which answers, for free, whether
project rules reach a manager turn. They do not.

`/run`, `/cache`, `/agent-home` and `/opt/atm/turn.js` are unchanged.

## cwd and the marker

Starting higher is not enough on its own: with no marker above cwd, Codex reads one file.

| cwd | markers | Claude | Codex |
|---|---|---|---|
| repo | `[".git"]` (default) | all levels | repo only |
| task dir | none | all levels | task dir only |
| **repo** | **`[".atm-root"]`** | **all levels** | **all levels** |

Build the third row. cwd is the repo, an empty `.atm-root` sits at `/workspace/<user>/`, and the
Codex config the entrypoint already writes sets `project_root_markers = [".atm-root"]`. Codex then
walks past the repo's own `.git` up to the marker and collects everything root-down, including the
repo's committed `AGENTS.md`. Claude does that walk natively and needs no config.

Everything is preloaded. Nothing relies on the on-demand path, which for Codex is a prompt
instruction rather than a loader guarantee.

The list must be **replaced**, not extended: the walk stops at the first marker found, and `.git`
sits below `.atm-root`.

## Mounts stay separate

**Nesting the destinations is not merging the binds.** Four binds at nested paths, each keeping its
own read-only flag. The daemon mounts a parent before anything under it, which is already why
`/agent-home/skills` works as a bind inside a bind.

One bind of `/workspace/<user>/` would hand every run every project and every task. The mount set is
the security boundary and stays closed by construction — `mountsFor` still builds it, only the
container paths get longer.

A container sees only what is listed, so sibling users, other projects and other tasks are absent by
default rather than hidden.

## Scopes and writability

| Scope | Access | For |
|---|---|---|
| workspace | RW | house rules, the vault, reference material for every run |
| project | RW | durable material a later task in the same project references |
| task | RW | this run's own output |
| repo clone | RW | the work |

**Project scope changes from read-only to read-write.** The use case is a research task writing a
document a later task builds on, and it outweighs what the read-only mount was buying. Attribution
does not depend on that flag: `artifact.lastRunId` is already a column with an index and a relation
back to the run, and `copyArtifact` already records a sha256. What the flag bought was
*deliberateness*, not attribution.

The one real loss is overwrite. Two runs writing different filenames never collide; the failure is a
run replacing an existing path, and the old bytes are kept nowhere. **Guard: a write into a shared
scope where the path exists with a different hash keeps the old bytes.** No locking, no review.

`promoteArtifact` stops being the only door into project scope. The verb stays for the human and
gateway path, where a promotion is a decision rather than a side effect.

## Instruction files, by level

What a human puts where, using files they already understand:

- `/workspace/<user>/CLAUDE.md` — house style, every run of both roles. Where `WRITING_RULES` goes.
- `/workspace/<user>/manager/CLAUDE.md` — how the manager answers.
- `/workspace/<user>/worker/<project>/CLAUDE.md` — that project's review and coding conventions.
- `<task>/CLAUDE.md` — rare, and free.
- `AGENTS.md` beside each, or one file and a symlink, or `CLAUDE.md` containing `@AGENTS.md`.

Leave `/agent-home` alone. It is shared across runs, the vendor rewrites it in place, and it is
per-install rather than per-workspace, so it is the wrong home for anything scoped.

## Skills

Per-level skills directories, discovered by the same root-down walk: `.claude/skills/` for Claude and
`.agents/skills/` for Codex, at any level of the tree. Our current `/agent-home/skills` mount is on
the path Codex's source marks deprecated, so a workspace-level `.agents/skills` replaces it for that
provider.

**One copy, two names.** Real files live at `<scope>/.agents/skills/<name>/`, and
`<scope>/.claude/skills/<name>` is a symlink to them. Codex reads the real path, Claude reads the
link, and there is one thing to edit. This is what the skills.sh CLI does and what this repo and the
operator's home already look like.

The link is **relative** — `../../.agents/skills/<name>` — never an absolute host path. Both
directories sit at the same scope level inside the same bind, so a relative link resolves inside the
container; an absolute one points at a host path the container cannot see.

**A skill is installed by writing files. There is no installer to run.** Two paths, both from the
dashboard, both producing that same pair:

- **GitHub.** Give an owner, repo and path to a `SKILL.md`. The gateway fetches it with the token it
  already holds, writes the files under `.agents/skills/<name>/`, creates the `.claude/skills/` link,
  and records source, path and sha256. Same four fields as `skills-lock.json` today, one lock row per
  scope. Update is re-fetch, compare hash, show the diff, confirm. A diff is reviewable in a way
  `npx skills update` is not.
- **The file browser.** Create the skill, write `SKILL.md`. The UI creates the directory and the link
  together, so a hand-written private skill is not a second layout to remember.

**No terminal.** A shell in the dashboard runs as the loop process, which holds the GitHub token, the
database credentials and the agent-home logins. If one is ever wanted, the safe shape is a throwaway
container with only the target scope mounted read-write, and it is an escape hatch rather than the
install mechanism.

A **worker run** still may not install skills mid-task: that is one run editing what every later run
is given, with no author. The restriction is about the run, not about the person.

## What leaves `rules.ts`

Test: **does the text describe a mechanism this build implements?**

- **Stays in code.** The message rule (a stop hook enforces it), `artifactRulesOf`, `CREDENTIAL_RULES`,
  board policy, anything naming a tool. Text that disagrees with its mechanism is a bug.
- **Moves to the tree.** `WRITING_RULES`, the size guidance inside `WORKER_RULES` and `MANAGER_RULES`,
  coding rules, per-project conventions.

`artifactRulesOf` gains a line per scope saying what each level is *for*. `placementSection` already
says "`<url>` is cloned at `<path>`" — only the paths get longer.

## Governance — unchanged by the filesystem

The tree solves storage and delivery. It does not answer who may write, so this half survives intact.

| Actor | Reach |
|---|---|
| Human | any path, any scope, via API and UI |
| Manager | workspace and project, direct |
| Worker | its own task scope directly; anything shared as a proposal |

A worker clones arbitrary repositories. One that writes `/workspace/<user>/CLAUDE.md` after reading a
hostile README has changed every later run on every project. A worker write above its own task scope
lands pending and inert.

Revisions are append-only, with an author and the run that raised them. The run event carries the
tree hash it was given, so "which rules did that run have" is one join. A rule change reaches a
session only when that session is fresh — already true, since a resumed prompt restates no rules.

## Build order

1. **Nest the mounts.** Container paths change, `mountsFor` still closes the set, project scope goes
   RW with the overwrite guard, `.atm-root` and `project_root_markers` land. No new storage.
2. **Move the content out of `rules.ts`** into the tree, seeded on first boot. This is where "edit a
   rule without a redeploy" arrives, and it needs no UI.
3. **Revisions, proposals, confirm path**, and the tree hash on the run event.
4. **UI file browser and editor**, plus GitHub skill install and update against the per-scope lock.
   Most visible, least load-bearing, last.

Steps 1–2 deliver the point of all three cards and are testable without a browser.

## Unresolved

1. What else in Codex reads `project_root_markers`? Replacing the default may change behaviour beyond
   instruction loading. Unchecked.
2. Codex's 32 KiB combined cap across four levels plus a repo's own conventions. Silent truncation.
   Do we budget per level, warn at write time, or raise `project_doc_max_bytes`?
3. Does the workspace scope mount read-write for a **worker**? The vault plus a hostile repo is the
   sharpest version of the injection question, and RO for workers with RW for the manager is the
   cheap answer.
4. Vault sync: git-backed, a sync mount, or a periodic push? Untouched by this plan.
5. Secrets in the vault. What must never reach a sandboxed run, and enforced how — a mounted subset,
   or a filter at materialization?
6. Is `<user>` in the path worth it while there is one user? It costs nothing and makes the multi-user
   shape obvious, but it is a level of nesting against the 32 KiB budget.
7. Where does the Obsidian vault sit relative to `.atm-root` — inside the workspace scope, so every
   run walks past it, or a sibling bind that only some runs get?
8. Task scope under `worker/<project>/<task>/`: what happens to a task with no project? A `worker/_/`
   placeholder, or a shallower path for that case.

## Deferred

**skills.sh as a third install source.** `GET /api/v1/skills/{owner}/{repo}/{skill}` returns
`files: [{path, contents}]` plus a sha256, which is the same write this plan already does, and
`/api/v1/skills/search` would give the dashboard a browse-and-install flow. Blocked on auth: it
takes a Vercel OIDC token rather than an API key, unauthenticated requests get a 401, and the
gateway runs on the VPS. Revisit once it is known whether a non-Vercel process can mint one.
