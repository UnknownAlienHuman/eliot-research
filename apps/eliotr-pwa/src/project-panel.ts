import { ApiRequestError } from "./api.js";
import { escapeHtml } from "./html.js";
import { readLibraryPage } from "./library-api.js";
import {
  createProject,
  readProjects,
  updateProject,
  type ProjectMutationView,
  type ProjectSummary,
} from "./project-api.js";

interface ProjectPanelOptions {
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
  readonly onOpenProject: (projectId: string) => void;
}

export interface ProjectPanelHandle {
  refresh(): void;
  clearPrivate(): void;
}

interface AvailableSource {
  readonly id: string;
  readonly title: string;
}

interface EditorSource extends AvailableSource {
  readonly unavailable?: boolean;
}

interface EditorDraft {
  readonly title: string;
  readonly sourceIds: readonly string[];
}

function failureMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return "Projects could not be read. Try Refresh Projects.";
  if (error.code === "PROJECT_GENERATION_MISMATCH" || error.code === "API_GENERATION_MISMATCH") {
    return "The workspace changed. Refresh Projects to read the current list.";
  }
  if (error.code === "PROJECT_REVISION_CONFLICT" || error.code === "PROJECT_REVISION_STALE" || error.code === "PROJECT_STALE" || error.code === "PROJECT_CONFLICT") {
    return "This project changed elsewhere. Refresh Projects, then try again.";
  }
  if (error.code === "PROJECT_SOURCE_DENIED" || error.code === "PROJECT_SOURCE_NOT_READABLE" || error.code === "PROJECT_SOURCE_UNAVAILABLE") {
    return "One or more selected sources are no longer readable. Refresh and choose current sources.";
  }
  if (error.code === "PROJECT_SETTLEMENT_UNCERTAIN" || error.code === "PROJECT_PENDING" || error.code === "PROJECT_OPERATION_PENDING") {
    return "The project change is still settling. Refresh Projects to read its current state.";
  }
  if (error.code === "PROJECT_IDEMPOTENCY_CONFLICT") return "This save key is already bound to another change. Edit the project and try again.";
  if (error.code === "PROJECT_NOT_FOUND") return "This project is no longer available. Refresh Projects to read the current list.";
  if (error.status === 401 || error.status === 403 || error.code.startsWith("ACCESS_")) {
    return "Project access changed. Sign in again or renew the workspace read policy.";
  }
  return "Projects could not be read. Try Refresh Projects.";
}

function mutationMessage(result: ProjectMutationView): string {
  switch (result.state) {
    case "CREATED":
    case "UPDATED": return "Project saved.";
    case "PENDING": return "The project change is still settling. Refresh Projects to read its current state.";
    case "STALE": return "This project changed elsewhere. Refresh Projects, then try again.";
    case "DENIED": return "The selected sources are not currently available for this project.";
  }
}

