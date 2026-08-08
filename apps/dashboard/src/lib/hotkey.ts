import { useEffect } from "react";

/**
 * Anything that turns a keystroke into text.
 *
 * `contenteditable` is matched on the element's own computed flag rather than
 * through this selector, because the attribute is inherited by every descendant
 * and an attribute selector would only catch the node carrying it.
 */
const TEXT_ENTRY = "input, textarea, select";

/**
 * Surfaces that own the keyboard for as long as they hold focus.
 *
 * A dialog, a sheet and a command palette are modal — the app behind them is
 * not being operated. A menu, a listbox and a combobox all implement typeahead,
 * where a bare letter selects an option. In every one of those a single letter
 * already means something, and a global shortcut firing underneath would be a
 * second, invisible meaning. `cmdk-root` is the command palette's own marker,
 * which it carries whether or not it was opened inside a dialog.
 */
const CAPTURING = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="combobox"]',
  "[cmdk-root]",
].join(", ");

/**
 * Whether this keystroke belongs to whatever already has focus.
 *
 * The target of a `keydown` is an element, but not necessarily an HTML one — an
 * SVG node can hold focus — and only `HTMLElement` carries `isContentEditable`,
 * so anything else is treated as ordinary chrome that claims nothing.
 */
const claimsTheKey = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.matches(TEXT_ENTRY) ||
    target.closest(CAPTURING) !== null
  );
};

/**
 * A single unmodified letter, anywhere in the app.
 *
 * Document-level rather than bound to a component's subtree: the point of these
 * is that they work without first clicking the control they stand for, so there
 * is no element that could reasonably own the listener. `key` is compared
 * exactly, which is what keeps `Shift`+the letter — a capital, and a different
 * keystroke — out of it; the other three modifiers are rejected outright so a
 * browser or OS binding is never shadowed.
 *
 * A held key repeats at the OS rate. Only the first of those counts: a shortcut
 * that flips something would otherwise strobe until the key came back up.
 *
 * The event's default is left alone. These bindings are bare letters, which no
 * browser reserves outside a text field, and swallowing the event would take
 * the keystroke away from anything that comes to depend on it later.
 */
export const useHotkey = (key: string, onPress: () => void) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== key ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat ||
        event.isComposing ||
        event.defaultPrevented ||
        claimsTheKey(event.target)
      ) {
        return;
      }
      onPress();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [key, onPress]);
};
