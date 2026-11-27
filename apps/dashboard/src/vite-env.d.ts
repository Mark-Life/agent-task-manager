/// <reference types="vite/client" />

/**
 * The build-time environment this app reads.
 *
 * Only `VITE_`-prefixed keys are inlined into the bundle, so anything declared
 * here is public by definition and must never hold a secret. The key is
 * optional because an unset variable is a legitimate configuration: it means
 * the API answers on this same origin.
 */
interface ImportMetaEnv {
  /**
   * `1` builds the demo: mock data in the page, no gateway, no sign-in. See
   * `src/demo/install.ts`.
   */
  readonly VITE_DEMO?: string;
  /**
   * The gateway's public origin — scheme and host, no path, no trailing slash.
   * Left unset in development, where Vite proxies the API onto this origin.
   */
  readonly VITE_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
