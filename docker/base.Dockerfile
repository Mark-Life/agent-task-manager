# The sandbox image: everything a run needs, baked in.
#
# The premise is that a container starts and the agent begins working. Every
# tool a run reaches for is already here, at a version somebody chose, because
# the alternative is `npm install -g` in the first thirty seconds of every turn
# — a per-run network dependency, a per-run failure mode, and a per-run version
# that nobody recorded. The image is rebuilt on a schedule instead; see
# docker/README.md.
#
# Chromium is here for that reason and no other. It used to live in a second
# image a task opted into by name, on the argument that several hundred
# megabytes of browser is start latency every run would otherwise pay. That
# argument was wrong twice. Nothing pulls at container start — the images are
# built on the host that runs them and `--pull=missing` never fires — so the
# bytes cost a mount, not a download. And in the week the second image existed,
# not one run was ever started from it, while two runs that needed a page staged
# a Chromium into `$HOME` by hand at run time: the exact per-run download the
# split was invented to avoid, paid because the opt-in was a free-text field
# nobody knew to fill in.
#
# Every version below is an exact one and every download is checked against a
# hash published with that release. An unpinned tool is a different image every
# rebuild, and the day a run starts behaving differently there is nothing to
# compare. What apt installs is the deliberate exception: Debian keeps no stable
# archive of superseded versions, so pinning those to an exact release is a
# Dockerfile that stops building the week the mirror rotates. Picking up
# Debian's security updates is most of the reason the rebuild is scheduled at
# all. What was actually resolved is not in the image labels — `dpkg -l` in a
# container is how you ask an image which Debian versions it got.
#
# arm64 only. The host is aarch64 and every archive fetched here names that
# architecture, so the build refuses to run anywhere else rather than producing
# an image that fails at the first `bun --version`.

# Pinned by digest rather than by the `bookworm-slim` tag, which moves. The
# digest is the multi-arch index, so it still resolves to the arm64 manifest.
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

FROM ${DEBIAN_IMAGE}

# Node runs the two agent CLIs, which are npm packages. The current LTS line.
ARG NODE_VERSION=24.18.1
ARG NODE_SHA256=7201e3a09dc825bac57867c81913e2b8f0ef87d04cb9082af4cda82f6ff3d88c

# Bun runs this repo's own code and is what an agent working in it will reach
# for. Held at the version in the root package.json's `packageManager`, so a
# lockfile written on the host resolves identically inside a container.
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b

# `gh` is how a run opens a pull request, which is the output of most coding
# tasks. Installed from the release tarball rather than the apt repository:
# one fewer signing key to trust and an exact version instead of whatever the
# repository is serving today.
ARG GH_VERSION=2.97.0
ARG GH_SHA256=73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5

# ripgrep is the search tool both agent CLIs shell out to, and it is also how
# the artifacts directory is searched — that is the whole index. Debian ships
# 13.x; the upstream release is several major versions ahead.
ARG RIPGREP_VERSION=15.2.0
ARG RIPGREP_SHA256=a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d

# The Claude CLI. Matched to the `claudeCodeVersion` declared by the
# `@anthropic-ai/claude-agent-sdk` release the harness depends on: the SDK
# speaks a protocol version, and a CLI from a different release is the one
# mismatch that produces a turn which starts fine and then stops making sense.
ARG CLAUDE_CODE_VERSION=2.1.220

# The Codex CLI. `packages/harness/src/codex.ts` spawns `codex` off PATH rather
# than going through `@openai/codex-sdk`, so this — not the SDK — is what a
# Codex run actually executes. Held at the same version as the SDK the harness
# pins, because the JSONL event protocol the harness parses is versioned with
# the binary.
ARG CODEX_VERSION=0.146.0

# The browser automation CLI the agent drives. Its own binary is downloaded by a
# postinstall script from a GitHub release, so that layer needs the network and
# the version is what pins it.
ARG AGENT_BROWSER_VERSION=0.33.1

# The uid and gid every container runs as.
#
# Numeric and stable, and it has to stay in step with `DEFAULT_USER` in
# packages/sandbox/src/hardening.ts and with the owner of `DATA_ROOT` on the
# host. A bind mount carries host ownership straight through — the kernel
# compares numbers, not names — so a run under a uid that does not own the data
# root boots fine and then cannot write its own agent home, its artifacts, or
# its event ledger. 1000 is the first non-system uid Debian hands out and the
# uid of the operator account on a single-user host, which is why it is the
# value that needs no coordination.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
ARG AGENT_USER=agent

ENV DEBIAN_FRONTEND=noninteractive

# Fail on the wrong architecture rather than three layers later, when a tarball
# named aarch64 unpacks and its binaries will not exec.
RUN set -eu; \
  if [ "$(uname -m)" != "aarch64" ]; then \
  echo "base.Dockerfile is arm64-only; this build is $(uname -m)" >&2; \
  exit 1; \
  fi

