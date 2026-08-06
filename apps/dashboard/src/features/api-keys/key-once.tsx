import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/button";
import { useCallback, useEffect, useState } from "react";

/** How long the button says it worked before going back to offering the copy. */
const CONFIRMATION_MS = 2000;

interface KeyOnceProps {
  readonly value: string;
}

/**
 * The one showing of a secret.
 *
 * It is selectable text rather than a masked field: this is the single moment
 * the value exists outside the database, and hiding it behind a reveal toggle
 * would be theatre — whoever is looking at this screen is the person who just
 * asked for it. The copy button exists because a long random string is the
 * thing people mis-transcribe.
 *
 * `navigator.clipboard` is absent over plain http on anything but localhost, so
 * the failure is handled rather than assumed away: the text stays on screen and
 * selectable either way, and the button simply does not claim success.
 */
export const KeyOnce = ({ value }: KeyOnceProps) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }, [value]);

  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">
        {value}
      </code>
      <Button
        aria-label="Copy the key"
        onClick={copy}
        size="icon-sm"
        variant="ghost"
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          strokeWidth={2}
        />
      </Button>
    </div>
  );
};
