/**
 * The demo build's first script, injected into the page ahead of the app by
 * `vite.config.ts`. Module scripts run in document order, so the fake `fetch`
 * is in place before the auth client asks for a session at load.
 */

import { installDemo } from "./install";

installDemo();
