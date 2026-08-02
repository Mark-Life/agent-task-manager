import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";

/**
 * The gateway origin the built bundle calls at runtime.
 *
 * Required rather than defaulted: the dashboard is a static bundle served from
 * another host, so an absent value bakes in "same origin" and every request
 * lands on the asset worker instead of the API. Failing here says which
 * variable is missing; a wrong build says nothing until a browser opens it.
 */
const gatewayUrl = Config.string("GATEWAY_PUBLIC_URL");

/**
 * The hostname the dashboard is served from, taken from the origin the rest of
 * the system already trusts, so the deployment cannot drift from what the
 * gateway accepts and what a notification links to. A custom domain is not
 * optional here: the session cookie is scoped to the registrable domain the
 * dashboard and the API share, and a `workers.dev` host is on neither.
 */
const dashboardHost = Config.url("DASHBOARD_ORIGIN").pipe(
  Config.map((origin) => origin.hostname)
);

/**
 * The dashboard as Cloudflare Workers Static Assets.
 *
 * State lives in `.alchemy/` next to this file, which makes deployment
 * machine-local by design — swap `Alchemy.localState()` for
 * `Cloudflare.state()` the day a second machine or CI deploys, or the two will
 * each believe they own the worker. The stack is an Effect because the CLI
 * refuses an entry module whose default export is anything else.
 *
 * This file has never been executed: it typechecks, and no plan, deploy or dev
 * has been run against a Cloudflare account. See `deploy/README.md` for what is
 * unknown until somebody does.
 */
export default Alchemy.Stack(
  "agent-task-manager",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    /**
     * Vite builds in-process against the app's own config, so the root has to
     * be the app rather than this file's directory. With no server bundle the
     * upload is assets-only and Cloudflare's asset layer answers every request,
     * which is why the client-side router needs the fallback declared here
     * rather than in a worker. Only `VITE_`-prefixed keys are inlined into the
     * bundle; anything else would become a worker binding no asset can read.
     */
    const dashboard = yield* Cloudflare.Website.Vite("Dashboard", {
      assets: {
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "single-page-application",
      },
      domain: yield* dashboardHost,
      env: { VITE_GATEWAY_URL: yield* gatewayUrl },
      rootDir: fileURLToPath(new URL("apps/dashboard", import.meta.url)),
      workersDev: false,
    });

    return { dashboardUrl: dashboard.url };
  })
);
