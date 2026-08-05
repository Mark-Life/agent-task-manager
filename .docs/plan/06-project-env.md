# Project Environment Files — editable in the dashboard, encrypted at rest

A container today gets six variables and nothing else, and a project has no place to put
`DATABASE_URL`. So an agent can build a repo and cannot run it: no dev server, no
integration test, no browser loop against a real page. This is the blocker.

Single operator, one host, one workspace. Multi-tenant changes the whole answer — external
sandboxes, per-tenant keys — and none of it is designed for here.

---

## 1. Files, not key-value pairs

The unit is a file with a repo-relative path.

```
.env.local
apps/web/.env
packages/db/.env.test
```

Key-value rows cannot say *where*. One monorepo keeps everything at the root, another needs
a file per app, and a repo with `.env.staging` beside `.env.dev` has two files that are not
two sets of keys. A file also survives comments, blank lines, multi-line values and
whatever quoting the reader expects — a key-value UI destroys all four on the first save.

The dashboard shows a list of paths per project; editing one edits its whole text.

## 2. Storage

```
project_env_file
  workspace_id, project_id     composite FK, as every child table here
  path          text not null  repo-relative, unique per project
  content_enc   bytea not null  iv ‖ ciphertext ‖ tag
  key_version   smallint not null
  created_at, updated_at
```

Encrypted, not hashed: the value has to come back out. AES-256-GCM. The key is derived from
`BETTER_AUTH_SECRET` with HMAC under a new label, exactly as `deriveSigningKey` in
`packages/token/src/tokens.ts` derives the token signer — a second label, a second key,
never the signing one reused.

That is what answers the Postgres question. The statement carries ciphertext, so a statement
log, a slow-query log and a `pg_dump` all leak nothing. Plaintext is never a query
parameter.

`key_version` exists from the first migration even with one key. Without it, rotating
`BETTER_AUTH_SECRET` makes every stored file permanently unreadable, and that is discovered
at the worst possible moment. Two keys readable, newest written.

Lives in `packages/token` as `secrets.ts` — that package already owns the root secret and
its derivations, and a second module that reads `BETTER_AUTH_SECRET` is a second thing to
rotate.

## 3. Path validation

The one place to be strict. A pure function in `packages/sandbox`, unit tested:

- reject absolute paths
- reject any `..` segment after normalizing
- resolved path must stay under the workspace root
- reject a path whose parent resolves through an existing symlink

A path field that escapes the workspace writes anywhere the loop user can write, and the
loop user owns the data root.

## 4. Getting them into the run

`packages/sandbox` never imports `packages/db`, and that stays true. So:

1. `packages/orchestrator/src/run.ts` `directoriesFor` reads the rows for the task's
   project and decrypts them, holding each as `Redacted`.
2. It passes them as plain values on `MaterializeInput.envFiles`.
3. `packages/sandbox/src/workspace.ts` `materialize` writes each into the checkout after the
   clone returns, `0600`, creating parent directories as needed.

The sandbox package learns "write these bytes at these paths" and never learns where they
came from.

A task with no project gets none. A manager turn gets none.

## 5. Permissions and lifetime

Plaintext exists only inside the run's checkout, which is deleted when the run's scope
closes. Two tightenings go with this:

- `RUN_DIR_MODE` is `0o755` (`workspace.ts`). Workspace directories become `0700`.
- Env files `0600`.

Both matter because the data root is one directory shared by a service account.

## 6. The leak that encryption does not close

The agent can read the files — that is the point of writing them. So if it runs `cat .env`,
the value lands in the timeline and the transcript, in Postgres, in plaintext, permanently.
This is the leak that will actually happen.

Mitigation: on transcript and event ingest, replace exact matches of the run's own secret
values with a marker. The values are in hand at that moment, so it is a string replace over
the ingested text and nothing more clever. Not perfect — a value the agent reformats
survives — and worth doing anyway because `cat` is the common case.

Logs name paths, never contents, matching how `announceTurnEnv` names variables at boot.

## 7. API and UI

| Surface | Shape |
| --- | --- |
| `GET /projects/:id/env` | paths and `updated_at` only, never content |
| `GET /projects/:id/env/*path` | decrypted content, for the editor |
| `PUT /projects/:id/env/*path` | upsert |
| `DELETE /projects/:id/env/*path` | |
| Dashboard | project page, file list, plain textarea per file |

The read endpoint is the one that returns a secret over HTTP. Same session auth as the rest
of the dashboard, and it is the operator's own secret being shown back to them.

## 8. Order

1. `secrets.ts`: derive, seal, open. Pure, tested against a fixed key.
2. Migration and repository.
3. Path validation, pure, tested.
4. Materializer writes files; verify with a task that reads one back into an artifact.
5. Gateway routes, then the dashboard editor.
6. Transcript redaction.

Step 4 is the one that unblocks real work. Steps 5 onward are convenience — until the editor
exists, rows go in with a script.

## 9. Trust boundary, stated plainly

Whoever holds the loop's environment can decrypt every project's files. On a single-operator
VPS with secrets in `/etc/agent-task-manager` that is the boundary that already exists for
the GitHub token and the Executor key. A per-project wrapped key would only start to mean
something with a second operator, and by then sandboxes are somebody else's service.

---

## Unresolved

- Does a task need to opt out of its project's env files? A run that should not hold
  production credentials is a real case, but a per-task toggle is a switch nobody remembers
  to set.
- One file set per project, or named sets (`dev`, `staging`) selected per task?
- Should the editor refuse a file whose path is not gitignored in the target repo? Writing
  `.env` into a repo that tracks it means the agent can commit it.
- Is there a case for a project-level variable that is *not* a file — something injected as
  a real container env var rather than written to disk?
