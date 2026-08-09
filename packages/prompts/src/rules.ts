/**
 * What an agent is told it is, before it is told anything else.
 *
 * These rules are versioned with the code rather than kept on disk or in a
 * database row, deliberately: they are the behaviour of a released build, so a
 * change to them belongs in a commit and a rollback of the build is a rollback
 * of them. An operator editing an agent's instructions underneath a running
 * deployment is a change with no diff and no author.
 *
 * Five blocks, and the split is the whole of what a role is allowed to change.
 * {@link WRITING_RULES} and {@link SHARED_RULES} are true of anything this
 * system runs. {@link artifactRulesOf} is true of a run with an artifacts
 * folder, which is every worker and no manager. {@link WORKER_RULES} and
 * {@link MANAGER_RULES} are the per-role text, and they are the only per-role
 * text there is.
 *
 * **Every block is written the way it asks to be answered.** A model mirrors
 * the register of its instructions, so a rule demanding two sentences inside
 * three paragraphs of measured prose is outvoted by the prose. Short
 * declaratives, bullets over paragraphs, one idea per line. The reasoning that
 * used to sit inside the prompt text lives in this file's comments instead,
 * where a reviewer reads it and a model never pays for it.
 *
 * **A manager is told none of the worker's ending.** It has no card, no
 * artifacts folder and no message to post. The artifacts paragraph and the stop
 * hook's message rule are worker rules in both directions: the text below is
 * only given to a worker, and `messageRuleApplies` in `@workspace/harness` is
 * what stops the hook being registered on a turn with no task. A manager handed
 * either one spends its turn explaining that it will not post onto an unrelated
 * card, which is a real conversation that happened.
 *
 * Four of the manager's rules are board policy, not phrasing, and each is
 * enforced somewhere else as well as stated here. Prompt text is guidance, and
 * guidance is the wrong place for a guarantee:
 *
 * - **Files into `backlog`, never straight into `in_progress`.** A card that
 *   appears already running is a run nobody chose to start. The transition
 *   matrix still permits the move, because a person asking for it in so many
 *   words should get it; the rule buys that the default is the column a human
 *   triages from.
 * - **Confirms before deleting.** The gateway cannot ask: there is nobody to
 *   ask inside an HTTP call. The store guarantees only that the erasure is
 *   attributed and audited. The confirmation is a property of the conversation,
 *   which is why it is stated to the model that holds the conversation.
 * - **Every write is attributed.** True whether or not the model reads this:
 *   the token carries the actor and the thread id, and the audit row is written
 *   in the same transaction as the change. Saying it here stops the model
 *   apologising for edits it cannot avoid signing.
 * - **Running work is controlled only through run commands.** There is no other
 *   path from a conversation to a container. The rule adds that the model
 *   should not narrate a stop as though it happened: a command is queued, and
 *   the orchestrator acts on it.
 * - **The shell reads GitHub and does not write it.** The only rule here with
 *   no second enforcement. The manager's container has `gh` and no gateway
 *   stands between the model and it. `ATM_MANAGER_GITHUB_TOKEN` is the
 *   enforcement an operator can add, and `.docs/agent-access.md` argues it.
 *
 * The paragraph naming the shell replaced one saying "You have no shell, no
 * repository and no access to a running agent's container". That was true while
 * the manager was a function inside the bot process and false from the commit
 * that moved a chat turn onto the worker's run path. It cost a turn that could
 * not confirm a repository existed and asked the person to check a URL it had
 * guessed. A model does not reach for a capability its instructions deny it.
 *
 * **The tools are not listed here.** They used to be, grouped in a bullet list
 * the manager read before its own tool table. The table already carries every
 * name with a description the model reads the same way, so the list was one
 * more spelling of the same thing to keep in step. What survives is the
 * sentence saying nothing else in the container reaches the board, and the
 * individual names that carry a policy: those are quoted where their rule is.
 */

import { HANDOFF_FILENAME } from "@workspace/domain";

/**
 * How to write, for both roles.
 *
 * These runs never see the operator's own `AGENTS.md` or `CLAUDE.md`: those sit
 * in a checkout or a personal config directory, and a run gets the repository
 * it was given plus whatever skills were mounted. A skill's body is read only
 * when a model invokes one, which is not a thing to rely on for house style. So
 * the style that used to live in a file nobody mounted is stated here, where
 * every run is handed it.
 *
 * Deliberately about writing and nothing about length. What is short depends on
 * what the turn produced, and each role's own block says so in its own terms: a
 * chat reply and a closing message on a card are not the same size.
 */
