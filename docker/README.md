# Sandbox image

One arm64 image. Every run gets a container from it, and everything that
container can do is what was baked in here: bun, node, git, `gh`, ripgrep,
`python3`, `jq`, `bc`, the Claude CLI, the Codex CLI, Chromium and
`agent-browser`.

`atm.local` is a registry that does not exist, deliberately. A bare name like
`atm-base` is a valid Docker Hub coordinate, so a container started before the
image was built would pull a stranger's image and run it under the operator's
GitHub token. A hostname with a dot in it makes docker treat the first segment
as a registry, so the same mistake is a DNS failure that names the image.

## Picking one

`task.sandbox_image` selects. Null takes the default, which is
`atm.local/base:latest` — see `DEFAULT_SANDBOX_IMAGE` and `sandboxImageFor` in
`packages/sandbox/src/images.ts`. Any other value is passed to the daemon
untouched: an operator pinning a dated tag, or naming an image built by hand, is
making a decision, and rejecting it in code would mean a redeploy to try a new
image.

With one image the field is no longer how a run asks for a capability — it is
how a task that must not move with the fleet pins a build. Which image actually
ran is recorded on `run.sandbox_image` either way.

### There were two, and why there is one

`atm.local/browser` was this image plus Chromium, opted into per task, because
several hundred megabytes was held to be start latency every run would otherwise
pay. Both halves were wrong.

Nothing pulls at container start. The images are built on the host that runs
them, `atm.local` resolves nowhere, and `--pull=missing` therefore either mounts
local layers or fails — it never downloads, so the size is a mount cost, not a
download. Nor does the split save disk: the browser image was built **on** this
one, so the host stored `base + delta` either way.

What the split did cost was the capability. Not one run was ever started from
the browser image: `task.sandbox_image` was a free-text box, hidden until it had
a value, that no rule, prompt or tool description ever mentioned. Meanwhile two
runs that needed a page staged a Chromium into `$HOME` at run time — the
per-run download the second image existed to avoid — and seven more closed with
"not verified in a browser" and handed the check to a person.

## Building

```sh
bun run images:build            # build, then sweep what it replaced
bun run images:build --check    # what is here, how old, and what a sweep would remove
bun run images:build --prune    # sweep only; builds nothing
bun run images:build --no-prune # build and leave the old tags alone
bun run images:build --keep=4   # how many dated builds survive a sweep; 2 by default
```

Each build produces two tags: `YYYY-MM-DD-<12 hex of the Dockerfile digest>`,
which never moves, and `latest`, which is repointed. The date is what an
operator actually asks about an image; the digest is what keeps the tag honest
when two builds happen on the same day.

`--check` reads `docker image inspect` and prints age, size and the pinned
versions the image recorded about itself as OCI labels — no container is
started. It calls an image stale after 14 days, which is twice the cadence
below: one missed rebuild is not an alarm, two are.

A build takes several minutes, most of it the two agent CLIs and Chromium. The
daemon's output is streamed line by line as it goes.

## What a build removes

Every build ends by sweeping, because nothing else on the host does. It removes
the dated tags beyond the newest two, and then drops the whole build cache. Left alone, a weekly rebuild is about two gigabytes of images
plus a few of cache per week, on a disk that has to hold the run data too.

Removing tags **by name** is the whole safety of it. `docker image prune -a`
reclaims the same bytes and takes `atm.local/base:latest` with it, and
`atm.local` is a registry that does not exist — there is no pull to fall back
on, so the next run fails until somebody spends several minutes rebuilding. The
sweep never names `latest`, never names a dated tag pointing at the same image
as `latest`, and never passes `--force`: an image a container is still holding
is a refusal to log, not something to take out from under a run in flight.

The build cache goes entirely, not by age. Cache is only worth keeping for a
build that reuses it, and a rebuild that reuses it is a rebuild that picked up
none of the Debian security updates it exists to pick up.

Two dated builds is what a pin can count on. A task may set `sandbox_image` to a
dated tag, and this script cannot see the board — making an image build read the
database would be worse than the disk. So the number is the contract: at the
weekly cadence, a pin older than two weeks is a pin that stops resolving, which
is the same fortnight `--check` starts calling an image stale. An operator
holding an older pin buys time with `--keep`, and `--no-prune` skips the sweep
entirely.

