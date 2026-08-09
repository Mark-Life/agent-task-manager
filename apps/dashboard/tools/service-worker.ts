import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

/**
 * Compiles `worker/sw.ts` and emits it as `/sw.js`, with the build's own file
 * list baked into it.
 *
 * The worker cannot be an ordinary entry of this build: it must land at a fixed
 * name at the root — its scope is the directory it is served from, and a
 * fingerprinted worker is a worker no browser can find — and it must be a
 * classic script rather than a module, because module workers are not supported
 * everywhere and the failure is a registration that throws and an app that
 * quietly stops updating. So it is compiled on its own, as an IIFE, by a nested
 * build that shares nothing with this one but the version of Vite.
 *
 * `__PRECACHE__` is the reason this is a plugin at all: the list of files to
 * precache is only known once the chunks have names, which is `generateBundle`.
 * `__BUILD_ID__` is that list's fingerprint, which makes the worker's own bytes
 * change whenever the build does — the only signal a browser uses to decide
 * there is a new worker to install.
 *
 * **Why not `vite-plugin-pwa`.** It generates the manifest and the precache
 * list, and Workbox under it implements a lifecycle this app does not want: a
 * precached shell served from the cache, and `skipWaiting` decided in the
 * worker. What is wanted is navigations network-first and adoption decided by
 * the page, so the plugin would be used in `injectManifest` mode — where the
 * worker is written here anyway and the plugin's contribution is the file list,
 * which is the twenty lines below. It brings `workbox-build` and
 * `workbox-window` with it, and Vite here is 8.x, which is newer than anything
 * that combination has been used against. So there is no new dependency and
 * nothing to pin; the version that matters is Vite's, already pinned in this
 * workspace's `package.json`.
 */

const ENTRY = fileURLToPath(new URL("../worker/sw.ts", import.meta.url));

/**
 * The shell, which keeps its name across builds and so is not in the chunk
 * list — but is the first thing a cold start needs.
 */
const SHELL = "/index.html";

/** Enough of the digest to be unique among a handful of builds, and to read. */
const ID_LENGTH = 12;

const buildIdOf = (paths: readonly string[]) =>
  createHash("sha256")
    .update(paths.join("\n"))
    .digest("hex")
    .slice(0, ID_LENGTH);

/**
 * Everything the browser has to have to start the app offline: the document,
 * and every chunk and asset this build emitted. Vite fingerprints all of them,
 * so each entry is immutable and the whole list changes on every deploy.
 */
const precacheOf = (fileNames: readonly string[]) =>
  [SHELL, ...fileNames.map((name) => `/${name}`).sort()].filter(
    (path, index, all) => all.indexOf(path) === index
  );

const compile = async (precache: readonly string[], buildId: string) => {
  const result = await build({
    build: {
      lib: {
        entry: ENTRY,
        fileName: () => "sw.js",
        formats: ["iife"],
        name: "atmServiceWorker",
      },
      minify: true,
      target: "es2022",
      write: false,
    },
    // Nothing of the app's config applies to the worker, and inheriting it
    // would pull in React, Tailwind and the dev proxy for a file that imports
    // none of them.
    configFile: false,
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __PRECACHE__: JSON.stringify(precache),
    },
    logLevel: "warn",
  });

  const outputs = Array.isArray(result) ? result : [result];
  const chunk = outputs
    .flatMap((output) => ("output" in output ? output.output : []))
    .find((part) => part.type === "chunk");

  if (chunk === undefined) {
    throw new Error("the service worker build produced no code");
  }
  return chunk.code;
};

export const serviceWorker = (): Plugin => ({
  apply: "build",
  async generateBundle(_options, bundle) {
    const precache = precacheOf(
      Object.values(bundle)
        .map((file) => file.fileName)
        .filter((name) => name !== "index.html")
    );
    const buildId = buildIdOf(precache);

    this.emitFile({
      fileName: "sw.js",
      source: await compile(precache, buildId),
      type: "asset",
    });
  },
  name: "atm:service-worker",
});
