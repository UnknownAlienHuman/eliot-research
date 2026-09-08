import { IdentifierSchema } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import {
  readRetrievalTrace, retrievalBody, runRetrievalQuery,
  type RetrievalResultView, type RetrievalTraceView,
} from "./retrieval-api.js";

function anchorText(anchor: Record<string, unknown>): string {
  const kind = String(anchor.kind ?? "unknown");
  if (kind === "normalized_byte_range" && typeof anchor.start === "number" && typeof anchor.end === "number") {
    return `bytes ${anchor.start}–${anchor.end}`;
  }
  return kind;
}

export function renderRetrieval(view: RetrievalResultView): string {
  if (view.evidence.length === 0) {
    // A no-hit is not an absence proof: coverage is capped at SAMPLED while no exhaustive
    // denominator is reconciled, so the honest statement is "not found in what was read".
    return `<p><strong>No evidence resolved.</strong> This is not proof the corpus lacks the term:
      coverage is sampled, not exhaustive.</p>
      ${view.omitted.length ? `<p>${view.omitted.length} candidate(s) omitted during resolution.</p>` : ""}
      <p>Scope <code>${escapeHtml(view.scope.id)}</code> · pack <code>${escapeHtml(view.pack.id)}</code></p>
      <button type="button" data-trace>Inspect trace</button>`;
  }
  return `<p><strong>${view.evidence.length} resolved excerpt(s)</strong> · ${view.total_utf8_bytes} UTF-8 bytes.
    Each excerpt is pinned to its source revision and verified against stored bytes.</p>
    ${view.evidence.map((item) => `<article class="source-card">
      <h3>${escapeHtml(item.source_title ?? item.handle.source_revision_ref)}</h3>
      <blockquote data-excerpt>${escapeHtml(item.exact_excerpt)}</blockquote>
      <p><code>${escapeHtml(item.handle.source_revision_ref)}</code></p>
      <p>${escapeHtml(anchorText(item.handle.anchor as unknown as Record<string, unknown>))} ·
        ${item.handle.excerpt_byte_length} bytes · ${escapeHtml(item.handle.terminal_state)}</p>
      <p>Verified <code>${escapeHtml(item.verification_receipt_ref)}</code> ·
        taint ${escapeHtml(item.instruction_taint)}</p>
    </article>`).join("")}
    ${view.omitted.length ? `<p>${view.omitted.length} candidate(s) omitted: ${
      escapeHtml(view.omitted.map((entry) => entry.reason_code).join(", "))}</p>` : ""}
    <p>Scope <code>${escapeHtml(view.scope.id)}</code> · pack <code>${escapeHtml(view.pack.id)}</code></p>
    <button type="button" data-trace>Inspect trace</button>`;
}

export function renderRetrievalTrace(view: RetrievalTraceView): string {
  const skipped = view.trace.lanes_skipped.map((entry) => `${entry.lane}=${entry.reason}`).join(", ");
  return [
    `coverage: ${view.coverage_claim}`,
    `lanes used: ${view.trace.lanes_used.join(", ") || "none"}`,
    `lanes skipped: ${skipped || "none"}`,
    `represented sources: ${view.trace.represented_source_refs.length}`,
    `omitted sources: ${view.trace.omitted_sources.length}`,
    `degraded channels: ${view.trace.stale_or_degraded_channels.join(", ") || "none"}`,
    `scope: ${view.trace.scope_snapshot.snapshot_id}@${view.trace.scope_snapshot.revision}`,
  ].join("\n");
}