`--prune` is the same sweep with no build in front of it, which is what to run
on a host that has been building for months and never removing.

## Rebuild cadence

**Weekly, on a schedule. Never per run.**

That is the whole reason the images exist. A run that installed its own tooling
would pay the download every turn, fail whenever a registry was down, and use a
version nobody recorded. Baking the tools in moves all three costs to a build
somebody watches.

What a rebuild picks up:

- Debian security updates. These are not pinned, and that is the deliberate
  exception to everything else here — apt keeps no stable archive of superseded
  versions, so pinning them exactly is a Dockerfile that stops building the week
  the mirror rotates. What was resolved is recorded in the image labels.
- Nothing else, unless a version in the Dockerfile was edited. Node, bun, `gh`,
  ripgrep and both agent CLIs are exact versions verified against a published
  hash, so an unedited Dockerfile produces the same toolchain every time.

Bumping an agent CLI is an edit, not a schedule. `CLAUDE_CODE_VERSION` is held
to the `claudeCodeVersion` that `@anthropic-ai/claude-agent-sdk` declares in
`packages/harness`, and `CODEX_VERSION` to the version of `@openai/codex-sdk`
pinned beside it — both harnesses parse a protocol that is versioned with the
binary, so a CLI ahead of the harness is a turn that starts fine and then stops
making sense.

## What is in the image, and why

Read `base.Dockerfile`; every choice is commented there. The five that matter
outside the file:

**`python3`, `jq` and `bc` are on PATH.** They are there because they were
missing: across 184 runs, `python3: command not found` came back 52 times, `jq`
10 and `bc` 5, and every one of those cost a failed command and a rewrite. The
three cost 26 MiB installed on an image of roughly 1.9 GiB. `turbo` is
deliberately not among them — it is a repo's own build tool, pinned in that
repo's `package.json`, and `bun run build` runs the pinned one. A global copy
would be a second version answering to the same name.

**uid 1000, gid 1000.** Bind mounts carry host ownership through — the kernel
compares numbers, not names — so the container's uid must own `DATA_ROOT` on the
host. The value is stated in three places that must agree: `AGENT_UID` here,
`DEFAULT_USER` in `packages/sandbox/src/hardening.ts`, and whoever owns the data
root. A mismatch is a run that boots fine and cannot write anything it was
given, the agent home included — which is where the vendor's refreshed token has
to land.

A dispatched run does not take `DEFAULT_USER`: `container-turn.ts` runs the
container as the uid of the loop process, which is by construction the owner of
the run directory it just created. On a host whose operator is uid 1000 that is
the image's own user and nothing differs; on a mac it is not, and the override is
what makes a container able to write its own mounts there. Both other values
still have to agree — the image's `/home/agent` and everything under it belongs
to 1000, so a run under another uid has no writable `HOME` and the tools that
want one fall back to `/tmp`.

**`git config --system safe.directory '*'`.** The workspace is a bind mount, and
a uid that disagrees with the checkout's owner turns every git command into
`detected dubious ownership` — a failure that reads like a broken image. The
container is the trust boundary; the checkout inside it came from a mirror the
orchestrator controls.

**No git identity.** `user.name` and `user.email` are policy, not tooling, and
belong to whatever starts the run.

**Chromium and `agent-browser`.** Debian's `chromium`, which drags in its own
runtime stack as ordinary package dependencies, plus two font packages Chromium
does not depend on and is visibly broken without. 695 MB installed across 159
packages, more than half the image, and the reason it is the last layer built.

Nothing is fetched from Chrome for Testing: `agent-browser install` downloads a
Chrome into the user's home, which here is a per-run agent home that is thrown
away, so it would be a several-hundred-megabyte download every run.
`AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium` is what stops it trying.
`AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage` is set for the same
reason: both flags are consequences of the confinement in `hardening.ts` rather
than preferences — `--cap-drop=ALL` with `no-new-privileges` removes what
Chromium's own sandbox needs, and docker's default 64 MB `/dev/shm` crashes a
renderer on any page of weight. Both failures are hangs rather than clean
errors, which is why they are set in the image and not left to a caller.

The build's last step renders `about:blank` rather than running
`chromium --version`, because a missing library, a font stack with no fonts and
a too-small `/dev/shm` all leave `--version` answering perfectly.
