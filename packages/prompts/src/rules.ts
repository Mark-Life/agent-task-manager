/**
 * What an agent is told it is — the half of it that is versioned with the code.
 *
 * Everything this system says to a model is split across two homes, and one
 * question decides which: **does this text describe a mechanism this build
 * implements?**
 *
 * If it does, it is here. A stop hook refuses a turn that ends with no message.
 * A mount flag decides which directory a run may write. `tasks_delete` erases a
 * card with no undo. A token carries the actor on every write. Text about any
 * of those is not advice, it is a description of a mechanism — so it ships with
 * the mechanism, changes in the same commit, and rolls back with the build.
 * Editing it underneath a running deployment would be writing a claim the code
 * can contradict, with no diff and no author, and text that disagrees with its
 * mechanism is a bug rather than a difference of opinion.
 *
 * If it can be wrong without anything breaking, it is content and it lives on
 * disk. `./instructions` holds that text, the loop seeds it into the workspace
 * scope of the run's tree on first boot, and nothing overwrites it afterwards —
 * so a person edits house style in a file and the next run reads the edit.
 *
 * The line does not follow "important", and it cuts through blocks rather than
 * between them. {@link WORKER_RULES} keeps the rule that a message must be
 * posted, because the hook enforces it, and gave up how long that message
 * should be, because nothing does. {@link MANAGER_RULES} keeps every board
 * policy and gave up how a reply is phrased. What is left in this file is
 * therefore the smaller half and the load-bearing one.
 *
 * Four blocks and a function, and the split is the whole of what a role is
 * allowed to change. {@link SHARED_RULES} is true of anything this system runs.
 * {@link artifactRulesOf} is true of a run with an artifacts folder, which is
 * every worker and no manager, and {@link CREDENTIAL_RULES} of one with a
 * repository to push. {@link WORKER_RULES} and {@link MANAGER_RULES} are the
 * per-role text, and they are the only per-role text there is.
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
 * Five of the manager's rules are board policy, not phrasing, and each is
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
 * The two bullets about directories replaced one saying "`/workspace` is
 * scratch, deleted when this turn ends", for the same class of reason. That was
 * true while the turn's own empty directory was mounted there and false from the
 * commit that made that path the shared directory every run reads, with only a
 * scratch directory under it dying with the turn. A manager told its one
 * writable path is thrown away will not edit the house rules a worker is handed,
 * which is the point of giving it write access at all.
 *
 * Neither bullet spells a path, and that is the other half of the same lesson.
 * A rule here is one string for every mode, while the paths are per run and a
 * local turn's are the host's — so the directories are described and
 * `placementSection` names them, which is the only place that knows.
 *
 * **The tools are not listed here.** They used to be, grouped in a bullet list
 * the manager read before its own tool table. The table already carries every
 * name with a description the model reads the same way, so the list was one
 * more spelling of the same thing to keep in step. What survives is the
 * sentence saying nothing else in the container reaches the board, and the
 * individual names that carry a policy: those are quoted where their rule is.
 */

import { HANDOFF_FILENAME, PROPOSALS_DIRNAME } from "@workspace/domain";

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

/** What the run was given, which is the whole of what changes below. */
export interface ArtifactRulesInput {
  /**
   * Whether a project directory is mounted. A task with no project has no
   * middle level at all, and a bullet about a directory that is not there is
   * the one lie this block cannot afford: it is the block that says where
   * output goes.
   */
  readonly hasProject: boolean;
  /** Whether the run has a repository. */
  readonly hasRepo: boolean;
}

/** True of every run with a folder, whatever else it was given. */
const ARTIFACT_DURABILITY =
  "Your directories nest, and each level is for something different. Everything outside them is scratch and dies with the container.";

/**
 * The levels, innermost first, one line each.
 *
 * The project level is new as a place to *write*. It used to be read-only
 * reference material, and the rules said so; a run that reads that and then
 * finds it can write is a run guessing at which of the two is true. What the
 * bullet has to carry is not the permission but the audience: a document only
 * this run's reader wants belongs one level in, and a document the next task on
 * the same project needs belongs here.
 */
const TASK_SCOPE = "- The task directory is this run's own output.";
const PROJECT_SCOPE =
  "- The project directory is durable material a later task on the same project reads. Yours to write, and every task in this project sees what you leave there.";
