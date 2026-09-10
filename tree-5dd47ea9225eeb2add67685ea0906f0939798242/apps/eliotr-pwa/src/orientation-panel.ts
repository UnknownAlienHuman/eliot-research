import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import { orientSources, orientationBody, readOrientationTrace, type OrientationView } from "./orientation-api.js";

export function renderOrientation(view: OrientationView): string {
  return `<p><strong>Navigation only — not citation evidence.</strong> ${view.cards.length} represented; ${view.omitted} omitted.</p>
    <p>Selection uses frozen source order. Semantic ranking, full document structure and research synthesis are not enabled.</p>
    ${view.cards.map((card) => `<article class="source-card"><h3>${escapeHtml(card.title)}</h3>
      <code>${escapeHtml(card.source_revision_ref)}</code><p>${escapeHtml(card.source_kind)} · ${escapeHtml(card.quality_status)}</p>
      <p>${escapeHtml(view.maps.find((map) => map.source_revision_ref === card.source_revision_ref)?.unresolved_structure.join(", ") ?? "DOCUMENT_MAP_MISSING")}</p></article>`).join("")}
    <p>Scope: <code>${escapeHtml(view.scope.id)}</code></p><button type="button" data-trace>Inspect trace</button>`;
}
export function mountOrientationPanel(element: HTMLElement): () => void {
  element.innerHTML = `<h2>Corpus Lens</h2><p>Browse admitted source metadata. Requires an explicit owner read policy. No model calls.</p>
    <form><label>Source IDs (optional, separated by commas)<input name="sources" maxlength="16000" autocomplete="off" placeholder="Blank: authorized library, at most 64 sources"></label>
    <label>Focus (metadata only)<input name="focus" maxlength="256" autocomplete="off"></label>
    <button type="submit">Load sources</button><button type="button" data-cancel disabled>Cancel</button></form>
    <p role="status" aria-live="polite"></p><section data-result></section><pre data-trace-result hidden></pre>`;
  const form = element.querySelector("form"); const status = element.querySelector('[role="status"]');
  const result = element.querySelector("[data-result]"); const traceResult = element.querySelector<HTMLPreElement>("[data-trace-result]");
  const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]");
  if (!form || !status || !result || !traceResult || !cancel) throw new Error("Corpus Lens panel is incomplete");
  let controller: AbortController | undefined; let active = 0; let key = ""; let previous = "";
  const errorText = (error: unknown) => error instanceof ApiRequestError
    ? `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}${error.retryable ? " · Retry preserves the operation identity." : ""}`
    : "Unable to read Corpus Lens. Check the inputs and session.";
  const stop = () => { active += 1; controller?.abort(); cancel.disabled = true; };
  cancel.onclick = () => { stop(); status.textContent = "Request cancelled. Retry unchanged inputs to reconcile the same operation."; };
  form.onsubmit = (event) => {
    event.preventDefault(); stop(); const serial = ++active; controller = new AbortController();
    result.replaceChildren(); traceResult.textContent = ""; traceResult.hidden = true;
    if (!navigator.onLine) { status.textContent = "Offline. Private source metadata is not cached."; return; }
    try {
      const values = new FormData(form);
      const ids = String(values.get("sources") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      const body = orientationBody(ids, String(values.get("focus") ?? ""));
      if (body !== previous || !key) { previous = body; key = crypto.randomUUID(); }
      cancel.disabled = false; status.textContent = "Reading current authorized sources…";
      void orientSources(body, key, controller.signal).then((view) => {
        if (serial !== active) return;
        status.textContent = `Loaded from ${view.generation}. No resolved citations; coverage is not a completeness claim.`;
        result.innerHTML = renderOrientation(view);
        const traceButton = result.querySelector<HTMLButtonElement>("[data-trace]");
        if (traceButton) traceButton.onclick = () => {
          traceButton.disabled = true;
          void readOrientationTrace(view.trace, controller?.signal).then((trace) => {
            if (serial === active) { traceResult.textContent = JSON.stringify(trace, null, 2); traceResult.hidden = false; }
          }).catch((error: unknown) => { if (serial === active) { result.replaceChildren(); status.textContent = errorText(error); } });
        };
      }).catch((error: unknown) => { if (serial === active) status.textContent = errorText(error); })
        .finally(() => { if (serial === active) cancel.disabled = true; });
    } catch (error) { status.textContent = errorText(error); }
  };
  const offline = () => { stop(); result.replaceChildren(); traceResult.textContent = ""; traceResult.hidden = true;
    status.textContent = "Offline. Reload sources after reconnecting; cached authority is not reused."; };
  window.addEventListener("offline", offline);
  return () => { stop(); window.removeEventListener("offline", offline); };
}
