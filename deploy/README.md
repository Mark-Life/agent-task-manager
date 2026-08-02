# Deploying on the VPS

Caddy on the front, two long-running Bun processes behind it, Postgres in a
Compose container beside them. Everything in this directory is **written, not
deployed** — no host has run any of it. What has been checked is stated at the
bottom.

Target: aarch64, 4 cores, 8 GB, Debian 12 or Ubuntu 24.04, Docker already
installed and running.

## What goes where

| Path | Who owns it | What it is |
| --- | --- | --- |
| `/opt/agent-task-manager` | `root`, read-only to the services | The checkout. Both units run from here. |
| `/var/lib/agent-task-manager` | `atm` | `DATA_ROOT`: run directories, checkouts, artifacts, the JSONL ledger. Also the service user's home. |
| `/var/lib/agent-task-manager-home` | `atm`, `0700` | One agent home per provider, mounted read-write into every container. Outside `DATA_ROOT` because it outlives every run and holds the logins. |
| `/etc/agent-task-manager` | `root`, `0640` to the service group | The environment files. The only place a secret is written. |

The split is the point. The services get exactly one writable directory, which
is what makes `ProtectSystem=strict` in the units mean something.

## Install

**1. User and directories.** The home lives inside `DATA_ROOT` so that
`ProtectHome=yes` costs nothing — Bun still has somewhere to put a cache.

```sh
sudo useradd --system --home-dir /var/lib/agent-task-manager --create-home --shell /usr/sbin/nologin atm
sudo usermod -aG docker atm
sudo mkdir -p /etc/agent-task-manager /var/log/caddy
sudo chown atm:atm /var/lib/agent-task-manager
```

**2. Bun, system-wide.** The units name `/usr/local/bin/bun` and a path under
`/root` is not readable by a service user.

```sh
curl -fsSL https://bun.sh/install | sudo BUN_INSTALL=/usr/local bash
bun --version
```

**3. The checkout and its dependencies.**

```sh
sudo git clone <repo> /opt/agent-task-manager
cd /opt/agent-task-manager
sudo bun install --frozen-lockfile
```

**4. Environment files.** Copy each `*.env.example` from this directory to
`/etc/agent-task-manager/` without the suffix, fill in the values marked
`CHANGEME` or left empty, then lock them down. Systemd parses these itself:
`KEY=value`, no quoting, no expansion, no trailing comments.

```sh
sudo install -m 0640 -o root -g atm deploy/common.env.example  /etc/agent-task-manager/common.env
sudo install -m 0640 -o root -g atm deploy/gateway.env.example /etc/agent-task-manager/gateway.env
sudo install -m 0640 -o root -g atm deploy/loop.env.example    /etc/agent-task-manager/loop.env
sudo install -m 0640 -o root -g caddy deploy/caddy.env.example /etc/agent-task-manager/caddy.env
```

Do not leave a `.env` in the checkout. It would not override these — the loader
sets `override: false` — but two files claiming to configure the same process is
a question somebody will have to answer at the wrong moment.

**5. Postgres.** Compose binds it to `127.0.0.1` only; nothing reaches it from
off the host. Set `POSTGRES_PASSWORD` to match the `DATABASE_URL` in
`common.env`.

```sh
cd /opt/agent-task-manager && sudo docker compose up -d
```

**6. Migrations**, run by hand, once per deploy that adds one. Forward-only.

```sh
cd /opt/agent-task-manager/packages/db
sudo -E DATABASE_URL="$(sudo grep ^DATABASE_URL= /etc/agent-task-manager/common.env | cut -d= -f2-)" bunx --bun drizzle-kit migrate
```

**6a. The operator's login**, once, on a fresh database. The seed creates the
workspace and the owner, and `OWNER_PASSWORD` is what turns that owner into
somebody who can sign in — sign-up is closed, so no form will ever do it. Pass
it on the command line rather than writing it into an env file, and change it
from the dashboard afterwards: re-running the seed leaves an existing password
alone, so a rotation is not undone by the next deploy.

```sh
cd /opt/agent-task-manager
sudo -u atm DATABASE_URL="$(sudo grep ^DATABASE_URL= /etc/agent-task-manager/common.env | cut -d= -f2-)" \
  OWNER_PASSWORD='...' bun run db:seed
```

**7. Agent homes and their logins.** One directory per provider, outside
`DATA_ROOT`, mounted read-write into every container. Nothing on the run path
creates or seeds them, because an auto-created empty home boots a container that
reports an auth error nobody can tell from an expired subscription. `harness:check`
says so by name when one is missing.

Both CLIs need an interactive login, which a `nologin` service user cannot do
directly — run each under `sudo -u atm` from your own session:

```sh
sudo install -d -m 0700 -o atm -g atm /var/lib/agent-task-manager-home/claude
sudo install -d -m 0700 -o atm -g atm /var/lib/agent-task-manager-home/codex
sudo -u atm CLAUDE_CONFIG_DIR=/var/lib/agent-task-manager-home/claude claude   # then /login
sudo -u atm CODEX_HOME=/var/lib/agent-task-manager-home/codex codex login
cd /opt/agent-task-manager && sudo -u atm bun run harness:check
```

The paths must match `ATM_AGENT_HOME_DIR_CLAUDE` / `ATM_AGENT_HOME_DIR_CODEX` in
`loop.env`, be mode `0700`, and be owned by the uid the loop's containers run as
— which is the loop's own, because a bind mount does no id translation. From
then on the containers refresh the tokens in place and nothing re-seeds them.

**8. Sandbox images and the two bundles.** The loop starts containers from
images that exist only once somebody builds them; a loop without them fails
every run it picks up. Minutes, and it needs the daemon. The two bundles are
copied onto each run's mount rather than baked into the image, because they
change with the code and the image does not — so they are rebuilt on every
deploy, and a missing one fails the run by name.

```sh
cd /opt/agent-task-manager
sudo -u atm bun run images:build
sudo -u atm bun run entrypoint:build   # ${DATA_ROOT}/bin/turn.js — the container's turn
sudo -u atm bun run agent-mcp:build    # ${DATA_ROOT}/bin/agent-mcp.js — the board tools
```

**9. The services.**

```sh
sudo install -m 0644 deploy/atm-gateway.service deploy/atm-loop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atm-gateway atm-loop
```

**10. Caddy.** Install from the official apt repository, then point it at the
Caddyfile here and give it its environment through the drop-in — the stock unit
reads no environment file, and unset `{$ATM_*}` placeholders adapt silently to a
site with no address.

```sh
sudo cp /opt/agent-task-manager/deploy/Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo cp /opt/agent-task-manager/deploy/caddy-override.conf /etc/systemd/system/caddy.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart caddy
```

## What an operator must set by hand

Nothing here has a default that is right for a real host.

- **DNS.** An A/AAAA record for `ATM_DOMAIN` pointing at this VPS, in place
  *before* Caddy starts. Certificate issuance fails otherwise and retries on a
  backoff that reads as a hang.
- **`ATM_DOMAIN`, `ATM_ACME_EMAIL`, `ATM_DASHBOARD_ORIGIN`** in `caddy.env`. The
  dashboard origin is compared literally against the browser's `Origin` header —
  scheme and host, no trailing slash. **Caddy owns CORS and the gateway must not
  set it**: two writers of `Access-Control-Allow-Origin` send it twice, and a
  browser rejects the pair. The preflight also has to allow `traceparent` and
  `b3` — the dashboard's API client sends both on every call, and a front door
  that omits them blocks every request before it is made. In development the
  dashboard's dev server proxies the API, so everything is same-origin and there
  is nothing to configure.
- **`DASHBOARD_ORIGIN`** in `common.env`, the same string as
  `ATM_DASHBOARD_ORIGIN` above. Caddy can grant the SPA permission to send its
  cookie, but only the gateway can accept it: Better Auth refuses a
  cookie-bearing POST from an origin it was not told about.
- **`AUTH_COOKIE_DOMAIN`** in `gateway.env`, and the two hosts under it. The
  session cookie is scoped to this domain so `dash.` and `api.` are one site to
  the browser — which is the whole plan, because a third-party cookie is dropped
  by Safari and Firefox however it is labelled. Setting it with no
  `BETTER_AUTH_URL` fails the gateway at boot.
- **`OWNER_PASSWORD`** at seed time, step 6a. Sign-up is closed, so this is the
  only way anybody gets a login.
- **`DATABASE_URL`** in `common.env` and the matching `POSTGRES_PASSWORD` for
  Compose. Two places, one password.
- **`GATEWAY_PUBLIC_URL`** in `gateway.env`. It is what the served spec
  advertises as `servers[0].url`; wrong here means a connector that reads the
  document correctly and then calls localhost.
- **`BETTER_AUTH_SECRET`** in `gateway.env`, from `openssl rand -base64 32`. The
  gateway refuses to boot without it: it signs session cookies and, under a
  derived key, every scoped bearer token. Rotating it is the only revocation
  there is, and it logs everybody out.
- **`GIT_SHA`** in `common.env` at each deploy. Nothing sets it automatically,
  and it is the only field that answers "which build wrote this row".
- **The provider logins**, once, into the agent homes at step 7. A token in a
  keychain or a home directory on your laptop reaches nothing here. `loop.env`
  also takes an `ANTHROPIC_API_KEY` for headless use, where there is no
  subscription login to inherit.
- **`ORCHESTRATOR_GATEWAY_URL`** in `loop.env`: the gateway **as a container
  reaches it**, which on a Linux host with the default bridge is the docker0
  address and never `localhost`. Unset, every turn runs with no board tools and
  the loop says so once at boot rather than failing.
