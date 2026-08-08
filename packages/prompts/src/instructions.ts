/**
 * The rules that are content, and the two documents they are seeded into.
 *
 * Everything in this file can be wrong without anything breaking. That is the
 * whole test that put it here rather than in `./rules`: house style, the shape
 * of a message, how long an answer should be. Nothing reads any of it back,
 * nothing refuses a turn over it, and a person who disagrees with a line should
 * be able to change it and see the next run behave differently — which means it
 * has to live on disk, in a file they can open, not in a constant that ships
 * with a build.
 *
 * **One source, two deliveries.** The same constants are written to disk by the
 * seeder and inlined into a prompt when there is no disk to read them from. A
 * local turn is a host process with no mounts, working in a directory whose
 * parents hold nothing, so a tree it cannot walk would drop house style
 * silently; `instructionsOnDisk` on each prompt builder is that switch. Two
 * copies of this text, one in a file and one in a string, is the thing being
 * avoided — so the file bodies below are composed out of the same constants the
 * prompts inline, and the seeder never sees a literal.
 *
 * **{@link WORKSPACE_INSTRUCTIONS} reaches both roles and
 * {@link MANAGER_INSTRUCTIONS} reaches one.** That falls out of where each file
 * sits: the workspace document is the top of every run's tree, and the manager's
 * sits in the directory only a manager turn works under. Both CLIs concatenate
 * what they find root-down, deepest last, so the manager reads house style and
 * then its own answering rules, in that order — which is the order the local
 * fallback states them in too.
 *
 * The documents carry two things the prompts do not, and both address the person
 * who opens the file rather than the model that reads it: what each directory
 * level is for, and the note that the `CLAUDE.md` beside each one is an import
 * rather than a second copy. A model needs neither, and a person editing rules
 * on disk needs both.
 */

/**
 * How to write, for both roles.
 *
 * A skill's body is read only when a model invokes one, which is not a thing to
 * rely on for house style, and the operator's own `AGENTS.md` is never mounted
 * into a run — so a file at the top of the run's own tree is the only place a
 * person can put this where every run of both roles reads it.
 *
 * Deliberately about writing and nothing about length. What is short depends on
 * what the turn produced, and a chat reply and a closing message on a card are
 * not the same size, so each has its own block.
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
 * How long a message on a card is, and nothing about whether to post one.
 *
 * The rule that a worker must post is enforced by a stop hook and stays in
 * `./rules` with the mechanism that enforces it. This is the half nothing
 * enforces: a message four and a half thousand characters long is a message
 * a person scrolls past, and no hook can tell the difference.
 *
 * Stated as a target rather than a cap, because a run with nothing to link has
 * to carry its whole result here and a cap would make that run's honest answer a
 * violation.
 *
 * A manager reads this too, from the workspace document, and that is fine: it
 * writes onto a card as well, and nothing here tells it to. The imperative — end
 * your turn with a message — is what a manager must never be handed, and that
 * one is a worker rule in code.
 */
export const MESSAGE_SHAPE_RULES = `## How long a message on a card is

A few short paragraphs, with no headings and no tables. That is a target and not a cap: a run with nothing to link has to carry its whole result in the message, and should.`;

/**
 * The rules every run of both roles reads, whether from the workspace document
 * or from its prompt.
 *
 * One constant so the two deliveries cannot drift into a container turn and a
 * local turn being told different things.
 */
export const WORKSPACE_RULES = `${WRITING_RULES}

${MESSAGE_SHAPE_RULES}`;

/**
 * How a manager's reply is shaped.
 *
 * All of it is style and none of it is policy, which is why it is a file rather
 * than a constant: an operator who wants longer answers should get them by
 * editing a document, and nothing about this system changes when they do. The
 * one line that used to sit here and was policy — that an answer growing past a
 * paragraph is a task brief and should be filed — went to the board section in
 * `./rules`, where the tool that files it is named.
 *
 * Second person and short declaratives, like the rules around it: a model
 * mirrors the register of its instructions, and a block asking for two sentences
 * in three paragraphs of measured prose is outvoted by the prose.
 */
export const MANAGER_ANSWER_RULES = `## How you answer

Two or three sentences. This is read in a chat window, often on a phone.

- Lead with the answer: what happened, or what you found.
- Name a task by its title, never by its id. Ids are noise and you already know them.
- Then only what the person has to decide. Everything else you know, keep.
- When you cannot do something, say which part failed and what would unblock it.
- Do not list your tool calls. The person watching sees them while you work.
- Do not state board state you have not read this turn.
- No headings and no tables.`;

/**
 * What the file is, said to whoever opened it.
 *
 * The pair note is first because it is the thing a person gets wrong: they find
 * `CLAUDE.md`, edit it, and lose the edit into a one-line import nobody reads
 * as text.
 */
const WORKSPACE_PREAMBLE = `# House rules

Every run of every agent reads this file before it reads its own prompt. Editing it changes the next run — no deploy, no restart, no version.

\`CLAUDE.md\` beside this file is one line importing it, because Claude does not read \`AGENTS.md\` and Codex does not read \`CLAUDE.md\`. This is the file to edit.

Nothing here is enforced. A rule this system really enforces is stated in the prompt instead, beside the mechanism that enforces it, so that the two cannot disagree.`;

/**
 * What each level of the tree is for, in a sentence each.
 *
 * Here because the person who opens this file is the person who will add to it,
 * and the first question they have is where their rule belongs. Paths rather
 * than prose, since these are the directories they are standing in.
 */
const WORKSPACE_LEVELS = `## The directories below this one

- \`manager/\` — the agent that talks to a person in a conversation. Its own rules are in \`manager/AGENTS.md\`, and a run working on a card never walks in here.
- \`worker/<project>/\` — one project. Conventions every task on it should follow, and material a later task on it will read.
- \`worker/<project>/<task>/\` — one task's own output. The checkout the run works in sits inside it and is thrown away with the container; what is left beside the checkout is kept.

This directory is read-only to a run working on a card and writable by the manager, so what is here was put here by a person or by the manager on their behalf.`;

/**
 * The space for coding conventions, left empty on purpose.
 *
 * A seeded opinion about a language or a test runner is a guess, and a guess
 * here is worse than nothing: it is read by every run on every project as though
 * somebody had decided it. What the heading buys is that a person adding their
 * own knows which file it goes in.
 */
const WORKSPACE_CONVENTIONS = `## Coding conventions

Nothing here yet. How a repository is built, tested and reviewed differs per project, so those rules belong in \`worker/<project>/AGENTS.md\` or in the repository's own file, where they can be exact rather than general.`;

/** The workspace document: house style, the shape of a message, and the tree it sits at the top of. */
export const WORKSPACE_INSTRUCTIONS = `${WORKSPACE_PREAMBLE}

${WORKSPACE_LEVELS}

${WORKSPACE_RULES}

${WORKSPACE_CONVENTIONS}
`;

/** The same note, for the file only one role reads. */
const MANAGER_PREAMBLE = `# The manager's rules

Only the manager agent reads this file. Its working directory is \`scratch/\` beside it; a run working on a card starts under \`worker/\` and never walks in here.

\`CLAUDE.md\` beside this file is one line importing it. This is the file to edit.`;

/** The manager document: how an answer in a conversation is shaped. */
export const MANAGER_INSTRUCTIONS = `${MANAGER_PREAMBLE}

${MANAGER_ANSWER_RULES}
`;