export function mountProjectPanel(
  element: HTMLElement,
  options: ProjectPanelOptions,
): (() => void) & ProjectPanelHandle {
  element.innerHTML = `
    <section class="project-panel" aria-labelledby="project-panel-title">
      <div class="tool-heading"><div><span class="eyebrow">Projects</span><h2 id="project-panel-title">Organize your research</h2></div><button class="button button--quiet" type="button" data-project-refresh>Refresh Projects</button></div>
      <p class="project-intro">Create an empty project or organize the admitted sources you can currently read.</p>
      <p class="project-status" role="status" aria-live="polite">Waiting for the owner workspace.</p>
      <section class="project-list" data-project-list aria-label="Saved projects"></section>
      <button class="button button--quiet" type="button" data-project-more-projects hidden>Load more projects</button>
      <form class="project-editor" data-project-form>
        <div class="tool-heading"><div><span class="eyebrow">Project details</span><h3 data-project-editor-heading>New project</h3></div></div>
        <label>Project name<input data-project-title name="title" maxlength="512" autocomplete="off" required></label>
        <fieldset class="project-source-options"><legend>Admitted sources</legend><div data-project-sources></div></fieldset>
        <p class="project-source-note" data-project-source-note></p>
        <button class="button button--quiet" type="button" data-project-more-sources hidden>Load more sources</button>
        <div class="project-actions"><button class="button" type="submit" data-project-save>Save project</button><button class="button button--quiet" type="button" data-project-cancel hidden>Cancel editing</button></div>
      </form>
    </section>`;

  const refreshButton = element.querySelector<HTMLButtonElement>("[data-project-refresh]");
  const status = element.querySelector<HTMLElement>("[data-project-status]") ?? element.querySelector<HTMLElement>(".project-status");
  const list = element.querySelector<HTMLElement>("[data-project-list]");
  const moreProjectsButton = element.querySelector<HTMLButtonElement>("[data-project-more-projects]");
  const form = element.querySelector<HTMLFormElement>("[data-project-form]");
  const editorHeading = element.querySelector<HTMLElement>("[data-project-editor-heading]");
  const titleInput = element.querySelector<HTMLInputElement>("[data-project-title]");
  const sourceOptions = element.querySelector<HTMLElement>("[data-project-sources]");
  const sourceNote = element.querySelector<HTMLElement>("[data-project-source-note]");
  const moreSourcesButton = element.querySelector<HTMLButtonElement>("[data-project-more-sources]");
  const saveButton = element.querySelector<HTMLButtonElement>("[data-project-save]");
  const cancelButton = element.querySelector<HTMLButtonElement>("[data-project-cancel]");
  if (!refreshButton || !status || !list || !moreProjectsButton || !form || !editorHeading || !titleInput || !sourceOptions || !sourceNote || !moreSourcesButton || !saveButton || !cancelButton) {
    throw new Error("Project panel is incomplete");
  }

  let projects: readonly ProjectSummary[] = [];
  let availableSources: readonly AvailableSource[] = [];
  let editing: ProjectSummary | undefined;
  let editorSources: readonly EditorSource[] = [];
  let controller: AbortController | undefined;
  let serial = 0;
  let disposed = false;
  let operation: "idle" | "loading" | "loading-projects" | "loading-sources" | "saving" = "idle";
  let projectCursor: string | undefined;
  let catalogCursor: string | undefined;
  let attemptFingerprint = "";
  let attemptKey: string | undefined;

  const currentGeneration = (): string | undefined => {
    const generation = options.deploymentGeneration();
    return generation === undefined || generation.length === 0 ? undefined : generation;
  };

  const updateButtons = (): void => {
    const ready = options.healthReady() && navigator.onLine && currentGeneration() !== undefined;
    refreshButton.disabled = operation !== "idle" || !ready;
    moreProjectsButton.disabled = operation !== "idle" || !ready;
    moreProjectsButton.hidden = projectCursor === undefined;
    moreSourcesButton.disabled = operation !== "idle" || !ready;
    moreSourcesButton.hidden = catalogCursor === undefined;
    saveButton.disabled = operation !== "idle" || !ready || titleInput.value.trim().length === 0;
    cancelButton.disabled = operation !== "idle";
  };

  const renderList = (): void => {
    if (projects.length === 0) {
      list.innerHTML = "<p class=\"project-empty\">No projects yet. Create one to organize admitted sources.</p>";
      return;
    }
    list.innerHTML = projects.map((project, index) => {
      const count = project.source_ids.length;
      return `<article class="project-card"><div><h3>${escapeHtml(project.title)}</h3><p>${count === 0 ? "No sources yet" : `${count} admitted source${count === 1 ? "" : "s"}`}</p></div><div class="project-card-actions"><button class="button button--quiet" type="button" data-project-open="${index}">Open sources</button><button class="button button--quiet" type="button" data-project-edit="${index}">Edit</button></div></article>`;
    }).join("");
    for (const button of list.querySelectorAll<HTMLButtonElement>("[data-project-open]")) {
      button.onclick = () => {
        const project = projects[Number(button.dataset.projectOpen)];
        if (project !== undefined && operation === "idle" && !disposed) options.onOpenProject(project.project_id);
      };
    }
    for (const button of list.querySelectorAll<HTMLButtonElement>("[data-project-edit]")) {
      button.onclick = () => {
        const project = projects[Number(button.dataset.projectEdit)];
        if (project !== undefined && operation === "idle" && !disposed) {
          editing = project;
          attemptFingerprint = "";
          attemptKey = undefined;
          renderEditor();
          titleInput.focus({ preventScroll: true });
        }
      };
    }
  };

  const renderEditor = (draft?: EditorDraft): void => {
    const selectedIds = [...new Set([...(editing?.source_ids ?? []), ...(draft?.sourceIds ?? [])])];
    const selected = new Set(draft?.sourceIds ?? editing?.source_ids ?? []);
    editorSources = [
      ...availableSources,
      ...selectedIds
        .filter((id) => !availableSources.some((source) => source.id === id))
        .map((id) => ({ id, title: "Selected source", unavailable: true })),
    ];
    editorHeading.textContent = editing === undefined ? "New project" : "Edit project";
    titleInput.value = draft?.title ?? editing?.title ?? "";
    cancelButton.hidden = editing === undefined;
    sourceOptions.innerHTML = editorSources.length === 0
      ? "<p class=\"project-empty\">No currently readable admitted sources are available.</p>"
      : editorSources.map((source, index) => `<label class="project-source-option"><input type="checkbox" data-project-source="${index}"${selected.has(source.id) ? " checked" : ""}><span>${escapeHtml(source.title)}${source.unavailable ? " <em>Not shown in this page</em>" : ""}</span></label>`).join("");
    sourceNote.textContent = editorSources.length === 0
      ? "You can still save an empty project and add sources later."
      : catalogCursor === undefined
        ? "Only sources permitted by the current owner policy can be selected."
        : "Showing one page of currently readable sources. Load more sources to browse the next page.";
    updateButtons();
  };

  const clearOperation = (): void => {
    controller?.abort();
    controller = undefined;
    operation = "idle";
    updateButtons();
  };

  const clearPrivate = (message = "Project data cleared. Refresh Projects when the workspace is ready."): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
    operation = "idle";
    projects = [];
    availableSources = [];
    projectCursor = undefined;
    catalogCursor = undefined;
    editing = undefined;
    attemptFingerprint = "";
    attemptKey = undefined;
    renderList();
    renderEditor();
    status.textContent = message;
    updateButtons();
  };

  const load = async (): Promise<void> => {
    if (disposed) return;
    const generation = currentGeneration();
    if (!options.healthReady() || generation === undefined) {
      status.textContent = "Waiting for the owner workspace.";
      updateButtons();
      return;
    }
    if (!navigator.onLine) {
      clearPrivate("Offline. Project data is not cached.");
      return;
    }
    const preserveAttempt = attemptFingerprint.length > 0 && attemptKey !== undefined;
    const retainedDraft = preserveAttempt
      ? { title: titleInput.value, sourceIds: selectedSourceIds() }
      : undefined;
    serial += 1;
    const mine = serial;
    controller?.abort();
    controller = new AbortController();
    operation = "loading";
    projectCursor = undefined;
    if (!preserveAttempt) {
      editing = undefined;
      attemptFingerprint = "";
      attemptKey = undefined;
    }
    status.textContent = "Reading your projects…";
    updateButtons();
    try {
      const [received, catalog] = await Promise.all([
        readProjects(generation, undefined, controller.signal),
        readLibraryPage({ generation }, controller.signal),
      ]);
      if (mine !== serial || disposed || currentGeneration() !== generation) return;
      projects = received.projects;
      projectCursor = received.next_project_id;
      availableSources = catalog.sources.map((source) => ({ id: source.id, title: source.title }));
      catalogCursor = catalog.next_cursor;
      renderList();
      renderEditor(retainedDraft);
      status.textContent = projectCursor === undefined
        ? `${projects.length} project${projects.length === 1 ? "" : "s"} available.`
        : `${projects.length} projects loaded. Load more projects to continue.`;
    } catch (error) {
      if (mine !== serial || disposed) return;
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code.startsWith("ACCESS_") || error.code === "PROJECT_GENERATION_MISMATCH")) {
        clearPrivate(failureMessage(error));
        return;
      }
      status.textContent = failureMessage(error);
    } finally {
      if (mine === serial && !disposed) clearOperation();
    }
  };

  const loadMoreProjects = async (): Promise<void> => {
    if (disposed || operation !== "idle" || projectCursor === undefined) return;
    const generation = currentGeneration();
    if (!options.healthReady() || generation === undefined) {
      status.textContent = "Waiting for the owner workspace.";
      updateButtons();
      return;
    }
    if (!navigator.onLine) {
      clearPrivate("Offline. Project data is not cached.");
      return;
    }
    const cursor = projectCursor;
    const retainedDraft = { title: titleInput.value, sourceIds: selectedSourceIds() };
    serial += 1;
    const mine = serial;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    operation = "loading-projects";
    status.textContent = "Reading more projects…";
    updateButtons();
    try {
      const page = await readProjects(generation, cursor, signal);
      if (mine !== serial || disposed || currentGeneration() !== generation) return;
      const byId = new Map(projects.map((project) => [project.project_id, project]));
      for (const project of page.projects) byId.set(project.project_id, project);
      projects = [...byId.values()].sort((left, right) => left.project_id.localeCompare(right.project_id));
      projectCursor = page.next_project_id;
      renderList();
      renderEditor(retainedDraft);
      status.textContent = projectCursor === undefined
        ? `${projects.length} project${projects.length === 1 ? "" : "s"} available.`
        : `${projects.length} projects loaded. Load more projects to continue.`;
    } catch (error) {
      if (mine !== serial || disposed) return;
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code.startsWith("ACCESS_") || error.code === "PROJECT_GENERATION_MISMATCH")) {
        clearPrivate(failureMessage(error));
        return;
      }
      status.textContent = failureMessage(error);
    } finally {
      if (mine === serial && !disposed) clearOperation();
    }
  };

  const loadMoreSources = async (): Promise<void> => {
    if (disposed || operation !== "idle" || catalogCursor === undefined) return;
    const generation = currentGeneration();
    if (!options.healthReady() || generation === undefined) {
      status.textContent = "Waiting for the owner workspace.";
      updateButtons();
      return;
    }
    if (!navigator.onLine) {
      clearPrivate("Offline. Project data is not cached.");
      return;
    }
    const cursor = catalogCursor;
    const retainedDraft = { title: titleInput.value, sourceIds: selectedSourceIds() };
    serial += 1;
    const mine = serial;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    operation = "loading-sources";
    status.textContent = "Reading more admitted sources…";
    updateButtons();
    try {
      const page = await readLibraryPage({ cursor, generation }, signal);
      if (mine !== serial || disposed || currentGeneration() !== generation) return;
      const byId = new Map(availableSources.map((source) => [source.id, source]));
      for (const source of page.sources) byId.set(source.id, { id: source.id, title: source.title });
      availableSources = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
      catalogCursor = page.next_cursor;
      renderEditor(retainedDraft);
      status.textContent = "More currently readable sources loaded.";
    } catch (error) {
      if (mine !== serial || disposed) return;
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code.startsWith("ACCESS_") || error.code === "PROJECT_GENERATION_MISMATCH")) {
        clearPrivate(failureMessage(error));
        return;
      }
      status.textContent = failureMessage(error);
    } finally {
      if (mine === serial && !disposed) clearOperation();
    }
  };

  const selectedSourceIds = (): readonly string[] => {
    const values: string[] = [];
    for (const checkbox of sourceOptions.querySelectorAll<HTMLInputElement>("[data-project-source]")) {
      if (checkbox.checked) {
        const source = editorSources[Number(checkbox.dataset.projectSource)];
        if (source !== undefined) values.push(source.id);
      }
    }
    return [...new Set(values)].sort();
  };

  form.onsubmit = (event) => {
    event.preventDefault();
    if (operation !== "idle" || disposed) return;
    const generation = currentGeneration();
    if (!options.healthReady() || !navigator.onLine || generation === undefined) {
      status.textContent = "The owner workspace is not ready. Refresh Projects when it is available.";
      return;
    }
    const title = titleInput.value.trim();
    const sourceIds = selectedSourceIds();
    if (title.length === 0) {
      status.textContent = "Enter a project name.";
      titleInput.focus();
      return;
    }
    const fingerprint = JSON.stringify([editing?.project_id ?? null, editing?.revision ?? null, title, sourceIds]);
    if (attemptFingerprint !== fingerprint || attemptKey === undefined) {
      attemptFingerprint = fingerprint;
      attemptKey = crypto.randomUUID();
    }
    const key = attemptKey;
    if (key === undefined) return;
    const mine = ++serial;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    operation = "saving";
    status.textContent = editing === undefined ? "Saving project…" : "Saving project changes…";
    updateButtons();
    void (async () => {
      try {
        const result = editing === undefined
          ? await createProject(title, sourceIds, key, generation, signal)
          : await updateProject(editing.project_id, title, sourceIds, editing.revision, key, generation, signal);
        if (mine !== serial || disposed || currentGeneration() !== generation) return;
        status.textContent = mutationMessage(result);
        if (result.state === "CREATED" || result.state === "UPDATED") {
          editing = undefined;
          attemptFingerprint = "";
          attemptKey = undefined;
          void load();
        }
      } catch (error) {
        if (mine !== serial || disposed) return;
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403 || error.code.startsWith("ACCESS_") || error.code === "PROJECT_GENERATION_MISMATCH")) {
          clearPrivate(failureMessage(error));
          return;
        }
        status.textContent = failureMessage(error);
      } finally {
        if (mine === serial && !disposed) clearOperation();
      }
    })();
  };

  cancelButton.onclick = () => {
    if (operation !== "idle") return;
    editing = undefined;
    attemptFingerprint = "";
    attemptKey = undefined;
    renderEditor();
  };
  refreshButton.onclick = () => { void load(); };
  moreProjectsButton.onclick = () => { void loadMoreProjects(); };
  moreSourcesButton.onclick = () => { void loadMoreSources(); };
  const offline = () => clearPrivate("Offline. Project data is not cached.");
  const denied = () => clearPrivate("Authorization changed. Project data cleared.");
  window.addEventListener("offline", offline);
  window.addEventListener("eliotr:authorization-cleared", denied);
  renderList();
  renderEditor();
  void load();

  const cleanup = () => {
    disposed = true;
    serial += 1;
    controller?.abort();
    controller = undefined;
    window.removeEventListener("offline", offline);
    window.removeEventListener("eliotr:authorization-cleared", denied);
  };
  return Object.assign(cleanup, { refresh: () => { void load(); }, clearPrivate: () => clearPrivate() });
}
