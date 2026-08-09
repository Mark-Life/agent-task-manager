import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

/**
 * Every path the gateway answers on, as seen from the browser.
 *
 * The contract is mounted at the gateway root rather than under an `/api`
 * prefix, so each group's own top-level segment has to be forwarded by name:
 * `/tasks` carries tasks and everything nested beneath one (messages, sessions,
 * runs, run commands, artifacts), while `/projects`, `/threads` and `/health`
 * carry the rest. `/api/auth` is Better Auth's own mount, and the only path
 * that does sit under `/api`.
 */
const GATEWAY_PREFIXES = [
  "/api/auth",
  "/tasks",
  "/projects",
  "/threads",
  "/health",
] as const;

/** Where the gateway binds when `GATEWAY_PORT` says nothing. */
const DEFAULT_GATEWAY = "http://localhost:3100";

/**
 * The app's own addresses that a proxied prefix would otherwise swallow.
 *
 * Sharing an origin in development means sharing an address space, and two of
 * the dashboard's screens sit exactly where the contract answers: a task's page
 * is the path the contract reads that task from, and the project list is the
 * path it lists projects from. Deeper paths — a task message, an artifact's bytes —
 * are the gateway's alone and are not listed.
 */
const APP_PAGES = [/^\/tasks\/[^/]+\/?$/, /^\/projects\/?$/];

/**
 * Whether the browser is asking for a page rather than for data.
 *
 * Only a navigation asks for HTML; the typed API client, an image and a
 * download ask for something else or for anything at all. That is what tells
 * the shared addresses above which of the two sides is being addressed.
 */
const isNavigation = (accept: string | undefined, url: string | undefined) =>
  accept?.includes("text/html") &&
  APP_PAGES.some((page) => page.test((url ?? "").split("?")[0] ?? ""));

/**
 * One prefix forwarded to the gateway, with the addresses the two sides share
 * handed back to the app whenever a browser is navigating to one.
 */
const gatewayProxy = (target: string): ProxyOptions => ({
  bypass: (request) =>
    isNavigation(request.headers.accept, request.url)
      ? "/index.html"
      : undefined,
  changeOrigin: true,
  target,
});

/**
 * Dev serves the app and the API from one origin, which is what makes the
 * session cookie first-party locally and lets the API client run with an empty
 * base URL. `GATEWAY_PROXY_TARGET` moves the far end without touching this
 * file — a gateway on another port, or one already running in a container.
 */
export default defineConfig(({ mode }) => {
  const appDir = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, appDir, "GATEWAY_");
  const target = env.GATEWAY_PROXY_TARGET || DEFAULT_GATEWAY;

  return {
    optimizeDeps: {
      exclude: ["@workspace/ui"],
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      proxy: Object.fromEntries(
        GATEWAY_PREFIXES.map((prefix) => [prefix, gatewayProxy(target)])
      ),
    },
  };
});
