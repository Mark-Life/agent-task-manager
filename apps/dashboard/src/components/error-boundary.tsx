import { Alert02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { failureSentence } from "@/components/query-state";

/**
 * A crash is not a failed request, and pretending otherwise hides both.
 *
 * A declared failure that reached a boundary still has its tag, so it is worth
 * saying in the reader's terms; anything else is a defect, and the message the
 * exception carries is the only thing that will help whoever has to fix it.
 * This is an operator's tool with one operator, so that message is shown rather
 * than swallowed.
 */
const detailOf = (error: unknown) => {
  const sentence = failureSentence(error);
  if (error instanceof Error && error.message !== "") {
    return { message: error.message, sentence };
  }
  return { message: null, sentence };
};

/** Throwing the whole page away is the only recovery a broken root has. */
const reloadPage = () => window.location.reload();

/**
 * The last resort, when the failure escaped every route beneath it.
 *
 * It owns the whole viewport because there is nothing trustworthy left to sit
 * inside — the shell itself may be what broke. Reloading is offered rather than
 * a retry: at this depth the router's own state is suspect and a fresh document
 * is the honest fix.
 */
export const RootError = ({ error }: ErrorComponentProps) => {
  const { message, sentence } = detailOf(error);

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Empty className="max-w-md">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
          </EmptyMedia>
          <EmptyTitle>The dashboard stopped</EmptyTitle>
          <EmptyDescription>{sentence}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {message === null ? null : (
            <p className="w-full break-words text-left font-mono text-muted-foreground text-xs">
              {message}
            </p>
          )}
          <Button onClick={reloadPage} size="sm" variant="outline">
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
            Reload
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
};

/**
 * The same failure, contained to the page it happened on.
 *
 * The shell, the sidebar and the conversation list are still standing, so the
 * reader keeps a way out that is not the back button, and `reset` re-renders
 * only this subtree — which is enough whenever the cause was one read that has
 * since been fixed elsewhere.
 */
export const RouteError = ({ error, reset }: ErrorComponentProps) => {
  const { message, sentence } = detailOf(error);

  return (
    <Empty className="py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
        </EmptyMedia>
        <EmptyTitle>This page stopped</EmptyTitle>
        <EmptyDescription>{sentence}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {message === null ? null : (
          <p className="w-full break-words text-left font-mono text-muted-foreground text-xs">
            {message}
          </p>
        )}
        <Button onClick={reset} size="sm" variant="outline">
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
};
