/**
 * What an agent is told it is, before it is told anything else.
 *
 * These rules are versioned with the code rather than kept in a file on disk or
 * a database row, and that is deliberate: they are the behaviour of a released
 * build, so a change to them belongs in a commit and a rollback of the build
 * has to be a rollback of them. An operator editing an agent's instructions
 * underneath a running deployment is a change with no diff and no author.
 *
 * Four blocks, and the split is the whole of what a role is allowed to change.
 * {@link SHARED_RULES} is true of anything this system runs in a container.
 * {@link ARTIFACT_RULES} is true of a run that has an artifacts folder, which
 * is every worker and no manager. {@link WORKER_RULES} and
 * {@link MANAGER_RULES} are the per-role text, and they are the only per-role
 * text there is.
 *
 * **A manager is told none of the worker's ending.** It has no card, no
 * artifacts folder and no comment to post, and the two rules that say otherwise
 * — the artifacts paragraph and the stop hook's comment rule — are worker rules
 * in both directions: the text below is only given to a worker, and
 * `commentRuleApplies` in `@workspace/harness` is what stops the hook from
 * being registered on a turn with no task. A manager that is handed either one
 * spends its turn explaining that it will not post onto an unrelated card,
 * which is a real conversation that happened and the reason this split exists.
 *
 * Four of the manager's rules are board policy and not phrasing, and each is
 * enforced somewhere else as well as stated here — prompt text is guidance, and
 * guidance is the wrong place for a guarantee:
 *
 * - **Files into `backlog`, never straight into `in_progress`.** A card that
 *   appears already running is a run nobody chose to start. The transition
 *   matrix still permits the move, because a person asking for it in so many
 *   words should get it; what the rule buys is that the default is the column a
 *   human triages from.
 * - **Confirms before deleting.** The gateway does not ask, and cannot: there is
 *   nobody to ask inside an HTTP call. What the store guarantees is only that
 *   the erasure is attributed and audited, so the audit row outlives the task it
 *   describes. The confirmation is a property of the conversation, which is
 *   exactly why it is stated to the model that holds the conversation.
 * - **Every write is attributed.** It happens whether or not the model reads
 *   this, because the token it holds carries the actor and the thread id, and
 *   the audit row is written in the same transaction as the change. Saying it
 *   here is what stops the model from apologising for edits it cannot avoid
 *   signing.
 * - **Running work is controlled only through run commands.** There is no other
 *   path from a conversation to a container, and the tool table has no way to
 *   express one. What the rule adds is that the model should not narrate a stop
 *   as though it happened: a command is queued, and the orchestrator acts on it.
 * - **The shell reads GitHub and does not write it.** This one is guidance and
 *   nothing else, and it is the only rule here with no second enforcement — the
 *   manager's container has `gh` on its environment and no gateway stands
 *   between the model and it. `ATM_MANAGER_GITHUB_TOKEN` is the enforcement an
 *   operator can add, and it is theirs to add rather than something this text
 *   can promise. `.docs/agent-access.md` is where that is argued.
 *
 * The paragraph naming the shell replaced one that said "You have no shell, no
 * repository and no access to a running agent's container". That was true while
 * the manager was a function inside the bot process and false from the commit
 * that moved a chat turn onto the worker's run path — the third clause is still
 * true and the first two had been wrong for as long as the manager had been a
 * container. What it cost is a turn that could not confirm a repository existed
 * and asked the person to check a URL it had guessed. A model does not reach
 * for a capability its instructions deny it, so an unused grant and a missing
 * one read identically from the outside.
 *
 * The tool names spelled below are asserted against the real tool table in
 * `manager.test.ts`, so a renamed tool is a failing test rather than a manager
 * confidently calling something that does not exist.
 */

import { HANDOFF_FILENAME } from "@workspace/domain";

/**
 * What is true of every run, whatever it was started to do.
 *
 * Both halves hold for a manager as much as for a worker: an answer in a
 * conversation is written down like a comment is, and a sentence narrating that
 * a card moved is noise in a chat window for the same reason it is noise in a
 * thread.
 */
export const SHARED_RULES = `## What counts as finishing

What you write down is the deliverable. Say what you did, what changed, and what the next reader needs to know — someone who was not here has only your words.

Lifecycle facts are not part of that. That a run started, that a card moved, that a command was queued: the system records each of those with a time and an author, and a sentence repeating one costs a reader a line and tells them nothing.`;

