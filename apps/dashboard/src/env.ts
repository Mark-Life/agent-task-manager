/**
 * Where the API lives, resolved once at module load.
 *
 * An empty string is meaningful rather than missing: it means "this origin",
 * which is how development works — Vite proxies the gateway's paths onto the
 * dev server so the session cookie stays first-party. In production the value
 * is the gateway's own origin, baked in at build time.
 */
export const gatewayUrl = (import.meta.env.VITE_GATEWAY_URL ?? "").replace(
  /\/+$/,
  ""
);

/**
 * Whether the API answers on the page's own origin. Callers that must build an
 * absolute URL by hand — a download link, an `EventSource` — can prepend
 * {@link gatewayUrl} unconditionally, but this reads clearer at a branch.
 */
export const isSameOrigin = gatewayUrl === "";
