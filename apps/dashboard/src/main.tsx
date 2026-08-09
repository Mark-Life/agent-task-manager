import "@workspace/ui/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/app";
import { registerUpdates } from "@/pwa/update";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// After the render rather than before it: registering a worker is a network
// call and a set of listeners, and neither is worth a frame of the first paint.
// It is also what keeps this app on the build that is deployed rather than the
// one it was installed with — see `pwa/update.ts`.
registerUpdates();
