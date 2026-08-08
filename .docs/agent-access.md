# What the manager agent may reach, and why

A person asked the manager to file a project for a private repository. It could not confirm the
repository existed, could not resolve its owner, could not read its default branch. It guessed the
URL from the repositories of neighbouring projects and asked the person to check the guess.

This note is the decision that came out of that, and the reasoning, so that a later reader arguing
with it is arguing with something written down. The full map of how both roles are wired — every
file, every config key — is the artifact `agent-access-map.md` on the task *Document how manager
and worker agent access is configured today*; what follows assumes it rather than repeats it.

## The thing that was actually wrong

**The manager already had a shell and a logged-in `gh`.** It has had them since the commit that
moved a chat turn onto the worker's run path: same `docker run`, same hardening, same
`bypassPermissions`, same open egress, and `GH_TOKEN` on its environment because
`turnEnvironment` was one list built at boot and handed to every run.

What it did not have was permission to know that. `MANAGER_RULES` opened with *"You have no shell,
no repository and no access to a running agent's container"* — a sentence that was true when the
manager was a function inside the bot process and had been false for every release since. So the
model did what its instructions said it could do, which was guess.

That is the useful shape of this bug. **An unused capability and a missing one are the same thing
from outside.** No amount of grant fixes a model that has been told it has none, and the config
that needed changing was mostly prose.

## The decision

**1. The manager keeps the shell, the network and `gh`, and is told so.** Not as a new grant — as
the existing one, stated. The named use is reading GitHub while filing work: confirm a repository
exists, resolve its owner and default branch before a project is named after them, read the issue
or pull request somebody is asking about, check whether the branch a run pushed has landed. Look it
up rather than asking a person to confirm a guess.

**2. It reads GitHub and does not write it.** No clones to fix something, no commits, no pushes, no
pull requests, no repository settings. This is a rule in the prompt and nothing else is enforcing
it — see the honesty section below. The argument is the one the manager's rules already make about
the board: work done from a conversation has no card, no run and no branch anyone chose to review.
A shell does not change that, and the request that arrives as *"just fix the typo"* is exactly the
one where an unreviewable one-line commit gets made. When a person asks for a repository change,
the manager files the card.

**3. No checkout, and no writable directory that outlives the turn.** `/workspace` stays an empty
scratch that is deleted when the turn ends, and the manager is told that in those words. A manager
that clones is a manager doing the work, which is decision 2 with more steps; and a durable
artifacts folder would be a second place for output to live when a conversation's output is the
reply. The mount set does not change.

**4. Its board reach stays wide, and that is now a decision rather than a fall-through.** A manager
token is bound to a thread and a user, and `checkBinding` in the gateway only narrows a principal
carrying a `boundTaskId` — which a worker has and a manager does not. So the manager may write
anywhere on the board. That is the job: it files work, re-prioritises, briefs workers through
task messages, steers runs. Deletes stay out of reach for both roles, at `admin` scope, which no agent
token is minted at. Nothing here changed; it is recorded because it was previously true by omission.

**5. Which GitHub token the manager holds is the operator's call.** `turnEnvironment` now returns
one environment per role, and `ATM_MANAGER_GITHUB_TOKEN` — when set — replaces `GH_TOKEN` and
`GITHUB_TOKEN` for manager turns only. Unset, the manager holds `ATM_GITHUB_TOKEN`, the same token
a worker does.

That default deserves its argument, because "the read-only role holds the pushing token" reads like
an oversight:

- A default of *no credential* would leave the manager unable to check a repository on every
  install that never reads a deployment note — which is the bug this task opened with, shipped as a
  default.
- The manager may move a card into `in_progress`, and the worker run that starts holds the pushing
  token. Narrowing the manager's own credential puts a step in that path; it does not close it. The
  thing that closes it is the board itself, which is a different piece of work.
- The narrowing actually worth having is a token GitHub minted narrow, over the repositories this
  board has projects for. That is a settings page, not a distinction this code can make. So the
  system supplies the seam and the operator supplies the scope.

## What changed in the code

| | |
| --- | --- |
| `packages/prompts/src/rules.ts` | `MANAGER_RULES` loses the "no shell, no repository" sentence and gains *Your shell, and what it is for*. The tool list stops claiming to be everything in the container, which also ends a quieter mismatch: the manager has had Executor connector tools all along and its rules listed only the board's. |
| `packages/sandbox/src/github.ts` | `MANAGER_TOKEN_ENV_VAR` / `readManagerGithubToken`. Null means "no override", not "no credential"; the fallback is applied by the caller so it is one question with one answer. |
| `packages/orchestrator/src/runtime.ts` | `turnEnvironment` returns `{manager, worker}`, keyed by `RunAttachment["role"]`. The dispatch reads its role's entry. Boot logs a line for the manager's credential only when it differs. |

The mounts, the image, the hardening, the denied-tool list, the token scope, the gateway's binding
check and the two concurrency lanes are all untouched.

## What was considered and not done

**A read-only token minted by the system.** There is nothing to mint it with — no GitHub App, no
OAuth flow of ours. See `.docs/github-credential.md`.

**A smaller image for manager turns.** The manager runs `atm.local/base:latest` and needs almost
none of it. Real, and it is a start-latency and attack-surface argument rather than an access one,
so it belongs in its own card.

**Narrowing the manager's board writes.** The enforcement point is `checkBinding` plus the status
machine, not the tool table. Nobody has asked for a narrower manager, and decision 4 says why the
wide one is the job.

**Per-role harness settings.** `makeClaudeProvider(settings)`, `parseClaudeSettings` and
`mergeClaudeSettings` all exist and nothing calls them; `CLAUDE_SETTINGS_JSON` is read into
`packages/env` and consumed nowhere. That seam is where a genuinely different tool table per role
would go, and wiring it is the prerequisite for any such change. Out of scope here, worth a card.

## The honest part

**Decision 2 is guidance with no second enforcement, and this change makes it likelier to matter.**
Every other manager rule has something behind it — the audit row is written in the same transaction
as the change, the gateway refuses a delete, the status machine is checked. "Read, do not write" has
the model's compliance and nothing else. `gh` is on the container's environment and no gateway
stands between the model and it.

The capability did not change today; the manager could always have pushed. What changed is that it
now knows it can, and the input driving a manager turn is a chat message — including a forward of
somebody else's words. That is a real increase in likelihood over a capability that was already
there, and it is the cost of the fix rather than a surprise inside it.

`ATM_MANAGER_GITHUB_TOKEN` is the answer for an install that does not want to carry it: point it at
a token with read access and decision 2 stops being a promise. An install that wants both — the
manager reading and no chance of it writing — should set that variable.
