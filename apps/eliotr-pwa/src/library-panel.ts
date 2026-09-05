import { mountSourceRevisionsPanel } from "./source-revisions-panel.js";
import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import { readLibraryPage, type LibraryPage } from "./library-api.js";

export function renderLibrary(page: LibraryPage): string {
  return `<h3>Projects on this page</h3>${page.projects.length ? page.projects.map((project, index) =>
    `<p><button type="button" data-project="${index}">${escapeHtml(project.title)}</button></p>`).join("") : "<p>No readable projects on this page.</p>"}
    <h3>Sources on this page</h3>${page.sources.length ? page.sources.map((source, index) =>
      `<article class="source-card"><strong>${escapeHtml(source.title)}</strong><p><code>${escapeHtml(source.id)}</code></p>
       <p>Admitted source. Search readiness not checked.</p>
       <button type="button" data-source="${index}">Open in Corpus Lens</button>
       <button type="button" data-versions="${index}">Versions and readiness</button></article>`).join("") : "<p>No readable source heads on this page.</p>"}`;
}

export function mountLibraryPanel(element: HTMLElement, onSelectSource: (id: string) => void): () => void {
  element.innerHTML = `<h2>Library</h2><p>Only sources permitted by your current read policy are shown.</p>
    <p><button type="button" data-first>All sources / refresh</button> <button type="button" data-next disabled>Next page</button></p>
    <p data-scope></p><p role="status" aria-live="polite"></p><section data-library-result></section><section data-library-versions></section>`;
  const first = element.querySelector<HTMLButtonElement>("[data-first]");
  const next = element.querySelector<HTMLButtonElement>("[data-next]");
  const scope = element.querySelector("[data-scope]");
  const status = element.querySelector('[role="status"]'); const result = element.querySelector("[data-library-result]");
  const versions = element.querySelector<HTMLElement>("[data-library-versions]");
  if (!first || !next || !scope || !status || !result || !versions) throw new Error("Library panel is incomplete");
  let controller: AbortController | undefined; let serial = 0; let disposed = false;
  let project: string | undefined; let page: LibraryPage | undefined;
  let closeVersions: (() => void) | undefined;
  const stop = () => { serial++; controller?.abort(); next.disabled = true; closeVersions?.(); closeVersions = undefined; };
  const clear = (message: string) => { stop(); page = undefined; result.replaceChildren(); scope.textContent = ""; status.textContent = message; };
  const load = async (cursor?: string) => {
    if (disposed) return;
    const generation = cursor ? page?.generation : undefined;
    stop(); const mine = serial; page = undefined; result.replaceChildren();
    scope.textContent = project ? `Project: ${project}` : "Authorized Library";
    if (!navigator.onLine) { clear("Offline. Private Library data is not cached."); return; }
    controller = new AbortController(); status.textContent = "Reading permitted sources…";
    try {
      const received = await readLibraryPage({ ...(project ? { project } : {}), ...(cursor ? { cursor } : {}),
        ...(generation ? { generation } : {}) }, controller.signal);
      if (mine !== serial || disposed) return;
      page = received; result.innerHTML = renderLibrary(received); next.disabled = !received.next_cursor;
      status.textContent = `${received.generation} · ${received.sources.length} sources on this page. Not a completeness or index-readiness claim.`;
      for (const button of result.querySelectorAll<HTMLButtonElement>("[data-project]")) button.onclick = () => {
        const selected = received.projects[Number(button.dataset.project)];
        if (selected && mine === serial && !disposed) { project = selected.id; void load(); }
      };
      for (const button of result.querySelectorAll<HTMLButtonElement>("[data-versions]")) button.onclick = () => {
        const selected = received.sources[Number(button.dataset.versions)];
        if (selected && mine === serial && !disposed) {
          closeVersions?.(); closeVersions = mountSourceRevisionsPanel(versions, selected.id, received.generation);
        }
      };
      for (const button of result.querySelectorAll<HTMLButtonElement>("[data-source]")) button.onclick = () => {
        const selected = received.sources[Number(button.dataset.source)];
        if (selected && mine === serial && !disposed) onSelectSource(selected.id);
      };
    } catch (error) {
      if (mine !== serial || disposed) return;
      clear(error instanceof ApiRequestError ? `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}` :
        "Library request failed. Reload the first page.");
    }
  };
  first.onclick = () => { project = undefined; void load(); };
  next.onclick = () => { const cursor = page?.next_cursor; if (cursor) void load(cursor); };
  const offline = () => clear("Offline. Private Library data cleared.");
  const denied = () => clear("Authorization changed. Sign in or renew the read policy, then refresh.");
  window.addEventListener("offline", offline); window.addEventListener("eliotr:authorization-cleared", denied);
  void load();
  return () => { disposed = true; clear("Library session closed."); first.onclick = null; next.onclick = null;
    window.removeEventListener("offline", offline); window.removeEventListener("eliotr:authorization-cleared", denied); };
}