const SHARED_SCOPE =
  "- The shared directory is reference material for every run, and you cannot write it.";

/** The levels this run actually has, in the order the paths nest. */
const scopeLines = (hasProject: boolean) =>
  [TASK_SCOPE, ...(hasProject ? [PROJECT_SCOPE] : []), SHARED_SCOPE].join("\n");

/**
 * The one door through the read-only mount, stated immediately after the bullet
 * that says the door is shut.
 *
 * It names a mechanism, so it is here and not on disk: `collectRunProposals` in
 * `@workspace/orchestrator` reads exactly this directory out of the task's
 * folder and parses exactly this front matter, and the confirm route is what
 * writes the body. Text that named another path would be a request nobody
 * collects — the failure the handoff file had before it was named.
 *
 * Only the shared directory is offered, and that is not an omission. The
 * project directory is a read-write mount, and the bullet above says so — a run
 * that was invited to propose a file it can simply write would wait on a person
 * for work it was already able to do. The one directory a proposal is for is the
 * one the mount refuses.
 *
 * The last sentence is the load-bearing one. A run that believes its proposal
 * took effect writes a comment saying the rules now say X, and the next person
 * to read the file finds that they do not.
 */
const PROPOSAL_RULES = `Ask for a change to the shared directory, which you cannot write, by writing a file to \`${PROPOSALS_DIRNAME}/<name>.md\` in your task directory:

\`\`\`
---
scope: workspace
path: CLAUDE.md
---
The whole proposed contents of that file.
\`\`\`

\`path\` says where the file goes inside the shared directory and may not leave it. The body replaces that file whole, so write all of it and not a diff.

Nothing changes until a person accepts it. Say in your comment that you proposed it, and never that the rules now say something.`;

/**
 * For a run with nowhere else to put anything. Close to what every run used to
 * be told, and correct here for the reason it was wrong there: this run really
 * does have one place, so "worth keeping" really is the whole test.
 */
const SCRATCH_RUN_ARTIFACTS =
  "Anything worth keeping goes in the task directory. This run has no repository, so there is nowhere else for it to go.";

/**
 * For a run that can commit, which is a run that can duplicate its own work.
 *
 * The second sentence is about where the checkout now sits. It used to be a
 * sibling of the artifacts folder and is a child of the task directory, so a
 * run reading that the task directory outlives the container can read its own
 * checkout as durable and leave a file there instead of pushing it. The
 * directories nest; the lifetimes do not.
 */
const REPO_RUN_ARTIFACTS = `The task directory is for output that has nowhere else to live: work you could not commit, notes for the next session or for a person rather than for review. Your checkout sits inside it and is not part of it — the checkout goes with the container, so anything you did not push is gone.

- Committed, with a pull request open: the pull request is where your work lives. Do not write a second copy into the task directory. Two copies drift apart as soon as review touches either, and a reader who finds both cannot tell which is current.
- Committed, but no pull request stands behind it, such as a branch that may never merge: keep it in the task directory too, and name the branch it is also on.`;

/** Where this run's output belongs, and what happens to everything else. */
export const artifactRulesOf = ({ hasProject, hasRepo }: ArtifactRulesInput) =>
  `## What survives this run

${ARTIFACT_DURABILITY}

${scopeLines(hasProject)}

${hasRepo ? REPO_RUN_ARTIFACTS : SCRATCH_RUN_ARTIFACTS}

${PROPOSAL_RULES}`;

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
 * **The size is not stated here any more.** How many paragraphs a message runs
 * to is a preference nothing enforces, so it moved to `./instructions` and is
 * read off the workspace document — while the rule that there must be a message
 * at all stayed, because the hook is what makes it true. That is the split this
 * file's header describes, applied inside one block: the enforced half and the
 * editable half of one instruction, in the two homes each belongs in.
 *
 * Nothing here names a pull request, though that is what most runs will link:
 * this block reaches a run with no repository too, and a run whose result lives
 * in its artifacts folder owes the reader the same sentence, link and caveat.
 *
 * The last paragraph exists because a worker that loses the board mid-run
 * otherwise invents its own answer, and both answers it reaches for are bad: it
 * retries the dead tool until its deadline, or it writes the file under a name
 * of its choosing and tells a person to go and copy it. Naming the file turns
 * the second into a recovery the loop performs. `readHandoff` in
 * `@workspace/orchestrator` reads exactly this name out of exactly that
 * directory, and `worker.test.ts` asserts the two still agree.
 *
 * It is the *task's* artifacts directory, said in those words, because a run
 * now has three of them and only one is ever read for this file. A handoff left
 * in the project or the shared directory is a message nobody collects, which is
 * the failure this rule exists to prevent.
 */
