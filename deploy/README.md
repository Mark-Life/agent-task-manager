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
| `/var/lib/agent-task-manager` | `atm` | `DATA_ROOT`: artifacts, per-run agent homes, the JSONL ledger. Also the service user's home. |
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

**7. Sandbox images.** The loop starts containers from images that exist only
once somebody builds them; a loop without them fails every run it picks up.
Minutes, and it needs the daemon.

```sh
cd /opt/agent-task-manager && sudo -u atm bun run images:build
```

**8. The services.**

```sh
sudo install -m 0644 deploy/atm-gateway.service deploy/atm-loop.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now atm-gateway atm-loop
```

**9. Caddy.** Install from the official apt repository, then point it at the
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
  scheme and host, no trailing slash. Caddy can grant the SPA permission to send
  its cookie, but it cannot make the cookie sendable: a dashboard on another
  origin needs the session cookie issued `SameSite=None; Secure`, and that is set
  where the cookie is set, in the gateway's auth configuration.
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
- **Agent credentials** in `loop.env`, if the model provider needs them.
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

## What was actually checked

- `caddy validate --adapter caddyfile` on this Caddyfile, in a `caddy:2`
  container with the four variables set: *Valid configuration*. It has never
  served a request, held an SSE stream, or ordered a certificate.
- `systemd-analyze verify` on both units, in a `debian:12` container: no syntax
  or directive errors. The only complaints were that container's own — no
  `docker.service` and no `/usr/local/bin/bun`.
- Nothing else. No host has run these files, and the install steps above are
  written from the units and the code, not from a session that performed them.
