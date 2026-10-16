import React, { lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "./Shell";
import { createPrivacyController, bindPrivacyLifecycle } from "./privacy";
import { createWorkspaceQueryClient, clearWorkspaceQueries } from "../query/client";
import { canonicalWorkspacePath } from "../routes/location";
import { createWorkspaceRuntime } from "./runtime";
import { ensureLegacyWorkerRetired } from "./legacy-worker-retirement";

const container = document.getElementById("root");
if (!container) throw new Error("Owner workspace root is missing.");
const guard = document.getElementById("privacy-guard");
if (!guard) throw new Error("Owner workspace privacy guard is missing.");
if (await ensureLegacyWorkerRetired()) {
  const hasWorkerController = () => "serviceWorker" in navigator && navigator.serviceWorker.controller !== null;
  const queryClient = createWorkspaceQueryClient();
  const fixture = import.meta.env.DEV && import.meta.env.VITE_ELIOTR_FIXTURE === "true";
  const FixtureOutlet = import.meta.env.DEV
    ? lazy(() => import("./FixtureWorkspace").then(module => ({ default: module.FixtureWorkspace })))
    : undefined;
  const timers = { setTimeout: (callback: () => void, milliseconds: number) => window.setTimeout(callback, milliseconds), clearTimeout: (handle: unknown) => window.clearTimeout(handle as number) };
  const runtime = createWorkspaceRuntime({
    fetch: window.fetch.bind(window), baseUrl: window.location.origin, timers, now: Date.now,
    mint: () => window.crypto.randomUUID(),
    async sha256(bytes) {
      const digest = new Uint8Array(await window.crypto.subtle.digest("SHA-256", bytes.slice()));
      return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
    },
    isCurrent: context => privacy.isCurrent(context),
    onAuthorizationLoss() { privacy.close(); },
  });
  const privacy = createPrivacyController({
    now: Date.now,
    timers,
    mask() { container.hidden = true; container.inert = true; container.setAttribute("aria-hidden", "true"); guard.hidden = false; runtime.close(); },
    reveal() { if (hasWorkerController()) return; guard.hidden = true; container.hidden = false; container.inert = false; container.removeAttribute("aria-hidden"); },
    cancelReads() { void queryClient.cancelQueries(undefined, { revert: false, silent: true }).catch(() => {}); },
    clearProtected() { clearWorkspaceQueries(queryClient); },
    async verify(signal) {
      if (signal.aborted || hasWorkerController()) return undefined;
      if (!fixture) {
        const verified = await runtime.verify(signal);
        return signal.aborted || hasWorkerController() ? undefined : verified;
      }
      return { principal: "synthetic-owner", credentialGeneration: "fixture-only", deploymentGeneration: "fixture-only", expiresAt: "2027-01-01T00:00:00.000Z" };
    },
  });
  const unbindRuntime = privacy.subscribe(() => {
    const snapshot = privacy.getSnapshot();
    if (!fixture && snapshot.phase === "available") runtime.bind(snapshot.context);
  });
  const unbind = bindPrivacyLifecycle(privacy, window);
  const controllerChanged = () => { if (hasWorkerController()) privacy.close(); };
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
  const path = canonicalWorkspacePath(window.location);
  if (window.location.pathname !== path || window.location.search || window.location.hash) window.history.replaceState(null, "", path);

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}><BrowserRouter><Shell privacy={privacy} fixture={fixture} {...(FixtureOutlet ? { fixtureOutlet: FixtureOutlet } : {})} runtime={runtime} rememberPreferences /></BrowserRouter></QueryClientProvider>
    </React.StrictMode>,
  );
  if (import.meta.hot) import.meta.hot.dispose(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    unbindRuntime(); unbind(); privacy.dispose(); runtime.dispose(); root.unmount();
  });
  void privacy.refresh();
}
