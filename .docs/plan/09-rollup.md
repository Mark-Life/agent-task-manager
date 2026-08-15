# Umbrella rollup — one reviewable artifact per batch

Three tasks finish in parallel and the board hands back three pull requests. Reviewing three is
harder than reviewing one, so today the operator spawns a pod by hand and tells it to combine
them (PR #35 was that, done manually). This makes it a property of the project: when a batch
finishes, the loop files one card that builds the umbrella PR, and a worker builds it.

Nothing here is a manager run. The whole decision is a query against `task` and `project`, so it
is code — a model in the loop for "count the columns" buys nothing and costs a container.

## The trigger is not the decision

The decision is a function of board state, not of an event. Every sweep asks the same question
of the same rows and gets the same answer, so a notification that is delivered twice, delivered
late, or lost entirely changes latency and never outcome. That is the existing contract in
`packages/orchestrator/src/trigger.ts` — "a signal is a nudge to sweep" — and it is what
dissolves the open question about repeat firing: there is no per-event bookkeeping to get wrong.

So: evaluate in `sweep`, between the command drain and `takeWork`
(`packages/orchestrator/src/runtime.ts:751`). Filing the card before the column is read means the
same pass dispatches it — one sweep from decision to running container.

A card entering `review` should still wake a sweep, or the rollup waits on the 30-second poll.
One more trigger in a custom migration, beside the three already there:

```sql
CREATE TRIGGER task_notify_settled AFTER UPDATE ON "task"
  FOR EACH ROW WHEN (NEW.status = 'review' AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION notify_task_settled();   -- channel atm_task_settled, ids only
```

`atm_task_settled` becomes a fourth `DispatchSignal` source. It carries the workspace id and
nothing else, like the other three.

## The rules

One query per sweep per workspace, joined to `project`. A project is a candidate when all of:

- `project.rollup_enabled` is true. Off by default; this repo turns it on.
- No task in the project sits in `in_progress`. That column *is* the queue — nothing promotes a
  card out of `backlog` on its own, so "what is queued to go in progress" and "what is running"
  are one count. A parked card counts as in flight and blocks; parking is bounded by the retry
  ladder, so it clears.
- No open rollup card in the project — any task carrying `metadata.rollup` whose status is not
  `done`. This is the operator's own guard against near-duplicates, and it doubles as the guard
  against the half-failed file below.
- Two or more eligible members.

A task is an eligible member when it is in `review`, has a non-null `pr_url`, carries no
`metadata.rolledUpBy`, carries no `metadata.rollup` of its own, and its effective repo
(`task.repo_url ?? project.repo_url`) equals the project's. A card with a repo override is not
part of this batch and the skip is logged by id.

Everything else is a no-op, silently and repeatedly: work still in flight, one PR in review,
zero PRs in review, a project with the flag off.

**`metadata.rolledUpBy` is what stops the second rollup rolling up the first batch again.** Cards
sit in `review` until a person moves them to `done`, so "in review with a PR" is not "new". When
the umbrella is filed, each member is stamped with the rollup card's id, and the next batch sees
only unclaimed cards. Both keys go in `metadata`, which is where the task row already says
agent-invented fields live until one earns a column.

Walk the cycle through: A and B finish, umbrella C is filed and runs. C lands in `review` with
its own PR — but A and B are claimed and C is a rollup card, so zero eligible members and nothing
fires. The operator merges C and moves all three to `done`. D and E finish: unclaimed, nothing
running, no open rollup → fire.

## Filing it

Two writes, deliberately not one.

1. `TaskRepo.create` into `backlog`, with the composed brief, `projectId`, and
   `metadata.rollup = { kind: "umbrella", memberTaskIds: [...] }`.
2. `TaskRepo.transition` to `in_progress` with `after: null`, which is the top of the column and
   therefore the head of the dispatch queue.

Split so the failure is visible. A create that fails leaves nothing and the next sweep retries. A
transition that fails leaves a card in `backlog` holding its member list, an error in the log, and
the open-rollup guard already stopping a second attempt — the operator drags it and the worker
picks it up. v1 does not retry the move; self-healing that case is a later line, not a first one.

The member stamps are written in the same step as the create, before the move.

The loop writes these as the `orchestrator` actor, which today may only move `in_progress → review`
and may only create into `ideas` or `review`. So `TASK_TRANSITIONS` in `packages/domain/src/status.ts`
gains one row: `{ actorKinds: ["orchestrator"], from: "backlog", to: "in_progress" }`. Note what
that implies — `creatableStatuses` is derived from the same table, so the orchestrator gains the
right to create straight into `in_progress` too. It is a permission, not a behaviour; the rollup
module is the only caller and still takes two steps.

Nobody is asked first. The card is filed, visible, and running. Consent is the project flag, given
once, and the alternative is a board that waits for an answer to a question whose answer is always
yes on the one project that turns it on. This is also the one place the manager's own rule — file
into `backlog`, never straight into `in_progress`, because a card that appears already running is
a run nobody chose to start — is deliberately overridden, and the flag is what makes the choice
attributable.

Emit one wide event, `atm.rollup`, per evaluation that reaches a candidate project: project id,
decision, the reason it was refused, member count. "Why did it not fire" is otherwise a question
answered by re-deriving the query by hand.

## Where the convention lives

`project.rollup_enabled boolean not null default false`, a real column, toggled in the project
form. It must be a column rather than project rules text, because the code that reads it is a SQL
predicate and prompt text cannot be joined to. The sibling card on runtime-editable rules covers
what the *worker* is told; this covers whether the card exists at all.

One boolean, not an enum. A second rollup convention will change the decision rule and the brief
together, so it will not arrive as a new value in an existing column.

## What the worker is told

The brief is composed by code from a template — member titles, task ids and PR URLs are data the
query already holds. What each PR *changes* is not, and that is the worker's job:

> Combine the pull requests below into one branch off `<default branch>` and open a single pull
> request against it.
>
> - `<title>` — `<pr url>` (task `<id>`)
> - `<title>` — `<pr url>` (task `<id>`)
>
> Read each pull request's diff and write the umbrella PR body as a test checklist: one line per
> rolled-up change, in the words of someone about to click on it. Link each line to the PR it came
> from. A member PR that is already merged or closed is skipped and named in your comment.
>
> End with the exact commands to install, migrate and restart against this branch.

The template lives in the orchestrator beside the decision, not in `packages/prompts` — it is the
body of a card, not the rules an agent is given.

## Deploy is written down, not run

The rollup exists so the running product can be tested, so the commands belong to the umbrella
task. Running them does not: the worker is in a container that is not the operator's box, and the
manual version of this spawns a pod with full access precisely because of that. v1 ends at a PR
whose body carries the checklist and the commands. Making the loop run them is a separate card
with a separate blast radius.

## v1

1. Migration: `project.rollup_enabled`; `notify_task_settled` and its trigger.
2. `packages/domain`: the `Project` field; one row in `TASK_TRANSITIONS`.
3. `packages/orchestrator/src/rollup.ts`: the query, the two writes, the brief template, the
   `atm.rollup` event. Called from `sweep`. `atm_task_settled` added to the signal sources.
4. `packages/api` + dashboard project form: expose and toggle the flag.
5. Tests against a real Postgres: fires on two unclaimed PRs and nothing running; does not fire
   on one, on work in flight, on a claimed batch, on an open rollup card, or with the flag off.

Out: running the deploy commands, batches spanning two repos, asking before filing, retrying a
failed move, any second rollup convention.
