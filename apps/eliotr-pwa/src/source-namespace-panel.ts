import { ApiRequestError } from "./api.js";
import {
  createSourceNamespace,
  readSourceNamespaces,
  type CreatedSourceNamespace,
  type SourceNamespaceCatalog,
  type SourceNamespaceProfile,
  type SourceNamespaceSummary,
} from "./source-namespace-api.js";

export interface SourceNamespacePanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function privateFailure(error: unknown): boolean {
  return error instanceof ApiRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 409 || error.code === "API_GENERATION_MISMATCH");
}

function failureText(error: unknown, operation: "load" | "create"): string {
  if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) {
    return "Authorization changed. Sign in again before managing workspaces.";
  }
  if (error instanceof ApiRequestError && (error.status === 409 || error.code === "API_GENERATION_MISMATCH")) {
    return "The workspace changed. Refresh the page before managing workspaces.";
  }
  if (operation === "load") return "Workspaces could not be loaded. Choose Refresh to try again.";
  if (error instanceof ApiRequestError && error.code.includes("PROFILE")) {
    return "Workspace creation is not configured on this server.";
  }
  return "Workspace could not be created. Check the name and try again.";
}

function profileRefText(profile: SourceNamespaceProfile): string {
  return `${profile.profile_ref.id}@${profile.profile_ref.revision}`;
}

function selectedNamespace(
  namespaces: readonly SourceNamespaceSummary[],
  id: string | undefined,
): SourceNamespaceSummary | undefined {
  return id === undefined ? undefined : namespaces.find((namespace) => namespace.source_namespace_id === id);
}