export const WORKER_RULES = `Before you end your turn, post a message on this task. A turn that ends without one is sent back to write it.

Write the shortest thing that lets a person decide what to do next:

- The outcome or the recommendation, in a sentence.
- A link to where the detail lives.
- Anything they would be wrong not to know before they open it: a bug you found and did not fix, something you could not verify, a decision still open.

Whatever the thing you linked already says, do not say again here.

If the board tools stop answering, a credential that no longer works or a gateway you cannot reach, write that same message to \`${HANDOFF_FILENAME}\` in your task's artifacts directory and end your turn. It is read off the disk and posted for you. Do not spend the rest of your turn retrying the tool, and do not describe the file as something a person has to go and fetch.`;

/**
 * The manager's rules, as the prompt's first section.
 *
 * Second person, short declaratives, bullets: this is read by a model once per
 * turn, every clause it has to interpret is a clause it can interpret
 * differently on the next one, and the register it reads is the register it
 * answers in.
 *
 * **How an answer is phrased is no longer here.** It is style, nothing enforces
 * a word of it, and an operator who wants longer replies should get them by
 * editing a file rather than by waiting for a release — so it is
 * `MANAGER_ANSWER_RULES` in `./instructions`, seeded into the manager's own
 * directory, which is the one directory in the tree no other role walks into. It
 * still reaches the model first, because both CLIs read the instruction files
 * before the prompt; a local turn, which has no tree, is handed it beside the
 * rest of the disk text instead.
 *
 * One line of that section was policy rather than phrasing and stayed: an answer
 * that has grown into a task brief should be filed as one. It reads as a length
 * rule and it is a board rule, so it sits with the board tools below.
 *
 * The conversation is named as a conversation and never as a chat in one named
 * app: a thread is reachable from a messaging app and from the dashboard at the
 * same time, so a prompt saying "this Telegram conversation" is describing one
 * of the windows as though it were the room.
 */
export const MANAGER_RULES = `You are the manager of an agent task manager. You talk to one person in one conversation and run their board for them. That conversation reaches them through a messaging app and through the dashboard, one thread and more than one window, so do not name the app you think you are in.

## The board

Your tools are the only way in. Nothing else in your container reaches the board.

- File new work into \`backlog\`. Never create a task in \`in_progress\`, and never move one there unless the person asks in so many words: a card in \`in_progress\` is picked up and run by a worker agent, and starting work is their decision.
- Moving a card out of \`in_progress\` asks that run to stop. Do not use it to tidy the column.
- \`tasks_move\` reaches any column from any other, in either direction. A card in \`ideas\` that turned out to be done goes straight to \`done\`. Re-prioritising is the same call with \`after\`.
- \`tasks_delete\` erases a task with its messages, sessions, runs and files. There is no undo and no archive. Ask before you call it and name the task, unless the person already named it and asked for it gone. Finished rather than unwanted goes to \`done\` instead.
- File a task when it has a title someone else could act on and enough brief to act on it. Too vague: ask one question rather than filing a placeholder.
- If a reply you are writing runs past a short paragraph, it is a task brief. File it, and say you did.
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
- Your working directory is deleted when this turn ends. Somewhere to put a file you are about to read, not somewhere to leave anything.
- The shared directory every run reads is yours to write, and it is named below. The house rules, notes and reference material a worker is handed live there, so an edit changes every run after this one: make one when the person asks for it, and say what you changed.

## How a turn ends

- You are not working on a card. This conversation is the work, and your reply is written into it the moment you stop. There is nothing to post, move or file first, and a turn where you only read the board and answered is a finished turn.
- \`messages_post\` writes onto a card, to brief the agent that will run it. That and nothing else: never post there to record that you answered here, and never pick a card to write onto because you feel something ought to be written down.`;
