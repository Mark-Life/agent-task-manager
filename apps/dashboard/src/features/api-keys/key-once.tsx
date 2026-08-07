import { CopyButton } from "@/components/copy-button";

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
 * The text stays on screen and selectable either way, which is what makes the
 * copy button's failure case survivable: `navigator.clipboard` is absent over
 * plain http on anything but localhost, and the key is still readable there.
 */
export const KeyOnce = ({ value }: KeyOnceProps) => (
  <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
    <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">
      {value}
    </code>
    <CopyButton label="Copy the key" value={value} />
  </div>
);
