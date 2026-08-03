import { Navigate } from "@tanstack/react-router";
import { Spinner } from "@workspace/ui/components/spinner";
import type { ReactNode } from "react";
import { useSession } from "@/auth/client";

/** Where a request without a session ends up. Spelled once, used twice. */
const SIGN_IN_PATH = "/login";

interface RequireSessionProps {
  readonly children: ReactNode;
}

/**
 * The gate every authenticated screen sits behind.
 *
 * The three states are kept apart on purpose: while the session is still being
 * read there is nothing to decide, so the screen stays quiet rather than
 * flashing the sign-in form at somebody who is already signed in. Only a
 * settled absence redirects, and the redirect replaces the history entry so the
 * back button does not bounce between the two.
 */
export const RequireSession = ({ children }: RequireSessionProps) => {
  const { data, isPending } = useSession();

  if (isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Spinner
          aria-label="Checking your session"
          className="size-4 text-muted-foreground"
        />
      </div>
    );
  }

  if (data === null || data === undefined) {
    return <Navigate replace to={SIGN_IN_PATH} />;
  }

  return children;
};
