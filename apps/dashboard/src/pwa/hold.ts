import { useEffect } from "react";

/**
 * What a reload would destroy, registered by whoever would lose it.
 *
 * Adopting a new build means reloading the page, and a reload is only free when
 * nothing on screen exists solely in the browser. Three things do: a draft in a
 * box that has not been committed, a message that has not been sent, and a live
 * run's timeline somebody is watching arrive. So the update path does not
 * decide when it is safe — the components that own those things say when they
 * are not, and the update waits.
 *
 * A hold is a reason, not a flag, so a stuck update can be explained rather
 * than guessed at. Every hold is keyed by its own symbol, which is what lets
 * two boxes hold for the same reason and release independently.
 *
 * The line for a new surface: hold when the browser is the only place some
 * content exists and retyping it would be work — a document, a message, an
 * environment file. Do not hold for a dialog waiting on a filename, or for a
 * sign-in field, because a hold that is taken every time somebody opens
 * something and walks away is a hold that stops the app updating at all.
 */

const held = new Map<symbol, string>();
const listeners = new Set<() => void>();

const announce = () => {
  for (const listener of listeners) {
    listener();
  }
};

/** Take a hold. Call what comes back to release it. */
export const hold = (reason: string): (() => void) => {
  const key = Symbol(reason);
  held.set(key, reason);
  announce();
  return () => {
    if (held.delete(key)) {
      announce();
    }
  };
};

/** Every reason a reload is being held off, in no particular order. */
export const holdReasons = (): readonly string[] => [...new Set(held.values())];

export const isHeld = (): boolean => held.size > 0;

export const onHoldsChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Hold off a reload for as long as `active` is true.
 *
 * The reason is user-facing prose because it ends up in the one place anybody
 * looks when an update seems stuck. Passing a value that changes on every
 * render would release and retake the hold each time, so keep it a literal.
 */
export const useUpdateHold = (active: boolean, reason: string): void => {
  useEffect(() => (active ? hold(reason) : undefined), [active, reason]);
};
