import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import "./app/style.css";
import { Shell } from "./app/Shell";
import { createPrivacyController, bindPrivacyLifecycle } from "./app/privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "./query/client";
import { canonicalWorkspacePath } from "./routes/location";

const container = document.getElementById("root");
if (!container) throw new Error("Owner workspace root is missing.");
const guard = document.getElementById("privacy-guard");
if (!guard) throw new Error("Owner workspace privacy guard is missing.");
const queryClient = createWorkspaceQueryClient();
const fixture = import.meta.env.DEV && import.meta.env.VITE_ELIOTR_FIXTURE === "true";
const privacy = createPrivacyController({
  mask() { container.hidden = true; container.inert = true; container.setAttribute("aria-hidden", "true"); guard.hidden = false; },
  reveal() { guard.hidden = true; container.hidden = false; container.inert = false; container.removeAttribute("aria-hidden"); },
  cancelReads() { void queryClient.cancelQueries(undefined, { revert: false, silent: true }).catch(() => {}); },
  clearProtected() { clearWorkspaceQueries(queryClient); },
  async verify(signal) {
    if (signal.aborted || !fixture) return undefined;
    return { principal: "synthetic-owner", session: "synthetic-session", credentialGeneration: "fixture-only", deploymentGeneration: "fixture-only" };
  },
});
const unbind = bindPrivacyLifecycle(privacy, window);
const path = canonicalWorkspacePath(window.location);
if (window.location.pathname !== path || window.location.search || window.location.hash) window.history.replaceState(null, "", path);

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><BrowserRouter><Shell privacy={privacy} fixture={fixture} /></BrowserRouter></QueryClientProvider>
  </React.StrictMode>,
);
void privacy.refresh();
if (import.meta.hot) import.meta.hot.dispose(() => { unbind(); privacy.dispose(); root.unmount(); });
