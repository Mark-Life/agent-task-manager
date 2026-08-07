import { Alert02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/button";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { cn } from "@workspace/ui/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { KEEPS_SESSION } from "@/lib/query-client";

/**
 * What each declared failure means to the person looking at the screen.
 *
 * The contract answers with a tagged value, and the tag is the only part of it
 * anybody can act on — the rest names rows, actors and columns. One sentence
 * per tag, written as the thing that happened rather than as a status code,
 * because a reader who is told "409" learns nothing they can do next.
 */
const SENTENCES: Record<string, string> = {
  AgentSessionEnded: "That session has already ended.",
  ArtifactAlreadyPromoted: "That file has already been promoted.",
  Forbidden: "This account is not allowed to do that.",
  IllegalInitialStatus: "A task cannot be filed straight into that column.",
  IllegalTransition:
    "That move is not one this task can make from where it is.",
  InvalidInput: "The server would not accept those contents.",
  NotFound: "That is not here any more.",
  PayloadTooLarge: "That file is larger than this endpoint accepts.",
  RunAlreadyLive: "A run is already working on this task.",
  RunNotLive: "That run has already finished, so there is nothing to stop.",
  SchemaError:
    "The server answered in a shape this app does not understand. It is probably running a different version.",
  Unauthorized: "The session has expired. Sign in again to carry on.",
};

/**
 * The same, for the transport wrapper. Reaching nothing at all and reaching a
 * server that answered something undeclared are different problems with
 * different fixes — one is the network, the other is a mismatch — so they do
 * not share a sentence.
 */
const TRANSPORT_SENTENCES: Record<string, string> = {
  DecodeError: "The server's answer could not be read.",
  EmptyBodyError: "The server answered with nothing at all.",
  EncodeError: "The request could not be prepared for sending.",
  InvalidUrlError: "The request was aimed at an address that is not valid.",
  StatusCodeError: "The server refused the request without saying why.",
  TransportError: "The server could not be reached. Check the connection.",
};

const FALLBACK = "Something went wrong, and the failure did not say what.";

/**
 * The discriminant every declared failure carries, read defensively: the error
 * channel also holds decode failures and the transport wrapper, and a thrown
 * value that is not an object at all is always possible.
 */
const tagOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof error._tag === "string"
    ? error._tag
    : undefined;

/**
 * What a 401 means when the credential itself is fine.
 *
 * A session proved against two workspaces, or against none, is refused the same
 * way an expired one is — so the tag alone would send a signed-in person to the
 * sign-in form and away from the only control that fixes it. Which refusals
 * those are is decided once, beside the redirect that has to skip them; this
 * only supplies the wording, and falls back to a general sentence rather than
 * claiming the session died if that set ever grows a member.
 */
const WORKSPACE_SENTENCES: Record<string, string> = {
  ambiguous_workspace:
    "This account belongs to more than one workspace. Choose one to carry on.",
  no_workspace: "This account is not a member of any workspace yet.",
};

const WORKSPACE_FALLBACK =
  "The workspace for this account could not be settled.";

/** The refusal a 401 carries, which is the only thing separating those cases. */
const refusalOf = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  typeof error.reason === "string"
    ? error.reason
    : undefined;

/** The inner reason of a transport failure, which is where its detail lives. */
const reasonTagOf = (error: unknown) =>
  typeof error === "object" && error !== null && "reason" in error
    ? tagOf(error.reason)
    : undefined;

/**
 * One sentence for one failure, or null when there was none.
 *
 * Exported on its own because plenty of screens want the sentence inline —
 * under a form, beside a button — rather than in place of their content, and
 * two spellings of the same mapping would drift apart within a week.
 */
export const failureSentence = (error: unknown) => {
  if (error === null || error === undefined) {
    return null;
  }
  const tag = tagOf(error);
  if (tag === "HttpClientError") {
    const reason = reasonTagOf(error);
    return (
      (reason === undefined ? undefined : TRANSPORT_SENTENCES[reason]) ??
      FALLBACK
    );
  }
  if (tag === "Unauthorized") {
    const refusal = refusalOf(error);
    if (refusal !== undefined && KEEPS_SESSION.has(refusal)) {
      return WORKSPACE_SENTENCES[refusal] ?? WORKSPACE_FALLBACK;
    }
    return SENTENCES.Unauthorized;
  }
  return (tag === undefined ? undefined : SENTENCES[tag]) ?? FALLBACK;
};

/** Widths cycled through so a placeholder reads as text rather than as bars. */
const BAR_WIDTHS = ["w-2/3", "w-full", "w-4/5", "w-1/2"] as const;

interface PendingProps {
  readonly className?: string;
  /** What is being waited for, for anyone listening rather than looking. */
  readonly label?: string;
  readonly lines?: number;
}

/**
 * The shape of what is coming, while it is coming.
 *
 * Skeletons rather than a spinner: the reader's eye settles where the content
 * will be instead of on a rotating mark in the middle of an empty page, and a
 * screen that is half loaded does not jump when the rest arrives. Callers pass
 * a line count that matches what they are about to render.
 */
export const Pending = ({
  className,
  label = "Loading",
  lines = 3,
}: PendingProps) => (
  <output
    aria-label={label}
    className={cn("flex w-full flex-col gap-3", className)}
  >
    {Array.from({ length: lines }, (_, index) => (
      <Skeleton
        className={cn("h-4", BAR_WIDTHS[index % BAR_WIDTHS.length])}
        key={`${label}-${index}`}
      />
    ))}
  </output>
);

interface FailedProps {
  readonly className?: string;
  readonly error: unknown;
  /** Present when trying again is worth offering — usually `query.refetch`. */
  readonly onRetry?: () => void;
  readonly title?: string;
}

/**
 * A read that did not come back, said plainly.
 *
 * The title names what failed in the screen's own terms and the sentence below
 * comes from the failure's tag, so a reader is told which of "gone", "not
 * yours" and "unreachable" they are looking at. Retry is offered only when the
 * caller has something to retry with; a decided refusal will answer the same
 * way however many times it is asked.
 */
export const Failed = ({
  className,
  error,
  onRetry,
  title = "That did not load",
}: FailedProps) => (
  <EmptyState
    className={cn("py-10", className)}
    description={failureSentence(error)}
    icon={Alert02Icon}
    title={title}
  >
    {onRetry === undefined ? null : (
      <Button onClick={onRetry} size="sm" variant="outline">
        <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
        Try again
      </Button>
    )}
  </EmptyState>
);
