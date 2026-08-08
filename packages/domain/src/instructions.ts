/**
 * What a run reads its rules from, and how much of them it is handed.
 *
 * Three parties have to agree on these and none of them can import the others:
 * the orchestrator writes the files into every scope, the sandbox adds up what
 * a run's whole tree costs before the container starts, and a browser draws the
 * same number beside the box a person types the rules into. The measuring side
 * reaches a filesystem and a container daemon and cannot be bundled for a
 * browser, so the two ends would otherwise each carry their own copy of the
 * limit — and Codex moving its default would be a silent disagreement rather
 * than one edit.
 *
 * Vocabulary only. Nothing here reads a file or joins a path.
 */

/**
 * What Codex calls an instruction file at any level of the tree.
 *
 * This is the name that carries the text. Codex reads it and Claude does not,
 * which is the whole reason there are two names for one document — see
 * {@link CLAUDE_INSTRUCTIONS_FILE}.
 */
export const AGENTS_INSTRUCTIONS_FILE = "AGENTS.md";

/**
 * What Claude calls an instruction file, and the second name of the same
 * document.
 *
 * Claude does not read `AGENTS.md` at all, so a directory holding only that file
 * is a directory whose rules reach one provider. The file written under this
 * name is one import line rather than a copy of the text, because two copies of
 * a rule are two rules the day somebody edits one.
 */
export const CLAUDE_INSTRUCTIONS_FILE = "CLAUDE.md";

/**
 * Both names, in the order a reader meets them. Only the first is what Codex's
 * budget is spent on, and both are counted anyway: the pair is one document
 * written twice, so somebody asked to shorten their rules is looking at both
 * files.
 */
export const INSTRUCTION_FILES = [
  AGENTS_INSTRUCTIONS_FILE,
  CLAUDE_INSTRUCTIONS_FILE,
] as const;

/** One of the two names an instruction file goes by. */
export type InstructionFileName = (typeof INSTRUCTION_FILES)[number];

/** Whether a filename is one of the two, so a caller does not have to spell the pair again. */
export const isInstructionFileName = (name: string) =>
  INSTRUCTION_FILES.some((known) => known === name);

/**
 * The combined size at which a run's instruction files are worth a warning:
 * thirty-two kibibytes.
 *
 * Codex collects every `AGENTS.md` from the top of the tree down to the working
 * directory and spends one budget across them, root first — so past the budget
 * the deepest and most specific document, the task's own, is the first thing
 * dropped, which is backwards from what the nesting is for. The truncation is
 * silent: the only signal is a log line the headless runner filters out.
 *
 * This is Codex's own default, and it is the number to warn at even though the
 * harness writes a larger `project_doc_max_bytes` into every run: raising the
 * setting moves the cliff, it does not remove it, and somebody will eventually
 * run the CLI by hand under the default.
 */
export const INSTRUCTION_BUDGET_WARN_BYTES = 32_768;
