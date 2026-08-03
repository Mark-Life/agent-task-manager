/**
 * What a failed request means, in the reader's terms.
 *
 * Every failure the contract declares carries a tag, and the tag is the only
 * part of it a person can act on — the rest names rows and actors. Anything
 * unlisted is a transport fault or a defect, which reads the same to whoever is
 * looking at the screen: it did not go through.
 *
 * One table for the whole app rather than one per screen, so the same refusal is
 * the same sentence wherever it surfaces.
 */
const FAILURE_TEXT: Record<string, string> = {
  AgentSessionEnded: "That session has already ended.",
  ArtifactAlreadyPromoted: "That file has already been promoted.",
  Forbidden: "You do not have permission for that.",
  IllegalDeletion: "This task is not yours to delete.",
  IllegalTransition: "That move is not one this task can make from here.",
  InvalidInput: "The server refused the contents.",
  NotFound: "That no longer exists.",
  PayloadTooLarge: "That file is over the size this endpoint accepts.",
  RunAlreadyLive: "A run is already working on this task.",
  RunNotLive: "That run has already ended.",
};

/**
 * A sentence for a failure, or null when there was none. Callers render the
 * null as nothing; the tagged union survives all the way from the endpoint, so
 * the branch here is on a value rather than on a parsed message.
 */
export const failureText = (
  error: { readonly _tag: string } | null | undefined
) => {
  if (error === null || error === undefined) {
    return null;
  }
  return FAILURE_TEXT[error._tag] ?? "That did not go through.";
};
