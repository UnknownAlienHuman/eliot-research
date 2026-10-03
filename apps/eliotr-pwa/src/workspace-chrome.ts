const READY_PROGRESS = "Ready to start a research run.";
const SELECTED_READY_MESSAGES = new Set([
  "Selected project ready for a research run.",
  "Selected source ready for a research run.",
]);
const DOCUMENT_LOADED_MESSAGE = "Normalized text loaded from the admitted document.";

export interface WorkspaceChromeController {
  setSourceChooserExpanded(expanded: boolean): void;
  sync(): void;
  dispose(): void;
}

function focusAndReveal(element: HTMLElement): void {
  element.scrollIntoView({ behavior: "smooth", block: "start" });
  element.focus({ preventScroll: true });
}

function restorePosition(node: Node, parent: Node | null, next: Node | null): void {
  if (parent === null || !parent.isConnected) return;
  parent.insertBefore(node, next?.parentNode === parent ? next : null);
}

/** Presentation-only DOM placement for the persistent library, reader, and report. */
export function mountWorkspaceChrome(root: HTMLElement): WorkspaceChromeController {
  const app = root.id === "app"
    ? root
    : root.closest<HTMLElement>("#app") ?? root.querySelector<HTMLElement>("#app") ?? root;
  const workspace = app.querySelector<HTMLElement>(".workspace");
  const dialog = app.querySelector<HTMLDialogElement>("dialog.library-drawer");
  const libraryNodes = app.querySelectorAll<HTMLElement>("#library");
  const library = libraryNodes.length === 1 ? libraryNodes[0] : null;
  const documentListHome = app.querySelector<HTMLElement>("#document-list-home");
  const chooser = app.querySelector<HTMLButtonElement>("[data-source-chooser-toggle]");
  const chooserState = app.querySelector<HTMLElement>("[data-source-chooser-state]");
  const closeLibrary = dialog?.querySelector<HTMLButtonElement>("[data-close-library]");
  const readingBack = app.querySelector<HTMLButtonElement>("[data-reading-back]");
  const reader = app.querySelector<HTMLElement>("[data-document-reader]");
  const readerStatus = reader?.querySelector<HTMLElement>("[data-document-reader-status]");
  const closeDocument = reader?.querySelector<HTMLButtonElement>("[data-close-document]");
  const researchRun = app.querySelector<HTMLElement>("#research-run");
  const searchTools = app.querySelector<HTMLElement>("#research-tools");
  const activity = app.querySelector<HTMLElement>("#research-changes-card");
  researchRun?.querySelector("[data-research-search-home]")?.append(...(searchTools ? [searchTools] : []));
  researchRun?.querySelector("[data-research-activity-home]")?.append(...(activity ? [activity] : []));
  const composer = researchRun?.querySelector<HTMLDetailsElement>(".research-composer");
  const toolsMenu = researchRun?.querySelector<HTMLDetailsElement>(".research-actions-menu");
  const result = researchRun?.querySelector<HTMLElement>("[data-run-result]");
  const badge = researchRun?.querySelector<HTMLElement>("[data-run-badge]");
  const progress = researchRun?.querySelector<HTMLElement>("[data-run-progress]");
  const feedbackNodes = researchRun
    ? [...researchRun.querySelectorAll<HTMLElement>(".workflow-action-feedback, [data-run-action-feedback]")]
    : [];
  const history = researchRun?.querySelector<HTMLDetailsElement>("[data-research-history]");
  const historySummary = history?.querySelector<HTMLElement>("summary");

  if (!workspace || !dialog || !library || !documentListHome) {
    throw new Error("Workspace chrome requires .workspace, a library dialog, one #library, and #document-list-home");
  }

  const originalLibraryParent = library.parentNode;
  const originalLibraryNext = library.nextSibling;
  const originalResultParent = result?.parentNode ?? null;
  const originalResultNext = result?.nextSibling ?? null;
  const originalComposerOpen = composer?.open ?? false;
  const originalLibraryTabIndex = library.getAttribute("tabindex");
  const originalReading = app.getAttribute("data-reading");
  const originalResearchReady = app.getAttribute("data-research-run-ready");
  const originalInputModality = app.getAttribute("data-input-modality");
  app.dataset.inputModality = "pointer";
  const notePointer = (): void => { app.dataset.inputModality = "pointer"; };
  const noteKeyboard = (event: KeyboardEvent): void => {
    if (!event.altKey && !event.ctrlKey && !event.metaKey) app.dataset.inputModality = "keyboard";
  };
  app.ownerDocument.addEventListener("pointerdown", notePointer, true);
  app.ownerDocument.addEventListener("keydown", noteKeyboard, true);
  const originalChooserExpanded = chooser?.getAttribute("aria-expanded") ?? null;
  const originalChooserState = chooserState?.textContent ?? null;
  const originalFeedbackHidden = feedbackNodes.map((node) => node.hidden);
  const quietFeedbackHidden = new Map<HTMLElement, boolean | "until-found">();
  let quietReaderStatusHidden: boolean | "until-found" | undefined;
  let disposed = false;
  let reportWasOpen = false;
  let returnFocus: HTMLElement | null = null;
  let restoreFocusOnClose = false;

  const inlineLibraryIsActive = (): boolean =>
    (workspace.dataset.activeView ?? "sources") === "sources" && (reader == null || reader.hidden !== false);

  const closeDialog = (restoreFocus: boolean): void => {
    if (!dialog.open) return;
    restoreFocusOnClose = restoreFocus;
    dialog.close();
  };

  const syncLibraryLocation = (): void => {
    if (inlineLibraryIsActive()) {
      if (dialog.open) closeDialog(false);
      if (library.parentElement !== documentListHome) documentListHome.append(library);
      return;
    }
    if (library.parentElement !== dialog) dialog.append(library);
  };

  const syncReportPlacement = (): void => {
    if (!result || !researchRun) return;
    const hasReport = !result.hidden && result.querySelector(".research-report-heading") !== null;
    if (hasReport) {
      if (composer?.parentElement === researchRun && result.parentElement === researchRun && result.nextElementSibling !== composer) {
        composer.before(result);
      }
      if (!reportWasOpen && composer) composer.open = false;
      reportWasOpen = true;
      return;
    }
    if (reportWasOpen) {
      if (composer?.parentElement === researchRun && result.parentElement === researchRun && composer.nextElementSibling !== result) {
        composer.after(result);
      }
      if (composer) composer.open = true;
    }
    reportWasOpen = false;
  };

  const syncReadingState = (): "document" | "report" | "false" => {
    const activeView = workspace.dataset.activeView ?? "sources";
    if (activeView === "sources" && reader != null && reader.hidden === false) return "document";
    if (activeView === "research" && result != null && result.hidden === false &&
        result.querySelector(".research-report-heading") !== null) return "report";
    return "false";
  };

  const syncQuietReadyState = (): void => {
    const ready = badge?.textContent === "READY" && progress?.textContent === READY_PROGRESS;
    if (ready) app.dataset.researchRunReady = "true";
    else delete app.dataset.researchRunReady;

    for (const feedback of feedbackNodes) {
      const shouldHide = SELECTED_READY_MESSAGES.has(feedback.textContent ?? "");
      if (shouldHide && !quietFeedbackHidden.has(feedback)) {
        quietFeedbackHidden.set(feedback, feedback.hidden);
        feedback.hidden = true;
      } else if (!shouldHide && quietFeedbackHidden.has(feedback)) {
        feedback.hidden = quietFeedbackHidden.get(feedback) ?? false;
        quietFeedbackHidden.delete(feedback);
      }
    }
    if (readerStatus != null) {
      const shouldHide = readerStatus.textContent === DOCUMENT_LOADED_MESSAGE;
      if (shouldHide && quietReaderStatusHidden === undefined) {
        quietReaderStatusHidden = readerStatus.hidden;
        readerStatus.hidden = true;
      } else if (!shouldHide && quietReaderStatusHidden !== undefined) {
        readerStatus.hidden = quietReaderStatusHidden;
        quietReaderStatusHidden = undefined;
      }
    }
  };

  const syncChooserState = (): void => {
    const inline = inlineLibraryIsActive();
    const expanded = inline || dialog.open;
    chooser?.setAttribute("aria-expanded", String(expanded));
    if (chooserState) {
      chooserState.textContent = inline ? "List in Documents" : dialog.open ? "Hide list" : "Show list";
    }
  };

  const focusInlineLibrary = (): void => {
    if (!library.hasAttribute("tabindex")) library.tabIndex = -1;
    focusAndReveal(library);
  };

  const sync = (): void => {
    if (disposed) return;
    syncReportPlacement();
    syncLibraryLocation();
    const reading = syncReadingState();
    app.dataset.reading = reading;
    if (readingBack) readingBack.hidden = reading === "false";
    syncQuietReadyState();
    syncChooserState();
  };

  const openLibrary = (): void => {
    if (disposed) return;
    sync();
    if (inlineLibraryIsActive()) {
      focusInlineLibrary();
      return;
    }
    if (!dialog.open && typeof dialog.showModal === "function") {
      const active = app.ownerDocument.activeElement;
      returnFocus = active instanceof HTMLElement ? active : chooser;
      restoreFocusOnClose = true;
      dialog.showModal();
    }
    syncChooserState();
  };

  const setSourceChooserExpanded = (expanded: boolean): void => {
    if (disposed) return;
    if (!expanded) {
      closeDialog(false);
      sync();
      return;
    }
    openLibrary();
  };

  const handleChooserClick = (): void => setSourceChooserExpanded(true);
  const handleCloseLibrary = (): void => {
    closeDialog(true);
    sync();
  };
  const handleDialogCancel = (): void => {
    restoreFocusOnClose = true;
    if (returnFocus === null) returnFocus = chooser;
  };
  const handleDialogClose = (): void => {
    const target = restoreFocusOnClose && returnFocus?.isConnected ? returnFocus : null;
    restoreFocusOnClose = false;
    returnFocus = null;
    sync();
    target?.focus({ preventScroll: true });
  };

  const handleReadingBack = (): void => {
    if ((workspace.dataset.activeView ?? "sources") === "sources" && reader != null && reader.hidden === false) {
      closeDocument?.click();
      closeDialog(false);
      sync();
      focusInlineLibrary();
      return;
    }
    if (syncReadingState() !== "report" || !result || !history || !historySummary) return;
    result.hidden = true;
    history.open = true;
    sync();
    focusAndReveal(historySummary);
  };

  chooser?.addEventListener("click", handleChooserClick);
  closeLibrary?.addEventListener("click", handleCloseLibrary);
  dialog.addEventListener("cancel", handleDialogCancel);
  dialog.addEventListener("close", handleDialogClose);
  readingBack?.addEventListener("click", handleReadingBack);
  const closeToolsWithEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && toolsMenu?.open) {
      event.preventDefault(); toolsMenu.open = false; toolsMenu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
  };
  toolsMenu?.addEventListener("keydown", closeToolsWithEscape);

  const observer = new MutationObserver(sync);
  observer.observe(workspace, { attributes: true, attributeFilter: ["data-active-view"] });
  if (reader) observer.observe(reader, { attributes: true, attributeFilter: ["hidden"] });
  if (readerStatus) observer.observe(readerStatus, { childList: true, characterData: true, subtree: true });
  if (result) observer.observe(result, { attributes: true, attributeFilter: ["hidden"], childList: true });
  if (badge) observer.observe(badge, { childList: true, characterData: true, subtree: true });
  if (progress) observer.observe(progress, { childList: true, characterData: true, subtree: true });
  for (const feedback of feedbackNodes) observer.observe(feedback, { childList: true, characterData: true, subtree: true });

  sync();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    app.ownerDocument.removeEventListener("pointerdown", notePointer, true);
    app.ownerDocument.removeEventListener("keydown", noteKeyboard, true);
    if (originalInputModality === null) delete app.dataset.inputModality;
    else app.setAttribute("data-input-modality", originalInputModality);
    chooser?.removeEventListener("click", handleChooserClick);
    closeLibrary?.removeEventListener("click", handleCloseLibrary);
    dialog.removeEventListener("cancel", handleDialogCancel);
    dialog.removeEventListener("close", handleDialogClose);
    readingBack?.removeEventListener("click", handleReadingBack);
    toolsMenu?.removeEventListener("keydown", closeToolsWithEscape);
    if (dialog.open) dialog.close();
    restorePosition(library, originalLibraryParent, originalLibraryNext);
    if (result) restorePosition(result, originalResultParent, originalResultNext);
    if (composer) composer.open = originalComposerOpen;
    if (originalLibraryTabIndex === null) library.removeAttribute("tabindex");
    else library.setAttribute("tabindex", originalLibraryTabIndex);
    if (originalReading === null) delete app.dataset.reading;
    else app.setAttribute("data-reading", originalReading);
    if (originalResearchReady === null) delete app.dataset.researchRunReady;
    else app.setAttribute("data-research-run-ready", originalResearchReady);
    if (chooser) {
      if (originalChooserExpanded === null) chooser.removeAttribute("aria-expanded");
      else chooser.setAttribute("aria-expanded", originalChooserExpanded);
    }
    if (chooserState && originalChooserState !== null) chooserState.textContent = originalChooserState;
    if (readerStatus != null && quietReaderStatusHidden !== undefined) readerStatus.hidden = quietReaderStatusHidden;
    feedbackNodes.forEach((node, index) => {
      if (quietFeedbackHidden.has(node)) node.hidden = quietFeedbackHidden.get(node) ?? originalFeedbackHidden[index] ?? false;
    });
  };

  return { setSourceChooserExpanded, sync, dispose };
}
