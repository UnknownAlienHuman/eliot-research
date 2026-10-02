import type { ArtifactRevision, VersionedRef } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { acceptArtifact, readArtifactPublication, reviseArtifactSection, type ArtifactPublicationView } from "./artifact-product-api.js";
import { message } from "./research-run-view.js";

export interface ArtifactProductControlHooks {
  ready(): boolean;
  readyAfterAction(): boolean;
  begin(): AbortController;
  finish(controller: AbortController): void;
  failed(error: unknown): void;
  openArtifact(ref: VersionedRef): void;
}
export function createArtifactProductControls(artifact: ArtifactRevision, generation: string, actions: HTMLElement,
  heading: HTMLElement, hooks: ArtifactProductControlHooks, initial?: ArtifactPublicationView) {
  const state = document.createElement("p"); state.className = "research-publication-status"; state.setAttribute("role", "status");
  const accept = document.createElement("button"); accept.type = "button"; accept.className = "button button--quiet"; accept.textContent = "Accept report";
  const check = document.createElement("button"); check.type = "button"; check.className = "button button--quiet"; check.textContent = "Check acceptance";
  const display = (publication: ArtifactPublicationView | null): void => {
    const accepted = publication?.revision.status === "ACCEPTED" || publication?.revision.status === "SUPERSEDED";
    state.textContent = publication === null ? "This revision has no owner acceptance." : "Owner publication: " + publication.revision.status;
    const badge = heading.querySelector(".research-draft-badge"); if (badge !== null) badge.textContent = publication?.revision.status ?? "DRAFT";
    accept.dataset.reportActionUnavailable = String(accepted); accept.disabled = accepted;
  };
  state.textContent = "Owner acceptance has not been checked.";
  if (initial !== undefined) display(initial);
  const failure = (error: unknown): void => { hooks.failed(error); state.textContent = message(error); };
  check.onclick = () => {
    if (!hooks.ready()) return;
    const controller = hooks.begin();
    void readArtifactPublication(artifact.artifact_ref, generation, controller.signal)
      .then((publication) => { if (!controller.signal.aborted && hooks.readyAfterAction()) display(publication); })
      .catch(failure).finally(() => hooks.finish(controller));
  };
  accept.onclick = () => {
    if (!hooks.ready() || !window.confirm("Accept this exact report revision after reviewing its sections and sources?")) return;
    const controller = hooks.begin(); state.textContent = "Checking current authority and acceptance.";
    void (async () => {
      const head = await readArtifactPublication(artifact.artifact_ref, generation, controller.signal, true);
      if (controller.signal.aborted || !hooks.readyAfterAction()) return;
      if (head !== null && head.receipt.artifact_ref.revision === artifact.artifact_ref.revision && head.revision.status === "ACCEPTED") { display(head); return; }
      const publication = await acceptArtifact(artifact.artifact_ref, head?.receipt.publication_revision ?? null, generation, controller.signal);
      const readback = await readArtifactPublication(artifact.artifact_ref, generation, controller.signal);
      if (readback === null || readback.receipt.publication_ref !== publication.receipt.publication_ref || readback.revision.status !== "ACCEPTED") {
        throw new ApiRequestError({ status: 502, code: "ARTIFACT_PUBLICATION_READBACK_INVALID", message: "Acceptance could not be confirmed; check the same revision before retrying" });
      }
      if (!controller.signal.aborted && hooks.readyAfterAction()) display(readback);
    })().catch(failure).finally(() => hooks.finish(controller));
  };
  actions.append(accept, check, state);
  return { addSectionAction(sectionId: string, container: HTMLElement): void {
    const revise = document.createElement("button"); revise.type = "button"; revise.className = "button button--quiet"; revise.textContent = "Revise section";
    revise.onclick = () => {
      if (!hooks.ready()) return;
      const controller = hooks.begin(); state.textContent = "Revising and independently verifying this section.";
      void reviseArtifactSection(artifact.artifact_ref, sectionId, generation, controller.signal)
        .then((revision) => {
          if (controller.signal.aborted || !hooks.readyAfterAction()) return;
          if (revision.state === "COMMITTED" && revision.draft !== undefined) {
            hooks.finish(controller); hooks.openArtifact(revision.draft.artifact_ref);
          } else state.textContent = revision.state === "UNKNOWN"
            ? "The effect is uncertain and cannot be resolved automatically. Checking this section again only rereads the same durable outcome; no duplicate model call will be made."
            : revision.state === "CANCELLED" ? "Section revision was cancelled." : "Section revision is awaiting reconciliation. Check the same section again.";
        }).catch(failure).finally(() => hooks.finish(controller));
    };
    const sectionActions = document.createElement("div"); sectionActions.className = "research-citation-actions";
    sectionActions.append(revise); container.append(sectionActions);
  } };
}
