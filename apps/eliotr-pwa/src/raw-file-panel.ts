import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import {
  captureRawFile,
  prepareRawFileSelection,
  readRawFileByIdempotency,
  RAW_FILE_MAX_BYTES,
  type RawFileCaptureReceipt,
  type RawFileSelection,
} from "./raw-file-api.js";

interface RawFilePanelHost {
  readonly generation: () => string | undefined;
  readonly ready: () => boolean;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function receiptCopy(receipt: RawFileCaptureReceipt, recovered: boolean): string {
  return `${recovered ? "Existing upload found" : "File saved"}. Waiting for processing before it can be searched.`;
}

export function mountRawFilePanel(element: HTMLElement, host: RawFilePanelHost): () => void {
  element.innerHTML = `<section class="raw-file-panel" aria-label="Upload a source file">
    <div class="tool-heading"><div><span class="eyebrow">Source intake</span><h2>Upload a source file</h2></div><span class="tool-badge">PRIVATE</span></div>
    <p>Select a PDF, document, image or text file to add to this workspace. Upload finishes first; processing and search readiness are separate.</p>
    <form>
      <label>Source file<input type="file" data-raw-file accept=".pdf,.doc,.docx,.html,.htm,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.svg,.gif,.bmp,application/pdf,text/plain,text/markdown,text/html,image/*" /></label>
      <div class="raw-file-actions"><button class="button button--primary" type="submit" data-raw-submit disabled>Upload file</button>
        <button class="button button--quiet" type="button" data-raw-recover disabled>Check upload status</button>
        <button class="button button--quiet" type="button" data-raw-stop hidden>Stop</button></div>
    </form>
    <p class="raw-file-limit">Up to ${formatBytes(RAW_FILE_MAX_BYTES)} per file in this browser session.</p>
    <p role="status" aria-live="polite" data-raw-status>Choose a file to begin.</p>
    <dl class="raw-file-receipt" data-raw-receipt hidden></dl>
  </section>`;
  const form = element.querySelector<HTMLFormElement>("form");
  const input = element.querySelector<HTMLInputElement>("[data-raw-file]");
  const submit = element.querySelector<HTMLButtonElement>("[data-raw-submit]");
  const recover = element.querySelector<HTMLButtonElement>("[data-raw-recover]");
  const stopButton = element.querySelector<HTMLButtonElement>("[data-raw-stop]");
  const status = element.querySelector<HTMLElement>("[data-raw-status]");
  const receiptNode = element.querySelector<HTMLElement>("[data-raw-receipt]");
  if (!form || !input || !submit || !recover || !stopButton || !status || !receiptNode) throw new Error("Raw file panel is incomplete");

  let serial = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  let busy = false;
  let selection: RawFileSelection | undefined;
  let receipt: RawFileCaptureReceipt | undefined;

  const renderReceipt = (value: RawFileCaptureReceipt, recovered: boolean): void => {
    receiptNode.hidden = false;
    receiptNode.innerHTML = `<dt>Status</dt><dd>${recovered ? "Recovered" : "Captured"}</dd>
      <dt>File</dt><dd>${escapeHtml(value.original_file_name)}</dd>
      <dt>Size</dt><dd>${formatBytes(value.size_bytes)}</dd>
      <dt>Captured</dt><dd>${value.captured_at}</dd>`;
  };
  const renderButtons = (): void => {
    const ready = host.ready() && host.generation() !== undefined;
    submit.disabled = busy || !selection || receipt !== undefined || !ready;
    recover.disabled = busy || !selection || !ready;
    input.disabled = busy;
    stopButton.hidden = !busy;
    stopButton.disabled = !busy;
  };
  const clear = (message: string): void => {
    serial++;
    controller?.abort();
    controller = undefined;
    busy = false;
    selection = undefined;
    receipt = undefined;
    input.value = "";
    receiptNode.hidden = true;
    receiptNode.replaceChildren();
    status.textContent = message;
    renderButtons();
  };
  const showError = (error: unknown): void => {
    if (error instanceof ApiRequestError) {
      status.textContent = error.status === 401 || error.status === 403
        ? "Authorization changed. Sign in again, then choose the file again."
        : `${error.code}: ${error.message}`;
      return;
    }
    status.textContent = "The file could not be captured. Check the same file again before starting another upload.";
  };
  const finish = (local: AbortController): void => {
    if (controller === local) { controller = undefined; busy = false; renderButtons(); }
  };
  const readback = async (current: RawFileSelection, generation: string, signal: AbortSignal): Promise<boolean> => {
    const found = await readRawFileByIdempotency(current, generation, signal);
    if (!found) return false;
    receipt = found;
    renderReceipt(found, true);
    status.textContent = receiptCopy(found, true);
    return true;
  };
  const run = (recoverOnly: boolean): void => {
    if (busy || !selection || !host.ready()) return;
    const generation = host.generation();
    if (!generation) { status.textContent = "The current deployment is still being checked."; return; }
    const current = selection;
    const active = ++serial;
    const local = new AbortController();
    controller = local;
    busy = true;
    renderButtons();
    status.textContent = recoverOnly ? "Checking the selected file's previous capture…" : "Capturing the selected file…";
    void (async () => {
      if (recoverOnly) {
        try {
          const found = await readback(current, generation, local.signal);
          if (!found) status.textContent = "No upload is recorded for this file yet. Uploading it will keep this same identity.";
        } catch (error) {
          if (active === serial && !disposed && !local.signal.aborted) showError(error);
        }
        return;
      }
      try {
        const captured = await captureRawFile(current, generation, local.signal);
        if (active !== serial || disposed) return;
        receipt = captured;
        renderReceipt(captured, false);
        status.textContent = receiptCopy(captured, false);
      } catch (error) {
        if (active !== serial || disposed) return;
        if (local.signal.aborted) {
          status.textContent = "Capture stopped. Check the previous outcome before trying again.";
          return;
        }
        if (error instanceof ApiRequestError && error.retryable) {
          status.textContent = "Capture outcome is unknown. Checking the same server identity…";
          try {
            const found = await readback(current, generation, local.signal);
            if (!found) status.textContent = "No receipt is available yet. Keep this file selected and check again; no replacement upload was created.";
          } catch (readError) {
            if (active === serial && !disposed) showError(readError);
          }
        } else showError(error);
      }
    })().finally(() => { if (active === serial && !disposed) finish(local); });
  };

  input.onchange = () => {
    serial++;
    controller?.abort();
    controller = undefined;
    busy = false;
    selection = undefined;
    receipt = undefined;
    receiptNode.hidden = true;
    receiptNode.replaceChildren();
    const file = input.files?.[0];
    if (!file) { status.textContent = "Choose a file to begin."; renderButtons(); return; }
    const active = serial;
    const local = new AbortController();
    controller = local;
    busy = true;
    renderButtons();
    status.textContent = "Checking file size and digest…";
    void prepareRawFileSelection(file, local.signal).then((prepared) => {
      if (active !== serial || disposed) return;
      selection = prepared;
      status.textContent = "Ready to capture. Re-selecting this same file can recover an uncertain outcome.";
    }).catch((error: unknown) => { if (active === serial && !disposed) showError(error); })
      .finally(() => { if (active === serial && !disposed) finish(local); });
  };
  form.onsubmit = (event) => { event.preventDefault(); run(false); };
  recover.onclick = () => run(true);
  stopButton.onclick = () => { if (!busy) return; serial++; controller?.abort(); controller = undefined; busy = false; status.textContent = "Capture stopped. Check the previous outcome before trying again."; renderButtons(); };
  const healthUpdated = () => renderButtons();
  const clearOnAuth = () => clear("Authorization changed. Private upload state cleared. Choose the file again.");
  const clearOnOffline = () => clear("Offline. Private upload state cleared; choose the file again when online.");
  const app = element.closest("#app");
  app?.addEventListener("eliotr:health-updated", healthUpdated);
  app?.addEventListener("eliotr:health-lost", clearOnAuth);
  window.addEventListener("eliotr:authorization-cleared", clearOnAuth);
  window.addEventListener("offline", clearOnOffline);
  window.addEventListener("pagehide", clearOnOffline);
  renderButtons();
  return () => {
    disposed = true;
    clear("Upload panel closed.");
    form.onsubmit = null; input.onchange = null; recover.onclick = null; stopButton.onclick = null;
    app?.removeEventListener("eliotr:health-updated", healthUpdated);
    app?.removeEventListener("eliotr:health-lost", clearOnAuth);
    window.removeEventListener("eliotr:authorization-cleared", clearOnAuth);
    window.removeEventListener("offline", clearOnOffline);
    window.removeEventListener("pagehide", clearOnOffline);
  };
}
