# Deploying on the VPS

Caddy on the front, two long-running Bun processes behind it, Postgres in a
Compose container beside them. What has and has not actually been run is stated
at the bottom, and it is worth reading before trusting a step here.

There are two shapes. The install below is the hardened one: a `nologin` service
account, a checkout in `/opt` nobody edits, secrets in `/etc`. The other is
[systemd user units from your own checkout](#running-it-from-your-own-checkout-instead),
which is what to use while the system is still being built.

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
it on the command line rather than writing it into an env file. Re-running the
seed leaves an existing password alone, so a rotation is not undone by the next
deploy — and rotating means `POST /api/auth/change-password` with that session's
cookie, because the dashboard has no account screen to do it from.

```sh
cd /opt/agent-task-manager
sudo -u atm DATABASE_URL="$(sudo grep ^DATABASE_URL= /etc/agent-task-manager/common.env | cut -d= -f2-)" \
  OWNER_PASSWORD='...' bun run db:seed
```

**6b. An account of your own.** The seeded owner is
`owner@agent-task-manager.local`, an address nobody owns and nothing mails.
`user:add` is what turns that into a person with their own email, and it is the
only way a second person is ever added — sign-up is closed and no invitation can
be sent, because nothing on this host sends mail.

```sh
cd /opt/agent-task-manager
sudo -u atm USER_PASSWORD='...' bun run user:add --email you@example.com --name You
```

It prints the `userId` and `workspaceId`, which are two of the three fields in a
`TELEGRAM_ALLOWLIST` entry and exist nowhere a person could otherwise read them
off. Re-running it changes nothing: an existing account is reused, an existing
password left alone, an existing membership not written twice.

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
cd /opt/agent-task-manager && sudo -u atm bun run quota:check
```

`quota:check` reads the same two logins and prints what is left on each
subscription, per window. It is the fastest way to see that a home is logged
into the account you meant — and the loop reads exactly the same files, so a
provider that prints "no signal" here is one the board will dispatch against
blind and show as unavailable on the dashboard.

The paths must match `ATM_AGENT_HOME_DIR_CLAUDE` / `ATM_AGENT_HOME_DIR_CODEX` in
`loop.env`, be mode `0700`, and be owned by the uid the loop's containers run as
— which is the loop's own, because a bind mount does no id translation. From
then on the containers refresh the tokens in place and nothing re-seeds them.

**8. Sandbox images and the two bundles.** The loop starts containers from
images that exist only once somebody builds them; a loop without them fails
every run it picks up. Minutes, and it needs the daemon. The two bundles are
mounted read-only into each run rather than baked into the image, because they
change with the code and the image does not — so they are rebuilt on every
deploy, and a missing one fails the run by name. Rebuilding while runs are going
is safe: each build writes beside its bundle and renames onto it, and a
container that is already up keeps the file it started with.

```sh
cd /opt/agent-task-manager
sudo -u atm bun run images:build
sudo -u atm bun run entrypoint:build   # ${DATA_ROOT}/bin/turn.js — the container's turn
sudo -u atm bun run agent-mcp:build    # ${DATA_ROOT}/bin/agent-mcp.js — the board tools
```

`images:build` also sweeps: each image's dated tags beyond the newest two, and
the whole build cache. That is the only thing on this host that removes docker
data, and without it a weekly rebuild adds a few gigabytes a week to a disk that
also holds every run's checkout. `bun run images:build --prune` is the sweep on
its own, for a host that has been building for a while; `docker/README.md` says
what it will not remove and why.

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

**On a host whose Caddy already serves something else**, copying over
`/etc/caddy/Caddyfile` takes that site down. Import instead — which is why the
Caddyfile here has no global options block and sets the ACME email per site:

```sh
sudo mkdir -p /etc/caddy/conf.d
sudo cp /opt/agent-task-manager/deploy/Caddyfile /etc/caddy/conf.d/atm.caddy
printf '\nimport conf.d/*.caddy\n' | sudo tee -a /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Validate by hand and you must load the environment yourself.** The drop-in is
systemd's, so a plain `sudo caddy validate` sees none of the `ATM_*` variables,
`{$ATM_DOMAIN} {` collapses to a bare `{`, and Caddy reports *server block
without any key is global configuration, and if used, it must be first* — which
reads as a broken Caddyfile and is nothing of the kind:

```sh
sudo bash -c 'set -a; . /etc/agent-task-manager/caddy.env; set +a; \
  caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile'
```

**11. The dashboard's files.** Caddy serves them off disk, as its own user, so
they cannot live somewhere only the operator can reach: a home directory is
`0750` on most distributions and `caddy` cannot traverse it, which is a 403 on
every page and nothing in the gateway's log to explain it.

```sh
sudo install -d -o atm -g atm /srv/agent-task-manager/dashboard
cd /opt/agent-task-manager
VITE_GATEWAY_URL=https://api.atm.example.com bun run dashboard:build
ATM_DASHBOARD_ROOT=/srv/agent-task-manager/dashboard bun run dashboard:publish
```

The gateway's address is compiled into the bundle rather than read at runtime,
so a change to it is a rebuild, not a restart.

## Running it from your own checkout instead

The install above is for a host that only runs this. There is a second shape,
`deploy/user/`, for the one that does not: the services run as **systemd user
units** under the operator's own login, from the checkout they edit, with no
`atm` account and no `/opt`. A code change is `bun run service:restart`, not a
deploy — which is the right trade while the system is still being built, and the
wrong one afterwards, because everything the loop can reach is everything the
operator can reach.

Write the environment files first — `common.env`, `gateway.env`, `loop.env` and
`bot.env`, from the `*.env.example` files here minus the paths under `/opt` and
`/var/lib`, at `chmod 0600`:

```sh
mkdir -p ~/.config/agent-task-manager
bun run service:install
```

`service:install` is `scripts/service.ts` and it is the whole of it: it writes
the units, reloads systemd, enables and starts each service whose environment
files are present, restarts any whose unit changed, and turns linger on.
Re-running it is how an edit to a unit takes effect, and running it twice does
nothing the second time.

Four services, five unit files. `backup` is the odd one: a `Type=oneshot`
service plus `atm-backup.timer`, and the timer is what gets enabled, started,
stopped and reported on. `bun run service:status backup` showing the timer
`active` is the schedule being armed, not a backup in progress — see
[Backups](#backups).

Linger is not a detail: without it the units stop with your last session and do
not come back after a reboot, and `Persistent=yes` on the backup timer needs its
state directory for the same reason. `service:install` enables it, or says which
`sudo loginctl enable-linger` to run when it cannot.

```sh
bun run service:status                 # active, enabled and linger, per service
bun run service:logs -n 50 loop        # journalctl, followed unless --no-follow
bun run service:restart gateway bot    # name any subset; none means all
```

The unit files stay the source of truth. `service:install` substitutes exactly
two things into them — where the repository is and where `bun` is — so a
checkout anywhere works without editing a committed file.

Three things differ from the install above and are easy to miss.

- **The units are `ProtectSystem=full`, not `strict`.** The checkout, the data
  root and the agent homes are all under `$HOME`, and `strict` would make every
  one of them read-only.
- **The agent homes keep their defaults**, `~/.claude-task-management` and
  `~/.codex-task-management`, because the service *is* the operator — so
  `ATM_AGENT_HOME_DIR_*` can stay unset and `bun run agent-home:login` creates
  them at the right mode.
- **`DATA_ROOT` must be the same absolute path the build scripts write to.**
  They read it from the checkout's `.env` and the services read it from
  `common.env`; if those two disagree, `images:build` and `entrypoint:build`
  land somewhere the loop does not look and every run fails on a missing bundle.

The checkout's `.env` is still there and still read, by the process rather than
by systemd, for any name the unit's environment files do not set — the loader
does not override. That is the one real cost of this shape: two files can
configure one process. Spell out everything that decides behaviour in
`~/.config/agent-task-manager/`, and `.env` never gets a vote.

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
  session cookie is scoped to this domain so the dashboard's host and the API's
  are one site to the browser — which is the whole plan, because a third-party
  cookie is dropped by Safari and Firefox however it is labelled. Scope it as
  narrowly as the two hosts allow: every host under this domain is one that can
  be asked for the session cookie, so a domain wide enough to cover an unrelated
  application on the same box hands that application your sessions. Setting it
  with no `BETTER_AUTH_URL` in `common.env` fails the gateway at boot.
- **`OWNER_PASSWORD`** at seed time, step 6a. Sign-up is closed, so this is the
  only way anybody gets a login.
- **`DATABASE_URL`** in `common.env` and the matching `POSTGRES_PASSWORD` for
  Compose. Two places, one password.
- **`GATEWAY_PUBLIC_URL`** in `gateway.env`. It is what the served spec
  advertises as `servers[0].url`; wrong here means a connector that reads the
  document correctly and then calls localhost.
- **`BETTER_AUTH_SECRET`** in `common.env`, from `openssl rand -base64 32`, and
  in `common.env` because **all three processes must hold the same one**. The
  gateway signs session cookies with it and verifies every bearer token against
  a key derived from it; the loop mints one such token per run so a container
  can reach the board, and the bot mints one per message it relays.

  Splitting it is the quietest failure in this system. The gateway boots
  normally on its own value, serves the dashboard, and rejects every token the
  other two mint — a 401 on each board tool call, with nothing anywhere saying
  the two sides disagree about a key. An agent in that state reports its tools
  not working and looks like a model problem. Checked by minting a token from
  the same file the services read and calling a real endpoint with it:

  ```sh
  set -a; . /etc/agent-task-manager/common.env; set +a
  token=$(bun run gateway:token --user <userId> --workspace <workspaceId> --scope read)
  curl -s -o /dev/null -w '%{http_code}\n' localhost:3100/projects -H "Authorization: Bearer $token"
  ```

  200 means the two agree. 401 means they do not — and note that running
  `gateway:token` *without* sourcing that file signs with whatever
  `BETTER_AUTH_SECRET` the checkout's `.env` carries, which is a different key
  and a 401 that says nothing about the deployment.

  Rotating it is the only revocation there is, and it logs everybody out.
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
- **A firewall**, and here it is load-bearing rather than a precaution. Postgres
  is on loopback, but **the gateway is not**: `BunHttpServer.layer({ port })` in
  `apps/gateway/src/layers.ts` is given no hostname, so Bun binds `0.0.0.0` and
  port 3100 answers on the public interface with no certificate in front of it.
  That is not a bug to fix by binding loopback — a turn's container runs on the
  default bridge and reaches the host at the docker0 address, so a loopback-only
  gateway is one no agent can use. The firewall is what closes the public half
  and leaves the bridge open:

  ```sh
  sudo ufw allow 80,443/tcp
  sudo ufw allow in on docker0 to any port 3100 proto tcp
  sudo ufw default deny incoming
  ```

  Without the second rule `ORCHESTRATOR_GATEWAY_URL` points at a port that
  times out, and every turn runs with no board tools. A default-deny host drops
  that traffic silently — ICMP to the host still answers, which makes it read
  as a hung gateway rather than a blocked port. Check it from a container
  rather than from the host, where loopback would answer either way:

  ```sh
  docker run --rm alpine:3 wget -qO- -T3 http://172.17.0.1:3100/health
  ```

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
signed from `BETTER_AUTH_SECRET` and expire. Three things mint them — the loop
per run, the bot per message, and `gateway:token` for you — and a 401 from any
of the three is the first thing to check against the secret entry above, since
the commonest cause is not an expired token but two processes holding different
keys.

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

**Upgrading past the board-tools mount, once.** Runs before that change each
kept a 1.7 MB copy of `agent-mcp.js` in their own directory, and nothing deletes
them. New runs make no more, and the old ones are safe to remove — the file is
identical on every run and nothing reads it once the run has ended:

```sh
find ${DATA_ROOT}/runs -name agent-mcp.js -delete
```

## Backups

Everything the board knows is in one Docker volume, `atm_postgres_data`, and
every file a run kept is in one directory under `DATA_ROOT`. `scripts/backup.ts`
makes a second copy of both, nightly, and can restore one.

```sh
bun run service:install backup    # writes the units, arms atm-backup.timer
bun run backup                    # take one now, in the foreground
bun run backup:list               # what is on disk and how old it is
bun run backup:verify             # restore the newest set and check every row count
```

A set is four files in `<DATA_ROOT>-backups/daily/<YYYY-MM-DD>/`:

| File | What it is |
| --- | --- |
| `db.dump` | `pg_dump --format=custom`, the whole database |
| `globals.sql` | `pg_dumpall --globals-only` — roles and their passwords, which `pg_dump` does not carry |
| `artifacts.tar.gz` | `<DATA_ROOT>/artifacts`, all three folders |
| `manifest.json` | sizes, sha256 of each file, and an exact row count per table taken immediately before the dump |

Fourteen daily sets and four weekly. A weekly set is **hardlinks** to the daily
one, relinked on every run in its week, so it ends up being that week's last
backup and costs nothing until the daily twin ages out. At this board's current
size — a 3.0 MB dump and a 3.5 MB artifact tree — the whole tree settles around
120 MB, against 17 GB free.

The tree is `0700` and every file `0600`, and that is not decoration: the dump
carries Better Auth password hashes and the encrypted project environment, and
`globals.sql` carries the Postgres role passwords. Copying a set off this host
copies all of that.

**`pg_dump` runs inside the Postgres container when Compose is running it.** A
`pg_dump` older than its server refuses, which is the single commonest way a
backup schedule turns out to have been failing for months; the container's own
client cannot be the wrong version. A host `pg_dump` is the fallback, and the
script checks its major version against the server's before writing anything.
`ATM_BACKUP_PG=host` or `=compose` forces one.

**Taking a backup does not need the loop stopped.** `pg_dump` reads one MVCC
snapshot and blocks no writer. The artifact tar is not snapshotted, so a file
being written while it runs can land half-copied; the next night's set has it
whole.

### Verifying

`bun run backup` finishes by reading the archive's table of contents and says
so in exactly those words. That proves the header is not truncated. It is not a
restore and proves nothing about the rows.

`bun run backup:verify` is the real check, and it needs a database to write to,
which is why the timer cannot run it for you. It creates a scratch database,
restores the archive into it, counts every table, compares each count against
the manifest written immediately before the dump, unpacks the artifact tar and
counts that too — then drops the scratch database, whether it passed or failed.
It exits non-zero on any mismatch. `--at weekly/2026-W32` checks a named set
instead of the newest daily one.

Run it after any change to the backup script, and once in a while regardless.

### Restoring

There is no partial path. A restore replaces the database.

```sh
bun run service:stop                       # the loop must not be writing
cd /opt/agent-task-manager                 # or your checkout
SET=/var/lib/agent-task-manager-backups/daily/2026-08-09

# 1. Roles. Only needed on a cluster that does not have them; on one that does
#    it says the role already exists, which is not a failure.
docker compose exec -T postgres psql -U user -d postgres < "$SET/globals.sql"

# 2. The database.
docker compose exec -T postgres dropdb -U user --if-exists agent_task_manager
docker compose exec -T postgres createdb -U user agent_task_manager
docker compose exec -T postgres pg_restore -U user -d agent_task_manager \
  --no-owner --no-privileges --exit-on-error < "$SET/db.dump"

# 3. The artifact tree.
tar --extract --gzip --file "$SET/artifacts.tar.gz" \
  --directory /var/lib/agent-task-manager

bun run service:start
```

**Do not run migrations after a restore.** The dump carries the schema as it was
at that moment. Restoring a set older than a migration puts you on the older
schema, and the checkout has to go back to a matching commit — this is what the
[Upgrading](#upgrading) section means by a rollback across a migration being a
restore rather than a checkout.

A restore brings back rows and files. It does not bring back containers or
leases: rows claiming a run was live come back too, and the loop reclaims and
reaps them at boot the same way it does after a crash.

### What is not in a set

Named so nobody assumes otherwise.

- **The JSONL event ledger** under `<DATA_ROOT>/events`. It has no rotation and
  no retention window yet, so it has no bounded size to budget for. Phase 9
  item 6 in `.docs/plan/02-build-plan.md` is that work, and the backup joins it
  there.
- **The agent homes**, `~/.claude-task-management` and `~/.codex-task-management`.
  They hold provider logins, not data, and a login is re-established by
  `bun run agent-home:login` rather than restored.
- **The environment files** in `/etc/agent-task-manager` or
  `~/.config/agent-task-manager`. Secrets an operator holds; a backup that
  copied them would put every secret in a second place on the same disk.
- **Run workspaces, checkouts and caches** under `DATA_ROOT`. Scratch, rebuilt
  on demand, and larger than everything else here combined.

The `/opt` install has no backup unit. `deploy/user/atm-backup.{service,timer}`
are user units and the script works from any checkout, so the missing piece
there is a system-wide unit pair running as `atm` — worth writing on the day
that shape is actually deployed, and not before.

## The dashboard, on Cloudflare

This is the second of two ways to serve it, and the one that has never been run.
The first is step 11 above: Caddy over a directory on this host, which needs no
Cloudflare account, no `alchemy` state and no second deploy path. Everything
below applies only if you want the bundle off this box.

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

The `/opt` install and the Cloudflare deployment are still written rather than
performed. The user-unit shape has been run.

Run on a host:

- **The user units.** `atm-gateway` and `atm-loop` started under
  `systemctl --user`, read their environment files, and came up. The gateway
  answered `/health` with `{"status":"ok"}`; the loop logged its slots, reclaimed
  leases, removed an orphan container and dispatched from the board.
- **`ss` says the gateway binds `*:3100`**, not loopback — see the firewall
  entry above, which is written from that observation rather than from the code.
- **A container could not reach `172.17.0.1:3100`** on a default-deny host while
  ICMP to the same address answered. This is the failure the firewall rule
  exists to prevent, seen rather than predicted.
- **`user:add`** created an account, linked its password and wrote its
  membership, and printed the two ids a `TELEGRAM_ALLOWLIST` entry needs.
- **`images:build`, `entrypoint:build`, `agent-mcp:build`** — two arm64 images
  and both bundles, from a clean host.
- **`dashboard:build`** with `VITE_GATEWAY_URL` set: the gateway's address is in
  the emitted JavaScript.

Served real requests, on one host:

- **This Caddyfile, imported into a Caddyfile already serving an unrelated
  site.** It ordered certificates for both hostnames and answered on them:
  `/health` and `/openapi.json` through the reverse proxy, the SPA at `/` and at
  a deep link that only `try_files` can resolve, `immutable` on a fingerprinted
  asset, and 204 to a preflight carrying `traceparent`. The unrelated site kept
  working. An SSE stream through `flush_interval -1` has still not been held.
- **The whole cookie path, cross-origin.** `POST /api/auth/sign-in/email` from
  the dashboard's origin to the gateway's answered 200 with
  `Access-Control-Allow-Origin` echoing that one origin, `Allow-Credentials`
  true, and `__Secure-better-auth.session_token` scoped `Domain=` the shared
  parent — so the two hosts are one site to the browser and a third domain under
  the same registrable name is not sent the cookie.

The backup, against a real Postgres 17.6 — the same version as the Compose
image — in a container, on its **host** channel. Not on the VPS, and not once
through Compose:

- **A dump and a real restore.** `bun run backup` against a migrated, seeded
  database; then `dropdb agent_task_manager`, `createdb`, `pg_restore` from that
  set, and every row back — including `drizzle.__drizzle_migrations`, which is
  what makes "do not run migrations after a restore" true. `bun run db:store-check`
  then drove the restored database through a task's whole lifecycle and passed.
  The artifact tar was extracted over a deleted `.data/artifacts` and the files
  came back.
- **`backup:verify` fails when it should.** With a byte flipped in the middle of
  `db.dump` it reported the sha256 mismatch, `pg_restore`'s "could not
  uncompress data", every table restored at 0 rows against what was dumped, and
  exited 1. With one table's count edited in the manifest it reported that one
  table. It dropped its scratch database in both cases; `pg_database` had none
  left behind.
- **Retention.** 20 day-stamped and 8 week-stamped sets pruned to 14 and 4, with
  a `.staging-*` directory and an unrecognised name left untouched.
- **Two runs in one day.** The second replaced the day's set atomically, the
  weekly hardlink was relinked to it — same inode, link count 2 — and no
  `.staging`, `.lock` or `.previous` was left behind.

Not exercised, and the place to look first if the first real night fails: the
**Compose channel**. `docker compose exec -T postgres pg_dump` with its stdout
redirected to a host file, and `pg_restore` fed from a host file on stdin, are
written and never run — there is no Docker in the container this was built in.
`ATM_BACKUP_PG=host` is the fallback if it misbehaves, and needs
`postgresql-client-17` on the host.

Adapted or verified, but never served a request:

- `systemd-analyze verify` on the system units, in a `debian:12` container, and
  on the user units on the host: no syntax or directive errors.
- **`atm-backup.service` and `atm-backup.timer` have not been run under
  systemd.** They render correctly through `service:install --dry-run`, and that
  is all that has been checked; there is no systemd in the container this was
  built in.
- `alchemy.run.ts` typechecks against the installed type definitions
  (`tsc --noEmit`, exit 0). It has never been executed and no Cloudflare
  resource exists.

Known not to work yet, and not a misconfiguration:

- **Cloning a private repository.** A run's checkout comes from the project's
  `repoUrl` and nothing else supplies git a credential, so a private remote
  fails as `Sandbox.CloneFailed` with git's "could not read Username" behind it.
  The only place a credential can live today is inside that URL.
- **Any turn at all, without a provider login.** An agent home with no
  credential in it starts a container that exits non-zero. `harness:check` names
  it; step 7 is the fix.
