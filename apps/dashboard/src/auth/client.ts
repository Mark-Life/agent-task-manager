import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { gatewayUrl } from "@/env";

/**
 * The browser's half of Better Auth.
 *
 * `baseURL` is the gateway's origin and nothing more — the client appends
 * `/api/auth` itself, so a value with that path on it produces a doubled one.
 * An empty value means this origin, which is the development case where Vite
 * proxies the gateway. `credentials` is spelled out although it is already the
 * default: losing it is a sign-in that appears to succeed and then authenticates
 * nothing.
 */
export const authClient = createAuthClient({
  baseURL: gatewayUrl,
  fetchOptions: { credentials: "include" },
  plugins: [organizationClient()],
});

export const { organization, signIn, signOut, useSession } = authClient;
