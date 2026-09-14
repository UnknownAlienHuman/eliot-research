import { ApiRequestError, isAuthorizationLoss } from "./api.js";
import {
  readWikiProposal,
  readWikiProposalBody,
  type WikiProposalReadView,
} from "./wiki-api.js";
import { createWikiEditProposal } from "./wiki-edit-api.js";
import type { VersionedRef } from "@eliotr/contracts";

export interface WikiEditSavedView {
  readonly proposal: WikiProposalReadView;
  readonly bodyText: string;
}

export interface WikiEditFormOptions {
  readonly proposal: WikiProposalReadView;
  readonly bodyText: string;
  readonly deploymentGeneration: () => string | undefined;
  readonly healthReady: () => boolean;
  readonly onSaved: (view: WikiEditSavedView) => void;
}

type Operation = "idle" | "saving";

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (isAuthorizationLoss(error) || error.status === 403) return "Editing is unavailable under the current owner access policy.";
    if (error.status === 404) return "The base Wiki proposal is no longer available.";
    if (error.status === 413) return "This edit is too large to save as a Wiki draft. Shorten the page and try again.";
    if (error.code === "WIKI_HEAD_CONFLICT" || error.code === "WIKI_PROPOSAL_READBACK_MISMATCH") {
      return "The base page changed. Reopen the current proposal and start a new edit.";
    }
    if (error.code === "WIKI_INPUT_INVALID") return "Review the title, body, and edit note, then try again.";
    if (error.retryable || error.status === 409 || error.status === 503) return "The new Wiki draft could not be confirmed. Retry the same edit.";
  }
  return "The new Wiki draft could not be saved. Retry the same edit.";
}

function invalidReadback(): never {
  throw new ApiRequestError({ status: 502, code: "WIKI_EDIT_RESPONSE_INVALID", message: "Wiki edit readback is invalid" });
}

