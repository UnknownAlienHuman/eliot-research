import { ApiRequestError, isAuthorizationLoss } from "@eliotr/pwa-http-client";
import {
  readResearchModelCatalog,
  readResearchProjectModelConfiguration,
  WORKERS_AI_CATALOG_ADAPTER_ID,
  selectResearchProjectModelConfiguration,
  type ResearchModelCatalogPage,
  type ResearchModelConfigurationRevision,
  type ResearchProjectModelConfiguration,
} from "./research-model-configuration-api.js";
import {
  renderResearchModelCatalogEntry,
  renderResearchModelConfigurationRevision,
  researchModelConfigurationIsSelectable,
  researchModelCatalogProviderOptions,
  researchModelConfigurationRevisionLabel,
} from "./research-model-configuration-view.js";

export interface ResearchModelConfigurationPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
}

export const RESEARCH_MODEL_SELECTION_SAVED_EVENT = "eliotr:research-model-selection-saved";

export function notifyResearchModelSelectionSaved(target: EventTarget): void {
  target.dispatchEvent(new Event(RESEARCH_MODEL_SELECTION_SAVED_EVENT, { bubbles: true }));
}

export type ResearchModelConfigurationPanelHandle = (() => void) & {
  clearPrivate(message?: string): void;
  refresh(): void;
  setProject(projectId?: string, title?: string): void;
};

export type ResearchModelConfigurationCopy = Readonly<{ summary: string; explanation: string }>;

export function researchModelConfigurationErrorCopy(error: unknown): ResearchModelConfigurationCopy {
  if (error instanceof ApiRequestError) {
    if (isAuthorizationLoss(error)) return {
      summary: "Sign in again to read project model configuration.",
      explanation: "Saved model selections were cleared from this view. Sign in with the project owner account, then refresh.",
    };
    if (error.status === 403) return {
      summary: "Project model configuration is denied by the current access policy.",
      explanation: "The owner session remains active, but current policy does not allow this project configuration request.",
    };
    if (error.code === "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT") return {
      summary: "The saved model selection changed on the server.",
      explanation: "The current project selection is being reloaded. Choose from the latest saved qualified configurations.",
    };
    if (error.code === "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED") return {
      summary: "This exact model configuration no longer has current qualification.",
      explanation: "The server declined the selection. Ask the operator to prepare and qualify a new exact configuration, then refresh.",
    };
    if (error.code === "API_RESPONSE_SCHEMA_MISMATCH" || error.code === "MALFORMED_JSON_RESPONSE" ||
        error.code === "MALFORMED_API_PROBLEM" || error.code === "API_RESPONSE_TOO_LARGE") return {
      summary: "The server returned an invalid model configuration response.",
      explanation: "No provider or model readiness was inferred. Check that the PWA and server versions match, then refresh.",
    };
    if (error.code === "API_GENERATION_MISMATCH") return {
      summary: "The application changed while model configuration was loading.",
      explanation: "Refresh this panel to read saved choices from the current deployment.",
    };
    if (error.code === "MODEL_CATALOG_PROVIDER_UNAVAILABLE" || error.code === "MODEL_CATALOG_UPSTREAM_UNAVAILABLE" ||
        error.code === "MODEL_CATALOG_WORKERS_AI_UNAVAILABLE" || error.code === "MODEL_CATALOG_STORAGE_UNAVAILABLE") return {
      summary: "The model catalog is unavailable.",
      explanation: "Catalog data is descriptive; saved project selections remain a separate server-owned list. Retry the catalog read later.",
    };
    if (error.code === "API_UNREACHABLE" || error.code === "API_REQUEST_ABORTED" || error.code === "API_HTTP_UNAVAILABLE") return {
      summary: "Project model configuration is unavailable.",
      explanation: "Reconnect to the server, then refresh this panel. No model call was made.",
    };
  }
  return {
    summary: "Project model configuration could not be read.",
    explanation: "Refresh this panel after checking the server connection.",
  };
}

function setText(element: HTMLElement, value: string): void {
  element.textContent = value;
}

