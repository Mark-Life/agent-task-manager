import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { gatewayUrl } from "@/env";

/**
 * Where the library answers and how the browser talks to it, in one value.
 *
 * Shared rather than repeated because `./api-key-client` builds a second client
 * over the same auth server — see there for why it is second — and two clients
 * that disagreed about the origin or about sending cookies would be one client
 * that silently authenticated nothing.
 */
export const authClientOptions = {
  baseURL: gatewayUrl,
  fetchOptions: { credentials: "include" },
} as const;

/**
 * The browser's half of Better Auth.
 *
 * `baseURL` is the gateway's origin and nothing more — the client appends
 * `/api/auth` itself, so a value with that path on it produces a doubled one.
 * An empty value means this origin, which is the development case where Vite
 * proxies the gateway. `credentials` is spelled out although it is already the
 * default: losing it is a sign-in that appears to succeed and then authenticates
 * nothing.
 *
 * The API key plugin is deliberately *not* here — `./api-key-client` explains
 * what happens to this module's inferred type when it is.
 */
export const authClient = createAuthClient({
  ...authClientOptions,
  plugins: [organizationClient()],
});

export const { organization, signIn, signOut, useSession } = authClient;
