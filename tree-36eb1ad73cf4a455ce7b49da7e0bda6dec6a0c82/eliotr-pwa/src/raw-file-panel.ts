import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import {
  captureRawFile,
  convertRawFileToMarkdown,
  admitRawFileToLibrary,
  prepareRawFileSelection,
  readRawFileByIdempotency,
  RAW_FILE_MAX_BYTES,
  type RawFileCaptureReceipt,
  type RawFileSelection,
  type RawMarkdownConversionResult,
  type RawNormalizedAdmissionResult,
} from "./raw-file-api.js";

interface RawFilePanelHost {
  readonly generation: () => string | undefined;
  readonly ready: () => boolean;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function receiptCopy(recovered: boolean): string {
  return `${recovered ? "Existing upload found" : "File saved"}. Process it when ready; this does not admit or index the source.`;
}

function processingCopy(result: RawMarkdownConversionResult): string {
  if (result.state === "COMPLETE") return "Processed. The conversion is ready for the next Library step; admission and search readiness are separate.";
  if (result.state === "STARTED") return "Processing started. Check processing status again.";
  if (result.state === "UNKNOWN") return `Processing status is unknown (${result.failure_code}). Check processing status again.`;
  return `Processing failed (${result.failure_code}). The captured source is still available for another check.`;
}

function admissionCopy(result: RawNormalizedAdmissionResult): string {
  if (result.state === "COMMITTED") {
    return result.admission_receipt?.decision === "DUPLICATE"
      ? "This source is already in Library. Search readiness is reported separately."
      : "Added to Library. Search readiness is reported separately.";
  }
  if (result.state === "UNKNOWN") return "Library add status is unknown. Check Library status again.";
  return `Library add is ${result.state.toLowerCase()}. Check Library status again.`;
}

export function mountRawFilePanel(element: HTMLElement, host: RawFilePanelHost): () => void {
  element.innerHTML = `<section class="raw-file-panel" aria-label="Upload and process a source file">
    <div class="tool-heading"><div><span class="eyebrow">Source intake</span><h2>Upload a source file</h2></div><span class="tool-badge">PRIVATE</span></div>
    <p>Select a PDF, document, image or text file to save in this workspace. Upload, processing, admission and search readiness are separate states.</p>
    <form>
      <label>Source file<input type="file" data-raw-file accept=".pdf,.doc,.docx,.html,.htm,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.svg,.gif,.bmp,application/pdf,text/plain,text/markdown,text/html,image/*" /></label>
      <div class="raw-file-actions"><button class="button button--primary" type="submit" data-raw-submit disabled>Upload file</button>
        <button class="button button--quiet" type="button" data-raw-recover disabled>Check upload status</button>
        <button class="button button--quiet" type="button" data-raw-process hidden disabled>Process file</button>
        <button class="button button--quiet" type="button" data-raw-admit hidden disabled>Add to Library</button>
        <button class="button button--quiet" type="button" data-raw-stop hidden>Stop</button></div>
    </form>
    <p class="raw-file-limit">Up to ${formatBytes(RAW_FILE_MAX_BYTES)} per file in this browser session; processing accepts up to 8.0 MiB.</p>
    <p role="status" aria-live="polite" data-raw-status>Choose a file to begin.</p>
    <dl class="raw-file-receipt" data-raw-receipt hidden></dl>
    <dl class="raw-file-processing" data-raw-processing hidden></dl>
    <dl class="raw-file-admission" data-raw-admission hidden></dl>
  </section>`;
  const form = element.querySelector<HTMLFormElement>("form");
  const input = element.querySelector<HTMLInputElement>("[data-raw-file]");
  const submit = element.querySelector<HTMLButtonElement>("[data-raw-submit]");
  const recover = element.querySelector<HTMLButtonElement>("[data-raw-recover]");
  const process = element.querySelector<HTMLButtonElement>("[data-raw-process]");
  const admit = element.querySelector<HTMLButtonElement>("[data-raw-admit]");
  const stopButton = element.querySelector<HTMLButtonElement>("[data-raw-stop]");
  const status = element.querySelector<HTMLElement>("[data-raw-status]");
  const receiptNode = element.querySelector<HTMLElement>("[data-raw-receipt]");
  const processingNode = element.querySelector<HTMLElement>("[data-raw-processing]");
  const admissionNode = element.querySelector<HTMLElement>("[data-raw-admission]");
  if (!form || !input || !submit || !recover || !process || !admit || !stopButton || !status || !receiptNode || !processingNode || !admissionNode) {
    throw new Error("Raw file panel is incomplete");
  }

  let serial = 0;
  let controller: AbortController | undefined;
  let disposed = false;
  let busy = false;
  let selection: RawFileSelection | undefined;
  let receipt: RawFileCaptureReceipt | undefined;
  let conversion: RawMarkdownConversionResult | undefined;
  let processingOutcomeUnknown = false;
  let admission: RawNormalizedAdmissionResult | undefined;
  let admissionOutcomeUnknown = false;
  let lastGeneration = host.generation();

  const renderReceipt = (value: RawFileCaptureReceipt, recovered: boolean): void => {
    receiptNode.hidden = false;
    receiptNode.innerHTML = `<dt>Status</dt><dd>${recovered ? "Captured · recovered" : "Captured"}</dd>
      <dt>File</dt><dd>${escapeHtml(value.original_file_name)}</dd>
      <dt>Size</dt><dd>${formatBytes(value.size_bytes)}</dd>
      <dt>Capture</dt><dd>${escapeHtml(value.capture_id)}</dd>
      <dt>Digest</dt><dd>${escapeHtml(value.content_sha256)}</dd>
      <dt>Captured</dt><dd>${escapeHtml(value.captured_at)}</dd>`;
  };
  const renderProcessing = (value: RawMarkdownConversionResult | undefined): void => {
    processingNode.hidden = value === undefined;
    if (value === undefined) { processingNode.replaceChildren(); return; }
    if (value.state === "COMPLETE") {
      processingNode.innerHTML = `<dt>Processing</dt><dd>Complete · conversion ready</dd>
        <dt>Operation</dt><dd>${escapeHtml(value.operation_id)}</dd>
        <dt>Output</dt><dd>${escapeHtml(value.output_sha256 ?? "")} · ${formatBytes(value.output_bytes ?? 0)}</dd>
        <dt>Detected</dt><dd>${escapeHtml(value.detected_mime ?? "")} · ${escapeHtml(value.format ?? "")}</dd>
        <dt>Tokens</dt><dd>${String(value.tokens ?? 0)}</dd>
        <dt>Library</dt><dd>Not admitted or indexed by this result.</dd>`;
      return;
    }
    processingNode.innerHTML = `<dt>Processing</dt><dd>${escapeHtml(value.state)} · ${escapeHtml(value.failure_code ?? "pending")}</dd>
      <dt>Operation</dt><dd>${escapeHtml(value.operation_id)}</dd>
      <dt>Capture</dt><dd>${escapeHtml(value.capture_id)}</dd>
      <dt>Digest</dt><dd>${escapeHtml(value.content_sha256)}</dd>`;
  };
  const renderAdmission = (value: RawNormalizedAdmissionResult | undefined): void => {
    admissionNode.hidden = value === undefined;
    if (value === undefined) { admissionNode.replaceChildren(); return; }
    admissionNode.innerHTML = `<dt>Library</dt><dd>${escapeHtml(value.state)}</dd>
      <dt>Admission</dt><dd>${escapeHtml(value.admission_operation_id)}</dd>
      <dt>Candidate</dt><dd>${escapeHtml(value.candidate_ref)}</dd>
      <dt>Source revision</dt><dd>${escapeHtml(value.source_revision_ref)}</dd>
      <dt>Source view</dt><dd>${escapeHtml(value.source_view_ref)}</dd>
      <dt>Updated</dt><dd>${escapeHtml(value.updated_at)}</dd>
      <dt>Reason</dt><dd>${escapeHtml(value.reason_codes.join(", ") || "None recorded")}</dd>
      <dt>Readiness</dt><dd>Search readiness is not established by admission.</dd>`;
  };
  const renderButtons = (): void => {
    const ready = host.ready() && host.generation() !== undefined;
    submit.disabled = busy || !selection || receipt !== undefined || !ready;
    recover.disabled = busy || !selection || !ready;
    process.hidden = receipt === undefined;
    process.disabled = busy || receipt === undefined || !ready;
    process.textContent = processingOutcomeUnknown || conversion?.state === "STARTED" || conversion?.state === "UNKNOWN"
      ? "Check processing status" : "Process file";
    admit.hidden = conversion?.state !== "COMPLETE";
    admit.disabled = busy || conversion?.state !== "COMPLETE" || !ready;
    admit.textContent = admissionOutcomeUnknown || (admission !== undefined && admission.state !== "COMMITTED")
      ? "Check Library status" : "Add to Library";
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
    conversion = undefined;
    processingOutcomeUnknown = false;
    admission = undefined;
    admissionOutcomeUnknown = false;
    input.value = "";
    receiptNode.hidden = true;
    receiptNode.replaceChildren();
    processingNode.hidden = true;
    processingNode.replaceChildren();
    admissionNode.hidden = true;
    admissionNode.replaceChildren();
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
    status.textContent = "The request was interrupted. Keep this file selected and check again before starting a new identity.";
  };
  const finish = (local: AbortController): void => {
    if (controller === local) { controller = undefined; busy = false; renderButtons(); }
  };
  const readback = async (current: RawFileSelection, generation: string, signal: AbortSignal, isCurrent: () => boolean): Promise<boolean> => {
    const found = await readRawFileByIdempotency(current, generation, signal);
    if (!found || !isCurrent()) return false;
    receipt = found;
    renderReceipt(found, true);
    status.textContent = receiptCopy(true);
    return true;
  };
  const runCapture = (recoverOnly: boolean): void => {
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
          const currentRequest = () => active === serial && !disposed && !local.signal.aborted;
          const found = await readback(current, generation, local.signal, currentRequest);
          if (currentRequest() && !found) status.textContent = "No upload is recorded for this file yet. Uploading it will keep this same identity.";
        } catch (error) {
          if (active === serial && !disposed && !local.signal.aborted) {
            if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") {
              clear("Application changed. Private upload and processing state cleared; choose the file again.");
            } else showError(error);
          }
        }
        return;
      }
      try {
        const captured = await captureRawFile(current, generation, local.signal);
        if (active !== serial || disposed) return;
        receipt = captured;
        conversion = undefined;
        processingOutcomeUnknown = false;
        admission = undefined;
        admissionOutcomeUnknown = false;
        renderReceipt(captured, false);
        status.textContent = receiptCopy(false);
      } catch (error) {
        if (active !== serial || disposed) return;
        if (local.signal.aborted) {
          status.textContent = "Capture stopped. Check the previous outcome before trying again.";
          return;
        }
        if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") {
          clear("Application changed. Private upload and processing state cleared; choose the file again.");
          return;
        }
        if (error instanceof ApiRequestError && error.retryable) {
          status.textContent = "Capture outcome is unknown. Checking the same server identity…";
          try {
            const currentRequest = () => active === serial && !disposed && !local.signal.aborted;
            const found = await readback(current, generation, local.signal, currentRequest);
            if (currentRequest() && !found) status.textContent = "No receipt is available yet. Keep this file selected and check again; no replacement upload was created.";
          } catch (readError) {
            if (active === serial && !disposed) showError(readError);
          }
        } else showError(error);
      }
    })().finally(() => { if (active === serial && !disposed) finish(local); });
  };
  const runProcess = (): void => {
    if (busy || !receipt || !host.ready()) return;
    const generation = host.generation();
    if (!generation) { status.textContent = "The current deployment is still being checked."; return; }
    const current = receipt;
    const active = ++serial;
    const local = new AbortController();
    controller = local;
    // A new processing attempt supersedes any prior conversion/admission
    // display. Until this request settles, the UI must not offer Library add
    // against an older COMPLETE result after Stop or a late response.
    conversion = undefined;
    admission = undefined;
    admissionOutcomeUnknown = false;
    renderProcessing(undefined);
    renderAdmission(undefined);
    busy = true;
    renderButtons();
    status.textContent = processingOutcomeUnknown ? "Checking processing status…" : "Processing the captured file…";
    void (async () => {
      try {
        const result = await convertRawFileToMarkdown(current, generation, local.signal);
        if (active !== serial || disposed) return;
        conversion = result;
        processingOutcomeUnknown = false;
        admission = undefined;
        admissionOutcomeUnknown = false;
        renderProcessing(result);
        renderAdmission(undefined);
        status.textContent = processingCopy(result);
      } catch (error) {
        if (active !== serial || disposed) return;
        if (local.signal.aborted) {
          processingOutcomeUnknown = true;
          status.textContent = "Processing stopped. Check processing status again before starting another request.";
          return;
        }
        if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") {
          clear("Application changed. Private upload and processing state cleared; choose the file again.");
          return;
        }
        if (error instanceof ApiRequestError && error.retryable) {
          processingOutcomeUnknown = true;
          status.textContent = "Processing status is unknown. Check processing status again.";
        } else showError(error);
      }
    })().finally(() => { if (active === serial && !disposed) finish(local); });
  };
  const runAdmission = (): void => {
    if (busy || !receipt || !conversion || conversion.state !== "COMPLETE" || !host.ready()) return;
    const generation = host.generation();
    if (!generation) { status.textContent = "The current deployment is still being checked."; return; }
    const currentReceipt = receipt;
    const currentConversion = conversion;
    const active = ++serial;
    const local = new AbortController();
    controller = local;
    busy = true;
    renderButtons();
    status.textContent = admissionOutcomeUnknown ? "Checking Library status…" : "Adding the processed file to Library…";
    void (async () => {
      try {
        const result = await admitRawFileToLibrary(currentReceipt, currentConversion, generation, local.signal);
        if (active !== serial || disposed) return;
        admission = result;
        admissionOutcomeUnknown = false;
        renderAdmission(result);
        status.textContent = admissionCopy(result);
        if (result.state === "COMMITTED") window.dispatchEvent(new Event("eliotr:raw-admission-completed"));
      } catch (error) {
        if (active !== serial || disposed) return;
        if (local.signal.aborted) {
          admissionOutcomeUnknown = true;
          status.textContent = "Library add stopped. Check Library status again before starting another request.";
          return;
        }
        if (error instanceof ApiRequestError && error.code === "API_GENERATION_MISMATCH") {
          clear("Application changed. Private upload and processing state cleared; choose the file again.");
          return;
        }
        if (error instanceof ApiRequestError && error.retryable) {
          admissionOutcomeUnknown = true;
          status.textContent = "Library add status is unknown. Check Library status again.";
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
    conversion = undefined;
    processingOutcomeUnknown = false;
    admission = undefined;
    admissionOutcomeUnknown = false;
    receiptNode.hidden = true;
    receiptNode.replaceChildren();
    renderProcessing(undefined);
    renderAdmission(undefined);
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
      status.textContent = "Ready to capture. Re-selecting this same file can recover its saved capture.";
    }).catch((error: unknown) => { if (active === serial && !disposed) showError(error); })
      .finally(() => { if (active === serial && !disposed) finish(local); });
  };
  form.onsubmit = (event) => { event.preventDefault(); runCapture(false); };
  recover.onclick = () => runCapture(true);
  process.onclick = () => runProcess();
  admit.onclick = () => runAdmission();
  stopButton.onclick = () => {
    if (!busy) return;
    serial++;
    controller?.abort();
    controller = undefined;
    busy = false;
    status.textContent = receipt === undefined
      ? "Capture stopped. Check the previous outcome before trying again."
      : "Processing stopped. Check processing status again before starting another request.";
    if (receipt !== undefined) processingOutcomeUnknown = true;
    renderButtons();
  };
  const healthUpdated = () => {
    const generation = host.generation();
    if (lastGeneration !== undefined && generation !== lastGeneration) {
      clear("Application changed. Private upload and processing state cleared; choose the file again.");
    }
    lastGeneration = generation;
    renderButtons();
  };
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
    form.onsubmit = null; input.onchange = null; recover.onclick = null; process.onclick = null; admit.onclick = null; stopButton.onclick = null;
    app?.removeEventListener("eliotr:health-updated", healthUpdated);
    app?.removeEventListener("eliotr:health-lost", clearOnAuth);
    window.removeEventListener("eliotr:authorization-cleared", clearOnAuth);
    window.removeEventListener("offline", clearOnOffline);
    window.removeEventListener("pagehide", clearOnOffline);
  };
}