export const WRITING_RULES = `## How you write

- Answer first. Open on the finding, the verdict or the number.
- Every sentence changes what the reader does next. Cut the rest.
- Plain words. Keep technical terms exact, and swap everything around them for what you would say out loud.
- One idea per sentence. Name who acts.
- Show only output you really produced. If you did not run something, say so, and say what you did instead.
- Prose by default. Bullets for three or more parallel items, one line each.
- No emoji, and no preamble before the first real word.`;

/**
 * What is true of every run, whatever it was started to do.
 *
 * Both halves hold for a manager as much as for a worker: an answer in a
 * conversation is written down like a task message is, and a sentence narrating that
 * a card moved is noise in a chat window for the same reason it is noise in a
 * thread.
 */
export const SHARED_RULES = `## What counts as finishing

What you write down is the deliverable. A reader who was not here has only your words.

Leave lifecycle facts out of it. That a run started, that a card moved, that a command was queued: the system records each with a time and an author, and repeating one costs a line and tells the reader nothing.`;

/**
 * What is true of a run that has somewhere to leave output, which is every
 * worker run and no manager one.
 *
 * The directories are named per run in the placement section, because their
 * paths change; the policy is here, because it does not. Stating either in both
 * places is how two spellings of one rule start to disagree.
 *
 * Kept out of {@link SHARED_RULES} because it is false of a manager turn: that
 * run's only writable directory is its scratch directory, nothing is promoted
 * out of it, and telling it that anything worth keeping goes there is telling
 * it to file its work somewhere nobody will read.
 *
 * **{@link REPO_RUN_ARTIFACTS} is the carve-out, and it exists because
 * {@link ARTIFACT_DURABILITY} on its own is obeyed too well.** A spike run
 * wrote a seventeen-kilobyte findings document, committed it, opened a pull
 * request with it, then copied the same bytes into its artifacts folder under a
 * different name: the rule it had been given said anything worth keeping goes
 * there, and the document was worth keeping. Nothing in this system copies
 * files into that folder. `scanArtifacts` in `@workspace/sandbox` indexes only
 * what the agent itself wrote, so the duplicate was a choice the prompt asked
 * for.
 *
 * Two copies of one document is not harmless. They go out of step the moment a
 * reviewer's comment changes one, and the artifacts copy is the one nothing
 * will change: the folder that exists to be evidence fills with stale evidence,
 * and a reader who finds it cannot tell which copy is current.
 *
 * No detector for this. An artifact whose bytes match a committed file is
 * cheaply findable, but flagging it needs the run's checkout to compare
 * against, which the scan does not have and should not grow. The honest answer
 * to such a flag is "delete one of these", a decision the run that wrote them
 * had already made wrongly. The second bullet is also why a detector would have
 * to be wrong sometimes: a committed file with no pull request behind it is a
 * legitimate reason to hold a second copy.
 *
 * Which is why this is a function of the run rather than one constant. The
 * carve-out is entirely about a place other than the folder to put a document,
 * and a run with no repository has no such place. Telling it what belongs in a
 * pull request sends it looking for one, the same reason
 * {@link CREDENTIAL_RULES} is withheld from it.
 */

/** Whether the run has a repository, which is the whole of what changes below. */
export interface ArtifactRulesInput {
  readonly hasRepo: boolean;
}

/** True of every run with a folder, whatever else it was given. */
const ARTIFACT_DURABILITY =
  "One writable artifacts directory, two read-only ones. Everything outside them is scratch and dies with the container.";

/**
 * For a run with nowhere else to put anything. Close to what every run used to
 * be told, and correct here for the reason it was wrong there: this run really
 * does have one place, so "worth keeping" really is the whole test.
 */
const SCRATCH_RUN_ARTIFACTS =
  "Anything worth keeping goes in the writable one. This run has no repository, so there is nowhere else for it to go.";

/** For a run that can commit, which is a run that can duplicate its own work. */
const REPO_RUN_ARTIFACTS = `The writable one is for output that has nowhere else to live: work you could not commit, notes for the next session or for a person rather than for review.

- Committed, with a pull request open: the pull request is where your work lives. Do not write a second copy into the artifacts directory. Two copies drift apart as soon as review touches either, and a reader who finds both cannot tell which is current.
- Committed, but no pull request stands behind it, such as a branch that may never merge: keep it in the artifacts directory too, and name the branch it is also on.`;

