import { ReadinessChannelSchema } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import { readSourceRevisionsPage, type SourceRevisionPage } from "./source-revisions-api.js";

export function renderSourceRevisions(page: SourceRevisionPage): string {
  return `<p>Observed ${escapeHtml(page.observed_at)}. Recorded states only; this view does not validate the current index or resolve evidence.</p>
    ${page.revisions.length ? page.revisions.map((revision) => `<article class="source-card">
      <h4>${escapeHtml(revision.source_revision_ref)}${revision.source_revision_ref === page.head_revision_ref ? " · Current head" : ""}</h4>
      <p>Captured: ${escapeHtml(revision.captured_at)} · Admitted: ${escapeHtml(revision.admitted_at)}</p>
      <p>Quality: ${escapeHtml(revision.quality_state)} · Observed currentness: ${escapeHtml(revision.currentness_state)}</p>
      <p>Content SHA-256: <code>${escapeHtml(revision.content_sha256)}</code></p>
      <h5>Recorded readiness by channel</h5><dl>${ReadinessChannelSchema.options.map((channel) => {
        const row = revision.readiness.find((item) => item.channel === channel);
        return `<dt>${escapeHtml(channel)}</dt><dd>${row ? `${escapeHtml(row.state)} · recorded ${escapeHtml(row.observed_at)}
          <br>Generation: ${escapeHtml(row.generation ?? "not recorded")} · Receipt: ${escapeHtml(row.receipt_ref ?? "not recorded")}
          ${row.reason_codes.length ? `<br>Reasons: ${row.reason_codes.map(escapeHtml).join(", ")}` : ""}` : "Not recorded"}</dd>`;
      }).join("")}</dl></article>`).join("") : "<p>No more permitted revisions on this page.</p>"}`;
}

export function mountSourceRevisionsPanel(element: HTMLElement, sourceId: string, generation: string): () => void {
  element.innerHTML = `<h3>Versions of <code>${escapeHtml(sourceId)}</code></h3>
    <p>Only currently permitted LIVE revisions are listed. Missing revisions are not a completeness claim.</p>
    <p><button type="button" data-revisions-first>Refresh versions</button>
    <button type="button" data-revisions-next disabled>Older versions</button></p>
    <p role="status" aria-live="polite"></p><section data-revisions-result></section>`;
  const first = element.querySelector<HTMLButtonElement>("[data-revisions-first]");
  const next = element.querySelector<HTMLButtonElement>("[data-revisions-next]");
  const status = element.querySelector('[role="status"]');
  const result = element.querySelector("[data-revisions-result]");
  if (!first || !next || !status || !result) throw new Error("Revision panel is incomplete");
  let controller: AbortController | undefined; let serial = 0; let disposed = false;
  let page: SourceRevisionPage | undefined;
  const clear = (message: string) => { serial++; controller?.abort(); page = undefined;
    result.replaceChildren(); next.disabled = true; status.textContent = message; };
  const load = async (cursor?: string) => {
    if (disposed) return;
    clear("Reading permitted versions…"); const mine = serial;
    if (!navigator.onLine) { clear("Offline. Private version data is not cached."); return; }
    controller = new AbortController();
    try {
      const received = await readSourceRevisionsPage(sourceId, generation, cursor, controller.signal);
      if (mine !== serial || disposed) return;
      page = received; result.innerHTML = renderSourceRevisions(received); next.disabled = !received.next_cursor;
      status.textContent = `${received.generation} · ${received.revisions.length} permitted revisions · trace ${received.trace}`;
    } catch (error) {
      if (mine !== serial || disposed) return;
      clear(error instanceof ApiRequestError ? `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}` :
        "Version request failed. Refresh the Library.");
    }
  };
  first.onclick = () => { void load(); };
  next.onclick = () => { const cursor = page?.next_cursor; if (cursor) void load(cursor); };
  const offline = () => clear("Offline. Private version data cleared.");
  const denied = () => clear("Authorization changed. Sign in or renew the read policy, then refresh.");
  window.addEventListener("offline", offline); window.addEventListener("eliotr:authorization-cleared", denied);
  void load();
  return () => { disposed = true; clear("Version session closed."); element.replaceChildren();
    first.onclick = null; next.onclick = null;
    window.removeEventListener("offline", offline); window.removeEventListener("eliotr:authorization-cleared", denied); };
}
