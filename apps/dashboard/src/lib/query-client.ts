import { QueryCache, QueryClient } from "@tanstack/react-query";

/** How long a read stays fresh. Short: the board moves under the operator. */
const STALE_TIME = 5000;

/** One retry, and only for failures that could plausibly differ next time. */
const RETRY_LIMIT = 1;

/** Where an expired or missing session sends the operator. */
const LOGIN_PATH = "/login";

/**
 * Failures the server declared, which means it decided. Asking again produces
 * the same answer, so a retry only doubles the latency of an error the UI is
 * about to render anyway. Transport and decode failures are not in this set and
 * are still retried once.
 */
const DECIDED = new Set([
  "AgentSessionEnded",
  "ArtifactAlreadyPromoted",
  "Forbidden",
  "IllegalInitialStatus",
  "IllegalTransition",
  "InvalidInput",
  "NotFound",
  "PayloadTooLarge",
  "RunAlreadyLive",
  "RunNotLive",
  "Unauthorized",
]);

/**
 * The discriminant every declared failure carries. Read defensively because the
 * error channel also holds transport and schema failures, which are tagged
 * differently or not at all.
 */
const tagOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string"
    ? error._tag
    : undefined;

/** Why the gateway refused, as it spells it on `Unauthorized`. */
const reasonOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  typeof error.reason === "string"
    ? error.reason
    : undefined;

/**
 * Refusals that arrive as a 401 and are not about the credential.
 *
 * A session that belongs to two workspaces and has chosen neither is proved and
 * live — the gateway simply cannot tell which workspace to answer for. Signing
 * out would throw away the only thing that can fix it, since the workspace
 * picker lives inside the frame this redirect tears down.
 */
export const KEEPS_SESSION = new Set(["ambiguous_workspace", "no_workspace"]);

/**
 * Whether a failed read means the session is gone.
 *
 * The tag alone does not settle it, because a 401 also carries the refusals in
 * {@link KEEPS_SESSION}. Exported because a mutation's own error handling needs
 * the same question answered, and two spellings of it would drift.
 */
export const isUnauthorized = (error: unknown) =>
  tagOf(error) === "Unauthorized" && !KEEPS_SESSION.has(reasonOf(error) ?? "");

const shouldRetry = (failureCount: number, error: unknown) => {
  const tag = tagOf(error);
  if (tag !== undefined && DECIDED.has(tag)) {
    return false;
  }
  return failureCount < RETRY_LIMIT;
};

/**
 * Send the operator to the sign-in screen, once.
 *
 * A hard navigation rather than a router call: this runs from the cache's error
 * hook, which is module-level and has no router in scope, and throwing away the
 * whole client state is the right thing when the session behind it has expired.
 * The path check stops a failing request on the login screen from looping.
 */
const redirectToLogin = () => {
  if (window.location.pathname !== LOGIN_PATH) {
    window.location.assign(LOGIN_PATH);
  }
};

/**
 * The app's single cache.
 *
 * Created at module load and shared by the provider and the router's context,
 * so a loader and a component asking for the same key get the same in-flight
 * request. Signed-out handling lives here rather than in every screen: a read
 * answering for a session that is gone sends the operator out, whichever screen
 * asked.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { retry: false },
    queries: {
      refetchOnWindowFocus: false,
      retry: shouldRetry,
      staleTime: STALE_TIME,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) {
        redirectToLogin();
      }
    },
  }),
});
