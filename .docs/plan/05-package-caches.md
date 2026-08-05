# Package Caches — one shared store, seven mounts

Today every run starts with an empty `node_modules` and a cold package cache. A monorepo
pays the full download every turn. This is the cheapest large win available: one new mount
and four environment variables.

Single operator, one host. No per-user or per-workspace scoping anywhere below.

---

## 1. The shape

One directory under the data root, shared by every run and every project:

```
${DATA_ROOT}/caches/bun     BUN_INSTALL_CACHE_DIR
${DATA_ROOT}/caches/pnpm    npm_config_store_dir
${DATA_ROOT}/caches/npm     npm_config_cache
${DATA_ROOT}/caches/yarn    YARN_GLOBAL_FOLDER  (+ YARN_ENABLE_GLOBAL_CACHE=true)
```

Mounted rw at `/cache`, one bind. The subdirectories are the container's problem, not the
mount's.

**Shared across projects, not per project.** These stores are content-addressed — sharing is
where the dedupe comes from, and two projects on the same lockfile pin fetch once.

**Every manager is pointed at it, none is detected.** A repo using pnpm and a repo using bun
get the same mount and the same variables; whichever tool runs finds its own store warm and
the others sit unused. Detecting the package manager per project is a guess that is wrong on
the repo that uses two.

**Same filesystem as the workspaces, deliberately.** pnpm hardlinks from its store into
`node_modules`, and a hardlink cannot cross a filesystem. `${DATA_ROOT}/caches` and
`${DATA_ROOT}/workspaces` under one root means the link works and a pnpm install is near
instant. Split them across disks and pnpm silently falls back to copying.

**`node_modules` stays per run.** The cache makes the install fast; it does not remove it. A
warm template tree copied with reflink is a later step and a different document.

## 2. Changes

| File | Change |
| --- | --- |
| `packages/sandbox/src/mounts.ts` | `"cache"` in `MOUNT_PURPOSES`; `cacheDir` on `MountSources`; `CONTAINER_CACHE_DIR = "/cache"`; one entry in `mountsFor`, rw |
| `packages/sandbox/src/workspace.ts` | `cachesDirOf({dataRoot})`; `ensureMountSource` it with purpose `"cache"` — **not** inside `Effect.acquireRelease`, it outlives the run |
| `packages/orchestrator/src/runtime.ts` | the four variables in `turnEnvironment`; `announceTurnEnv` already prints the names |
| `docker/base.Dockerfile` | `mkdir -p /cache` owned by the agent uid, beside the other mount points |

Worker runs only. `managerMountsFor` is unchanged — a chat turn installs nothing.

## 3. What this also fixes

The container runs as the loop process's uid, which on the VPS is a system account and not
the image's 1000, so `$HOME` is not writable and every tool that wants a home falls back to
`/tmp` — a 512 MB tmpfs billed against the container's 2 GB memory cgroup. Pointing the
stores at `/cache` takes installs off that path entirely.

## 4. Order

1. Mount plumbing and the purpose. Pure, unit-testable against `mountsFor`.
2. Directory creation in the materializer.
3. The four variables, verified by starting a container and printing where each tool thinks
   its store is. `BUN_INSTALL_CACHE_DIR` and `npm_config_cache` are certain; the pnpm and
   yarn names need that one run to confirm.
4. Measure: a cold install and a warm one on the same repo, wall clock, from `atm.sandbox`.

## 5. Accepted risks

**A poisoned cache spreads.** One run can write a bad artifact that a later run installs.
The agent already has network access and push rights, so this adds nothing it could not
already do. Per-project caches would contain it and would cost the dedupe; not worth it for
one operator.

**Unbounded growth.** No eviction. `du` the directory when disk gets tight, delete it, take
one cold install. A sweep can come later if the number is ever real.

---

## Unresolved

- pnpm store: is `npm_config_store_dir` honoured from the environment, or does it need
  `.npmrc` in the workspace?
- Yarn berry: `YARN_GLOBAL_FOLDER` plus `YARN_ENABLE_GLOBAL_CACHE`, or is the per-project
  `.yarn/cache` unavoidable?
- Should the cache mount be readable by manager runs, for a chat turn that wants to run
  `bunx` on something? Currently no.
