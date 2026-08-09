import { holdReasons } from "@/pwa/hold";
import {
  SKIP_WAITING,
  STALE_BUILD,
  type WorkerMessage,
} from "../../worker/protocol";

/**
 * The page's half of the update. `worker/sw.ts` is the other half.
 *
 * What this is for: the dashboard is added to a phone's home screen, and until
 * now what was installed there stayed on the build it was installed with. The
 * worker fetches every new build in the background as soon as it sees one; this
 * decides when the app starts running it, which is a reload, and a reload at
 * the wrong moment loses somebody's work.
 *
 * The moments it is allowed to happen:
 *
 * - **On load**, before anything has been typed. A worker left waiting from the
 *   last visit is adopted here, which is why closing the app and opening it
 *   again is enough to be on the new build.
 * - **When the app goes to the background**, and when a download that started
 *   before that finishes while it is still there. The reload happens where
 *   nobody is looking and the app is already new by the time it is opened.
 * - **When the app comes back to the foreground**, in case the browser froze
 *   the page before the previous rule could run. This is also when it asks the
 *   server whether there is a new build at all.
 *
 * And the moment it is never allowed: while anything holds it. See `hold.ts` —
 * an open editor draft, an unsent message, a run stream being watched. A held
 * update is not lost, only late: it is taken at the next of the moments above,
 * which in practice is the next time the app is put down.
 *
 * Nobody is asked. There is no "a new version is available" prompt, because the
 * answer to it is always yes and it can only ever be asked at a bad moment.
 */

/** Fixed name at the root: a worker's scope is the directory it is served from. */
const SCRIPT = "/sw.js";

/**
 * Whether this page was already being served by a worker when it loaded.
 *
 * The first install claims the page, which fires `controllerchange` exactly
 * like an update does. Reloading on that one would turn every first visit into
 * two loads, so the two are told apart by whether there was a worker before.
 */
let wasControlled = false;

/** A reload is one-way; a second one on the way out helps nobody. */
let reloading = false;

/**
 * Why an update cannot be adopted at this instant, or null when it can.
 *
 * Split out from the machinery because it is the whole of the policy and the
 * only part worth testing on its own — everything else in this file is browser
 * plumbing. The first hold is the answer when there are several: they are all
 * equally disqualifying, and one reason is what a person can act on.
 */
export const blockedBy = ({
  reasons,
  waiting,
}: {
  readonly reasons: readonly string[];
  readonly waiting: boolean;
}): string | null => {
  if (!waiting) {
    return "there is no new build waiting";
  }
  return reasons[0] ?? null;
};

/**
 * Adopt the waiting build if this is a safe instant.
 *
 * The worker is asked to stop waiting rather than told to reload: it takes
 * over, `controllerchange` fires, and the reload below is what runs the new
 * code. In that order the page never reloads onto a build the worker has not
 * actually activated.
 */
const adoptIfSafe = (registration: ServiceWorkerRegistration) => {
  const { waiting } = registration;
  const blocked = blockedBy({
    reasons: holdReasons(),
    waiting: waiting !== null,
  });
  if (reloading || blocked !== null || waiting === null) {
    return;
  }
  waiting.postMessage({ type: SKIP_WAITING });
};

const onControllerChange = () => {
  if (!wasControlled || reloading) {
    return;
  }
  reloading = true;
  window.location.reload();
};

/**
 * Development registers nothing and clears whatever a production build on the
 * same origin left behind. A worker in front of a dev server serves yesterday's
 * module for today's edit, and the symptom is a change that does not appear.
 */
const unregisterAll = async () => {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((one) => one.unregister()));
};

/** Nothing to do about a failed check; the next one asks again. */
const ignore = () => {
  /* Offline, or the server is down. */
};

const listen = (registration: ServiceWorkerRegistration) => {
  const check = () => registration.update().catch(ignore);
  const adopt = () => adoptIfSafe(registration);

  adopt();
  check();

  // A build that finishes downloading while the app is in the background is
  // taken there and then, so what gets opened next is already the new one.
  registration.addEventListener("updatefound", () => {
    const { installing } = registration;
    if (installing === null) {
      return;
    }
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && document.hidden) {
        adopt();
      }
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      check();
    }
    adopt();
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if ((event.data as WorkerMessage | null)?.type !== STALE_BUILD) {
      return;
    }
    // A file this build is made of is no longer on the server, so the shell in
    // this tab is older than the deploy. Nothing to decide: fetch what is
    // there now and adopt it at the first safe instant.
    registration.update().then(adopt).catch(ignore);
  });
};

/**
 * Starts the update loop. Called once, from the entry module; a second call
 * would add a second set of listeners.
 */
export const registerUpdates = (): void => {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  if (import.meta.env.DEV) {
    unregisterAll().catch(ignore);
    return;
  }

  wasControlled = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    onControllerChange
  );

  navigator.serviceWorker
    // `updateViaCache: "none"` so the check for a new worker is a real request.
    // The script is served `no-cache` as well; both are cheap, and the failure
    // mode of getting this wrong is an app that cannot ship its own successor.
    .register(SCRIPT, { updateViaCache: "none" })
    .then(listen)
    .catch(ignore);
};
