# Who a run's commits belong to

Run commits used to say `Agent Task Manager <agent@atm.invalid>`, which GitHub
can link to nobody. They now say whoever owns `ATM_GITHUB_TOKEN`, at that
account's no-reply address, resolved once per loop boot from the token itself.
This note is the investigation that decided it, and it records the state before
and after — the "before" matters, because most of it is still true and it is
what the options were weighed against.

One line of policy caused it, and nothing else: `packages/sandbox/src/repo.ts`
set every run checkout's `user.name` and `user.email` to the agent, and no
caller overrode it. The credential the run pushes with already belongs to the
human — it is a GitHub CLI OAuth token for `Mark-Life` — so the *pusher* was
always the person, and only the commit's author and committer fields said
otherwise.

File references are to the `mvp` branch, which is where the system lives. `main`
is still the scaffold.

## Where identity is set

`materializeRepo` writes three `git config --local` values into the run's
checkout on the host, before the directory is mounted into the container
(`packages/sandbox/src/repo.ts:466-477`): the credential helper, `user.name`,
`user.email`. It takes a `committer` in its input (`repo.ts:397`) and falls back
to `DEFAULT_COMMITTER` when that is null (`repo.ts:432`).

That seam existed and was unfed. The only production caller,
`cloneIntoWorkspace` (`repo.ts:516`), hardcoded `committer: null`, and it is
reached through the workspace materializer's clone seam
(`packages/sandbox/src/workspace.ts`). It is now fed by `workspaceLayer`
(`workspace.ts:315`), which resolves the identity at layer build and closes over
it — see [What changed](#what-changed).

`DEFAULT_COMMITTER` (`repo.ts:97`) is still `Agent Task Manager
<agent@atm.invalid>`, now as the fallback for a run with no credential. Its
comment used to argue against a real address at all: the commits are the
agent's, and pointing them at a real mailbox would attribute them to a person
who did not write them. That is the policy this reverses, and the comment now
states the one in force.

Nothing else sets an identity. The image ships none on purpose (`docker/README.md`,
"No git identity ... policy, not tooling"); confirmed inside this run's container,
where `/etc/gitconfig` holds only `safe.directory=*` and there is no
`~/.gitconfig`. No `GIT_AUTHOR_*` or `GIT_COMMITTER_*` anywhere in the repo.

The practical effect of `.invalid`: the TLD is reserved, so no GitHub account can
ever claim it and GitHub cannot link the commit to anybody. The API returns
`author: null` for run commits — checked on `136e1e6`, the commit on PR #8. On the
web it renders as a plain name with a default avatar, no profile link, and no
contribution credit.

## How pushes are authenticated

One token, and it is the operator's own. The operator sets `ATM_GITHUB_TOKEN`
(`packages/sandbox/src/github.ts:42`, documented at `deploy/loop.env.example:60-75`);
the loop copies it onto every container's environment as both `GH_TOKEN` and
`GITHUB_TOKEN` (`github.ts:96-104`, wired at `packages/orchestrator/src/runtime.ts:248`
and `:260`). Git reads the same value through an inline credential helper written
into the run checkout (`github.ts:70`, installed at `repo.ts:454-457`); host-side
git gets it through `credentialConfigArgs` (`github.ts:82-87`, applied at
`packages/sandbox/src/git.ts:129`). `gh` picks up `GH_TOKEN` with no configuration,
which is how the agent can run `gh pr create` — the instruction to do so comes from
`packages/prompts/src/render.ts:91`.

In this run the token is `gho_…`, 40 characters, scopes `admin:public_key, gist,
read:org, repo`, and `gh api user` resolves it to `Mark-Life` / Andrey Markin /
`108@mark-life.com`. That is a GitHub CLI OAuth user token — the output of
`gh auth token` on the operator's machine. It is not a GitHub App installation
token (`ghs_`), not a PAT (`ghp_` / `github_pat_`), and not a deploy key; the
remote is HTTPS and the container has no `~/.ssh`.

So the pusher is the human, and PRs opened from a run are opened by the human:
PR #8's `user` is `Mark-Life`. Nothing about the current setup makes an app the
actor.

## Signing

Nothing signs anything. No `commit.gpgsign`, `gpg.format`, or `user.signingkey`
in the repo or in any container config; `gpg` is not even installed in the image
(`git log --show-signature` answers `cannot run gpg: No such file or directory`).
Run commits come back from the API as `verified: false, reason: unsigned`. The
only signing code in the repo is HMAC for the board's own tokens
(`packages/token/src/tokens.ts`), which has nothing to do with git.

The API-side path is not used either: no code creates commits through GitHub's
contents or git-data API, so no commit is signed with the token's identity. The
one exception is GitHub's own squash-merge commit, created server-side, which is
signed by `web-flow` and does show Verified.

## The co-author trailer

It comes from Claude Code, not from this system, and it carries no user
attribution. The repo never mentions `Co-authored-by` or `noreply@anthropic.com`;
the trailer is the CLI's default and names the model:
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

A trailer is text in the commit message and does not touch the author field.
GitHub parses it to add extra avatars, but only for addresses that belong to an
account, and Anthropic's no-reply does not — so it links to nothing.

## Author, committer, pusher — what each one showed

Author and committer were both `Agent Task Manager <agent@atm.invalid>`:
unlinked, uncredited, unsigned. The pusher is `Mark-Life`, and so is the PR.

Then the merge changes the answer. GitHub's squash re-authors the result to the PR
author and preserves the original as a trailer. `06753b1` on `mvp` — the squash of
PR #8, whose single branch commit was authored by the agent — has author
`Andrey Markin <108@mark-life.com>`, committer `GitHub <noreply@github.com>`,
`verified: true`, and `Co-authored-by: Agent Task Manager <agent@atm.invalid>` in
the body.

That matters for how much this is worth fixing. Trunk already reads as the human,
verified. The misattribution is visible on the branch and in the PR's commit list,
and it would reach trunk only under a merge-commit or rebase merge strategy.

## Options

**A. Set the author per run from the user's GitHub identity.** Pass a real
`Committer` down the seam that already exists (`repo.ts:397` → `repo.ts:432`).
The identity needs no new credential: `GET /user` with the token in hand returns
login, id, and public email, and the no-reply form
`{id}+{login}@users.noreply.github.com` is derivable from the first two with no
extra scope — for this account, `88837967+Mark-Life@users.noreply.github.com`.
(`user/emails` is out of reach; the token lacks the `user` scope. The no-reply
address sidesteps that entirely and is the right choice even where a public email
exists.) Cost is small: one API call per loop boot, cached, plus a fallback to
`DEFAULT_COMMITTER` when there is no token. The real cost is the policy — commits
would say a person wrote code they did not write, and blame, the contribution
graph and every reviewer's reflex would follow. It is also only correct while one
human runs the board: the token is workspace-wide, so a second member's task would
still be attributed to the token's owner. The database knows who asked, but only
as `audit_entry.actor_user_id` (`packages/db/src/schema/audit.ts`) holding a login
email, not a GitHub identity.

**B. Commit through the GitHub API as the user.** Commits created through the
contents or git-data API are signed by GitHub with the token's identity, so this
is the only option that gets both the user as author and a Verified badge, and the
user OAuth token it needs is the one already installed. The cost is the whole
commit path: an agent commits locally many times a turn, with hooks, amends and
rebases, and routing that through the API means either re-implementing it or
rewriting every run commit after the fact. Not worth it for a badge.

**C. Keep the agent as author, add the user as co-author.** Same identity lookup
as A, no new credential, and it is honest — the human gets an avatar on the commit
and contribution credit, the author field still says who wrote the code. The
weakness is enforcement. The agent writes its own commit messages, so this is
either prompt guidance (`packages/prompts/src/render.ts`) or a `commit-msg` hook
written into the checkout beside the config at `repo.ts:466`. Guidance is a
request; the hook is enforced but will surprise an agent that reads back what it
just committed.

**D, for completeness: give the agent its own GitHub account.** A machine user
with a real `users.noreply.github.com` address makes run commits link to an avatar
and a profile without claiming a person wrote them. It costs an account to create
and manage, and if the identity is to be a GitHub App bot rather than a machine
user, an installation token — which cuts against the current design of one user
token doing everything.

## Recommendation

Take A, with the no-reply address, and keep the model's co-author trailer.
`user.name` becomes the account's display name and `user.email` becomes
`{id}+{login}@users.noreply.github.com`, resolved once per loop boot from the token
already configured. That links every run commit to the account that asked for the
work, gives contribution credit, leaks no mailbox, and makes branch commits match
what the squash merge already writes to trunk. The trailer keeps the record
straight about a model having written it, and the commit body already names the
task.

Not recommended now: signing. It would take an SSH signing key inside the
container — a credential model-generated code can read — for a badge that trunk
already gets from GitHub's own squash signature.

## What changed

A is what shipped, after the policy call it needed.

`packages/sandbox/src/committer.ts` resolves the identity: `GET /user` with
`ATM_GITHUB_TOKEN`, then `{id}+{login}@users.noreply.github.com` and the
account's display name, falling back to its login. The id leads the address
because a login can be renamed and the numeric prefix cannot.

`workspaceLayer` (`packages/sandbox/src/workspace.ts:315`) calls it once, at
layer build, and closes over the answer for the life of the process. That is the
only place it can be read once: the clone seam answers with `Scope` alone and
cannot ask a service who it is, and a lookup inside the clone would put a GitHub
request on the path of every dispatch for an answer that cannot change while the
loop runs. `cloneIntoWorkspace` (`repo.ts:516`) takes the committer it is handed.

The lookup is total and capped at ten seconds. No token, a 401, an endpoint that
is down, a body that changed shape: every one of them logs at info and takes
`DEFAULT_COMMITTER`, so a GitHub that is not answering costs one boot a short
delay and a process that commits as the agent — never a loop that will not start
or a dispatch that fails. The identity a boot settled on is logged once, which is
where an operator asking "why do the commits say that" should look first.

What did not change: the credential, the push path, the trailer, and signing.
Commits are still unsigned, the model's `Co-Authored-By` still records who wrote
them, and the merge still re-authors to the PR author.

Revisit when a second person uses the board. The token is workspace-wide, so
this attributes to its owner rather than to whoever filed the card, and real
per-requester attribution needs a GitHub identity per user that the schema does
not hold.
