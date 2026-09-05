import { ApiRequestError } from "./api.js";
import { prepareBrowserBundle, selectedBundleFiles } from "./bundle-input.js";
import { createBrowserBundleImport, discoverBrowserBundleImport, recoverBrowserBundleImport, type BrowserBundleImport } from "./bundle-import.js";
import { readImportStatus, type ImportIdentity } from "./bundle-import-api.js";

export function mountBundleImportPanel(element: HTMLElement): () => void {
  element.innerHTML = `<details><summary>Import normalized source bundle</summary>
    <p>Choose an already normalized folder with manifest.json, content.md and hashes.sha256.
    Raw PDF/OCR conversion is not performed here. Initialize the namespace and admission policy explicitly with the local owner command.</p>
    <p>Browser profile: 64 files, 16 MiB per file, 32 MiB total. Admission does not grant read access or prove index readiness.</p>
    <form><label>Bundle folder<input name="bundle" type="file" webkitdirectory multiple required></label>
    <label>Existing operation ID (recovery only)<input name="recovery" type="text" maxlength="256" autocomplete="off"
      placeholder="Leave empty for a new import"></label>
    <button type="submit">Validate and import / recover</button><button type="button" data-stop disabled>Stop sending</button>
    <button type="button" data-resume disabled>Resume same upload</button>
    <button type="button" data-discover>Find previous upload from folder</button>
    <button type="button" data-status disabled>Check durable status</button></form>
    <p>Keep the operation ID shown below. After reload or sign-in, reselect the exact original folder and enter that ID.
    Lost the ID? Reselect the original folder and use Find previous upload, then Resume.
    Discovery never creates a new operation. Recovery reads current server state; it does not save source bytes or credentials in browser storage.
    Completed files are verified, unfinished files resend their original parts. Do not create a new operation for an uncertain result.</p>
    <p role="status" aria-live="polite"></p><p data-identity></p></details>`;
  const form = element.querySelector("form"); const input = element.querySelector<HTMLInputElement>('input[name="bundle"]');
  const recovery = element.querySelector<HTMLInputElement>('input[name="recovery"]');
  const start = element.querySelector<HTMLButtonElement>('[type="submit"]'); const stopButton = element.querySelector<HTMLButtonElement>("[data-stop]");
  const resume = element.querySelector<HTMLButtonElement>("[data-resume]");
  const discover = element.querySelector<HTMLButtonElement>("[data-discover]");
  const inspect = element.querySelector<HTMLButtonElement>("[data-status]"); const status = element.querySelector('[role="status"]');
  const identityText = element.querySelector("[data-identity]");
  if (!form || !input || !recovery || !start || !stopButton || !resume || !discover || !inspect || !status || !identityText) throw new Error("Import panel is incomplete");
  let serial = 0; let controller: AbortController | undefined; let identity: ImportIdentity | undefined;
  let attempt: BrowserBundleImport | undefined; let busy = false; let key = crypto.randomUUID();
  const buttons = () => { start.disabled = busy || attempt !== undefined; resume.disabled = busy || !attempt?.canResume;
    discover.disabled = busy || attempt !== undefined;
    stopButton.disabled = !busy; input.disabled = busy; recovery.disabled = busy; inspect.disabled = busy || identity === undefined; };
  const stop = () => { ++serial; controller?.abort(); stopButton.disabled = true; };
  const message = (error: unknown) => error instanceof ApiRequestError
    ? `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}`
    : "Import interrupted. Resume checks durable status first; no mutation was retried automatically.";
  const reset = () => { stop(); attempt?.dispose(); attempt = undefined; identity = undefined; identityText.textContent = "";
    key = crypto.randomUUID(); buttons(); status.textContent = "Ready to validate. No upload has started."; };
  input.onchange = reset; recovery.onchange = reset;
  stopButton.onclick = () => { stop(); status.textContent = "Stopped sending. Already sent requests may have completed. Resume only after the current request settles; this is not rollback."; };
  const finish = (local: AbortController) => { if (controller === local) { controller = undefined; busy = false; buttons(); } };
  const run = (continuation: boolean) => {
    if (busy || (continuation ? !attempt?.canResume : attempt !== undefined)) return;
    if (!navigator.onLine) { status.textContent = "Offline. No upload attempted."; return; }
    const active = ++serial; const local = new AbortController(); controller = local; busy = true; buttons();
    status.textContent = continuation ? "Checking the same upload before continuation…" : "Validating and freezing selected bytes…";
    void (async () => {
      if (!continuation) {
        const bundle = await prepareBrowserBundle(selectedBundleFiles(Array.from(input.files ?? [])), local.signal);
        if (active !== serial) return;
        const restored = recovery.value.trim();
        const next = restored ? await recoverBrowserBundleImport(bundle, restored, { signal: local.signal })
          : createBrowserBundleImport(bundle, key);
        if (active !== serial) { next.dispose(); return; }
        attempt = next;
      }
      if (!attempt) return;
      const receipt = await attempt.run({ signal: local.signal,
        onIdentity: (value) => { if (active === serial) { identity = value; identityText.textContent = `Operation: ${value.operation} · Keep this ID to recover after reload.`; } },
        onProgress: (value) => { if (active === serial) status.textContent = `${value.phase} · ${value.bytes}/${value.total} acknowledged bytes`; },
      });
      if (active === serial && receipt) status.textContent = `${receipt.decision}: ${receipt.source_revision_ref}. Search readiness and read-policy access are separate.`;
    })().catch((error: unknown) => { if (active === serial) {
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) clearPrivate();
      status.textContent = message(error);
    } }).finally(() => finish(local));
  };
  form.onsubmit = (event) => { event.preventDefault(); run(false); };
  resume.onclick = () => run(true);
  discover.onclick = () => {
    if (busy || attempt) return;
    if (!navigator.onLine) { status.textContent = "Offline. No discovery attempted."; return; }
    const active = ++serial; const local = new AbortController(); controller = local; busy = true; buttons();
    status.textContent = "Validating selected bytes and looking up the original upload…";
    void (async () => {
      const bundle = await prepareBrowserBundle(selectedBundleFiles(Array.from(input.files ?? [])), local.signal);
      if (active !== serial) return;
      const found = await discoverBrowserBundleImport(bundle, { signal: local.signal });
      if (active !== serial) { found.attempt.dispose(); return; }
      attempt = found.attempt; identity = found.identity; recovery.value = identity.operation;
      identityText.textContent = `Operation: ${identity.operation} · Existing reservation, not a new import.`;
      status.textContent = "Previous upload found. No upload or commit was sent. Resume explicitly to reconcile or continue it.";
    })().catch((error: unknown) => { if (active === serial) {
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) clearPrivate();
      status.textContent = error instanceof ApiRequestError && error.code === "INGEST_OPERATION_NOT_FOUND"
        ? "No matching upload is available to this signed-in user. Nothing was created. Check the original folder and account before starting a new import."
        : message(error);
    } }).finally(() => finish(local));
  };
  inspect.onclick = () => {
    if (!identity || busy) return;
    const active = ++serial; const local = new AbortController(); controller = local; busy = true; buttons();
    void readImportStatus(identity, local.signal).then((value) => {
      if (active !== serial) return;
      if (value.receipt || ["REJECTED", "QUARANTINED"].includes(value.state)) attempt?.dispose();
      status.textContent = `${value.state}${value.receipt ? ` · ${value.receipt.decision}` : " · no terminal receipt"}. Index readiness is separate.`;
    }).catch((error: unknown) => { if (active === serial) {
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) clearPrivate();
      status.textContent = message(error);
    } }).finally(() => finish(local));
  };
  const clearPrivate = () => { stop(); attempt?.dispose(); attempt = undefined; identity = undefined; identityText.textContent = "";
    controller = undefined; busy = false; input.value = ""; recovery.value = ""; key = crypto.randomUUID(); buttons();
    status.textContent = "Session interrupted. Private import state cleared. Reselect the original folder and find the previous upload or enter its operation ID."; };
  window.addEventListener("eliotr:authorization-cleared", clearPrivate);
  window.addEventListener("offline", clearPrivate); window.addEventListener("pagehide", clearPrivate);
  return () => { clearPrivate(); window.removeEventListener("eliotr:authorization-cleared", clearPrivate);
    window.removeEventListener("offline", clearPrivate); window.removeEventListener("pagehide", clearPrivate); };
}