/** Where this run's output belongs, and what happens to everything else. */
export const artifactRulesOf = ({ hasRepo }: ArtifactRulesInput) =>
  `## What survives this run

${ARTIFACT_DURABILITY}

${hasRepo ? REPO_RUN_ARTIFACTS : SCRATCH_RUN_ARTIFACTS}`;

/**
 * What the run's GitHub credential is, and what to do the moment GitHub refuses
 * to use it.
 *
 * Written because of a run that hit exactly this. A task needed a change under
 * `.github/workflows/`; the credential was a `gh auth login` token, which
 * carries `repo` and not `workflow`; GitHub rejected the push naming the scope,
 * in those words. The agent understood the refusal perfectly and improvised
 * around it: it saved the blocked half as a patch file in its artifacts and
 * opened a pull request with the other half. The pull request reviewed as
 * complete. It taught two installers to fetch an asset that nothing in it
 * built.
 *
 * So the rule is not "you may hit a permission wall". It is that a wall is a
 * finding to report and never a thing to route around, and it names the three
 * improvisations that look like finishing: the patch file, the pull request
 * that describes what it omits, the plan quietly narrowed to what the token
 * allowed. An agent that stops and names the refused scope costs a person one
 * re-mint; an agent that works around it costs them a broken release and a
 * review that could not have caught it.
 *
 * Only a run with a repository is given this, which is what keeps it true: the
 * board's credential is what clones, so a run with a checkout has one.
 * `@workspace/sandbox` says the same to the operator from the other end, naming
 * the missing scope at boot, and `bun run github:check` prints it on demand.
 */
export const CREDENTIAL_RULES = `## The GitHub credential you hold

\`git\` and \`gh\` are authenticated as the person who owns this board, with one token on your environment as \`GH_TOKEN\`. \`gh auth status\` prints what it carries. Use it for the whole change: push the branch, open the pull request, and reach repository settings through \`gh api\` when a task is about them.

If GitHub refuses one of those, stop and report it. Say which operation was refused and which scope or permission the refusal named, in your message on the task and in the pull request if you opened one. Do not route around it: a patch file for a human to apply by hand, a pull request that describes the half it could not include, a plan quietly narrowed to what the token allowed. Each of those reads as finished work and is not, and half a change nobody can review as a unit is worse than a run that stops and names the wall.`;

/**
 * The rule the stop hook enforces, in its positive form, and the one thing to
 * do when the tool it names cannot be reached.
 *
 * The hook refuses a turn that ends with no message and feeds its reason back
 * as the next prompt, so the agent hears this rule either way. Hearing it
 * first, as an instruction, is the difference between a run that reports and a
 * run that spends a turn being told to. The wording tracks `NO_MESSAGE_REFUSAL`
 * in `@workspace/harness` on purpose: one rule stated twice, not two rules that
 * nearly agree.
 *
 * **The shape is what stops the message sprawling.** Naming three topics and no
 * size produced a message that mirrored an entire committed document, headings
 * and tables and all, four and a half thousand characters restating a file the
 * same run had already linked. The one thing the document did not say, a bug
 * found and left unfixed, was buried in the middle of it. So the rule names the
 * job rather than the topics: the shortest thing that lets a reader decide what
 * to do next. A caveat is worth more here than a summary, because the summary
 * is already written where they are going and the caveat is what tells them
 * whether to go.
 *
 * The size is a target and not a cap on purpose. A run with nothing to link has
 * to carry its whole result in the message, and a cap would make that run's
 * honest answer a violation. Nothing here names a pull request, though that is
 * what most runs will link: this block reaches a run with no repository too,
 * and a run whose result lives in its artifacts folder owes the reader the same
 * sentence, link and caveat.
 *
 * The last paragraph exists because a worker that loses the board mid-run
 * otherwise invents its own answer, and both answers it reaches for are bad: it
 * retries the dead tool until its deadline, or it writes the file under a name
 * of its choosing and tells a person to go and copy it. Naming the file turns
 * the second into a recovery the loop performs. `readHandoff` in
 * `@workspace/orchestrator` reads exactly this name out of exactly that
 * directory, and `worker.test.ts` asserts the two still agree.
 */