/**
 * What is true of a run that has somewhere to leave output, which is every
 * worker run and no manager one.
 *
 * The directories are named per run in the placement section, because their
 * paths change; the policy about them is here, because it does not. Stating
 * either in both places is how two spellings of one rule start to disagree.
 *
 * Kept out of {@link SHARED_RULES} because it is simply false of a manager
 * turn: that run's only writable directory is its scratch directory, nothing is
 * promoted out of it, and telling it that anything worth keeping goes there is
 * telling it to file its work somewhere nobody will ever read.
 */
export const ARTIFACT_RULES = `## What survives this run

You have one writable artifacts directory and two read-only ones. Anything worth keeping goes in the writable one; everything outside it is scratch and dies with the container.`;

/**
 * What the run's GitHub credential is, and what to do the moment GitHub refuses
 * to use it.
 *
 * Written because of a run that hit exactly this. A task needed a change under
 * `.github/workflows/`; the credential was a `gh auth login` token, which
 * carries `repo` and not `workflow`; GitHub rejected the push naming the scope,
 * in those words. The agent understood the refusal perfectly and then improvised
 * around it — it saved the blocked half as a patch file in its artifacts and
 * opened a pull request with the other half. The pull request reviewed as
 * complete. It taught two installers to fetch an asset that nothing in it built.
 *
 * So the rule is not "you may hit a permission wall". It is that a wall is a
 * finding to report and never a thing to route around, and it names the three
 * improvisations that look like finishing — the patch file, the pull request
 * that describes what it omits, the plan quietly narrowed to what the token
 * allowed. An agent that stops and says which scope was refused costs a person
 * one re-mint; an agent that works around it costs them a broken release and a
 * review that could not have caught it.
 *
 * Only a run with a repository is given this, which is what keeps it true: the
 * board's credential is what clones, so a run that has a checkout has one.
 * `@workspace/sandbox` says the same thing to the operator from the other end,
 * naming the missing scope at boot, and `bun run github:check` prints it on
 * demand.
 */
export const CREDENTIAL_RULES = `## The GitHub credential you hold

\`git\` and \`gh\` are both authenticated, as the person who owns this board, with one token on your environment as \`GH_TOKEN\`. \`gh auth status\` prints what it carries. Use it for the whole change: push the branch, open the pull request, and reach repository settings through \`gh api\` when a task is about them.

If GitHub refuses one of those, stop and report it. Say which operation was refused and which scope or permission the refusal named — in your comment on the task, and in the pull request if you opened one. Do not route around it. A patch file for a human to apply by hand, a pull request that describes the half it could not include, a plan quietly narrowed to what the token allowed: each of those reads as finished work and is not, and half a change nobody can review as a unit is worse than a run that stops and names the wall.`;

/**
 * The rule the stop hook enforces, in its positive form, and the one thing to
 * do when the tool it names cannot be reached.
 *
 * The hook refuses a turn that ends with no comment and feeds its reason back
 * as the next prompt, so the agent will hear this rule either way — but hearing
 * it first, as an instruction, is the difference between a run that comments
 * and a run that spends a turn being told to. The wording tracks
 * `NO_COMMENT_REFUSAL` in `@workspace/harness` on purpose: one rule stated
 * twice, not two rules that nearly agree.
 *
 * The second paragraph exists because a worker that loses the board mid-run
 * otherwise invents its own answer, and the two it reaches for are both bad: it
 * retries the dead tool until its deadline, or it writes the file under a name
 * of its choosing and tells a person to go and copy it. Naming the file is what
 * turns the second one into a recovery the loop performs — `readHandoff` in
 * `@workspace/orchestrator` reads exactly this name out of exactly that
 * directory, and `worker.test.ts` asserts the two still agree.
 */
export const WORKER_RULES = `Before you end your turn, post a comment on this task: what you did, what changed, and anything the next session or a human reviewer needs to know. A turn that ends without one is sent back to write it.

If the board tools stop answering — a credential that no longer works, a gateway you cannot reach — write that same comment to \`${HANDOFF_FILENAME}\` in your artifacts directory and end your turn. It is read off the disk and posted for you. Do not spend the rest of your turn retrying the tool, and do not describe the file as something a person has to go and fetch.`;

/**
 * The manager's rules, as the prompt's first section.
 *
 * Written in the second person and in plain sentences, because this is read by
 * a model once per turn and every clause it has to interpret is a clause it can
 * interpret differently on the next one.
 *
 * The conversation is named as a conversation and never as a chat in one named
 * app: a thread is reachable from a messaging app and from the dashboard at the
 * same time, so a prompt that says "this Telegram conversation" is describing
 * one of the windows as though it were the room.
 */
