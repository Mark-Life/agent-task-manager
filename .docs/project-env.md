# Project environment files

A container gets its identity, its agent home and a package cache, and until now nothing else.
So an agent could build a repo and could not run it: no `DATABASE_URL`, no dev server, no
integration test, no browser loop against a real page. A project's environment files close that.

**The unit is a file with a repo-relative path**, not a key-value pair. `.env.local`,
`apps/web/.env`, `packages/db/.env.test` are three files, not three sets of keys — key-value
rows cannot say *where*, and a key-value editor destroys comments, blank lines, quoting and
multi-line values on the first save. The dashboard shows a list of paths per project and edits
one file's whole text in a textarea.

**Stored encrypted, in `project_env_file`.** `content_enc` is `bytea` holding
`iv ‖ ciphertext ‖ tag` — AES-256-GCM, key derived from `BETTER_AUTH_SECRET` under a label of
its own, exactly as `packages/token`'s signing key is derived under a label of its own. The
statement the driver sends carries ciphertext, so a statement log, a slow-query log and a
`pg_dump` all leak nothing; plaintext is never a query parameter. `key_version` is on the row
from the first migration even with one key: it names the derivation, so a later change of
algorithm ships as version 2, both open while a re-encryption pass runs, and the pass can tell a
done row from a pending one.

The encryption is the store's job. `ProjectEnvFileRepo` takes plaintext and hands plaintext
back; no consumer holds a key, and no application contains a line of crypto. The audit log
records that a file's text changed and how long it became — never the value, and never the
ciphertext either.

**The path is the one thing validated hard.** `EnvFilePath` in `@workspace/domain` refuses an
absolute path, any `.` or `..` segment, an empty segment, a backslash, a control character, any
`.git` segment, and anything over 256 characters. Refusals rather than repairs: normalizing a
path with `..` in it is how a validator and the filesystem come to disagree about which file was
meant. `.git` is refused at any depth because `.git/hooks/pre-commit` would turn an environment
file into arbitrary code. Because it is a schema, the API refuses a bad path at decode.

**Into the run.** `packages/orchestrator` reads the rows for the task's project, the store
decrypts them, and they travel to `packages/sandbox` as plain `{path, content}` — so the sandbox
package still never imports `packages/db`. `materialize` writes them into the checkout *after*
the clone returns (a file already sitting there is how `git clone` is made to refuse), `0600`,
parent directories created as needed, inside the scope that removes the checkout — so the one
copy in the clear dies with the run. Checkout directories are `0700`.

A task with no project gets none. A chat turn gets none.

Each path is appended to the checkout's own `.git/info/exclude`, so `git add .` skips it and
`git add .env` refuses by name. Per checkout, so nothing touches a `.gitignore` the repository
tracks. It does not help with a path the repository *already tracks* — exclusion applies to
untracked files only.

A file that cannot be written fails the run. A container that boots without the `DATABASE_URL`
the operator can see in the dashboard costs a debugging session; failing before a slot is spent
names the path and the reason.

**The leak encryption does not close.** The agent can read the files — that is the point of
writing them — so `cat .env` puts the value in a tool result, in the transcript, and into
Postgres in the clear, permanently. Mitigation: every event entering the loop has this run's own
secret values replaced with `[redacted]` before it reaches a row, the final text or a comment;
and at the close, the run's event file and its durable transcript copy are rewritten with the
same replacement, so a re-ingest weeks later cannot put a secret back.

What is redacted is the right-hand sides, not the whole file — the key name is what makes
`DATABASE_URL=[redacted]` readable — and only values of twelve characters or more, since
scrubbing `test` out of every log line costs more than it protects. It is not a filter: a value
the agent reformats or base64s survives it. It is worth doing because `cat` is the case that
actually happens. The provider's own transcript inside the shared agent home is not rewritten;
that is the vendor's directory and every run on the host writes into it.

**API and UI.** Four operations on the `projects` group, all `admin`:

| | |
| --- | --- |
| `GET /projects/:projectId/env` | paths and timestamps, never content |
| `GET /projects/:projectId/env/:fileId` | decrypted content, for the editor |
| `PUT /projects/:projectId/env` | upsert on the path |
| `DELETE /projects/:projectId/env/:fileId` | |

`admin` and not `task-write` is load-bearing. A worker run's token is `task-write` bound to one
task, and `admin` is a scope its actor's ceiling can never reach — so "a run cannot ask the
board for a project's secrets" is enforced by the ceiling rather than by a check in a handler.
A run is given its own project's files on disk, by the loop, and that is the only path they
travel. Addressed by row id rather than by path because a repo-relative path has slashes in it.

**The trust boundary, stated plainly.** Whoever holds the loop's environment holds
`BETTER_AUTH_SECRET` and can open every project's files. On a single-operator host with secrets
in one file read by one service account, that is the boundary the GitHub token and the Executor
key already sit behind. A per-project wrapped key would only start to mean something with a
second operator, and by then the sandboxes are somebody else's service.

Rotating `BETTER_AUTH_SECRET` itself is a re-encryption pass, not a config change: every sealed
value has to be opened under the old secret and re-sealed under the new one. `secretSealerFrom`
takes the secret as an argument so a script can hold both sealers at once.
