# The browser sandbox image: the base image plus a Chromium that agent-browser
# can drive.
#
# Separate from the base image rather than folded into it because Chromium and
# its font and graphics stack are several hundred megabytes that most runs never
# touch, and image size is start latency on a four-core host running two or
# three containers. A task asks for this image by name through
# `task.sandboxImage`; everything else takes base. See docker/README.md.
#
# Nothing is downloaded from Chrome for Testing at build or run time.
# `agent-browser install` fetches a Chrome build into the user's home directory,
# which in this system is a per-run agent home that is thrown away — so it would
# be a several-hundred-megabyte download per run. Debian's `chromium` is a real
# package with real security updates and `AGENT_BROWSER_EXECUTABLE_PATH` points
# the CLI straight at it.

# Defaults to the tag the build script and the orchestrator share. Passed
# explicitly by scripts/build-images.ts so a browser image is always built on
# the base image from the same run rather than on whatever `latest` happened to
# be.
ARG BASE_IMAGE=atm.local/base:latest

FROM ${BASE_IMAGE}

# The browser automation CLI the agent drives. Its own binary is downloaded by
# a postinstall script from a GitHub release, so this layer needs the network
# and the version is what pins it.
ARG AGENT_BROWSER_VERSION=0.33.1

ARG AGENT_UID=1000
ARG AGENT_GID=1000

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Chromium, plus the two things apt will not pull in for it.
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

# `AGENT_BROWSER_EXECUTABLE_PATH` is what stops the CLI looking for a Chrome it
# would otherwise offer to download.
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

LABEL org.opencontainers.image.title="atm sandbox browser" \
  org.opencontainers.image.description="Base sandbox image plus Chromium and agent-browser." \
  com.atm.image.kind="browser" \
  com.atm.version.agent_browser="${AGENT_BROWSER_VERSION}"

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /workspace

# Chromium answers and agent-browser finds it, as the unprivileged user. A
# missing shared library shows up here rather than in the middle of a run.
RUN set -eu; \
  chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --dump-dom about:blank > /dev/null; \
  agent-browser --version

CMD ["bash"]