export function mountRetrievalPanel(element: HTMLElement): (() => void) & { selectSource(id: string): void } {
  element.innerHTML = `<h2>Retrieval</h2>
    <p>Exact and lexical retrieval over admitted sources. Excerpts are citation evidence, pinned and verified.
    Coverage is sampled: a miss does not prove absence, and no model is called.</p>
    <form><label>Query<input name="query" maxlength="4096" autocomplete="off" required placeholder="Exact term or phrase"></label>
    <label>Source IDs (optional, separated by commas)<input name="sources" maxlength="16000" autocomplete="off" placeholder="Blank: authorized library, at most 64 sources"></label>
    <button type="submit">Search</button><button type="button" data-cancel disabled>Cancel</button></form>
    <p role="status" aria-live="polite"></p><section data-result></section><pre data-trace-result hidden></pre>`;
  const form = element.querySelector("form");
  const status = element.querySelector('[role="status"]');
  const result = element.querySelector("[data-result]");
  const traceResult = element.querySelector<HTMLPreElement>("[data-trace-result]");
  const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]");
  const sources = element.querySelector<HTMLInputElement>('input[name="sources"]');
  if (!form || !status || !result || !traceResult || !cancel || !sources) throw new Error("Retrieval panel is incomplete");

  let controller: AbortController | undefined;
  let active = 0;
  let key = "";
  let previous = "";
  let lastTrace: RetrievalResultView["trace"] | undefined;

  const errorText = (error: unknown) => error instanceof ApiRequestError
    ? `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}${
      error.retryable ? " · Retry preserves the operation identity." : ""}`
    : "Unable to run retrieval. Check the inputs and session.";

  const stop = () => { active += 1; controller?.abort(); cancel.disabled = true; };
  cancel.onclick = () => {
    stop();
    status.textContent = "Request cancelled. Retry unchanged inputs to reconcile the same operation.";
  };

  form.onsubmit = (event) => {
    event.preventDefault();
    stop();
    const serial = ++active;
    controller = new AbortController();
    result.replaceChildren();
    traceResult.textContent = "";
    traceResult.hidden = true;
    lastTrace = undefined;
    if (!navigator.onLine) { status.textContent = "Offline. Retrieval results are not cached."; return; }
    let body: string;
    try {
      const values = new FormData(form);
      const ids = String(values.get("sources") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      body = retrievalBody(String(values.get("query") ?? ""), ids);
    } catch {
      status.textContent = "Query or source IDs are invalid.";
      return;
    }
    // One idempotency key per distinct input: an unchanged retry reconciles the same operation
    // instead of minting a second one, which is what the Worker's replay path expects.
    if (body !== previous) { previous = body; key = crypto.randomUUID(); }
    cancel.disabled = false;
    status.textContent = "Running retrieval…";
    void runRetrievalQuery(body, key, controller.signal)
      .then((view) => {
        if (serial !== active) return;
        lastTrace = view.trace;
        result.innerHTML = renderRetrieval(view);
        status.textContent = `Resolved ${view.evidence.length} excerpt(s).`;
        element.dispatchEvent(new CustomEvent("retrieval:resolved",
          { bubbles: true, detail: { resolved: view.evidence.length, bytes: view.total_utf8_bytes } }));
      })
      .catch((error: unknown) => {
        if (serial !== active || (error instanceof Error && error.name === "AbortError")) return;
        status.textContent = errorText(error);
      })
      .finally(() => { if (serial === active) cancel.disabled = true; });
  };

  result.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.hasAttribute("data-trace") || lastTrace === undefined) return;
    const ref = lastTrace;
    const serial = active;
    traceResult.hidden = false;
    traceResult.textContent = "Reading trace…";
    void readRetrievalTrace(ref)
      .then((view) => { if (serial === active) traceResult.textContent = renderRetrievalTrace(view); })
      .catch((error: unknown) => { if (serial === active) traceResult.textContent = errorText(error); });
  });

  const cleanup = () => { stop(); };
  return Object.assign(cleanup, {
    selectSource(id: string): void {
      IdentifierSchema.parse(id);
      const current = sources.value.split(",").map((value) => value.trim()).filter(Boolean);
      if (!current.includes(id)) sources.value = [...current, id].join(", ");
    },
  });
}
