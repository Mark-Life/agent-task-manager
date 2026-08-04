/**
 * Reading a setting out of an environment, once.
 *
 * Three parties in this package read environment variables — the stop hook, the
 * Executor wiring, and the turn's correlation ids — and each of them had written
 * the same three lines: trim it, and treat what is left of nothing as nothing.
 * The rule is worth stating once because getting it wrong is silent. A variable
 * that is present but empty is how a shell passes "unset", and a caller that
 * reads `""` as a value joins it onto a path and looks for a file at the
 * filesystem root, or stamps a blank string onto a row where a null belonged and
 * makes an absent id look like a supplied one.
 */

/**
 * The trimmed value of an environment variable, or null when it is unset,
 * absent, or nothing but whitespace. Pure.
 */
export const trimmedOrNull = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
};
