import type { EvidenceHandle } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { readAdmittedDocument, type AdmittedDocument } from "./document-reader-api.js";
import { escapeHtml } from "./html.js";
import {
  expandNavigation,
  type NavigationExpansionResult,
  type NavigationSection,
} from "./navigation-expand-api.js";
import {
  orientSources, orientationBody, readOrientationTrace, type OrientationView,
} from "./orientation-api.js";

export function renderOrientation(view: OrientationView): string {
  return `<p>Choose a source below to read its admitted document. ${view.cards.length} represented; ${view.omitted} omitted.</p>
    ${view.cards.map((card, index) => { const map = view.maps.find((candidate) => candidate.source_revision_ref === card.source_revision_ref); return `<article class="source-card"><h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.quality_status)}</p>
      <button class="button button--quiet" type="button" data-read-document="${index}">Read document</button>
      ${map === undefined ? `<p>Sections are unavailable for this source.</p>` : `<button class="button button--quiet" type="button" data-expand-map="${index}">Expand sections</button><div data-navigation-expansion="${index}" aria-live="polite"></div>`}
      <details class="source-details"><summary>Source details</summary><div class="health-details-content">
        <span>Source type: ${escapeHtml(card.source_kind)}</span><span>Revision: <code>${escapeHtml(card.source_revision_ref)}</code></span>
        <span>Reason codes: ${escapeHtml(view.maps.find((map) => map.source_revision_ref === card.source_revision_ref)?.unresolved_structure.join(", ") ?? "DOCUMENT_MAP_MISSING")}</span>
      </div></details></article>`; }).join("")}
    <details class="orientation-technical-details"><summary>Technical details</summary>
      <p><strong>Navigation only.</strong> This view shows source metadata and does not provide citation evidence, full document structure, or research synthesis.</p>
      <p>Scope: <code>${escapeHtml(view.scope.id)}</code></p><p>Trace: <code>${escapeHtml(view.trace.id)}</code></p>
      <button type="button" data-trace>Inspect trace</button>
    </details>`;
}

function textElement(tag: string, value: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  element.textContent = value;
  return element;
}