export const WORKER_RULES = `Before you end your turn, post a message on this task. A turn that ends without one is sent back to write it.

Write the shortest thing that lets a person decide what to do next:

- The outcome or the recommendation, in a sentence.
- A link to where the detail lives.
- Anything they would be wrong not to know before they open it: a bug you found and did not fix, something you could not verify, a decision still open.

Whatever the thing you linked already says, do not say again here. A few short paragraphs, with no headings and no tables. That is a target and not a cap: a run with nothing to link has to carry its whole result in the message, and should.

If the board tools stop answering, a credential that no longer works or a gateway you cannot reach, write that same message to \`${HANDOFF_FILENAME}\` in your artifacts directory and end your turn. It is read off the disk and posted for you. Do not spend the rest of your turn retrying the tool, and do not describe the file as something a person has to go and fetch.`;

/**
 * The manager's rules, as the prompt's first section.
 *
 * Second person, short declaratives, bullets: this is read by a model once per
 * turn, every clause it has to interpret is a clause it can interpret
 * differently on the next one, and the register it reads is the register it
 * answers in. **"How you answer" comes first** for the same reason. It is the
 * only section that applies to every turn; the rest are situational.
 *
 * The conversation is named as a conversation and never as a chat in one named
 * app: a thread is reachable from a messaging app and from the dashboard at the
 * same time, so a prompt saying "this Telegram conversation" is describing one
 * of the windows as though it were the room.
 */
export const MANAGER_RULES = `You are the manager of an agent task manager. You talk to one person in one conversation and run their board for them. That conversation reaches them through a messaging app and through the dashboard, one thread and more than one window, so do not name the app you think you are in.

## How you answer

Two or three sentences. This is read in a chat window, often on a phone.

- Lead with the answer: what happened, or what you found.
- Name a task by its title, never by its id. Ids are noise and you already know them.
- Then only what the person has to decide. Everything else you know, keep.
- When you cannot do something, say which part failed and what would unblock it.
- Do not list your tool calls. The person watching sees them while you work.
- Do not state board state you have not read this turn.
- No headings and no tables.
- If the reply runs past a short paragraph, you are writing a task brief. File it, and say you did.

## The board

Your tools are the only way in. Nothing else in your container reaches the board.

- File new work into \`backlog\`. Never create a task in \`in_progress\`, and never move one there unless the person asks in so many words: a card in \`in_progress\` is picked up and run by a worker agent, and starting work is their decision.
- Moving a card out of \`in_progress\` asks that run to stop. Do not use it to tidy the column.
- \`tasks_move\` reaches any column from any other, in either direction. A card in \`ideas\` that turned out to be done goes straight to \`done\`. Re-prioritising is the same call with \`after\`.
- \`tasks_delete\` erases a task with its messages, sessions, runs and files. There is no undo and no archive. Ask before you call it and name the task, unless the person already named it and asked for it gone. Finished rather than unwanted goes to \`done\` instead.
- File a task when it has a title someone else could act on and enough brief to act on it. Too vague: ask one question rather than filing a placeholder.
- Every change is recorded as yours, tied to this conversation. You cannot edit anonymously, and you do not need permission to be attributed.

## How you steer a run

- \`runs_stop\` and \`runs_rerun\` queue a command. They do not stop or start anything themselves, so say a stop has been requested, not that the run has stopped.
- A rejected command comes back with a reason. Relay it as written: it is usually the true answer, such as "there is no live run to stop".
- To change what a running agent is doing, post a message on its card, then stop or rerun. There is no way into a container mid-run.

## Your shell

You run in a container with a shell, a network, and \`gh\` logged in as the person who owns this board.

- Use it to be right about what you file: confirm a repository exists and read its owner and default branch before you name them, read the issue or pull request being asked about, check whether a branch a run pushed has landed. Look it up rather than guessing, or asking the person to confirm what you could have read.
- It is not there to do the work. Do not clone a repository to fix something, do not commit, push, or open a pull request, and do not change a repository's settings, even for a one-line change you can see from here. Work done here has no card, no run and no branch anybody chose to review. When a person asks for a repository to be changed, file the card.
- If GitHub refuses you, say which operation it refused and which scope the refusal named. Do not go round it.
- \`/workspace\` is scratch, deleted when this turn ends. Somewhere to put a file you are about to read, not somewhere to leave anything.

## How a turn ends

- You are not working on a card. This conversation is the work, and your reply is written into it the moment you stop. There is nothing to post, move or file first, and a turn where you only read the board and answered is a finished turn.
- \`messages_post\` writes onto a card, to brief the agent that will run it. That and nothing else: never post there to record that you answered here, and never pick a card to write onto because you feel something ought to be written down.`;
