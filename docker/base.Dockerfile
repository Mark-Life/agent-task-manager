# The base sandbox image: everything a run needs, baked in.
#
# The premise is that a container starts and the agent begins working. Every
# tool a run reaches for is already here, at a version somebody chose, because
# the alternative is `npm install -g` in the first thirty seconds of every turn
# — a per-run network dependency, a per-run failure mode, and a per-run version
# that nobody recorded. The image is rebuilt on a schedule instead; see
# docker/README.md.
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
# installed on an image of roughly 1.1 GiB, and 25 of those 26 are `python3`.
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

# What each pinned version actually was, readable with `docker image inspect`
# and without starting a container.
LABEL org.opencontainers.image.title="atm sandbox base" \
  org.opencontainers.image.description="Base sandbox image for agent-task-manager runs: bun, node, git, gh, ripgrep, python3, jq, bc, Claude Code and Codex." \
  com.atm.image.kind="base" \
  com.atm.version.node="${NODE_VERSION}" \
  com.atm.version.bun="${BUN_VERSION}" \
  com.atm.version.gh="${GH_VERSION}" \
  com.atm.version.ripgrep="${RIPGREP_VERSION}" \
  com.atm.version.claude_code="${CLAUDE_CODE_VERSION}" \
  com.atm.version.codex="${CODEX_VERSION}" \
  com.atm.user="${AGENT_UID}:${AGENT_GID}"

USER ${AGENT_USER}
WORKDIR /workspace

# Every tool answers, as the unprivileged user that will actually run them. A
# broken install fails the build here rather than in the first minute of a run
# that has already claimed a worker slot.
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
  codex --version

CMD ["bash"]