/** Owner workspace chooser and creation flow for the Sources view. */
export function mountSourceNamespacePanel(
  element: HTMLElement,
  options: SourceNamespacePanelOptions,
): (() => void) & { clearPrivate(): void; refresh(): void } {
  element.innerHTML = `
    <div class="workflow-head">
      <div><span class="eyebrow">Workspace</span><h2>Choose a workspace</h2></div>
      <span class="workflow-badge" data-namespace-state>Waiting</span>
    </div>
    <p class="workflow-copy" data-namespace-intro>Choose where new documents should be added.</p>
    <section class="readiness-card" aria-labelledby="namespace-list-title">
      <div class="workflow-recovery-head"><div><span class="eyebrow">Existing workspaces</span><h3 id="namespace-list-title">Workspace</h3></div><button type="button" class="button button--quiet" data-namespace-refresh>Refresh</button></div>
      <label>Workspace<select data-namespace-select aria-label="Workspace"><option value="">Loading workspaces…</option></select></label>
      <p class="field-hint" data-namespace-list-copy>Workspaces appear after the owner service is ready.</p>
      <details data-namespace-details hidden><summary>Workspace details</summary><dl>
        <dt>Workspace ID</dt><dd><code data-namespace-id></code></dd>
        <dt>Profile</dt><dd><code data-namespace-profile-ref></code></dd>
      </dl></details>
    </section>
    <section class="readiness-card" aria-labelledby="namespace-create-title" data-namespace-create-section>
      <span class="eyebrow">New workspace</span><h3 id="namespace-create-title">Create a workspace</h3>
      <p class="field-hint" data-namespace-create-copy>Use a clear name so you can find this workspace when adding documents.</p>
      <details data-namespace-create-unavailable hidden><summary>Additional workspace</summary><p data-namespace-create-unavailable-copy>Additional workspace creation is unavailable on this server.</p></details>
      <form data-namespace-form>
        <label>Workspace name<input data-namespace-title name="workspace-title" maxlength="120" autocomplete="off" required placeholder="For example, Policy research"></label>
        <label data-namespace-profile-field>Profile<select data-namespace-profile name="profile" aria-label="Workspace profile"></select></label>
        <div class="workflow-actions"><button type="submit" class="button" data-namespace-create>Create workspace</button></div>
      </form>
    </section>
    <p class="workflow-status" role="status" aria-live="polite" data-namespace-status>Workspaces appear when the owner service is ready.</p>`;

  const stateNode = element.querySelector<HTMLElement>("[data-namespace-state]");
  const introNode = element.querySelector<HTMLElement>("[data-namespace-intro]");
  const refreshButton = element.querySelector<HTMLButtonElement>("[data-namespace-refresh]");
  const select = element.querySelector<HTMLSelectElement>("[data-namespace-select]");
  const listCopy = element.querySelector<HTMLElement>("[data-namespace-list-copy]");
  const details = element.querySelector<HTMLElement>("[data-namespace-details]");
  const namespaceIdNode = element.querySelector<HTMLElement>("[data-namespace-id]");
  const profileRefNode = element.querySelector<HTMLElement>("[data-namespace-profile-ref]");
  const form = element.querySelector<HTMLFormElement>("[data-namespace-form]");
  const titleInput = element.querySelector<HTMLInputElement>("[data-namespace-title]");
  const profileField = element.querySelector<HTMLElement>("[data-namespace-profile-field]");
  const profileSelect = element.querySelector<HTMLSelectElement>("[data-namespace-profile]");
  const createCopy = element.querySelector<HTMLElement>("[data-namespace-create-copy]");
  const createUnavailable = element.querySelector<HTMLDetailsElement>("[data-namespace-create-unavailable]");
  const createUnavailableCopy = element.querySelector<HTMLElement>("[data-namespace-create-unavailable-copy]");
  const createButton = element.querySelector<HTMLButtonElement>("[data-namespace-create]");
  const statusNode = element.querySelector<HTMLElement>("[data-namespace-status]");
  if (!stateNode || !introNode || !refreshButton || !select || !listCopy || !details || !namespaceIdNode ||
      !profileRefNode || !form || !titleInput || !profileField || !profileSelect || !createCopy || !createUnavailable ||
      !createUnavailableCopy || !createButton || !statusNode) {
    throw new Error("Source namespace panel is incomplete");
  }

  let disposed = false;
  let serial = 0;
  let controller: AbortController | undefined;
  let catalog: SourceNamespaceCatalog | undefined;
  let selectedId: string | undefined;
  let selectedProfile: SourceNamespaceProfile | undefined;
  let createProfileKey: string | undefined;
  let loadedGeneration: string | undefined;
  let statusMessage = "Workspaces appear when the owner service is ready.";
  let operation: "idle" | "loading" | "creating" = "idle";
  let attemptPayload: string | undefined;
  let attemptKey: string | undefined;

  const generation = (): string | undefined => {
    const value = options.deploymentGeneration();
    return value !== undefined && value !== "" && value !== "unreachable" && value !== "generation pending" ? value : undefined;
  };
  const canRequest = (): boolean => options.healthReady() && isOnline() && generation() !== undefined;
  const stop = (): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
    operation = "idle";
  };

  const dispatchSelection = (id: string, title: string): void => {
    element.dispatchEvent(new CustomEvent("eliotr:namespace-selected", {
      bubbles: true,
      detail: { sourceNamespaceId: id, title },
    }));
  };

  const dispatchSelectionClear = (): void => {
    element.dispatchEvent(new CustomEvent("eliotr:namespace-selected", {
      bubbles: true,
      detail: { sourceNamespaceId: "", title: "" },
    }));
  };

  const render = (): void => {
    const ready = canRequest();
    const namespaces = catalog?.namespaces ?? [];
    const profiles = catalog?.profiles ?? [];
    const setupMissing = catalog !== undefined && namespaces.length === 0 && profiles.length === 0;
    const existingWorkspaceWithoutProfile = catalog !== undefined && namespaces.length > 0 && profiles.length === 0;
    stateNode.textContent = operation === "loading" ? "Refreshing" : operation === "creating" ? "Creating" : setupMissing ? "Setup required" : ready ? "Ready" : "Waiting";
    introNode.textContent = setupMissing
      ? "No workspace is available yet. Server setup is required before adding documents."
      : ready
      ? "Choose where new documents should be added."
      : "The owner workspace is not ready yet. Check the server before choosing a workspace.";
    refreshButton.disabled = !ready || operation !== "idle";
    select.disabled = !ready || catalog === undefined || catalog.namespaces.length === 0;
    titleInput.disabled = !ready || operation !== "idle";
    profileSelect.disabled = !ready || operation !== "idle" || catalog?.profiles.length === 0;
    createButton.disabled = !ready || operation !== "idle" || catalog?.profiles.length === 0 || titleInput.value.trim().length === 0;
    form.hidden = existingWorkspaceWithoutProfile;
    createCopy.hidden = existingWorkspaceWithoutProfile;
    createUnavailable.hidden = !existingWorkspaceWithoutProfile;
    select.replaceChildren();
    if (namespaces.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = catalog === undefined ? "Loading workspaces…" : "No workspaces yet";
      select.append(option);
    } else {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a workspace";
      select.append(placeholder);
      for (const namespace of namespaces) {
        const option = document.createElement("option");
        option.value = namespace.source_namespace_id;
        option.textContent = namespace.title;
        select.append(option);
      }
      select.value = selectedId ?? "";
    }
    profileSelect.replaceChildren();
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profileRefText(profile);
      option.textContent = profile.title;
      profileSelect.append(option);
    }
    const profileKey = createProfileKey ?? (profiles[0] === undefined ? undefined : profileRefText(profiles[0]));
    if (profileKey !== undefined && profiles.some((profile) => profileRefText(profile) === profileKey)) {
      profileSelect.value = profileKey;
    }
    profileField.hidden = profiles.length <= 1;
    const chosen = selectedNamespace(namespaces, selectedId);
    details.hidden = chosen === undefined;
    namespaceIdNode.textContent = chosen?.source_namespace_id ?? "";
    profileRefNode.textContent = selectedProfile === undefined ? "" : profileRefText(selectedProfile);
    if (catalog === undefined) {
      listCopy.textContent = ready ? "Loading workspaces…" : "Workspaces appear after the owner service is ready.";
      createCopy.textContent = "Workspace creation options appear when the owner service is ready.";
    } else if (profiles.length === 0) {
      listCopy.textContent = namespaces.length === 0 ? "Setup is required: no workspace is available." : "Choose an existing workspace above.";
      createCopy.textContent = namespaces.length === 0
        ? "No server-installed profile is available to create a workspace."
        : "Additional workspace creation is unavailable on this server.";
      createUnavailableCopy.textContent = "Additional workspace creation is unavailable on this server. Use the existing workspace above.";
    } else {
      listCopy.textContent = namespaces.length === 0 ? "No workspaces have been created yet." : "Choose a workspace before adding a document.";
      createCopy.textContent = "Use a clear name so you can find this workspace when adding documents.";
    }
    statusNode.textContent = statusMessage;
    statusNode.setAttribute("aria-busy", operation === "idle" ? "false" : "true");
  };

  const clearPrivate = (message = "Workspace data cleared. Check the server before choosing a workspace."): void => {
    stop();
    catalog = undefined;
    selectedId = undefined;
    selectedProfile = undefined;
    createProfileKey = undefined;
    loadedGeneration = undefined;
    attemptPayload = undefined;
    attemptKey = undefined;
    statusMessage = message;
    render();
    dispatchSelectionClear();
  };

  const load = async (automatic = false): Promise<void> => {
    const currentGeneration = generation();
    if (!canRequest() || currentGeneration === undefined || operation !== "idle" ||
        (automatic && loadedGeneration === currentGeneration)) return;
    stop();
    const active = serial;
    const local = new AbortController();
    controller = local;
    operation = "loading";
    statusMessage = "Reading available workspaces…";
    render();
    try {
      const received = await readSourceNamespaces(currentGeneration, local.signal);
      if (disposed || active !== serial) return;
      if (generation() !== currentGeneration) {
        clearPrivate("The workspace changed. Refresh before choosing a workspace.");
        return;
      }
      catalog = received;
      loadedGeneration = received.deployment_generation;
      const chosen = selectedNamespace(received.namespaces, selectedId);
      const previousSelectedId = selectedId;
      if (chosen === undefined) {
        selectedId = undefined;
        selectedProfile = undefined;
        if (previousSelectedId !== undefined) dispatchSelectionClear();
      }
      if (createProfileKey === undefined || !received.profiles.some((profile) => profileRefText(profile) === createProfileKey)) {
        createProfileKey = received.profiles[0] === undefined ? undefined : profileRefText(received.profiles[0]);
      }
      if (selectedId === undefined && received.namespaces.length === 1) {
        const onlyNamespace = received.namespaces[0];
        if (onlyNamespace !== undefined) {
          selectedId = onlyNamespace.source_namespace_id;
          dispatchSelection(onlyNamespace.source_namespace_id, onlyNamespace.title);
        }
      }
      statusMessage = received.profiles.length === 0
        ? received.namespaces.length === 0
          ? "Setup required: no workspace is available and no server-installed profile is configured."
          : "Existing workspace available. Choose it or import a document."
        : "Choose a workspace or create one before adding a document.";
      render();
    } catch (error) {
      if (disposed || active !== serial || (error instanceof Error && error.name === "AbortError")) return;
      if (privateFailure(error)) clearPrivate(failureText(error, "load"));
      else { statusMessage = failureText(error, "load"); render(); }
    } finally {
      if (active === serial) { controller = undefined; operation = "idle"; render(); }
    }
  };

  const create = async (): Promise<void> => {
    if (!canRequest() || operation !== "idle" || catalog === undefined || catalog.profiles.length === 0) return;
    if (!form.reportValidity()) return;
    const chosenProfile = catalog.profiles.find((profile) => profileRefText(profile) === (createProfileKey ?? profileSelect.value)) ?? catalog.profiles[0];
    if (chosenProfile === undefined) return;
    const title = titleInput.value.trim();
    const payload = `${profileRefText(chosenProfile)}\u0000${title}`;
    if (attemptPayload !== payload || attemptKey === undefined) {
      attemptPayload = payload;
      attemptKey = crypto.randomUUID();
    }
    const currentGeneration = generation();
    if (currentGeneration === undefined || attemptKey === undefined) return;
    stop();
    const active = serial;
    const local = new AbortController();
    controller = local;
    operation = "creating";
    statusMessage = "Creating the workspace…";
    render();
    try {
      const created = await createSourceNamespace(chosenProfile.profile_ref, title, attemptKey, currentGeneration, local.signal);
      if (disposed || active !== serial) return;
      if (generation() !== currentGeneration) {
        clearPrivate("The workspace changed. Refresh before choosing a workspace.");
        return;
      }
      applyCreated(created, chosenProfile);
    } catch (error) {
      if (disposed || active !== serial || (error instanceof Error && error.name === "AbortError")) return;
      if (privateFailure(error)) clearPrivate(failureText(error, "create"));
      else { statusMessage = failureText(error, "create"); render(); }
    } finally {
      if (active === serial) { controller = undefined; operation = "idle"; render(); }
    }
  };

  const applyCreated = (created: CreatedSourceNamespace, profile: SourceNamespaceProfile): void => {
    const previousSelectedId = selectedId;
    const currentCatalog = catalog;
    if (currentCatalog !== undefined) {
      catalog = {
        ...currentCatalog,
        namespaces: [...currentCatalog.namespaces.filter((namespace) => namespace.source_namespace_id !== created.source_namespace_id), {
          source_namespace_id: created.source_namespace_id,
          title: created.title,
        }],
      };
    }
    selectedId = created.source_namespace_id;
    selectedProfile = profile;
    titleInput.value = "";
    attemptPayload = undefined;
    attemptKey = undefined;
    statusMessage = `Workspace “${created.title}” created and selected.`;
    render();
    if (previousSelectedId !== created.source_namespace_id) dispatchSelection(created.source_namespace_id, created.title);
  };

  select.onchange = () => {
    const id = select.value;
    const namespace = selectedNamespace(catalog?.namespaces ?? [], id);
    if (namespace === undefined) {
      const previousSelectedId = selectedId;
      selectedId = undefined;
      selectedProfile = undefined;
      statusMessage = "Choose a workspace before adding a document.";
      render();
      if (previousSelectedId !== undefined) dispatchSelectionClear();
      return;
    }
    selectedId = namespace.source_namespace_id;
    selectedProfile = undefined;
    statusMessage = `Workspace “${namespace.title}” selected.`;
    render();
    dispatchSelection(namespace.source_namespace_id, namespace.title);
  };
  titleInput.oninput = () => render();
  profileSelect.onchange = () => {
    createProfileKey = profileSelect.value || undefined;
    render();
  };
  refreshButton.onclick = () => { void load(false); };
  form.onsubmit = (event) => { event.preventDefault(); void create(); };

  const onOffline = (): void => clearPrivate("Workspace data cleared while offline. Reconnect before managing workspaces.");
  const onAuthorizationCleared = (): void => clearPrivate("Authorization changed. Workspace data was cleared; sign in again before retrying.");
  const onHealthLost = (): void => clearPrivate("The workspace changed. Workspace data was cleared; check the server before managing workspaces.");
  const onHealthUpdated = (): void => {
    const currentGeneration = generation();
    if (!options.healthReady() || !isOnline() || currentGeneration === undefined) {
      if (catalog !== undefined || selectedId !== undefined) clearPrivate();
      else render();
      return;
    }
    if (loadedGeneration !== undefined && loadedGeneration !== currentGeneration) {
      clearPrivate("The workspace changed. Refresh before choosing a workspace.");
      return;
    }
    render();
    if (catalog === undefined && operation === "idle") void load(true);
  };
  const onPageHide = (): void => clearPrivate("Workspace data cleared when the page was closed.");
  window.addEventListener("offline", onOffline);
  window.addEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
  window.addEventListener("pagehide", onPageHide);
  const app = element.closest("#app");
  app?.addEventListener("eliotr:health-lost", onHealthLost);
  app?.addEventListener("eliotr:health-updated", onHealthUpdated);
  if (canRequest()) void load(true);
  render();

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    stop();
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("eliotr:authorization-cleared", onAuthorizationCleared);
    window.removeEventListener("pagehide", onPageHide);
    app?.removeEventListener("eliotr:health-lost", onHealthLost);
    app?.removeEventListener("eliotr:health-updated", onHealthUpdated);
    element.replaceChildren();
  };
  return Object.assign(cleanup, { clearPrivate, refresh: () => { void load(false); } });
}