- **A firewall.** 80 and 443 in, nothing else. Postgres is on loopback and the
  gateway binds loopback, so the only thing this protects against is a future
  service that forgets to — which is the usual way it happens.

## Checking it came up

```sh
systemctl status atm-gateway atm-loop caddy
journalctl -u atm-gateway -f
curl -s https://$ATM_DOMAIN/health
curl -s https://$ATM_DOMAIN/openapi.json | head -c 200
```

`/health` answering `{"status":"ok",...}` means the process is up. `/openapi.json`
carrying a `servers[0].url` equal to `GATEWAY_PUBLIC_URL` means the deployment
knows its own address. `/docs` renders the same document for a person. The
gateway's own ledger is `${DATA_ROOT}/events/gateway.jsonl`, readable with
`bun run logs`.

Every other endpoint wants a credential: a Better Auth session cookie from
`/api/auth/*` for a person, or a scoped bearer token for a machine. Tokens are
signed from `BETTER_AUTH_SECRET` and expire; nothing on this host mints one yet,
so until that exists the machine half of the API is reachable only in principle
and a 401 there is the expected answer, not a misconfiguration.

## Upgrading

```sh
cd /opt/agent-task-manager
sudo git fetch && sudo git checkout <sha>
sudo bun install --frozen-lockfile
# migrations, if the diff has any
sudo systemctl restart atm-gateway atm-loop
```

Restart order does not matter: they share no state but the database, and each
recovers its own debris at boot. Rolling back is the same commands at the older
sha — except for migrations, which are forward-only, so a rollback across one is
a restore, not a checkout.

Stopping the loop is the slow half. It stops the containers it is holding and
releases its leases; `TimeoutStopSec=60s` bounds that, and a `SIGKILL` through
the middle leaves rows claiming a run is live and containers nobody will reap.

## The dashboard, on Cloudflare

The gateway and the loop run on this host; the dashboard does not. It is a
static bundle on Cloudflare Workers Static Assets, described by `alchemy.run.ts`
at the repo root and deployed from a workstation, not from the VPS.

```sh
bun run cf:plan      # what would change
bun run cf:deploy    # build the bundle and upload it
bun run cf:destroy   # remove the worker and its domain attachment
```

**Credentials.** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the
environment, or `bunx alchemy login` once on the machine, which writes a profile
to `~/.alchemy/profiles.json`. CI has no way to answer a prompt, so there it is
the two variables or nothing.

**Configuration.** `GATEWAY_PUBLIC_URL` and `DASHBOARD_ORIGIN`, read from `.env`
in the repo root or the environment. Both are required: the first is baked into
the bundle as the API's address, and the second names the host the worker is
served at. There is no default for either, because a dashboard that guesses
wrong builds cleanly and fails in the browser.

**State.** `.alchemy/state` next to `alchemy.run.ts` — deployment records,
build hashes, logs. It is gitignored and machine-local, so a second machine that
deploys will not know this one already created the worker and will try to create
it again. Swap `Alchemy.localState()` for `Cloudflare.state()` in the entry file
before that becomes true; Alchemy then keeps state in a worker in the same
account.

**The domain is not optional.** `DASHBOARD_ORIGIN` must be a subdomain of the
same registrable domain as the gateway — `dash.example.com` against
`api.example.com`, with `AUTH_COOKIE_DOMAIN=.example.com`. The session cookie is
scoped to that shared domain, which is what makes it first-party for both hosts.
Left on a `workers.dev` URL the dashboard shares no domain with the API, the
cookie is never sent, and every request answers 401. The zone must already exist
in the Cloudflare account: Alchemy attaches a hostname, it does not register one.

CORS stays where it is. Caddy sets the headers for the one origin above and
answers preflight; the gateway sets none. Nothing in this file changes that.

**None of this has been run.** No `alchemy plan`, `deploy` or `dev`, and no
Cloudflare resource exists. In particular, whether the Vite build survives
Alchemy's injected Cloudflare plugin alongside Tailwind and the workspace
dependencies, and whether Cloudflare accepts an assets-only upload carrying the
`VITE_GATEWAY_URL` binding, are both unknown until somebody deploys. If the
upload is rejected, drop the `env` block and build with the variable in the
shell instead.

## What was actually checked

- `caddy validate --adapter caddyfile` on this Caddyfile, in a `caddy:2`
  container with the four variables set: *Valid configuration*. It has never
  served a request, held an SSE stream, or ordered a certificate.
- `systemd-analyze verify` on both units, in a `debian:12` container: no syntax
  or directive errors. The only complaints were that container's own — no
  `docker.service` and no `/usr/local/bin/bun`.
- `alchemy.run.ts` typechecks against the installed type definitions
  (`tsc --noEmit`, exit 0). It has never been executed and no Cloudflare
  resource exists.
- Nothing else. No host has run these files, and the install steps above are
  written from the units and the code, not from a session that performed them.
