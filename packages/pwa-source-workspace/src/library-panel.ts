import { mountSourceRevisionsPanel } from "./source-revisions-panel.js";
import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import { readLibraryPage, type LibraryPage } from "./library-api.js";
import { readLibraryReadiness, type LibrarySelectionContext } from "./library-readiness-api.js";
import { renderLibraryReadiness } from "./library-readiness-panel.js";

function renderLibrarySource(source: LibraryPage["sources"][number], index: number): string {
  const revision = source.readiness_ref.slice(`readiness:${source.id}:`.length);
  return `<article class="source-card library-source-card"><div class="library-source-heading"><h3><button class="library-source-title" type="button" data-source="${index}" aria-label="Read ${escapeHtml(source.title)}"><span class="library-source-title-text">${escapeHtml(source.title)}</span></button></h3></div>
       <p class="library-source-meta"><span class="library-source-freshness">Freshness not checked</span></p>
       <details class="library-source-details"><summary>Source details and versions</summary>
         <dl class="library-source-identifiers"><dt>Source ID</dt><dd><code>${escapeHtml(source.id)}</code></dd><dt>Revision</dt><dd><code>${escapeHtml(revision)}</code></dd></dl>
         <button class="button button--quiet" type="button" data-versions="${index}">Versions and recorded states</button>
       </details></article>`;
}

export function renderLibrary(page: LibraryPage): string {
  return `<details class="library-project-filters"><summary>Projects${page.projects.length ? ` · ${page.projects.length} on this page` : ""}</summary>
      ${page.projects.length ? page.projects.map((project, index) =>
        `<p><button type="button" class="library-project-filter" data-project="${index}">${escapeHtml(project.title)}</button></p>`).join("") : "<p>No readable projects on this page.</p>"}
    </details>
    ${page.sources.length ? page.sources.map(renderLibrarySource).join("") : "<p>No readable documents on this page.</p>"}`;
}

function libraryErrorText(error: unknown, subject: string): string {
  if (!(error instanceof ApiRequestError)) return `${subject} could not be loaded. Try again.`;
  if (error.status === 401 || error.status === 403 || error.code.startsWith("ACCESS_")) {
    return `Access changed. Sign in again, then retry ${subject.toLowerCase()}.`;
  }
  if (error.retryable) return `${subject} is temporarily unavailable. Try again in a moment.`;
  return `${subject} could not be loaded. Check the workspace and try again.`;
}

function isRetryableCatalogConflict(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 409 && error.retryable &&
    ["CATALOG_AUTHORITY_CHANGED", "CATALOG_CURSOR_STALE", "CATALOG_GENERATION_CHANGED"].includes(error.code);
}

function renderLibraryError(target: HTMLElement, error: unknown, subject: string, retryCatalog?: () => void): void {
  const reason = document.createElement("p"); reason.className = "library-error-reason";
  reason.textContent = libraryErrorText(error, subject);
  target.replaceChildren(reason);
  if (retryCatalog !== undefined && isRetryableCatalogConflict(error)) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button button--quiet";
    retry.dataset.libraryRetry = "true";
    retry.textContent = "Reload catalog from first page";
    retry.onclick = retryCatalog;
    target.append(retry);
  }
  if (!(error instanceof ApiRequestError)) return;
  const details = document.createElement("details"); details.className = "library-error-details";
  const summary = document.createElement("summary"); summary.textContent = "Technical details";
  const fields = document.createElement("dl");
  const add = (label: string, value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    const term = document.createElement("dt"); term.textContent = label;
    const description = document.createElement("dd"); description.textContent = value;
    fields.append(term, description);
  };
  add("Code", error.code);
  add("Status", String(error.status));
  add("Message", error.message);
  add("Trace", error.traceId ?? undefined);
  details.append(summary, fields); target.append(details);
}

