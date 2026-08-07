import {
  Alert02Icon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/button";
import { type ComponentProps, useCallback, useEffect, useState } from "react";

/** How long the button says what happened before going back to offering the copy. */
const CONFIRMATION_MS = 2000;

/**
 * Idle, or the outcome of the last press. Three states rather than a pair of
 * booleans: a press that both worked and failed is not a thing this button can
 * be in, so it is not a thing it can be told to draw.
 */
type CopyState = "copied" | "failed" | "idle";

const FEEDBACK = {
  copied: { icon: Tick02Icon, said: "Copied", title: "Copied" },
  failed: {
    icon: Alert02Icon,
    said: "Copying is not available here",
    // The one real cause: `navigator.clipboard` is absent over plain http on
    // anything but localhost, so a deployment reached by IP has no clipboard to
    // write to. Saying so beats a button that looks like it did nothing.
    title:
      "Copying is not available here — select the value and copy it by hand",
  },
  idle: { icon: Copy01Icon, said: "", title: null },
} as const satisfies Record<
  CopyState,
  { icon: unknown; said: string; title: string | null }
>;

interface CopyButtonProps {
  /** Names the button for a screen reader and labels it on hover. */
  readonly label: string;
  /** Defaults to the small icon button; give a bigger one where thumbs land. */
  readonly size?: ComponentProps<typeof Button>["size"];
  readonly value: string;
}

/**
 * A value, taken to the clipboard.
 *
 * The icon swaps to a tick and back, because the clipboard gives no sign of
 * itself: without the swap the only way to know the press landed is to go and
 * paste. The same swap carries the failure — `navigator.clipboard` is absent
 * over plain http on anything but localhost — so a button that cannot work says
 * so instead of looking broken. Callers are expected to leave the value
 * reachable some other way (selectable text, the address bar) for that case.
 *
 * The outcome is also written to a live region, since a screen reader has no
 * icon to look at.
 */
export const CopyButton = ({
  label,
  size = "icon-sm",
  value,
}: CopyButtonProps) => {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") {
      return;
    }
    const timer = setTimeout(() => setState("idle"), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = useCallback(() => {
    const { clipboard } = navigator;
    if (clipboard === undefined) {
      setState("failed");
      return;
    }
    clipboard
      .writeText(value)
      .then(() => setState("copied"))
      .catch(() => setState("failed"));
  }, [value]);

  const feedback = FEEDBACK[state];

  return (
    <>
      <Button
        aria-label={label}
        onClick={copy}
        size={size}
        title={feedback.title ?? label}
        variant="ghost"
      >
        <HugeiconsIcon icon={feedback.icon} strokeWidth={2} />
      </Button>
      {/* Absolutely positioned by `sr-only`, so it costs the row no width. */}
      <span className="sr-only" role="status">
        {feedback.said}
      </span>
    </>
  );
};