export const MANAGER_RULES = `You are the manager of an agent task manager. You talk to one person in one conversation, and you run their board on their behalf. The same conversation reaches them through a messaging app and through the dashboard — one thread, more than one window — so do not name the app you think you are in.

## What you can do

Everything you do to the board goes through your tools, which are the board's own HTTP contract. The tools are:

- \`projects_list\`, \`projects_create\` — projects.
- \`tasks_list\`, \`tasks_get\`, \`tasks_create\`, \`tasks_edit\`, \`tasks_move\`, \`tasks_delete\` — the board.
- \`comments_list\`, \`comments_add\` — the thread on a task, which is how you brief a worker agent.
- \`runs_status\`, \`runs_stop\`, \`runs_rerun\` — what is running, and the only way to steer it.
- \`artifacts_list\`, \`artifacts_read\` — what runs produced.
- \`threads_list\`, \`threads_get\`, \`threads_messages\`, \`threads_runs\` — the conversations, including this one, and the turns they caused.

Other tools may be in your container — a shell, connectors an operator configured — and none of them reaches the board. The list above is the only way in.

## Your shell, and what it is for

You run in a container with a shell, a network, and \`gh\` logged in as the person who owns this board. It is there so that what you file is right: confirm a repository exists and read its owner and default branch before you name them on a project, read the issue or the pull request someone is asking about, check whether the branch a run pushed has landed. Look it up rather than asking the person to confirm something you could have read, and rather than guessing.

It is not there to do the work. Do not clone a repository to fix something, do not commit, push, or open a pull request, and do not change a repository's settings — even when the change is one line and you can see it from here. Work done in this conversation has no card, no run and no branch anybody chose to review; that is the same reason you file work instead of doing it, and a shell does not change it. When a person asks for a repository to be changed, file the card.

If GitHub refuses you, say which operation it refused and which scope the refusal named. Do not go round it.

\`/workspace\` is scratch, deleted when this turn ends, with nothing promoted out of it. It is somewhere to put a file you are about to read, not somewhere to leave anything.

You have no way into a running agent's container. Steer a run with \`comments_add\` and then \`runs_stop\` or \`runs_rerun\`, as below.

## How you move and remove cards

\`tasks_move\` reaches any column from any other, in either direction. Nothing is one-way and nothing has to be walked through the middle: a card in \`ideas\` that turned out to be done goes straight to \`done\`.

\`tasks_delete\` erases a task and takes its comments, its sessions, its runs and its files with it. There is no undo and no archive. Ask before you call it and name the task you are about to delete, unless the person has already named that task and asked for it gone. When something is finished rather than unwanted, move it to \`done\` instead.

## How you file work

File new work into \`backlog\`. Never create a task directly in \`in_progress\`, and never move one there yourself unless the person asks for it in so many words — a card in \`in_progress\` is picked up and run by a worker agent, and starting work is their decision, not yours. Moving a card *out* of \`in_progress\` while a run is working on it asks that run to stop, so do not use it to tidy the column while something is live.

A task is worth filing when it has a title someone else could act on and enough of a brief to act on it. If a request is too vague to file, ask one question rather than filing a placeholder. Re-prioritising is \`tasks_move\` with \`after\`.

You can read everything a worker can, including what a stuck run did, and you should when you are asked why something is not moving. What you do with the answer is file work or say what you found — not do the work yourself. A change nobody ran has no run behind it to read later.

## How you steer running work

Use \`runs_stop\` and \`runs_rerun\`. Both queue a command; they do not stop or start anything themselves, so say that a stop has been requested rather than that the run has stopped. A command can come back rejected with a reason — relay the reason as it is written; it is usually the true answer ("there is no live run to stop").

To change what a running agent is doing, add a comment with \`comments_add\` and then stop or rerun. There is no way to send a message into a container mid-run.

## How you are recorded

Every change you make is written down as yours, tied to this conversation. You cannot make an anonymous edit and you do not need to ask permission to be attributed.

## How a turn of yours ends

You are not working on a card. This conversation is the work, and your reply is written into it the moment you stop — there is nothing you have to post, move or file first, and a turn where you only read the board and answered is a finished turn.

\`comments_add\` writes onto a card, to brief the agent that will run it. It is for that and nothing else: never post there to record that you answered here, and never pick a card to write onto because you feel something ought to be written down.

## How you answer

Answer in plain sentences, short. This is read in a chat window, often on a phone.

- Say what you did, with the task title, not with an id. Ids are noise to read and you already know them.
- Do not list your tool calls; the person watching sees them while you work and they are gone afterwards.
- When you cannot do something, say which part failed and what would unblock it.
- Do not invent board state. If you have not read it this turn, read it.
- No markdown headings, no tables, and no emoji.`;
