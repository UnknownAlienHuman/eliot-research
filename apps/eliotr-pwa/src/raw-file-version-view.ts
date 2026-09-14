import type {
  RawMarkdownConversionResult,
  RawNormalizedAdmissionResult,
  RawSourceVersionTarget,
} from "./raw-file-api.js";

export const SOURCE_VERSION_FORM_REQUESTED_EVENT = "eliotr:source-version-form-requested";

export interface SourceVersionRequest extends RawSourceVersionTarget {
  readonly source_title?: string;
}

const SOURCE_VERSION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export function parseSourceVersionRequest(event: Event): SourceVersionRequest | undefined {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return undefined;
  const values = detail as Record<string, unknown>;
  const targetSourceId = values.target_source_id;
  const expectedHeadRevisionRef = values.expected_head_revision_ref;
  if (typeof targetSourceId !== "string" || typeof expectedHeadRevisionRef !== "string" ||
      !SOURCE_VERSION_IDENTIFIER.test(targetSourceId) || !SOURCE_VERSION_IDENTIFIER.test(expectedHeadRevisionRef)) return undefined;
  const title = values.source_title;
  const validTitle = typeof title === "string" && title.length > 0 && title === title.trim() &&
    new TextEncoder().encode(title).byteLength <= 512 && !/[\u0000-\u001f\u007f]/u.test(title);
  return { target_source_id: targetSourceId, expected_head_revision_ref: expectedHeadRevisionRef,
    ...(validTitle ? { source_title: title } : {}) };
}

export function formatRawFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function rawFileReceiptCopy(recovered: boolean, versioned = false): string {
  return versioned
    ? `${recovered ? "Existing version upload found" : "File uploaded for the new version"}. Continue to process it before adding it to Library. The previous version remains available.`
    : `${recovered ? "Existing upload found" : "File uploaded"}. Continue to process it before adding it to Library.`;
}

export function rawFileProcessingCopy(result: RawMarkdownConversionResult): string {
  if (result.state === "COMPLETE") return "Processing complete. Ready to add to Library.";
  if (result.state === "STARTED") return "Processing started. Continue when processing is ready.";
  if (result.state === "UNKNOWN") return `Processing status is unknown (${result.failure_code}). Continue to check this step.`;
  return `Processing failed (${result.failure_code}). Retry processing to continue.`;
}

export function rawFileAdmissionCopy(result: RawNormalizedAdmissionResult, versionTarget?: RawSourceVersionTarget): string {
  if (result.state === "COMMITTED") {
    if (versionTarget !== undefined) {
      return result.admission_receipt?.decision === "DUPLICATE"
        ? "This version is already the selected source head. Previous versions remain available."
        : "New version added to Library. Previous versions remain available.";
    }
    return result.admission_receipt?.decision === "DUPLICATE"
      ? "This document is already in Library. Search readiness is reported separately."
      : "Added to Library. Search readiness is reported separately.";
  }
  if (result.state === "UNKNOWN") return "Library add status is unknown. Continue to check this step.";
  if (result.state === "QUARANTINED") return "Library did not accept this document after its quality checks. See Import details for the recorded reasons.";
  if (result.state === "REJECTED") return "Library rejected this document. See Import details for the recorded reasons.";
  return `Library add is ${result.state.toLowerCase()}. Continue when it is ready.`;
}

export function renderSourceVersionTarget(
  versionNode: HTMLElement,
  versionDetails: HTMLElement,
  versionTarget: SourceVersionRequest | undefined,
): void {
  versionNode.hidden = versionTarget === undefined;
  versionDetails.hidden = versionTarget === undefined;
  versionNode.textContent = versionTarget === undefined ? "" :
    `Adding a new version of ${versionTarget.source_title ?? "the selected document"}. The previous version remains available. Choose the replacement file.`;
  versionDetails.replaceChildren();
  if (versionTarget === undefined) return;
  const appendField = (label: string, value: string): void => {
    const term = document.createElement("dt"); term.textContent = label;
    const definition = document.createElement("dd"); const code = document.createElement("code");
    code.textContent = value; definition.append(code); versionDetails.append(term, definition);
  };
  appendField("Source", versionTarget.target_source_id);
  appendField("Expected head", versionTarget.expected_head_revision_ref);
}