# The system floor.
#
# `ca-certificates` and `curl` are how everything below is fetched and how a run
# reaches the model APIs. `git` is the work. `less` is `gh`'s pager, and without
# it `gh` writes raw escape codes into a captured stdout. `libstdc++6` and
# `libgcc-s1` are what the Bun binary links against and are not in the slim
# image. `openssh-client` covers a repo whose remote is an ssh URL. `procps` is
# what a stuck agent uses to see its own children. `unzip` and `xz-utils` unpack
# Bun and Node respectively.
#
# `python3`, `jq` and `bc` are here because agents reach for them without
# checking. `python3: command not found` came back in 52 of 184 runs, `jq` in 10
# and `bc` in 5, and the recovery is the same every time: notice the failure,
# rewrite the one-liner as `bun -e`, four seconds gone. They cost 26 MiB
# installed on an image of roughly 1.9 GiB, and 25 of those 26 are `python3`.
# It is the full interpreter and not `python3-minimal`, which would save 13 MiB
# by leaving out `libpython3.11-stdlib` — the package that carries `json` and
# `statistics`. A one-liner that does not import `json` is a rare one-liner.
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  bc \
  ca-certificates \
  curl \
  git \
  jq \
  less \
  libgcc-s1 \
  libstdc++6 \
  openssh-client \
  procps \
  python3 \
  unzip \
  xz-utils; \
  rm -rf /var/lib/apt/lists/*

# Node, unpacked over /usr/local so `node` and `npm` land on the default PATH
# without a profile script. `--no-same-owner` because the tarball records the
# uid of whoever built it upstream.
RUN set -eu; \
  curl -fsSL -o /tmp/node.tar.xz \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"; \
  echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
  --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
  rm /tmp/node.tar.xz

# Bun. `bunx` is a second name for the same binary, which is how the upstream
# installer ships it and what every `bunx` invocation in this repo expects.
RUN set -eu; \
  curl -fsSL -o /tmp/bun.zip \
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip"; \
  echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c -; \
  unzip -q /tmp/bun.zip -d /tmp/bun; \
  install -m 0755 /tmp/bun/bun-linux-aarch64/bun /usr/local/bin/bun; \
  ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
  rm -rf /tmp/bun /tmp/bun.zip

# The GitHub CLI. Only the binary is kept; the tarball's man pages and shell
# completions are weight nothing headless will read.
RUN set -eu; \
  curl -fsSL -o /tmp/gh.tar.gz \
  "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz"; \
  echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/gh.tar.gz -C /tmp; \
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_arm64/bin/gh" /usr/local/bin/gh; \
  rm -rf "/tmp/gh_${GH_VERSION}_linux_arm64" /tmp/gh.tar.gz

# ripgrep.
RUN set -eu; \
  curl -fsSL -o /tmp/rg.tar.gz \
  "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu.tar.gz"; \
  echo "${RIPGREP_SHA256}  /tmp/rg.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/rg.tar.gz -C /tmp; \
  install -m 0755 "/tmp/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu/rg" /usr/local/bin/rg; \
  rm -rf "/tmp/ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-gnu" /tmp/rg.tar.gz

# Both agent CLIs, installed globally so they resolve on PATH for any user.
# Each ships its real binary in a per-platform optional dependency, so npm
# resolves the aarch64 build here and the postinstall only links it.
RUN set -eu; \
  npm install -g --no-audit --no-fund \
  "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  "@openai/codex@${CODEX_VERSION}"; \
  npm cache clean --force

# Chromium, plus the two things apt will not pull in for it.
#
# Its own layer, and the last heavy one, because it is 695 MB installed across
# 159 packages — more than half the image — and every layer above it is one a
# rebuild should still hit cache on when only this version moves.
#
# `chromium` itself drags in the whole runtime stack as ordinary Debian
# dependencies — libnss3 for certificate handling, libgbm1 and libdrm2 for the
# graphics buffers headless still allocates, libatk1.0-0 and at-spi2 for the
# accessibility tree agent-browser reads elements out of, libxkbcommon0 and the
# libx11/libxcb family for input and window handling, libasound2 for audio
# devices Chromium probes even with none present. Listing them by hand is a list
# that goes stale against the package; the package already declares them.
#
# The two that are *not* dependencies, and that a headless browser is visibly
# broken without:
#
# - `fonts-liberation`: Debian's Chromium depends on no font at all. Without
#   one, every screenshot and every text measurement renders as boxes, so a page
#   the agent screenshots is unreadable and any layout assertion is meaningless.
#   Liberation is metric-compatible with Arial, Times and Courier, which is what
#   most pages actually ask for.
# - `fonts-noto-color-emoji`: emoji are ordinary content on the pages an agent
#   is sent to read, and without this they render as tofu — visible in a
#   screenshot and, worse, silently absent from extracted text.
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  chromium \
  fonts-liberation \
  fonts-noto-color-emoji; \
  rm -rf /var/lib/apt/lists/*

# agent-browser ships a native binary per platform; the postinstall picks the
# aarch64 one. Installed globally so it resolves on PATH for the agent user.
RUN set -eu; \
  npm install -g --no-audit --no-fund "agent-browser@${AGENT_BROWSER_VERSION}"; \
  npm cache clean --force

# The account every run is. `--create-home` because both CLIs and `gh` write
# state under HOME, and a user without one writes to `/` and fails.
RUN set -eu; \
  groupadd --gid "${AGENT_GID}" "${AGENT_USER}"; \
  useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" \
  --create-home --shell /bin/bash "${AGENT_USER}"

# The mount points, pre-created and owned by the agent.
#
# Docker would create a missing bind target itself, as root — harmless while
# every one of these is mounted, and a silently root-owned directory the moment
# one is not. Creating them here means a run with no project artifacts folder
# finds an empty readable directory instead of a permission error from a path it
# never chose. `/run` is absent on purpose: Debian already ships it, and the
# run directory is mounted over it.
#
# `/cache` is the shared package store. Only the mount point is made here; the
# per-manager subdirectories under it are created by whichever tool runs, which
# is what lets a fifth package manager be one more variable rather than another
# image build.
RUN set -eu; \
  mkdir -p /workspace /cache /artifacts/task /artifacts/project /artifacts/global; \
  chown -R "${AGENT_UID}:${AGENT_GID}" /workspace /cache /artifacts

# Git refuses to operate on a repository owned by another uid, which is the
# right default on a shared machine and wrong here: the workspace is a bind
# mount whose ownership comes from the host, and a uid that disagrees turns
# every git command into `detected dubious ownership` — a failure that reads
# like a broken image rather than a mismatched mount. The container is the
# trust boundary; the checkout inside it was materialized by the orchestrator
# from a mirror it controls.
RUN git config --system --add safe.directory '*'

ENV HOME=/home/${AGENT_USER} \
  LANG=C.UTF-8 \
  # An agent CLI that updates itself is a per-run install of an unrecorded
  # version, which is exactly what baking the version in was for.
  DISABLE_AUTOUPDATER=1 \
  NPM_CONFIG_FUND=false \
  NPM_CONFIG_UPDATE_NOTIFIER=false

# `AGENT_BROWSER_EXECUTABLE_PATH` is what stops the CLI looking for a Chrome it
# would otherwise offer to download into the per-run agent home — several
# hundred megabytes fetched and thrown away every run, which is why Debian's
# `chromium` is installed above instead.
#
# The two launch flags are both consequences of how this container is confined,
# and both are silent hangs rather than clean errors when they are missing.
#
# `--no-sandbox`: Chromium's own sandbox needs either the setuid helper or
# unprivileged user namespaces, and `--cap-drop=ALL` with
# `no-new-privileges:true` takes away both. The container is the sandbox — that
# is the whole design — so Chromium's second one is redundant here, and asking
# for it produces a renderer that dies at startup.
#
# `--disable-dev-shm-usage`: Docker gives a container 64 MB of `/dev/shm` by
# default and Chromium puts its renderer's shared memory there, so a page of
# any weight crashes the tab. The flag moves it to a regular temporary file,
# which lands in the run's `/tmp` tmpfs.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
  AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage

# What each pinned version actually was, readable with `docker image inspect`
# and without starting a container.
LABEL org.opencontainers.image.title="atm sandbox base" \
  org.opencontainers.image.description="Sandbox image for agent-task-manager runs: bun, node, git, gh, ripgrep, python3, jq, bc, Claude Code, Codex, Chromium and agent-browser." \
  com.atm.image.kind="base" \
  com.atm.version.node="${NODE_VERSION}" \
  com.atm.version.bun="${BUN_VERSION}" \
  com.atm.version.gh="${GH_VERSION}" \
  com.atm.version.ripgrep="${RIPGREP_VERSION}" \
  com.atm.version.claude_code="${CLAUDE_CODE_VERSION}" \
  com.atm.version.codex="${CODEX_VERSION}" \
  com.atm.version.agent_browser="${AGENT_BROWSER_VERSION}" \
  com.atm.user="${AGENT_UID}:${AGENT_GID}"

USER ${AGENT_USER}
WORKDIR /workspace

# Every tool answers, as the unprivileged user that will actually run them. A
# broken install fails the build here rather than in the first minute of a run
# that has already claimed a worker slot.
#
# Chromium is asked to render rather than to print its version, because the ways
# it breaks in a container — a missing shared library, a font stack with no
# fonts in it, `/dev/shm` too small — all leave `chromium --version` answering
# perfectly. `--dump-dom about:blank` starts a real renderer, which is the
# cheapest thing that does not.
RUN set -eu; \
  node --version; \
  npm --version; \
  bun --version; \
  git --version; \
  gh --version; \
  rg --version; \
  python3 --version; \
  jq --version; \
  bc --version; \
  claude --version; \
  codex --version; \
  chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --dump-dom about:blank > /dev/null; \
  agent-browser --version

CMD ["bash"]
