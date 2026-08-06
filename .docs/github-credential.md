# The GitHub credential an agent holds

An agent could push code and could not push CI. A task on another board implemented
linux-arm64 support, and the half of it under `.github/workflows/` was refused by GitHub with
*"refusing to allow an OAuth App to create or update workflow `.github/workflows/publish-cli.yml`
without `workflow` scope"*. The run saved that half as a patch file in its artifacts and opened a
pull request with the rest. The pull request reviewed as complete: two installers taught to fetch
an asset, and nothing in the branch that builds it.

The refusal was correct and the workaround was the bug. This note records what the credential is,
what it needs to be, and what each side of the system now does about it.

## What the credential is

**An operator-supplied token in `ATM_GITHUB_TOKEN`. Nothing mints it.** There is no GitHub App,
no OAuth flow of ours, and no per-project credential — one value in the loop's environment file,
read once at layer build (`packages/sandbox/src/github.ts`), and reaching two tools:

- the host's `git`, through an inline credential helper that names the variable and never holds
  the value (`credentialConfigArgs`, applied in `packages/sandbox/src/git.ts` and written into
  each run's checkout by `repo.ts`);
- every container, as `GH_TOKEN` and `GITHUB_TOKEN` on its environment
  (`githubTokenEnv`, wired at `packages/orchestrator/src/runtime.ts`), which is what logs `gh` in
  with no configuration at all.

So `gh` in a sandbox was never the missing piece: it is authenticated, and `gh api` reaches
repository settings today — reading a repository's visibility and the token's own permissions on
it works. What was missing was scope on the token, and any statement about what an agent can do is
a statement about that token and nothing else.

**On this install it was a `gho_` token — the OAuth token `gh auth login` leaves behind**, carrying
`admin:public_key, gist, read:org, repo`. That set is the GitHub CLI's default consent, and
`workflow` is not in it. The kind matters because it decides the remedy: an OAuth token's scopes
were fixed when somebody approved the login, so widening one is a re-consent rather than an edit.

## What it needs

| | Scopes | Why |
| --- | --- | --- |
| Required | `repo`, `workflow` | clone, push, pull requests — and the file under `.github/workflows/`. `repo` does not imply `workflow`: GitHub treats writing code and writing what runs on every push to that code as different powers. |
| Owner-level | `admin:repo_hook`, `read:org`, `delete_repo` | repository settings and webhooks, organisation-owned repositories, and the destructive end of repository administration. |

On a fine-grained token or a GitHub App the same thing is spelled as repository permissions:
**Contents, Workflows, Pull requests, Issues and Administration at write**. `Contents: write` does
not grant `Workflows: write`, exactly as `repo` does not grant `workflow`, and `Administration:
write` is what a visibility change needs.

### Widening it

- **OAuth (`gh auth login`)** — a re-consent:
  `gh auth refresh -h github.com -s repo,workflow,admin:repo_hook,read:org,delete_repo`, then
  `gh auth token` into `ATM_GITHUB_TOKEN`.
- **Classic PAT** — re-mint at <https://github.com/settings/tokens> with those scopes.
- **Fine-grained PAT** — edit at <https://github.com/settings/personal-access-tokens> and give it
  the permissions above on the repositories the board works on.
- **GitHub App** — widen the App's permissions *and re-approve the installation*. Until that
  approval, every token it mints carries the old set.

**Only new runs pick up a widened credential.** The token is read once per process, at layer
build, and handed to every dispatch after that — so a widened token means restarting the loop, and
a container already running keeps the value it was started with. That is deliberate (one read is
one answer; two runs in a process cannot disagree about which account they are) and it is the
thing to remember after a re-mint.

### Which credential to prefer

**A fine-grained token over the repositories the board has projects for, at full permission.** The
person who owns this board asked for full access — flip a repo between public and private, edit
CI, manage releases — and that is the call. What it does not have to be is account-wide: the token
is on the environment of a container running model-generated code, and the run's checkout carries
a credential helper naming it, so an agent can read it and use it against anything in its scope. A
token that can change repository visibility can change it on repositories this board never touches.
Selected-repository scoping costs one settings page and removes that entirely.

Where that is not achievable — an organisation that has not enabled fine-grained tokens, a flow
that only issues an account-wide one — take the wider credential. The access was asked for; the
narrowing is an improvement on it, not a condition of it.

## What the system does about it now

**The loop says what the credential can do, at boot.** `probeGithubCredential`
(`packages/sandbox/src/scopes.ts`) spends one `GET /user` and reads `x-oauth-scopes` off the
response — the same request `./committer` already makes to decide whose name the commits carry.
Five outcomes, each its own line: nothing configured, a token GitHub refuses, a token GitHub did
not get to answer about, a token whose permissions no header carries (fine-grained, App), and a
token whose scopes are these. A missing scope is a warning naming the scope, the refusal it will
cause, and the exact way to widen that kind of credential. None of them stops a boot: a board
whose repositories nobody pushes to still works.

**`bun run github:check` prints the same thing on demand**, and exits non-zero when a *required*
scope is missing, so a deploy step can gate on it. Given a repository —
`bun run github:check owner/name` — it also reads that repository through the API and prints its
visibility and the token's permissions on it, which is the settings-side check a scope list cannot
make on its own.

**A worker run is told what it holds and what a refusal means.** `CREDENTIAL_RULES` in
`packages/prompts` goes into the prompt of every run that has a repository: `git` and `gh` are
authenticated, `gh auth status` prints what the token carries, and a refusal is a finding to report
— which operation, which scope — never a thing to route around. It names the three improvisations
that look like finishing: the patch file, the pull request that describes the half it could not
include, the plan quietly narrowed to what the token allowed.

That last one is the actual fix for how this stayed quiet. A scope can be widened in a minute once
somebody knows; a run that works around a wall produces a branch that looks reviewable and is not.
