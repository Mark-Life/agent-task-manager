/**
 * Holding the page's first requests until the demo can answer them. No
 * imports: `vite.config.ts` reads `HOLD_SCRIPT` from here.
 */

/** A request made before the demo was installed, held by `HOLD_SCRIPT`. */
export interface Held {
  readonly init?: RequestInit;
  readonly input: RequestInfo | URL;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (response: Response) => void;
}

/** What `HOLD_SCRIPT` leaves on the window. */
export interface Holding {
  /** Set once the demo is installed; every call is answered by it from then. */
  answer?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly held: Held[];
  readonly network: typeof fetch;
}

/** The global `HOLD_SCRIPT` writes; the name is shared with that string. */
export const HOLDING = "__atmDemoHolding";

/**
 * A classic inline script for the page's head. It runs before any module, so
 * it holds every request the app makes while its modules load — the auth
 * client asks for a session the moment it is evaluated, and bundling decides
 * whether that is before or after the demo is installed. Code that kept a
 * reference to this `fetch` is answered too, once `answer` is set.
 */
export const HOLD_SCRIPT = `(() => {
  const network = window.fetch.bind(window);
  const holding = { held: [], network };
  window.${HOLDING} = holding;
  window.fetch = (input, init) =>
    holding.answer
      ? holding.answer(input, init)
      : new Promise((resolve, reject) =>
          holding.held.push({ init, input, reject, resolve })
        );
})();`;