export function mountResearchModelConfigurationPanel(
  element: HTMLElement,
  options: ResearchModelConfigurationPanelOptions,
): ResearchModelConfigurationPanelHandle {
  element.innerHTML = `<section class="research-model-configuration-panel" aria-labelledby="research-model-configuration-title">
    <div class="connection-heading"><div><span class="eyebrow">New runs</span><h3 id="research-model-configuration-title">Project model selection</h3></div><span class="connection-state connection-state--unknown" data-model-selection-badge>NOT CHECKED</span></div>
    <p role="status" aria-live="polite" data-model-selection-status>Select a project in Library to read its saved model configurations.</p>
    <p data-model-selection-explanation>Only saved exact qualified configurations can be selected. Catalog entries are descriptive; listing a model does not establish account access, billing entitlement, or qualification. BYOK shows its saved alias but never its secret, and a missing BYOK key does not switch to unified billing. Started runs keep their saved snapshot.</p>
    <p data-model-selection-project></p>
    <div class="connection-actions"><button class="button button--quiet" type="button" data-model-selection-refresh>Refresh model configuration</button></div>
    <section aria-labelledby="saved-model-configuration-title">
      <h4 id="saved-model-configuration-title">Saved configurations for new runs</h4>
      <label>Prepared project configuration<select data-model-selection-select disabled><option value="">No saved qualified configuration</option></select></label>
      <div class="connection-actions"><button class="button button--quiet" type="button" data-model-selection-save disabled>Select saved configuration</button></div>
      <div data-model-selection-current></div>
      <div data-model-selection-revisions></div>
      <button class="button button--quiet" type="button" data-model-selection-more hidden>Load more saved configurations</button>
    </section>
    <section aria-labelledby="model-catalog-title">
      <h4 id="model-catalog-title">Text-generation catalog</h4>
      <p>Catalog reads fetch metadata only; they do not send prompts, invoke models, or start qualification. Account access and billing entitlement are not established by the catalog. Only provider catalogs explicitly configured by the server can be browsed.</p>
      <form data-model-catalog-search-form><label>Provider catalog<select data-model-catalog-provider></select></label><label>Search listed models<input type="search" maxlength="512" data-model-catalog-search></label><button class="button button--quiet" type="submit" data-model-catalog-search-submit>Search catalog</button></form>
      <p role="status" aria-live="polite" data-model-catalog-status>Choose a project to browse its catalog.</p>
      <div data-model-catalog-list></div>
      <div class="connection-actions"><button class="button button--quiet" type="button" data-model-catalog-previous hidden>Previous catalog page</button><button class="button button--quiet" type="button" data-model-catalog-next hidden>Next catalog page</button></div>
    </section>
  </section>`;

  const root = element.querySelector<HTMLElement>("[data-model-selection-badge]")?.closest<HTMLElement>(".research-model-configuration-panel");
  const badge = root?.querySelector<HTMLElement>("[data-model-selection-badge]");
  const status = root?.querySelector<HTMLElement>("[data-model-selection-status]");
  const explanation = root?.querySelector<HTMLElement>("[data-model-selection-explanation]");
  const projectLabel = root?.querySelector<HTMLElement>("[data-model-selection-project]");
  const refreshButton = root?.querySelector<HTMLButtonElement>("[data-model-selection-refresh]");
  const choice = root?.querySelector<HTMLSelectElement>("[data-model-selection-select]");
  const saveButton = root?.querySelector<HTMLButtonElement>("[data-model-selection-save]");
  const current = root?.querySelector<HTMLElement>("[data-model-selection-current]");
  const revisionsHost = root?.querySelector<HTMLElement>("[data-model-selection-revisions]");
  const moreRevisionsButton = root?.querySelector<HTMLButtonElement>("[data-model-selection-more]");
  const searchForm = root?.querySelector<HTMLFormElement>("[data-model-catalog-search-form]");
  const providerSelect = root?.querySelector<HTMLSelectElement>("[data-model-catalog-provider]");
  const searchInput = root?.querySelector<HTMLInputElement>("[data-model-catalog-search]");
  const searchButton = root?.querySelector<HTMLButtonElement>("[data-model-catalog-search-submit]");
  const catalogStatus = root?.querySelector<HTMLElement>("[data-model-catalog-status]");
  const catalogList = root?.querySelector<HTMLElement>("[data-model-catalog-list]");
  const previousCatalogButton = root?.querySelector<HTMLButtonElement>("[data-model-catalog-previous]");
  const nextCatalogButton = root?.querySelector<HTMLButtonElement>("[data-model-catalog-next]");
  if (!root || !badge || !status || !explanation || !projectLabel || !refreshButton || !choice || !saveButton ||
      !current || !revisionsHost || !moreRevisionsButton || !searchForm || !providerSelect || !searchInput || !searchButton ||
      !catalogStatus || !catalogList || !previousCatalogButton || !nextCatalogButton) {
    throw new Error("Research model configuration panel is incomplete");
  }

  let disposed = false;
  let serial = 0;
  let projectId: string | undefined;
  let projectTitle: string | undefined;
  let readController: AbortController | undefined;
  let writeController: AbortController | undefined;
  let saving = false;
  let loading = false;
  let configuration: ResearchProjectModelConfiguration | undefined;
  let selected: ResearchModelConfigurationRevision | null = null;
  let revisions: ResearchModelConfigurationRevision[] = [];
  let choiceRef = "";
  let nextRevisionCursor: string | null = null;
  let catalog: ResearchModelCatalogPage | undefined;
  let catalogPage = 1;
  let catalogSearch = "";
  let catalogProvider: string = WORKERS_AI_CATALOG_ADAPTER_ID;
  let configurationError: unknown;
  let catalogError: unknown;
  let notice: string | undefined;

  const online = (): boolean => typeof navigator === "undefined" || navigator.onLine;
  const clearReadState = (): void => {
    configuration = undefined;
    selected = null;
    revisions = [];
    choiceRef = "";
    nextRevisionCursor = null;
    catalog = undefined;
    configurationError = undefined;
    catalogError = undefined;
  };
  const stopRequests = (): void => {
    serial += 1;
    readController?.abort();
    readController = undefined;
    writeController?.abort();
    writeController = undefined;
    saving = false;
    loading = false;
  };
  const setBadge = (label: string, state: "unknown" | "pending" | "configured" | "blocked"): void => {
    badge.className = `connection-state connection-state--${state}`;
    setText(badge, label);
  };
  const render = (): void => {
    projectLabel.textContent = projectId === undefined ? "" : projectTitle
      ? `Project: ${projectTitle} · ${projectId}` : `Project: ${projectId}`;
    refreshButton.disabled = projectId === undefined || saving || disposed;
    choice.disabled = projectId === undefined || configuration === undefined || revisions.length === 0 || saving || loading;
    const chosenRevision = revisions.find((revision) => revision.configuration_ref === choiceRef);
    saveButton.disabled = projectId === undefined || configuration === undefined || saving || loading || !choiceRef ||
      choiceRef === selected?.configuration_ref || !chosenRevision || !researchModelConfigurationIsSelectable(chosenRevision);
    saveButton.textContent = saving ? "Saving selection…" : "Select saved configuration";
    moreRevisionsButton.hidden = nextRevisionCursor === null;
    searchInput.disabled = projectId === undefined || saving || loading;
    searchButton.disabled = projectId === undefined || saving || loading;
    providerSelect.disabled = projectId === undefined || saving || loading;
    previousCatalogButton.hidden = catalogPage <= 1;
    previousCatalogButton.disabled = saving || loading;
    nextCatalogButton.hidden = catalog?.pagination.next_page === null || catalog === undefined;
    nextCatalogButton.disabled = saving || loading;
    moreRevisionsButton.disabled = saving || loading;

    if (projectId === undefined) {
      setBadge("NO PROJECT", "unknown");
      setText(status, "Select a project in Library to read its saved model configurations.");
      setText(catalogStatus, "Choose a project to browse its catalog.");
      setText(explanation, "Only saved exact qualified configurations can be selected. Catalog entries are descriptive; listing a model does not establish account access, billing entitlement, or qualification. BYOK shows its saved alias but never its secret, and a missing BYOK key does not switch to unified billing. Started runs keep their saved snapshot.");
    } else if (!online()) {
      setBadge("OFFLINE", "unknown");
      setText(status, "Offline. Private project model configuration was cleared.");
      setText(catalogStatus, "Offline. The model catalog is not cached.");
    } else if (configurationError !== undefined) {
      const copy = researchModelConfigurationErrorCopy(configurationError);
      setBadge("UNAVAILABLE", "blocked");
      setText(status, copy.summary);
      setText(explanation, copy.explanation);
      setText(catalogStatus, catalogError === undefined ? "Catalog results are shown separately from project configuration." : researchModelConfigurationErrorCopy(catalogError).summary);
    } else if (configuration === undefined && loading) {
      setBadge("CHECKING", "pending");
      setText(status, notice ?? "Reading saved model configuration for this project…");
      setText(catalogStatus, "Reading the project-scoped model catalog…");
    } else if (configuration === undefined) {
      setBadge("NOT CHECKED", "unknown");
      setText(status, notice ?? "Refresh this panel to read saved configurations for the selected project.");
      setText(catalogStatus, catalogError === undefined ? "Refresh to browse the project-scoped text-generation catalog." : researchModelConfigurationErrorCopy(catalogError).summary);
    } else {
      const selectedIsSelectable = selected !== null && researchModelConfigurationIsSelectable(selected);
      setBadge(saving ? "SAVING" : selectedIsSelectable ? "SAVED SELECTION" : selected ? "REQUALIFICATION REQUIRED" : "NO SELECTION",
        saving ? "pending" : selectedIsSelectable ? "configured" : "blocked");
      setText(status, notice ?? (selected
        ? selectedIsSelectable
          ? "New runs use this saved project selection. Started runs retain their original model snapshot."
          : "The saved selection remains in history, but the server could not validate its exact configuration. New runs are blocked until an eligible saved configuration is selected."
        : revisions.length === 0 ? "No saved qualified model configuration is available for this project yet."
          : "Choose a saved qualified model configuration to use for new runs."));
      setText(explanation, "The server checks each saved configuration under its own rules. A saved choice remains eligible while its exact proof and current owner/project checks pass; missing, mismatched, unavailable, or revoked proof blocks selection. An unchanged saved choice can remain eligible after its model proof date passes. Catalog browsing does not confirm account access, billing, or credentials, and this view makes no model request. BYOK shows only the alias, not a key or live credential status; a missing key does not switch to unified billing.");
      setText(catalogStatus, catalogError !== undefined
        ? researchModelConfigurationErrorCopy(catalogError).summary
        : catalog === undefined ? "The catalog has not been read yet."
          : `Catalog page ${catalog.pagination.page} · coverage ${catalog.pagination.coverage} · ${catalog.pagination.probe.replaceAll("_", " ")}. Listed models do not establish account access or billing entitlement.`);
    }

    const selectedValue = choiceRef || selected?.configuration_ref || "";
    const options = document.createDocumentFragment();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = revisions.length === 0 ? "No saved qualified configuration" : "Choose a saved configuration";
    options.append(placeholder);
    for (const revision of revisions) {
      const option = document.createElement("option");
      option.value = revision.configuration_ref;
      option.textContent = researchModelConfigurationRevisionLabel(revision);
      option.disabled = !researchModelConfigurationIsSelectable(revision);
      options.append(option);
    }
    const currentSelection = selected?.configuration_ref === selectedValue ? selected : undefined;
    if (selectedValue && currentSelection && !revisions.some((revision) => revision.configuration_ref === selectedValue)) {
      const selectedOption = document.createElement("option");
      selectedOption.value = selectedValue;
      selectedOption.textContent = `Current selection · ${researchModelConfigurationRevisionLabel(currentSelection)}`;
      selectedOption.disabled = !researchModelConfigurationIsSelectable(currentSelection);
      options.append(selectedOption);
    }
    choice.replaceChildren(options);
    choice.value = revisions.some((revision) => revision.configuration_ref === selectedValue) || selectedValue === selected?.configuration_ref
      ? selectedValue : "";

    const providerOptions = researchModelCatalogProviderOptions([
      ...revisions.flatMap((revision) => revision.model_selections.map((selection) => selection.provider_id)),
      ...(selected?.model_selections.map((selection) => selection.provider_id) ?? []),
    ]);
    providerSelect.replaceChildren(...providerOptions.map((provider) => {
      const option = document.createElement("option");
      option.value = provider;
      option.textContent = provider === WORKERS_AI_CATALOG_ADAPTER_ID ? "Cloudflare Workers AI" : provider;
      return option;
    }));
    if (!providerOptions.includes(catalogProvider)) catalogProvider = WORKERS_AI_CATALOG_ADAPTER_ID;
    providerSelect.value = catalogProvider;

    current.replaceChildren();
    if (selected) current.append(renderResearchModelConfigurationRevision(selected));
    revisionsHost.replaceChildren();
    for (const revision of revisions) {
      const article = renderResearchModelConfigurationRevision(revision);
      if (revision.configuration_ref === selected?.configuration_ref) article.setAttribute("aria-current", "true");
      revisionsHost.append(article);
    }
    catalogList.replaceChildren();
    if (catalog) {
      for (const entry of catalog.models) {
        catalogList.append(renderResearchModelCatalogEntry(entry, revisions, (revision) => {
          choiceRef = revision.configuration_ref;
          choice.value = choiceRef;
          render();
          selectRevision(revision);
        }));
      }
      if (catalog.models.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "No models were returned for this catalog page and search.";
        catalogList.append(empty);
      }
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-model-prepared-configuration]")) button.disabled = saving || loading;
  };
  const clearPrivate = (message = "Project model configuration was cleared. Refresh after the owner session is available."): void => {
    stopRequests();
    clearReadState();
    notice = message;
    if (projectId === undefined) notice = undefined;
    setBadge("NOT CHECKED", "unknown");
    render();
  };
  const refresh = (): void => {
    if (disposed || saving) return;
    if (projectId === undefined) { clearReadState(); notice = "Select a project in Library to read its saved model configurations."; render(); return; }
    if (!online()) { clearPrivate("Offline. Private project model configuration was cleared."); return; }
    const generation = options.deploymentGeneration();
    if (generation === undefined || generation === "" || generation === "unreachable") {
      clearReadState();
      configurationError = new ApiRequestError({ status: 503, code: "API_HTTP_UNAVAILABLE", message: "Deployment generation is unavailable" });
      notice = "Check the server before reading saved model configurations.";
      render();
      return;
    }
    serial += 1;
    const mine = serial;
    readController?.abort();
    const local = new AbortController();
    readController = local;
    loading = true;
    const projectAtStart = projectId;
    clearReadState();
    configurationError = undefined;
    catalogError = undefined;
    notice = "Reading saved project configuration and the descriptive catalog…";
    setBadge("CHECKING", "pending");
    render();
    const configurationPromise = readResearchProjectModelConfiguration(projectAtStart, generation, { limit: 50 }, local.signal);
    const catalogPromise = readResearchModelCatalog(projectAtStart, generation, { page: catalogPage, perPage: 20,
      ...(catalogProvider === WORKERS_AI_CATALOG_ADAPTER_ID ? {} : { providerId: catalogProvider }),
      ...(catalogSearch === "" ? {} : { search: catalogSearch }) }, local.signal);
    void Promise.allSettled([configurationPromise, catalogPromise]).then((results) => {
      if (mine !== serial || disposed || projectId !== projectAtStart || options.deploymentGeneration() !== generation) return;
      const [configurationResult, catalogResult] = results;
      if (configurationResult.status === "fulfilled") {
        configuration = configurationResult.value;
        selected = configuration.selected;
        revisions = [...configuration.revisions];
        nextRevisionCursor = configuration.next_cursor;
        choiceRef = selected?.configuration_ref ?? "";
      } else {
        configurationError = configurationResult.reason;
        if (isAuthorizationLoss(configurationError)) { clearPrivate("Sign in again to read saved project model configuration."); return; }
      }
      if (catalogResult.status === "fulfilled") catalog = catalogResult.value;
      else {
        catalogError = catalogResult.reason;
        if (isAuthorizationLoss(catalogError)) { clearPrivate("Sign in again to browse this project's model catalog."); return; }
      }
      notice = undefined;
      render();
    }).finally(() => {
      if (mine === serial) {
        readController = undefined;
        loading = false;
        render();
      }
    });
  };
  const readMoreRevisions = (): void => {
    if (disposed || saving || !projectId || !nextRevisionCursor) return;
    const generation = options.deploymentGeneration();
    if (!generation || generation === "unreachable") { refresh(); return; }
    const projectAtStart = projectId;
    const cursor = nextRevisionCursor;
    serial += 1;
    const readSerial = serial;
    readController?.abort();
    const local = new AbortController();
    readController = local;
    loading = true;
    moreRevisionsButton.disabled = true;
    void readResearchProjectModelConfiguration(projectAtStart, generation, { limit: 50, after: cursor }, local.signal)
      .then((page) => {
        if (readSerial !== serial || disposed || projectId !== projectAtStart || options.deploymentGeneration() !== generation) return;
        const refs = new Set(revisions.map((revision) => revision.configuration_ref));
        revisions.push(...page.revisions.filter((revision) => !refs.has(revision.configuration_ref)));
        configuration = Object.freeze({ ...page, revisions: Object.freeze([...revisions]) });
        selected = page.selected;
        choiceRef = selected?.configuration_ref ?? "";
        nextRevisionCursor = page.next_cursor;
        notice = undefined;
        render();
      }).catch((error: unknown) => {
        if (readSerial !== serial || disposed) return;
        if (isAuthorizationLoss(error)) { clearPrivate("Sign in again to read saved project model configuration."); return; }
        configurationError = error;
        render();
      }).finally(() => {
        if (readSerial === serial) { readController = undefined; loading = false; render(); }
      });
  };
  const readCatalogPage = (page: number): void => {
    if (disposed || saving || !projectId || !Number.isSafeInteger(page) || page < 1) return;
    if (!online()) { clearPrivate("Offline. Private project model configuration was cleared."); return; }
    const generation = options.deploymentGeneration();
    if (!generation || generation === "unreachable") { catalogError = new ApiRequestError({ status: 503, code: "API_HTTP_UNAVAILABLE", message: "Deployment generation is unavailable" }); render(); return; }
    serial += 1;
    const mine = serial;
    const projectAtStart = projectId;
    readController?.abort();
    const local = new AbortController();
    readController = local;
    loading = true;
    catalogPage = page;
    catalog = undefined;
    catalogError = undefined;
    setText(catalogStatus, "Reading the descriptive catalog…");
    render();
    void readResearchModelCatalog(projectAtStart, generation, { page, perPage: 20,
      ...(catalogProvider === WORKERS_AI_CATALOG_ADAPTER_ID ? {} : { providerId: catalogProvider }),
      ...(catalogSearch === "" ? {} : { search: catalogSearch }) }, local.signal)
      .then((result) => {
        if (mine !== serial || disposed || projectId !== projectAtStart || options.deploymentGeneration() !== generation) return;
        catalog = result;
        catalogError = undefined;
      }).catch((error: unknown) => {
        if (mine !== serial || disposed) return;
        if (isAuthorizationLoss(error)) { clearPrivate("Sign in again to browse this project's model catalog."); return; }
        catalogError = error;
      }).finally(() => {
        if (mine === serial) { readController = undefined; loading = false; render(); }
      });
  };
  const selectRevision = (revision: ResearchModelConfigurationRevision): void => {
    if (disposed || saving || !projectId || !configuration || !researchModelConfigurationIsSelectable(revision) ||
        revision.configuration_ref === selected?.configuration_ref) return;
    if (!configuration.revisions.some((item) => item.configuration_ref === revision.configuration_ref) &&
        !revisions.some((item) => item.configuration_ref === revision.configuration_ref)) return;
    if (!online()) { clearPrivate("Offline. Private project model configuration was cleared."); return; }
    const generation = options.deploymentGeneration();
    if (!generation || generation === "unreachable") { configurationError = new ApiRequestError({ status: 503, code: "API_HTTP_UNAVAILABLE", message: "Deployment generation is unavailable" }); render(); return; }
    const configurationAtStart = configuration;
    if (!configurationAtStart) return;
    const expectedRevision = configurationAtStart.selection_revision;
    const projectAtStart = projectId;
    const mine = serial;
    const local = new AbortController();
    writeController = local;
    saving = true;
    notice = "Saving this saved configuration for future runs…";
    render();
    void selectResearchProjectModelConfiguration(projectAtStart, generation, expectedRevision, revision.configuration_ref, local.signal)
      .then((receipt) => {
        if (mine !== serial || disposed || projectId !== projectAtStart || options.deploymentGeneration() !== generation) return;
        configuration = Object.freeze({ ...configurationAtStart, selection_revision: receipt.selection_revision,
          selected: receipt.selected, revisions: Object.freeze([...revisions]), next_cursor: nextRevisionCursor });
        selected = receipt.selected;
        choiceRef = receipt.selected.configuration_ref;
        if (!revisions.some((item) => item.configuration_ref === receipt.selected.configuration_ref)) revisions.push(receipt.selected);
        notice = "Saved. New runs use this project selection; started runs keep their original snapshot.";
        configurationError = undefined;
        notifyResearchModelSelectionSaved(element);
      }).catch((error: unknown) => {
        if (mine !== serial || disposed) return;
        if (isAuthorizationLoss(error)) { clearPrivate("Sign in again before selecting a saved model configuration."); return; }
        const copy = researchModelConfigurationErrorCopy(error);
        configurationError = undefined;
        if (error instanceof ApiRequestError && (error.code === "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT" ||
            error.code === "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED")) {
          notice = copy.summary;
          saving = false;
          writeController = undefined;
          refresh();
          return;
        }
        notice = copy.summary;
        catalogError = undefined;
        configurationError = error;
      }).finally(() => {
        if (mine === serial) {
          saving = false;
          writeController = undefined;
          render();
        }
      });
  };
  const onScopeChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ reason?: unknown; projectId?: unknown; title?: unknown }>).detail;
    if (detail?.reason !== "project-filter") return;
    const nextProject = typeof detail.projectId === "string" && detail.projectId.length > 0 ? detail.projectId : undefined;
    const nextTitle = nextProject !== undefined && typeof detail.title === "string" && detail.title.length > 0 ? detail.title : undefined;
    setProject(nextProject, nextTitle);
  };
  const setProject = (nextProject?: string, title?: string): void => {
    if (nextProject === projectId && title === projectTitle) return;
    stopRequests();
    projectId = nextProject;
    projectTitle = title;
    clearReadState();
    catalogPage = 1;
    catalogProvider = WORKERS_AI_CATALOG_ADAPTER_ID;
    notice = undefined;
    render();
    if (projectId !== undefined) refresh();
  };
  const onOffline = (): void => clearPrivate("Offline. Private project model configuration was cleared.");
  const onOnline = (): void => { notice = "Back online. Wait for the server check or refresh this panel."; render(); };
  const onAuthorizationCleared = (): void => clearPrivate("Sign in again before reading or changing this project's model selection.");

  const onChoiceChanged = (): void => { choiceRef = choice.value; render(); };
  const onSaveClick = (): void => {
    const revision = revisions.find((item) => item.configuration_ref === choiceRef);
    if (revision) selectRevision(revision);
  };
  const onMoreRevisionsClick = (): void => readMoreRevisions();
  const onSearchSubmit = (event: Event): void => {
    event.preventDefault();
    catalogSearch = searchInput.value.trim();
    catalogPage = 1;
    readCatalogPage(1);
  };
  const onProviderChanged = (): void => {
    catalogProvider = providerSelect.value;
    catalogPage = 1;
    readCatalogPage(1);
  };
  const onPreviousCatalog = (): void => readCatalogPage(catalogPage - 1);
  const onNextCatalog = (): void => {
    const next = catalog?.pagination.next_page;
    if (next !== null && next !== undefined) readCatalogPage(next);
  };

  refreshButton.addEventListener("click", refresh);
  choice.addEventListener("change", onChoiceChanged);
  saveButton.addEventListener("click", onSaveClick);
  moreRevisionsButton.addEventListener("click", onMoreRevisionsClick);
  searchForm.addEventListener("submit", onSearchSubmit);
  providerSelect.addEventListener("change", onProviderChanged);
  previousCatalogButton.addEventListener("click", onPreviousCatalog);
  nextCatalogButton.addEventListener("click", onNextCatalog);
  document.addEventListener("library:scope-changed", onScopeChanged);
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  render();

  return Object.assign(() => {
    disposed = true;
    stopRequests();
    document.removeEventListener("library:scope-changed", onScopeChanged);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    refreshButton.removeEventListener("click", refresh);
    choice.removeEventListener("change", onChoiceChanged);
    saveButton.removeEventListener("click", onSaveClick);
    moreRevisionsButton.removeEventListener("click", onMoreRevisionsClick);
    searchForm.removeEventListener("submit", onSearchSubmit);
    providerSelect.removeEventListener("change", onProviderChanged);
    previousCatalogButton.removeEventListener("click", onPreviousCatalog);
    nextCatalogButton.removeEventListener("click", onNextCatalog);
    setBadge("NOT CHECKED", "unknown");
    clearReadState();
    root.replaceChildren();
  }, { clearPrivate, refresh, setProject });
}
