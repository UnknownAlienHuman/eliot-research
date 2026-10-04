import type { ResolvedEvidence, VersionedRef } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { verifyAndOpenEvidence } from "./evidence-api.js";
import { readAdmittedDocument } from "./document-reader-api.js";
import { renderReadingMarkdown } from "./reading-markdown.js";

export interface EvidenceRailController {
  readonly clear: () => void;
  readonly select: (evidence: ResolvedEvidence, scopeSnapshotRef?: VersionedRef) => void;
  readonly selectHandle: (scopeSnapshotRef: VersionedRef, handleRef: VersionedRef, expectedExcerptSha256?: string) => void;
  readonly dispose: () => void;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return `${error.code}: ${error.message}${error.traceId ? ` · trace ${error.traceId}` : ""}`;
  return "Evidence could not be verified or opened. Retry after reconnecting.";
}

function field(label: string, value: string): HTMLSpanElement {
  const item = document.createElement("span");
  const title = document.createElement("b"); title.textContent = label;
  const code = document.createElement("code"); code.textContent = value;
  item.append(title, code);
  return item;
}

function anchorText(anchor: ResolvedEvidence["handle"]["anchor"]): string {
  if (anchor.kind === "normalized_byte_range") return `bytes ${anchor.start}–${anchor.end}`;
  if (anchor.kind === "normalized_line_range") return `lines ${anchor.start_line}–${anchor.end_line}`;
  return anchor.kind;
}

export function evidenceSourceTitle(sourceTitle: string | undefined): string {
  return sourceTitle ?? "Authorized source excerpt";
}

export function evidenceSourceRevisionText(sourceRevisionRef: string): string {
  return `Source revision: ${sourceRevisionRef}`;
}

export const EVIDENCE_INTEGRITY_NOTE = "This confirms that the excerpt bytes match the authorized handle and SHA-256. It does not assess any report claim; review the claim verdicts in the report.";

function renderVerified(detail: HTMLElement, opened: Awaited<ReturnType<typeof verifyAndOpenEvidence>>): HTMLElement {
  const evidence = opened.evidence;
  const heading = document.createElement("h3"); heading.textContent = evidenceSourceTitle(evidence.source_title);
  const revision = document.createElement("p"); revision.className = "evidence-source-revision"; revision.textContent = evidenceSourceRevisionText(evidence.handle.source_revision_ref);
  const state = document.createElement("p"); state.className = "evidence-read-state";
  state.textContent = "Excerpt bytes verified";
  const source = document.createElement("pre"); source.className = "evidence-source"; source.textContent = opened.text;
  const excerpt = document.createElement("div"); excerpt.className = "reading-view evidence-excerpt";
  const original = document.createElement("details"); original.className = "evidence-provenance";
  const originalSummary = document.createElement("summary"); originalSummary.textContent = "Original excerpt";
  original.append(originalSummary, source);
  const metadata = document.createElement("div"); metadata.className = "evidence-meta";
  metadata.append(
    field("Revision", evidence.handle.source_revision_ref),
    field("Anchor", anchorText(evidence.handle.anchor)),
    field("Excerpt SHA-256", opened.excerptSha256),
    field("Verification", opened.verificationReceiptRef),
    field("Handle and instruction state", `${evidence.handle.terminal_state} · ${evidence.instruction_taint}`),
  );
  const note = document.createElement("p"); note.className = "evidence-note";
  note.textContent = EVIDENCE_INTEGRITY_NOTE;
  const provenance = document.createElement("details"); provenance.className = "evidence-provenance";
  const summary = document.createElement("summary"); summary.textContent = "Revision and verification";
  provenance.append(summary, note, metadata);
  detail.replaceChildren(heading, revision, state, excerpt, original, provenance);
  return excerpt;
}

