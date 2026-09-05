import { ApiRequestError } from "./api.js";
import { prepareBrowserBundle, selectedBundleFiles } from "./bundle-input.js";
import { importBrowserBundle } from "./bundle-import.js";
import { readImportStatus, type ImportIdentity } from "./bundle-import-api.js";

export function mountBundleImportPanel(element: HTMLElement): () => void {
  element.innerHTML = `<details><summary>Import normalized source bundle</summary>
    <p>Choose an already normalized folder with manifest.json, content.md and hashes.sha256.
    Raw PDF/OCR conversion is not performed here. The namespace and admission policy must already exist.</p>
    <p>Browser profile: 64 files, 16 MiB per file, 32 MiB total. Admission does not grant read access or prove index readiness.</p>
    <form><label>Bundle folder<input name="bundle" type="file" webkitdirectory multiple required></label>
    <button type="submit">Validate and import</button><button type="button" data-stop disabled>Stop sending</button>
    <button type="button" data-status disabled>Check durable status</button></form>
    <p role="status" aria-live="polite"></p><p data-identity></p></details>`;
  const form = element.querySelector("form"); const input = element.querySelector<HTMLInputElement>("input");
  const start = element.querySelector<HTMLButtonElement>('[type="submit"]'); const stopButton = element.querySelector<HTMLButtonElement>("[data-stop]");
  const inspect = element.querySelector<HTMLButtonElement>("[data-status]"); const status = element.querySelector('[role="status"]');
  const identityText = element.querySelector("[data-identity]");
  if (!form || !input || !start || !stopButton || !inspect || !status || !identityText) throw new Error("Import panel is incomplete");
  let serial = 0; let controller: AbortController | undefined; let identity: ImportIdentity | undefined;
  let attempted = false; let key = crypto.randomUUID();
  const stop = () => { ++serial; controller?.abort(); stopButton.disabled = true; input.disabled = false; };
  const message = (error: unknown) => error instanceof ApiRequestError
    ? `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}` : "Import failed. Inspect durable status before starting another upload.";
  const reset = () => { stop(); identity = undefined; identityText.textContent = ""; attempted = false;
    key = crypto.randomUUID(); start.disabled = false; inspect.disabled = true; status.textContent = "Ready to validate. No upload has started."; };
  input.onchange = reset;
  stopButton.onclick = () => { stop(); start.disabled = attempted; status.textContent = "Stopped sending. Sent requests may have completed. Check durable status; this is not server-side rollback.";
    inspect.disabled = identity === undefined; };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (attempted) return;
    if (!navigator.onLine) { status.textContent = "Offline. No upload attempted."; return; }
    stop(); const active = ++serial; controller = new AbortController();
    start.disabled = true; stopButton.disabled = false; input.disabled = true; status.textContent = "Validating and freezing selected bytes…";
    const signal = controller.signal;
    void (async () => {
      const bundle = await prepareBrowserBundle(selectedBundleFiles(Array.from(input.files ?? [])), signal);
      if (active !== serial) return;
      attempted = true;
      const receipt = await importBrowserBundle(bundle, key, { signal,
        onIdentity: (value) => { if (active === serial) { identity = value; identityText.textContent = `Operation: ${value.operation}`; } },
        onProgress: (value) => { if (active === serial) status.textContent = `${value.phase} · ${value.bytes}/${value.total} bytes`; },
      });
      if (active !== serial) return;
      if (receipt) status.textContent = `${receipt.decision}: ${receipt.source_revision_ref}. Search readiness and read-policy access are separate.`;
    })().catch((error: unknown) => { if (active === serial) {
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) clearPrivate();
      status.textContent = message(error);
    } })
      .finally(() => { if (active === serial) { input.disabled = false; stopButton.disabled = true;
        start.disabled = attempted; inspect.disabled = identity === undefined; } });
  };
  inspect.onclick = () => {
    if (!identity) return;
    stop(); const active = ++serial; controller = new AbortController(); inspect.disabled = true;
    void readImportStatus(identity, controller.signal).then((value) => {
      if (active === serial) status.textContent = `${value.state}${value.receipt ? ` · ${value.receipt.decision}` : " · no terminal receipt"}. Index readiness is separate.`;
    }).catch((error: unknown) => { if (active === serial) { status.textContent = message(error);
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) { identity = undefined; identityText.textContent = ""; } } })
      .finally(() => { if (active === serial) inspect.disabled = identity === undefined; });
  };
  const clearPrivate = () => { stop(); identity = undefined; identityText.textContent = ""; inspect.disabled = true;
    input.value = ""; attempted = false; start.disabled = false; status.textContent = "Session interrupted. Private import state cleared; inspect the saved operation before retrying."; };
  window.addEventListener("offline", clearPrivate); window.addEventListener("pagehide", clearPrivate);
  return () => { stop(); window.removeEventListener("offline", clearPrivate); window.removeEventListener("pagehide", clearPrivate); };
}
