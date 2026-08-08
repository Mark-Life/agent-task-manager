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
 *
 * The dialog role is also what answers for the conversation and task panels,
 * which is the case worth spelling out because nothing in our own code says
 * `dialog`: a `Sheet` is a Base UI `Dialog.Root`, and its popup renders
 * `role="dialog"` by default. So a letter pressed while one of those is open is
 * declined wherever focus sits inside it — the chat composer does not have to
 * hold the caret for the panel around it to claim the keystroke.
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
 * How a bound set is spelled for the dependency list below. A newline, because
 * no `KeyboardEvent.key` is one — the return key is spelled `Enter` — so
 * splitting the string back apart cannot invent a key nobody asked for.
 */
const BOUND_SEPARATOR = "\n";

/**
 * A family of single unmodified keys, anywhere in the app, answered by one
 * handler that is told which of them fired.
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
export const useHotkeys = (
  keys: readonly string[],
  onPress: (key: string) => void
) => {
  // Flattened to a string before it reaches the dependency list, so a caller
  // may build the list inline — one letter below, a run of positions elsewhere
  // — without the listener being torn down and rebuilt on every render.
  const bound = keys.join(BOUND_SEPARATOR);

  useEffect(() => {
    const answered = new Set(bound.split(BOUND_SEPARATOR));

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !answered.has(event.key) ||
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
      onPress(event.key);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bound, onPress]);
};

/** One key, for a caller with nothing to tell apart. */
export const useHotkey = (key: string, onPress: () => void) => {
  useHotkeys([key], onPress);
};