export function mountEvidenceRail(
  empty: HTMLElement,
  detail: HTMLElement,
  status: HTMLElement,
): EvidenceRailController {
  let serial = 0;
  let controller: AbortController | undefined;
  let returnFocus: HTMLElement | undefined;
  const rail = detail.closest<HTMLDialogElement>("dialog.panel--evidence");
  const app = detail.closest<HTMLElement>("#app");
  const sheetLayout = window.matchMedia("(max-width: 900px)");
  let returnPosition: { x: number; y: number; width: number } | undefined;
  const close = rail?.querySelector<HTMLButtonElement>("[data-close-evidence]");
  detail.tabIndex = -1;

  const focusOpenedEvidence = (): void => {
    if (rail && !rail.open) {
      if (sheetLayout.matches) rail.showModal(); else rail.show();
    }
    if (app) app.dataset.evidenceInspector = String(!sheetLayout.matches);
    rail?.setAttribute("aria-modal", String(sheetLayout.matches));
    close?.focus({ preventScroll: true });
  };
  const changePresentation = (): void => {
    if (!rail?.open) return;
    const focused = document.activeElement;
    rail.close();
    if (sheetLayout.matches) rail.showModal(); else rail.show();
    if (app) app.dataset.evidenceInspector = String(!sheetLayout.matches);
    rail.setAttribute("aria-modal", String(sheetLayout.matches));
    if (focused instanceof HTMLElement && rail.contains(focused)) focused.focus({ preventScroll: true });
  };

  const clear = (): void => {
    serial += 1;
    controller?.abort(); controller = undefined;
    empty.hidden = false; detail.hidden = true; detail.replaceChildren();
    status.textContent = "No excerpt selected";
    if (rail?.open) rail.close();
    if (app) delete app.dataset.evidenceInspector;
  };

  const openHandle = (selectedScope: VersionedRef, handleRef: VersionedRef, expectedExcerptSha256?: string): void => {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    returnPosition = { x: window.scrollX, y: window.scrollY, width: window.innerWidth };
    clear();
    const current = ++serial;
    controller = new AbortController();
    empty.hidden = true; detail.hidden = false; detail.replaceChildren(); status.textContent = "VERIFYING";
    const pending = document.createElement("p"); pending.className = "evidence-pending";
    pending.textContent = "Verifying pinned handle and reopening source bytes…";
    detail.append(pending);
    focusOpenedEvidence();
    void verifyAndOpenEvidence(selectedScope, handleRef, controller.signal)
      .then((opened) => {
        if (current !== serial) return;
        if (expectedExcerptSha256 !== undefined && opened.excerptSha256 !== expectedExcerptSha256) throw new ApiRequestError({ status: 502, code: "EVIDENCE_RESPONSE_INVALID", message: "Opened evidence does not match the cited excerpt" });
        const excerpt = renderVerified(detail, opened); status.textContent = "EXCERPT INTEGRITY VERIFIED";
        void renderReadingMarkdown(excerpt, opened.text, controller?.signal);
        const sourceActions = document.createElement("div"); sourceActions.className = "evidence-source-actions";
        const fullSource = document.createElement("button"); fullSource.type = "button"; fullSource.className = "button button--quiet";
        fullSource.textContent = "View full source";
        fullSource.onclick = () => {
          if (current !== serial || fullSource.disabled) return;
          const generation = document.querySelector<HTMLElement>("#app")?.dataset.healthGeneration;
          if (generation === undefined) { status.textContent = "Source unavailable. Refresh the workspace."; return; }
          controller?.abort(); const local = new AbortController(); controller = local;
          fullSource.disabled = true; status.textContent = "Reading full source.";
          void readAdmittedDocument(opened.evidence.handle.source_revision_ref, generation, local.signal)
            .then(async (admitted) => {
              if (current !== serial || local.signal.aborted || generation !== document.querySelector<HTMLElement>("#app")?.dataset.healthGeneration) return;
              const full = document.createElement("section"); full.className = "evidence-full-source";
              const heading = document.createElement("h3"); heading.textContent = "Full source"; heading.tabIndex = -1;
              const body = document.createElement("div"); body.className = "reading-view";
              const original = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "Original text";
              const raw = document.createElement("pre"); raw.className = "evidence-source"; raw.textContent = admitted.text;
              original.append(summary, raw); full.append(heading, body, original);
              const back = document.createElement("button"); back.type = "button"; back.className = "button button--quiet"; back.textContent = "Back to cited excerpt";
              back.onclick = () => {
                local.abort(); full.remove(); back.remove();
                for (const child of Array.from(detail.children)) if (child instanceof HTMLElement) child.hidden = false;
                fullSource.disabled = false; status.textContent = "EXCERPT INTEGRITY VERIFIED"; fullSource.focus({ preventScroll: true });
              };
              for (const child of Array.from(detail.children)) if (child instanceof HTMLElement) child.hidden = true;
              detail.append(back, full); heading.focus({ preventScroll: true });
              await renderReadingMarkdown(body, admitted.text, local.signal);
              if (current === serial && !local.signal.aborted) status.textContent = "Full admitted source opened.";
            })
            .catch((error: unknown) => {
              if (current !== serial || local.signal.aborted) return;
              fullSource.disabled = false; status.textContent = error instanceof ApiRequestError && (error.status === 401 || error.status === 403)
                ? "Full source access changed. Reopen the citation after signing in." : "Full source could not be read. The verified excerpt is still available.";
            });
        };
        sourceActions.append(fullSource); detail.append(sourceActions);
      })
      .catch((error: unknown) => {
        if (current !== serial || (error instanceof Error && error.name === "AbortError")) return;
        detail.replaceChildren();
        const failure = document.createElement("p"); failure.className = "evidence-error";
        failure.textContent = error instanceof ApiRequestError && (error.status === 401 || error.status === 403)
          ? "Source access changed. Check your session in Connections, then reopen this citation."
          : "This excerpt could not be verified. Reconnect and reopen the citation.";
        const diagnostics = document.createElement("details"); diagnostics.className = "evidence-provenance";
        const summary = document.createElement("summary"); summary.textContent = "Technical details";
        const reason = document.createElement("p"); reason.textContent = errorText(error);
        diagnostics.append(summary, reason);
        detail.append(failure, diagnostics); status.textContent = "UNAVAILABLE";
      });
  };

  const select = (evidence: ResolvedEvidence, scopeSnapshotRef?: VersionedRef): void => {
    const selectedScope = evidence.handle.scope_snapshot_ref;
    if (scopeSnapshotRef !== undefined && !sameRef(selectedScope, scopeSnapshotRef)) {
      clear(); status.textContent = "SCOPE CHANGED"; return;
    }
    openHandle(selectedScope, evidence.handle.handle_ref, evidence.handle.excerpt_sha256);
  };

  const dismiss = (): void => {
    clear();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    if (returnPosition?.width === window.innerWidth) window.scrollTo({ left: returnPosition.x, top: returnPosition.y, behavior: "instant" });
    returnPosition = undefined;
  };
  const cancel = (event: Event): void => { event.preventDefault(); dismiss(); };
  const escapeInspector = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && rail?.open && !sheetLayout.matches && !event.defaultPrevented) {
      event.preventDefault(); dismiss();
    }
  };
  const noteBackgroundInteraction = (event: Event): void => {
    if (rail?.open && event.target instanceof Node && !rail.contains(event.target)) returnPosition = undefined;
  };
  const noteBackgroundScrollKey = (event: KeyboardEvent): void => {
    if (["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"].includes(event.key)) noteBackgroundInteraction(event);
  };
  close?.addEventListener("click", dismiss);
  rail?.addEventListener("cancel", cancel);
  sheetLayout.addEventListener("change", changePresentation);
  document.addEventListener("keydown", escapeInspector);
  document.addEventListener("keydown", noteBackgroundScrollKey, true);
  document.addEventListener("pointerdown", noteBackgroundInteraction, true);
  document.addEventListener("wheel", noteBackgroundInteraction, { capture: true, passive: true });
  return { clear, select, selectHandle: openHandle, dispose: () => {
    clear(); close?.removeEventListener("click", dismiss);
    rail?.removeEventListener("cancel", cancel);
    sheetLayout.removeEventListener("change", changePresentation);
    document.removeEventListener("keydown", escapeInspector);
    document.removeEventListener("keydown", noteBackgroundScrollKey, true);
    document.removeEventListener("pointerdown", noteBackgroundInteraction, true);
    document.removeEventListener("wheel", noteBackgroundInteraction, true);
  } };
}
