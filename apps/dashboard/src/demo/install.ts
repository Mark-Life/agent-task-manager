/**
 * Demo mode: the real dashboard with nothing behind it.
 *
 * Replaces `fetch` before the app renders. Calls to the contract go to the
 * in-page server in `./server`, calls to Better Auth get one signed-in person,
 * and everything else (the bundle, icons) goes to the network as usual. Nothing
 * else in the app knows it is a demo.
 */

import { HOLDING, type Holding } from "./hold";
import { DEMO_USER, DEMO_WORKSPACE } from "./ids";
import { handler } from "./server";

const CONTRACT_PREFIXES = [
  "/tasks",
  "/projects",
  "/threads",
  "/files",
  "/skills",
  "/usage",
  "/health",
];

const AUTH_PREFIX = "/api/auth";

const isContract = (path: string) =>
  CONTRACT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );

const SIGNED_IN_AT = new Date().toISOString();
const DAY_MS = 86_400_000;

const USER = {
  createdAt: SIGNED_IN_AT,
  email: "demo@agent-task-manager.local",
  emailVerified: true,
  id: DEMO_USER,
  image: null,
  name: "Demo",
  updatedAt: SIGNED_IN_AT,
};

const WORKSPACE = {
  createdAt: SIGNED_IN_AT,
  id: DEMO_WORKSPACE,
  logo: null,
  metadata: null,
  name: "Demo",
  slug: "demo",
};

const SESSION = {
  session: {
    activeOrganizationId: DEMO_WORKSPACE,
    createdAt: SIGNED_IN_AT,
    expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
    id: "session_demo",
    token: "demo",
    updatedAt: SIGNED_IN_AT,
    userId: DEMO_USER,
  },
  user: USER,
};

/** Better Auth's answers, by the path after `/api/auth`. */
const authAnswer = (path: string): unknown => {
  switch (path) {
    case "/get-session":
      return SESSION;
    case "/organization/list":
      return [WORKSPACE];
    case "/organization/get-full-organization":
    case "/organization/set-active":
      return { ...WORKSPACE, invitations: [], members: [] };
    case "/api-key/list":
      return [];
    default:
      return null;
  }
};

export const installDemo = () => {
  const holding = (
    globalThis as unknown as Record<string, Holding | undefined>
  )[HOLDING];
  const network = holding?.network ?? globalThis.fetch.bind(globalThis);
  const demoFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.startsWith(AUTH_PREFIX)) {
      return Promise.resolve(
        Response.json(authAnswer(path.slice(AUTH_PREFIX.length)))
      );
    }
    return isContract(path) ? handler(request) : network(input, init);
  };
  if (holding === undefined) {
    globalThis.fetch = Object.assign(demoFetch, network);
    return;
  }
  holding.answer = demoFetch;
  for (const request of holding.held.splice(0)) {
    demoFetch(request.input, request.init).then(
      request.resolve,
      request.reject
    );
  }
};
