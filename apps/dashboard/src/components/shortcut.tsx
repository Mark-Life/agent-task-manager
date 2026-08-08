import { Kbd } from "@workspace/ui/components/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import type { ReactElement } from "react";

interface ShortcutLabelProps {
  /** The key as it is bound — one bare letter, lower case. */
  readonly hotkey: string;
  /** What the control does, in the words the operator would use for it. */
  readonly label: string;
}

/**
 * What a control does and the key that does it, for a tooltip somebody else
 * already draws.
 *
 * The sidebar is the one caller: `SidebarMenuButton` renders a tooltip of its
 * own and shows it only while the rail is collapsed, which is exactly when the
 * row has no room for a label or a key. Wrapping such a button in a second
 * tooltip would put two on the same control, so this hands over the contents
 * and leaves the tooltip to it.
 *
 * The letter is drawn as a capital because that is how a key is engraved, not
 * because `Shift` is part of it — the binding is the bare lower-case letter.
 */
export const ShortcutLabel = ({ hotkey, label }: ShortcutLabelProps) => (
  <>
    {label}
    <Kbd>{hotkey.toUpperCase()}</Kbd>
  </>
);

interface ShortcutHintProps {
  /**
   * The control the hint is about, as an element rather than rendered markup:
   * the tooltip has to put its own props on it — the hover and focus handlers,
   * and the id that ties the two together for a screen reader.
   */
  readonly children: ReactElement;
  readonly hotkey: string;
  readonly label: string;
}

/**
 * A control, with what it does and the key that does it on hover and on focus.
 *
 * This replaces the native `title` attribute rather than joining it. A `title`
 * is drawn by the browser in its own box after about a second, ignores the
 * page's palette, and never appears at all on a touch screen or for a keyboard
 * that tabs onto the control — so a shortcut announced only that way is a
 * shortcut most people never learn. A control whose only name was the `title`
 * keeps an `aria-label`: this tooltip describes, and does not label.
 */
export const ShortcutHint = ({
  children,
  hotkey,
  label,
}: ShortcutHintProps) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent>
      <ShortcutLabel hotkey={hotkey} label={label} />
    </TooltipContent>
  </Tooltip>
);