export function mountWikiEditForm(
  element: HTMLElement,
  options: WikiEditFormOptions,
): (() => void) & { clearPrivate(message?: string): void } {
  element.innerHTML = `<section class="wiki-edit-form" aria-label="Edit Wiki page">
    <button type="button" class="button button--quiet" data-wiki-edit-open>Edit page</button>
    <form class="wiki-publication-action" data-wiki-edit-form hidden>
      <label>Title<input type="text" data-wiki-edit-title maxlength="512" required></label>
      <label>Body<textarea data-wiki-edit-body rows="14" required></textarea></label>
      <label>Edit note <span>(optional)</span><textarea data-wiki-edit-note rows="3" maxlength="4096"></textarea></label>
      <div><button type="submit" class="button" data-wiki-edit-save>Save new draft</button> <button type="button" class="button button--quiet" data-wiki-edit-cancel>Cancel</button></div>
    </form>
    <p class="wiki-status" data-wiki-edit-status role="status" aria-live="polite">Edit the saved page to create a new proposal.</p>
  </section>`;
  const openButton = element.querySelector<HTMLButtonElement>("[data-wiki-edit-open]");
  const form = element.querySelector<HTMLFormElement>("[data-wiki-edit-form]");
  const titleInput = element.querySelector<HTMLInputElement>("[data-wiki-edit-title]");
  const bodyInput = element.querySelector<HTMLTextAreaElement>("[data-wiki-edit-body]");
  const noteInput = element.querySelector<HTMLTextAreaElement>("[data-wiki-edit-note]");
  const saveButton = element.querySelector<HTMLButtonElement>("[data-wiki-edit-save]");
  const cancelButton = element.querySelector<HTMLButtonElement>("[data-wiki-edit-cancel]");
  const status = element.querySelector<HTMLElement>("[data-wiki-edit-status]");
  if (!openButton || !form || !titleInput || !bodyInput || !noteInput || !saveButton || !cancelButton || !status) {
    throw new Error("Wiki edit form is incomplete");
  }

  const baseProposal = options.proposal.proposal_ref;
  const basePage = options.proposal.page.page_ref;
  const baseGeneration = options.proposal.deployment_generation;
  let operation: Operation = "idle";
  let editing = false;
  let disposed = false;
  let serial = 0;
  let controller: AbortController | undefined;
  let attemptFingerprint = "";
  let attemptKey: string | undefined;

  const currentGeneration = (): string | undefined => {
    const generation = options.deploymentGeneration();
    return generation === undefined || generation.length === 0 || generation === "unreachable" ? undefined : generation;
  };
  const ready = (): boolean => options.healthReady() && navigator.onLine && currentGeneration() === baseGeneration;
  const updateButtons = (): void => {
    const available = !disposed && ready();
    openButton.disabled = operation !== "idle" || !available;
    saveButton.disabled = operation !== "idle" || !editing || !available || titleInput.value.trim().length === 0 || bodyInput.value.length === 0;
    cancelButton.disabled = operation !== "idle";
    openButton.setAttribute("aria-expanded", String(editing));
  };
  const showEditor = (): void => {
    if (!ready()) {
      status.textContent = "The owner workspace is not ready. Refresh before editing this page.";
      updateButtons();
      return;
    }
    editing = true;
    form.hidden = false;
    openButton.hidden = true;
    titleInput.value = options.proposal.page.title;
    bodyInput.value = options.bodyText;
    noteInput.value = "";
    status.textContent = "Review the page, then save a new proposed draft.";
    updateButtons();
    titleInput.focus({ preventScroll: true });
  };
  const hideEditor = (): void => {
    editing = false;
    form.hidden = true;
    openButton.hidden = false;
    titleInput.value = options.proposal.page.title;
    bodyInput.value = options.bodyText;
    noteInput.value = "";
    updateButtons();
  };
  const clearPrivate = (message = "Wiki edit data cleared. Reopen the proposal to edit it again."): void => {
    serial += 1;
    controller?.abort();
    controller = undefined;
    operation = "idle";
    editing = false;
    attemptFingerprint = "";
    attemptKey = undefined;
    form.hidden = true;
    openButton.hidden = false;
    titleInput.value = "";
    bodyInput.value = "";
    noteInput.value = "";
    status.textContent = message;
    updateButtons();
  };

  const save = (): void => {
    if (disposed || operation !== "idle" || !editing) return;
    const generation = currentGeneration();
    if (!options.healthReady() || !navigator.onLine || generation === undefined) {
      status.textContent = "The owner workspace is not ready. Refresh before saving this draft.";
      updateButtons();
      return;
    }
    if (generation !== baseGeneration) {
      clearPrivate("The workspace changed. Reopen the current Wiki proposal before editing it.");
      return;
    }
    const title = titleInput.value;
    const bodyText = bodyInput.value;
    const editNote = noteInput.value;
    if (title.trim().length === 0 || bodyText.length === 0) {
      status.textContent = "Enter a title and body before saving the new draft.";
      updateButtons();
      return;
    }
    const fingerprint = JSON.stringify([baseProposal, basePage, basePage.revision, title, bodyText, editNote]);
    if (fingerprint !== attemptFingerprint || attemptKey === undefined) {
      attemptFingerprint = fingerprint;
      attemptKey = crypto.randomUUID();
    }
    const key = attemptKey;
    serial += 1;
    const mine = serial;
    const local = new AbortController();
    controller = local;
    operation = "saving";
    status.textContent = "Saving a new proposed Wiki draft…";
    updateButtons();
    void (async () => {
      const created = await createWikiEditProposal(baseProposal, basePage, basePage.revision, title, bodyText, editNote, generation, key, local.signal);
      if (disposed || mine !== serial) return;
      if (currentGeneration() !== generation) {
        clearPrivate("The workspace changed while saving. Reopen the current Wiki proposal.");
        return;
      }
      const proposal = await readWikiProposal(created.proposal_ref, generation, local.signal);
      const body = await readWikiProposalBody(proposal.proposal_ref, proposal.page.page_ref, proposal.page.body_sha256, generation, local.signal);
      if (disposed || mine !== serial) return;
      if (currentGeneration() !== generation) {
        clearPrivate("The workspace changed while reading the saved draft. Reopen the current Wiki proposal.");
        return;
      }
      if (!sameRef(created.proposal_ref, proposal.proposal_ref) || !sameRef(created.page_ref, proposal.page.page_ref) ||
          !sameRef(proposal.page.page_ref, { id: basePage.id, revision: basePage.revision + 1 }) ||
          proposal.state !== "PROPOSED" || proposal.risk_class !== "D2_ANALYTICAL" || proposal.page.status !== "DRAFT" ||
          proposal.page.supersedes_ref === undefined || !sameRef(proposal.page.supersedes_ref, basePage) ||
          proposal.page.title !== title || body.text !== bodyText) invalidReadback();
      if (disposed || mine !== serial || currentGeneration() !== generation) return;
      operation = "idle";
      controller = undefined;
      editing = false;
      attemptFingerprint = "";
      attemptKey = undefined;
      form.hidden = true;
      openButton.hidden = false;
      status.textContent = "New Wiki draft saved. Review it before publishing.";
      options.onSaved({ proposal, bodyText: body.text });
      updateButtons();
    })()
      .catch((error: unknown) => {
        if (disposed || mine !== serial || (error instanceof Error && error.name === "AbortError")) return;
        if (error instanceof ApiRequestError && (isAuthorizationLoss(error) || error.status === 403 || error.code === "WIKI_DEPLOYMENT_CHANGED")) {
          clearPrivate(error.status === 403 ? "Editing is unavailable under the current owner access policy." : "The workspace changed. Reopen the current Wiki proposal.");
          return;
        }
        status.textContent = errorText(error);
      })
      .finally(() => {
        if (mine === serial && controller === local) {
          controller = undefined;
          operation = "idle";
          updateButtons();
        }
      });
  };

  const cancel = (): void => {
    if (operation !== "idle") return;
    hideEditor();
    status.textContent = "Editing cancelled.";
  };
  const offline = (): void => clearPrivate("Offline. Wiki edit data was cleared.");
  const denied = (): void => clearPrivate("Authorization changed. Sign in again to edit this Wiki proposal.");
  const healthLost = (): void => clearPrivate("The owner workspace changed. Reopen the current Wiki proposal.");
  const healthUpdated = (): void => {
    if (currentGeneration() !== baseGeneration) {
      clearPrivate("The deployment changed. Reopen the current Wiki proposal.");
      return;
    }
    updateButtons();
  };

  openButton.onclick = showEditor;
  cancelButton.onclick = cancel;
  form.onsubmit = (event) => { event.preventDefault(); save(); };
  titleInput.oninput = updateButtons;
  bodyInput.oninput = updateButtons;
  noteInput.oninput = updateButtons;
  window.addEventListener("offline", offline);
  window.addEventListener("eliotr:authorization-cleared", denied);
  window.addEventListener("eliotr:health-lost", healthLost);
  window.addEventListener("eliotr:health-updated", healthUpdated);
  updateButtons();

  const cleanup = (): void => {
    disposed = true;
    serial += 1;
    controller?.abort();
    controller = undefined;
    operation = "idle";
    openButton.onclick = null;
    cancelButton.onclick = null;
    form.onsubmit = null;
    titleInput.oninput = null;
    bodyInput.oninput = null;
    noteInput.oninput = null;
    window.removeEventListener("offline", offline);
    window.removeEventListener("eliotr:authorization-cleared", denied);
    window.removeEventListener("eliotr:health-lost", healthLost);
    window.removeEventListener("eliotr:health-updated", healthUpdated);
    element.replaceChildren();
  };
  return Object.assign(cleanup, { clearPrivate });
}