export function mountLibraryPanel(element: HTMLElement, onSelectSource: (id: string, context?: LibrarySelectionContext) => void | boolean | Promise<void | boolean>): (() => void) & { clearPrivate(): void; openProject(projectId: string): void; refresh(): void } {
  element.innerHTML = `<h2 class="visually-hidden">Document Library</h2>
    <p class="library-actions"><button class="button button--quiet" type="button" data-first>All sources</button></p>
    <div class="library-scope" data-scope></div><div class="library-status" role="status" aria-live="polite"></div>
    <section data-library-result></section><p class="library-pagination"><button class="button button--quiet" type="button" data-next disabled>Next page</button></p>
    <section data-library-versions></section>
    <section data-library-readiness aria-live="polite"></section>`;
  const first = element.querySelector<HTMLButtonElement>("[data-first]");
  const next = element.querySelector<HTMLButtonElement>("[data-next]");
  const scope = element.querySelector("[data-scope]");
  const status = element.querySelector<HTMLElement>('[role="status"]'); const result = element.querySelector("[data-library-result]");
  const versions = element.querySelector<HTMLElement>("[data-library-versions]");
  const readiness = element.querySelector<HTMLElement>("[data-library-readiness]");
  if (!first || !next || !scope || !status || !result || !versions || !readiness) throw new Error("Library panel is incomplete");
  let controller: AbortController | undefined; let serial = 0; let disposed = false;
  let readinessController: AbortController | undefined; let readinessSerial = 0;
  let project: string | undefined; let projectTitle: string | undefined; let page: LibraryPage | undefined;
  let closeVersions: (() => void) | undefined;
  const renderScope = (generation?: string): void => {
    scope.replaceChildren();
    const label = document.createElement("span");
    label.textContent = project === undefined ? "Authorized Library" : `Project: ${projectTitle?.trim() || "Selected project"}`;
    scope.append(label);
    const details = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = "View scope details";
    const fields = document.createElement("dl");
    if (project !== undefined) {
      const term = document.createElement("dt"); term.textContent = "Project ID";
      const value = document.createElement("dd"); const code = document.createElement("code"); code.textContent = project; value.append(code);
      fields.append(term, value);
    }
    if (generation !== undefined) {
      const term = document.createElement("dt"); term.textContent = "Generation";
      const value = document.createElement("dd"); value.textContent = generation; fields.append(term, value);
    }
    const note = document.createElement("p"); note.textContent = "This is one bounded page, not a completeness or index-readiness claim.";
    details.append(summary, fields, note);
    scope.append(details);
  };
  const dispatchScopeChange = (reason: "project-filter" | "source-currentness", projectId?: string, title?: string): void => {
    element.dispatchEvent(new CustomEvent("library:scope-changed", {
      bubbles: true,
      detail: { reason, ...(projectId === undefined ? {} : { projectId }), ...(title === undefined ? {} : { title }) },
    }));
  };
  const clearReadiness = (message = "Select a source to check active search readiness."): void => {
    readinessSerial++; readinessController?.abort(); readinessController = undefined;
    readiness.replaceChildren(); if (message) readiness.textContent = message;
  };
  const stop = () => { serial++; controller?.abort(); next.disabled = true; closeVersions?.(); closeVersions = undefined; clearReadiness(); };
  const clear = (message: string) => { stop(); page = undefined; result.replaceChildren(); scope.textContent = ""; status.textContent = message; };
  const load = async (cursor?: string) => {
    if (disposed) return;
    const generation = cursor ? page?.generation : undefined;
    stop(); const mine = serial; page = undefined; result.replaceChildren();
    renderScope(generation);
    if (!navigator.onLine) { clear("Offline. Private Library data is not cached."); return; }
    controller = new AbortController(); status.textContent = "Reading permitted sources…";
    try {
      const received = await readLibraryPage({ ...(project ? { project } : {}), ...(cursor ? { cursor } : {}),
        ...(generation ? { generation } : {}) }, controller.signal);
      if (mine !== serial || disposed) return;
      page = received;
      const receivedProject = project === undefined ? undefined : received.projects.find((item) => item.id === project);
      if (receivedProject !== undefined) projectTitle = receivedProject.title;
      renderScope(received.generation);
      result.innerHTML = renderLibrary(received); next.disabled = !received.next_cursor;
      status.textContent = `${received.sources.length} source${received.sources.length === 1 ? "" : "s"} on this page.`;
      for (const button of result.querySelectorAll<HTMLButtonElement>("[data-project]")) button.onclick = () => {
        const selected = received.projects[Number(button.dataset.project)];
        if (selected && mine === serial && !disposed) { project = selected.id; projectTitle = selected.title; dispatchScopeChange("project-filter", selected.id, selected.title); void load(); }
      };
      for (const button of result.querySelectorAll<HTMLButtonElement>("[data-versions]")) button.onclick = () => {
        const selected = received.sources[Number(button.dataset.versions)];
        if (selected && mine === serial && !disposed) {
          closeVersions?.(); closeVersions = mountSourceRevisionsPanel(versions, selected.id, received.generation, selected.title);
        }
      };
      for (const button of result.querySelectorAll<HTMLButtonElement>("[data-source]")) button.onclick = () => {
        const selected = received.sources[Number(button.dataset.source)];
        if (selected && mine === serial && !disposed) {
          const head = selected.readiness_ref.slice(`readiness:${selected.id}:`.length);
          clearReadiness("Updating selected source…");
          const selectionReadinessSerial = readinessSerial;
          void (async () => {
            let selectedForReadiness: void | boolean;
            try { selectedForReadiness = await onSelectSource(selected.id, { deploymentGeneration: received.generation }); }
            catch { if (mine === serial && selectionReadinessSerial === readinessSerial && !disposed) readiness.textContent = "Source selection did not complete. Retry selecting the source."; return; }
            if (mine !== serial || selectionReadinessSerial !== readinessSerial || disposed) return;
            if (selectedForReadiness === false) { readiness.textContent = "Source selection did not complete. Retry selecting the source."; return; }
            await checkReadiness(selected.id, received.generation, head, mine);
          })();
        }
      };
    } catch (error) {
      if (mine !== serial || disposed) return;
      clear(libraryErrorText(error, "Library"));
      renderLibraryError(status, error, "Library", () => { void load(); });
    }
  };
  const checkReadiness = async (sourceId: string, deploymentGeneration: string,
    expectedSourceRevisionRef: string, pageSerial: number): Promise<void> => {
    clearReadiness("Checking active search readiness…");
    const mine = readinessSerial;
    if (!navigator.onLine) { readiness.textContent = "Offline. Active readiness is not cached."; return; }
    readinessController = new AbortController();
    try {
      const received = await readLibraryReadiness(sourceId, deploymentGeneration, readinessController.signal, expectedSourceRevisionRef);
      if (mine !== readinessSerial || pageSerial !== serial || disposed) return;
      readiness.innerHTML = renderLibraryReadiness(received);
      const context: LibrarySelectionContext = {
        sourceRevisionRef: received.source_revision_ref,
        deploymentGeneration: received.deployment_generation,
        catalogGeneration: received.catalog_generation,
        currentness: received.currentness,
      };
      onSelectSource(sourceId, context);
    } catch (error) {
      if (mine !== readinessSerial || pageSerial !== serial || disposed) return;
      if (error instanceof ApiRequestError &&
          (error.code === "LIBRARY_DEPLOYMENT_CHANGED" || error.code === "LIBRARY_SOURCE_HEAD_CHANGED")) {
        dispatchScopeChange("source-currentness");
        return;
      }
      renderLibraryError(readiness, error, "Active search readiness");
    }
  };
  const openProject = (projectId: string, title?: string): void => {
    if (disposed) return;
    project = projectId;
    projectTitle = title ?? page?.projects.find((item) => item.id === projectId)?.title;
    const observedTitle = projectTitle;
    dispatchScopeChange("project-filter", projectId, observedTitle);
    void load();
  };
  first.onclick = () => { project = undefined; projectTitle = undefined; dispatchScopeChange("project-filter"); void load(); };
  next.onclick = () => { const cursor = page?.next_cursor; if (cursor) void load(cursor); };
  const offline = () => { clear("Offline. Private Library data cleared."); onSelectSource(""); };
  const denied = () => { clear("Authorization changed. Sign in again, then refresh to check which sources remain permitted."); onSelectSource(""); };
  const admissionCompleted = () => { void load(); };
  window.addEventListener("offline", offline); window.addEventListener("eliotr:authorization-cleared", denied);
  window.addEventListener("eliotr:raw-admission-completed", admissionCompleted);
  window.addEventListener("eliotr:source-erased", admissionCompleted);
  void load();
  const cleanup = () => { disposed = true; clear("Library session closed."); first.onclick = null; next.onclick = null;
    window.removeEventListener("offline", offline); window.removeEventListener("eliotr:authorization-cleared", denied);
    window.removeEventListener("eliotr:raw-admission-completed", admissionCompleted);
    window.removeEventListener("eliotr:source-erased", admissionCompleted); };
  return Object.assign(cleanup, { clearPrivate: () => { project = undefined; projectTitle = undefined; clear("Library data cleared. Refresh to read permitted sources."); onSelectSource(""); }, openProject, refresh: () => { void load(); } });
}
