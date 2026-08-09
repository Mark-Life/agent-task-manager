/// <reference lib="webworker" />

import { SKIP_WAITING, STALE_BUILD, type WorkerMessage } from "./protocol";
import { handlingOf } from "./route";

/**
 * The dashboard's service worker.
 *
 * Written here rather than generated, because the interesting half of it is the
 * update policy and that policy is unusual: navigations are network-first so a
 * deploy is seen immediately, the build is precached so the reload that adopts
 * it needs no network, and the moment of adoption belongs to the page rather
 * than to this file — nothing here calls `skipWaiting` on its own. The page
 * asks, once it knows nobody is mid-sentence. `src/pwa/update.ts` is the other
 * half and the two are worth reading together.
 *
 * What it deliberately does not do is touch the API. The board is live data on
 * the gateway's origin and TanStack Query already owns its freshness; a cached
 * board looks current and is not, which is worse than an error. `route.ts`
 * holds those rules.
 *
 * `__PRECACHE__` and `__BUILD_ID__` are substituted at build time by
 * `tools/service-worker.ts`, which is also what makes a new build produce a
 * byte-different worker — the browser only installs a worker whose script has
 * changed.
 */

declare const self: ServiceWorkerGlobalScope;

/** Every file of this build, as paths on this origin. */
declare const __PRECACHE__: readonly string[];

/** A fingerprint of that list, which is what makes each build its own cache. */
declare const __BUILD_ID__: string;

/** Shared by every build's cache, so activation can tell ours from the last one's. */
const CACHE_PREFIX = "atm-dashboard-";

const CACHE = `${CACHE_PREFIX}${__BUILD_ID__}`;

/**
 * Where the app's shell is kept, whatever path the browser navigated to.
 *
 * Every route is served by the same document — that is what `try_files` does in
 * front of this — so one cache entry answers all of them, and a person who
 * browsed thirty tasks offline does not have thirty copies of it.
 */
const SHELL = "/index.html";

/** Statuses that mean the server answered and this path is not there any more. */
const NOT_FOUND = 404;
const GONE_STATUS = 410;
const GONE = new Set([NOT_FOUND, GONE_STATUS]);

/**
 * Install: fetch the whole build and keep it.
 *
 * `cache: "reload"` on every entry because the browser's own HTTP cache is
 * exactly what this is meant to get past — precaching a copy of the shell the
 * browser was already holding would install the build we are replacing.
 *
 * No `skipWaiting`. Installing is the background half of the update and it is
 * allowed to happen at any moment; taking over is the half that reloads a page,
 * and the page decides when.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(
          __PRECACHE__.map((path) => new Request(path, { cache: "reload" }))
        )
      )
  );
});

/**
 * Activate: drop every earlier build's cache, and take over the open pages.
 *
 * Claiming matters here rather than being a formality — a page that loaded
 * before any worker existed is uncontrolled, and an uncontrolled page is one
 * whose assets 404 the moment a deploy lands.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/** The page saying this is a safe moment. Everything after this is the reload. */
self.addEventListener("message", (event) => {
  if ((event.data as WorkerMessage | null)?.type === SKIP_WAITING) {
    self.skipWaiting();
  }
});

const tellClients = async (type: string) => {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type });
  }
};

/**
 * A navigation: the network first, and the last shell we saw if there is none.
 *
 * This is what makes a deploy visible. The document is the one file in the
 * build that keeps its name, so serving it from a cache — which is what a
 * precached shell means — pins the app to whichever asset hashes that copy
 * happens to name, forever. Asking the server every time costs one small
 * revalidated request per open, and it is the whole of why this app can change.
 */
const navigate = async (request: Request) => {
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(SHELL, fresh.clone());
      return fresh;
    }
    return (await caches.match(SHELL)) ?? fresh;
  } catch (failure) {
    const cached = await caches.match(SHELL);
    if (cached) {
      return cached;
    }
    throw failure;
  }
};

/**
 * A file of the build: the cache first, because its name is its version.
 *
 * The lookup is across every cache this origin holds, not just this build's.
 * `dashboard:publish` is an `rsync --delete`, so the previous build's files are
 * gone from the server the instant a deploy lands — a page still running the
 * old shell would 404 on its own scripts. Its assets are still in the cache the
 * old worker filled, and answering from there is the difference between a lazy
 * chunk arriving and a white screen.
 *
 * When it is in no cache and the server says it is gone, that page cannot be
 * saved by this worker: it is running a build that no longer exists anywhere.
 * The page is told, and it reloads at its own first safe moment onto the shell
 * the network has now.
 */
const asset = async (request: Request) => {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const fresh = await fetch(request);
  if (fresh.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, fresh.clone());
    return fresh;
  }
  if (GONE.has(fresh.status)) {
    await self.registration.update();
    await tellClients(STALE_BUILD);
  }
  return fresh;
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const handling = handlingOf({
    accept: request.headers.get("accept"),
    method: request.method,
    mode: request.mode,
    path: url.pathname,
    sameOrigin: url.origin === self.location.origin,
  });

  if (handling === "pass-through") {
    return;
  }
  event.respondWith(
    handling === "navigate" ? navigate(request) : asset(request)
  );
});