function renderNavigationExpansion(
  expansion: NavigationExpansionResult,
  inspectSection: (section: NavigationSection, button: HTMLButtonElement) => void,
  openEvidence: (handle: EvidenceHandle, button: HTMLButtonElement) => void,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "navigation-expansion";
  if (expansion.kind === "DOCUMENT_MAP") {
    panel.append(
      textElement("h4", "Document sections"),
      textElement("p", `${expansion.sections.length} section${expansion.sections.length === 1 ? "" : "s"} available for navigation.`),
    );
    const list = document.createElement("div");
    list.className = "navigation-section-list";
    for (const section of expansion.sections) {
      const item = document.createElement("article");
      item.className = "navigation-section";
      const title = textElement("h5", section.label);
      const ref = textElement("code", section.section_ref);
      const button = document.createElement("button");
      button.type = "button"; button.className = "button button--quiet"; button.textContent = "Inspect section";
      button.addEventListener("click", () => inspectSection(section, button));
      item.append(title, ref, button); list.append(item);
    }
    panel.append(list);
    return panel;
  }
  if (expansion.kind === "SECTION") {
    panel.append(textElement("h4", expansion.section.label), textElement("code", expansion.section.section_ref));
    if (expansion.evidence_handle !== undefined) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "button button--quiet"; button.textContent = "Open exact evidence";
      button.addEventListener("click", () => openEvidence(expansion.evidence_handle as EvidenceHandle, button));
      panel.append(textElement("p", "An exact evidence handle is available and will be verified in the Evidence rail."), button);
    } else {
      panel.append(textElement("p", "Navigation only. Exact evidence is unavailable for this section."));
    }
    return panel;
  }
  if (expansion.kind === "SOURCE_CARD") {
    panel.append(textElement("h4", expansion.source_card.title), textElement("p", "Source card loaded. Expand its document map to browse sections."));
    return panel;
  }
  panel.append(textElement("h4", expansion.node.label), textElement("p", `${expansion.source_revision_refs.length} source reference${expansion.source_revision_refs.length === 1 ? "" : "s"} in this navigation node.`));
  return panel;
}
export function mountOrientationPanel(element: HTMLElement): (() => void) & { selectSource(id: string): Promise<boolean> } {
  element.innerHTML = `<h2>Read admitted documents</h2><p>Choose a source to read its admitted text.</p>
    <details class="orientation-advanced-selection"><summary>Advanced selection</summary>
      <form><label>Source IDs (optional, separated by commas)<input name="sources" maxlength="16000" autocomplete="off" placeholder="Blank: authorized library, at most 64 sources"></label>
      <label>Focus (metadata only)<input name="focus" maxlength="256" autocomplete="off"></label>
      <button type="submit">Load sources</button><button type="button" data-cancel disabled>Cancel</button></form>
    </details>
    <details class="orientation-technical-details"><summary>About this view</summary><p>Corpus Lens is navigation metadata only. It does not provide citation evidence, full document structure, or research synthesis.</p></details>
    <p role="status" aria-live="polite"></p><section data-result></section>
    <section class="document-reader" data-document-reader hidden aria-labelledby="document-reader-title">
      <div class="document-reader-heading"><div><span class="eyebrow">Admitted document</span><h3 id="document-reader-title">Document</h3></div><span data-document-reader-size></span></div>
      <p data-document-reader-status role="status" aria-live="polite"></p>
      <pre class="document-reader-body" data-document-reader-body tabindex="0"></pre>
      <div class="document-reader-actions"><button class="button button--quiet" type="button" data-close-document>Close</button><button class="button button--quiet" type="button" data-download-document hidden>Download</button></div>
    </section><details class="orientation-trace-output" data-trace-details hidden><summary>Trace output</summary><pre data-trace-result hidden></pre></details>`;
  const form = element.querySelector("form"); const status = element.querySelector('[role="status"]');
  const result = element.querySelector("[data-result]"); const traceResult = element.querySelector<HTMLPreElement>("[data-trace-result]");
  const traceDetails = element.querySelector<HTMLDetailsElement>("[data-trace-details]");
  const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]");
  const documentReader = element.querySelector<HTMLElement>("[data-document-reader]");
  const documentTitle = element.querySelector<HTMLElement>("#document-reader-title");
  const documentSize = element.querySelector<HTMLElement>("[data-document-reader-size]");
  const documentStatus = element.querySelector<HTMLElement>("[data-document-reader-status]");
  const documentBody = element.querySelector<HTMLPreElement>("[data-document-reader-body]");
  const closeDocument = element.querySelector<HTMLButtonElement>("[data-close-document]");
  const downloadDocument = element.querySelector<HTMLButtonElement>("[data-download-document]");
  if (!form || !status || !result || !traceResult || !traceDetails || !cancel || !documentReader || !documentTitle || !documentSize ||
      !documentStatus || !documentBody || !closeDocument || !downloadDocument) throw new Error("Corpus Lens panel is incomplete");
  let controller: AbortController | undefined; let active = 0; let key = ""; let previous = "";
  let readerController: AbortController | undefined; let readerSerial = 0;
  let navigationController: AbortController | undefined; let navigationSerial = 0;
  let openedDocument: AdmittedDocument | undefined; let downloadUrl: string | undefined;
  let lastReadButton: HTMLButtonElement | undefined;
  let pendingSelection: Promise<boolean> = Promise.resolve(true);
  const errorText = (error: unknown) => error instanceof ApiRequestError
    ? `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}${error.retryable ? " · Retry preserves the operation identity." : ""}`
    : "Unable to read Corpus Lens. Check the inputs and session.";
  const documentErrorText = (error: unknown): string => {
    if (error instanceof ApiRequestError) {
      if (error.status === 401 || error.status === 403) return "Document access changed. Refresh the Library.";
      if (error.status === 404) return "This document is no longer available in the Library.";
      if (error.status === 409) return "The selected document changed. Refresh the Library.";
    }
    return "The document could not be read right now. Try again.";
  };
  const formatBytes = (bytes: number): string => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  const downloadName = (title: string): string => {
    const safe = title.replace(/[^A-Za-z0-9._ -]/gu, "_").trim().slice(0, 80);
    const extension = /\.txt$/iu.test(safe) ? ".txt" : ".md";
    let stem = safe;
    while (/\.(?:md|markdown|txt)$/iu.test(stem)) stem = stem.replace(/\.(?:md|markdown|txt)$/iu, "").trim();
    return `${stem || "admitted-document"}${extension}`;
  };
  const clearReader = (message = ""): void => {
    readerSerial += 1; readerController?.abort(); readerController = undefined; openedDocument = undefined;
    const button = lastReadButton; lastReadButton = undefined; if (button) button.disabled = false;
    if (downloadUrl !== undefined) { URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; }
    documentReader.hidden = true; documentTitle.textContent = "Document"; documentSize.textContent = "";
    documentStatus.textContent = message; documentBody.textContent = ""; downloadDocument.hidden = true;
  };
  const stop = () => {
    active += 1; navigationSerial += 1; controller?.abort(); navigationController?.abort();
    controller = undefined; navigationController = undefined; clearReader(); traceDetails.hidden = true; traceDetails.open = false; cancel.disabled = true;
  };
  const clearPrivateOrientation = (): void => {
    stop(); key = ""; previous = ""; result.replaceChildren(); traceResult.textContent = ""; traceResult.hidden = true;
    traceDetails.hidden = true; traceDetails.open = false; status.textContent = "Access changed; reload sources.";
  };
  const readDocument = (view: OrientationView, cardIndex: number, button: HTMLButtonElement): void => {
    const card = view.cards[cardIndex];
    if (card === undefined || readerController !== undefined || active < 1 || disposed) return;
    clearReader();
    const local = new AbortController(); readerController = local; const mine = readerSerial;
    lastReadButton = button; button.disabled = true; documentReader.hidden = false;
    documentTitle.textContent = card.title; documentStatus.textContent = "Reading admitted document…";
    void readAdmittedDocument(card.source_revision_ref, view.generation, local.signal)
      .then((document) => {
        if (mine !== readerSerial || local.signal.aborted || disposed) return;
        openedDocument = document; documentBody.textContent = document.text;
        documentSize.textContent = formatBytes(document.sizeBytes);
        documentStatus.textContent = "Normalized text loaded from the admitted document.";
        downloadDocument.hidden = false; documentReader.scrollIntoView({ block: "start" }); documentBody.focus({ preventScroll: true });
      })
      .catch((error: unknown) => {
        if (mine !== readerSerial || disposed) return;
        documentBody.textContent = ""; documentSize.textContent = ""; downloadDocument.hidden = true;
        documentStatus.textContent = documentErrorText(error);
      })
      .finally(() => {
        if (mine === readerSerial) { readerController = undefined; button.disabled = false; }
      });
  };
  const dispatchEvidence = (handle: EvidenceHandle, button: HTMLButtonElement): void => {
    button.disabled = true;
    const eventTarget = document.querySelector<HTMLElement>("#research-run") ?? element;
    eventTarget.dispatchEvent(new CustomEvent("research:evidence-selected", {
      bubbles: true,
      detail: { scopeSnapshotRef: handle.scope_snapshot_ref, handleRef: handle.handle_ref, excerptSha256: handle.excerpt_sha256 },
    }));
  };
  const inspectSection = (
    view: OrientationView,
    section: NavigationSection,
    output: HTMLElement,
    button: HTMLButtonElement,
    selectionSerial: number,
  ): void => {
    if (disposed || selectionSerial !== active || !navigator.onLine) {
      if (!navigator.onLine) status.textContent = "Offline. Reconnect before expanding sections.";
      return;
    }
    navigationController?.abort();
    const local = new AbortController(); const mine = ++navigationSerial; navigationController = local;
    button.disabled = true; output.replaceChildren(textElement("p", "Reading the selected section…"));
    status.textContent = "Reading the selected section…";
    void expandNavigation(view, {
      kind: "SECTION", sourceRevisionRef: section.source_revision_ref, sectionRef: section.section_ref,
    }, local.signal)
      .then((expansion) => {
        if (mine !== navigationSerial || selectionSerial !== active || local.signal.aborted || disposed) return;
        output.replaceChildren(renderNavigationExpansion(expansion, () => undefined, dispatchEvidence));
        status.textContent = expansion.kind === "SECTION" && expansion.evidence_handle !== undefined
          ? "Section loaded. Exact evidence is ready for verification." : "Section loaded. Navigation only.";
      })
      .catch((error: unknown) => {
        if (mine !== navigationSerial || selectionSerial !== active || local.signal.aborted || disposed) return;
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          clearPrivateOrientation();
          return;
        }
        output.replaceChildren(textElement("p", errorText(error), "navigation-expansion-error"));
        status.textContent = "The section could not be expanded. Retry while the source view is current.";
      })
      .finally(() => {
        if (mine === navigationSerial) { navigationController = undefined; button.disabled = false; }
      });
  };
  const expandMap = (view: OrientationView, cardIndex: number, button: HTMLButtonElement, selectionSerial: number): void => {
    const card = view.cards[cardIndex];
    const map = card === undefined ? undefined : view.maps.find((candidate) => candidate.source_revision_ref === card.source_revision_ref);
    const output = result.querySelector<HTMLElement>(`[data-navigation-expansion="${cardIndex}"]`);
    if (map === undefined || output === null || disposed || selectionSerial !== active) return;
    if (!navigator.onLine) { status.textContent = "Offline. Reconnect before expanding sections."; return; }
    navigationController?.abort();
    const local = new AbortController(); const mine = ++navigationSerial; navigationController = local;
    button.disabled = true; output.replaceChildren(textElement("p", "Loading current document sections…"));
    status.textContent = "Loading current document sections…";
    void expandNavigation(view, { kind: "DOCUMENT_MAP", sourceRevisionRef: map.source_revision_ref }, local.signal)
      .then((expansion) => {
        if (mine !== navigationSerial || selectionSerial !== active || local.signal.aborted || disposed) return;
        output.replaceChildren(renderNavigationExpansion(expansion,
          (section, sectionButton) => inspectSection(view, section, output, sectionButton, selectionSerial), dispatchEvidence));
        status.textContent = expansion.kind === "DOCUMENT_MAP"
          ? "Sections loaded. Choose a section to inspect its exact evidence availability." : "Navigation expanded.";
      })
      .catch((error: unknown) => {
        if (mine !== navigationSerial || selectionSerial !== active || local.signal.aborted || disposed) return;
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
          clearPrivateOrientation();
          return;
        }
        if (error instanceof ApiRequestError &&
            ["NAVIGATION_DEPLOYMENT_CHANGED", "ORIENTATION_DEPLOYMENT_CHANGED", "ORIENTATION_SCOPE_CHANGED"].includes(error.code)) {
          key = ""; previous = ""; clearReader(); result.replaceChildren();
          status.textContent = "The source view changed. Load sources again.";
          return;
        }
        output.replaceChildren(textElement("p", errorText(error), "navigation-expansion-error"));
        status.textContent = "Sections could not be expanded. Retry while the source view is current.";
      })
      .finally(() => {
        if (mine === navigationSerial) { navigationController = undefined; button.disabled = false; }
      });
  };
  const wireOrientation = (view: OrientationView, selectionSerial: number): void => {
    for (const button of result.querySelectorAll<HTMLButtonElement>("[data-read-document]")) {
      const cardIndex = Number(button.dataset.readDocument);
      button.onclick = () => readDocument(view, cardIndex, button);
    }
    for (const button of result.querySelectorAll<HTMLButtonElement>("[data-expand-map]")) {
      const cardIndex = Number(button.dataset.expandMap);
      button.onclick = () => expandMap(view, cardIndex, button, selectionSerial);
    }
    const traceButton = result.querySelector<HTMLButtonElement>("[data-trace]");
    if (traceButton) traceButton.onclick = () => {
      traceButton.disabled = true;
      void readOrientationTrace(view.trace, controller?.signal, view.generation).then((trace) => {
        if (selectionSerial === active) { traceResult.textContent = JSON.stringify(trace, null, 2); traceResult.hidden = false; traceDetails.hidden = false; traceDetails.open = true; }
      }).catch((error: unknown) => { if (selectionSerial === active) { result.replaceChildren(); status.textContent = errorText(error); } });
    };
  };
  closeDocument.onclick = () => { const button = lastReadButton; clearReader(); button?.focus(); };
  downloadDocument.onclick = () => {
    if (openedDocument === undefined) return;
    if (downloadUrl !== undefined) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([openedDocument.bytes.slice()], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = downloadUrl; link.download = downloadName(documentTitle.textContent ?? "");
    link.click();
  };
  cancel.onclick = () => { stop(); status.textContent = "Request cancelled. Retry unchanged inputs to reconcile the same operation."; };
  const submitSelection = (): Promise<boolean> => {
    stop(); const serial = ++active; controller = new AbortController();
    result.replaceChildren(); traceResult.textContent = ""; traceResult.hidden = true;
    if (!navigator.onLine) { status.textContent = "Offline. Private source metadata is not cached."; const unavailable = Promise.resolve(false); pendingSelection = unavailable; return unavailable; }
    let request: Promise<boolean>;
    try {
      const values = new FormData(form);
      const ids = String(values.get("sources") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      const body = orientationBody(ids, String(values.get("focus") ?? ""));
      if (body !== previous || !key) { previous = body; key = crypto.randomUUID(); }
      cancel.disabled = false; status.textContent = "Reading current authorized sources…";
      request = orientSources(body, key, controller.signal).then((view) => {
        if (serial !== active) return false;
        status.textContent = "Sources loaded. Choose a document to read.";
        result.innerHTML = renderOrientation(view);
        wireOrientation(view, serial);
        return true;
      }).catch((error: unknown) => {
        if (serial === active) {
          const expired = error instanceof ApiRequestError &&
            ["ORIENTATION_OPERATION_EXPIRED", "ORIENTATION_SCOPE_EXPIRED", "EXPIRED_SCOPE"].includes(error.code);
          if (expired) {
            key = ""; previous = ""; clearReader(); result.replaceChildren(); traceResult.textContent = ""; traceResult.hidden = true; traceDetails.hidden = true; traceDetails.open = false;
            status.textContent = "Source view expired. Load sources to refresh.";
          } else status.textContent = errorText(error);
        }
        return false;
      })
        .finally(() => { if (serial === active) cancel.disabled = true; });
    } catch (error) { status.textContent = errorText(error); request = Promise.resolve(false); }
    pendingSelection = request;
    return request;
  };
  form.onsubmit = (event) => {
    event.preventDefault(); void submitSelection();
  };
  const offline = () => { stop(); result.replaceChildren(); traceResult.textContent = ""; traceResult.hidden = true;
    status.textContent = "Offline. Reload sources after reconnecting; cached authority is not reused."; };
  const denied = () => { offline(); status.textContent = "Authorization changed. Reload after renewing the session/read policy."; };
  window.addEventListener("offline", offline); window.addEventListener("eliotr:authorization-cleared", denied);
  let disposed = false;
  return Object.assign(() => { disposed = true; offline(); window.removeEventListener("offline", offline);
    window.removeEventListener("eliotr:authorization-cleared", denied); }, {
    selectSource(id: string): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      orientationBody([id], "");
      const sources = element.querySelector<HTMLInputElement>('input[name="sources"]');
      if (!sources) throw new Error("Source selector is missing");
      sources.value = id; form.requestSubmit(); return pendingSelection;
    },
  });
}
