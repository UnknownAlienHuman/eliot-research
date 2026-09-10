import type { ResolvedEvidence, VersionedRef } from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { verifyAndOpenEvidence } from "./evidence-api.js";

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

function renderVerified(detail: HTMLElement, opened: Awaited<ReturnType<typeof verifyAndOpenEvidence>>): void {
  const evidence = opened.evidence;
  const heading = document.createElement("h3"); heading.textContent = evidence.source_title ?? evidence.handle.source_revision_ref;
  const state = document.createElement("p"); state.className = "evidence-read-state";
  state.textContent = "Source excerpt verified";
  const source = document.createElement("pre"); source.className = "evidence-source"; source.textContent = opened.text;
  const metadata = document.createElement("div"); metadata.className = "evidence-meta";
  metadata.append(
    field("Revision", evidence.handle.source_revision_ref),
    field("Anchor", anchorText(evidence.handle.anchor)),
    field("Excerpt SHA-256", opened.excerptSha256),
    field("Verification", opened.verificationReceiptRef),
    field("Integrity", `${evidence.handle.terminal_state} · ${evidence.instruction_taint}`),
  );
  const note = document.createElement("p"); note.className = "evidence-note";
  note.textContent = "Matches the selected scope and source revision.";
  detail.replaceChildren(heading, state, source, metadata, note);
}

export function mountEvidenceRail(
  empty: HTMLElement,
  detail: HTMLElement,
  status: HTMLElement,
): EvidenceRailController {
  let serial = 0;
  let controller: AbortController | undefined;

  const clear = (): void => {
    serial += 1;
    controller?.abort(); controller = undefined;
    empty.hidden = false; detail.hidden = true; detail.replaceChildren();
    status.textContent = "QUERY RESULT";
  };

  const openHandle = (selectedScope: VersionedRef, handleRef: VersionedRef, expectedExcerptSha256?: string): void => {
    clear();
    const current = ++serial;
    controller = new AbortController();
    empty.hidden = true; detail.hidden = false; detail.replaceChildren(); status.textContent = "VERIFYING";
    const pending = document.createElement("p"); pending.className = "evidence-pending";
    pending.textContent = "Verifying pinned handle and reopening source bytes…";
    detail.append(pending);
    void verifyAndOpenEvidence(selectedScope, handleRef, controller.signal)
      .then((opened) => {
        if (current !== serial) return;
        if (expectedExcerptSha256 !== undefined && opened.excerptSha256 !== expectedExcerptSha256) throw new ApiRequestError({ status: 502, code: "EVIDENCE_RESPONSE_INVALID", message: "Opened evidence does not match the cited excerpt" });
        renderVerified(detail, opened); status.textContent = "VERIFIED";
      })
      .catch((error: unknown) => {
        if (current !== serial || (error instanceof Error && error.name === "AbortError")) return;
        detail.replaceChildren();
        const failure = document.createElement("p"); failure.className = "evidence-error"; failure.textContent = errorText(error);
        detail.append(failure); status.textContent = "UNAVAILABLE";
      });
  };

  const select = (evidence: ResolvedEvidence, scopeSnapshotRef?: VersionedRef): void => {
    const selectedScope = evidence.handle.scope_snapshot_ref;
    if (scopeSnapshotRef !== undefined && !sameRef(selectedScope, scopeSnapshotRef)) {
      clear(); status.textContent = "SCOPE CHANGED"; return;
    }
    openHandle(selectedScope, evidence.handle.handle_ref, evidence.handle.excerpt_sha256);
  };

  return { clear, select, selectHandle: openHandle, dispose: clear };
}
