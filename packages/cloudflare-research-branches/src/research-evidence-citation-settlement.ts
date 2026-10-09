import type { CitationResolutionReceipt } from "@eliotr/contracts";

const LEGACY_PROVEN_CITATION_REJECTIONS = new Set([
  "EVIDENCE_HANDLE_NOT_FOUND",
  "EVIDENCE_SCOPE_NOT_FOUND",
  "EVIDENCE_SCOPE_INVALIDATED",
  "EVIDENCE_SCOPE_EXPIRED",
  "EVIDENCE_AUTHORIZATION_DENIED",
  "EVIDENCE_SOURCE_NOT_FOUND",
  "EVIDENCE_OWNER_GENERATION_MISMATCH",
  "EVIDENCE_SCOPE_MISMATCH",
  "EVIDENCE_OBJECT_INTEGRITY",
]);

export type CitationReceiptSettlement = "SETTLED" | "PROVEN_INVALID" | "UNCERTAIN";

/** Resolve V2 outcomes, or conservatively classify legacy V1 rejection reasons. */
export function classifyCitationReceiptSettlement(
  receipt: CitationResolutionReceipt,
): CitationReceiptSettlement {
  if ("schema_version" in receipt && receipt.schema_version === 2) {
    if (receipt.outcomes.some((item) => item.outcome === "SOURCE_QUARANTINED" ||
        item.outcome === "VERIFY_UNAVAILABLE" || item.outcome === "STORAGE_UNAVAILABLE" ||
        item.outcome === "EFFECT_UNKNOWN")) return "UNCERTAIN";
    if (receipt.outcomes.some((item) => item.outcome !== "RESOLVED")) return "PROVEN_INVALID";
    return "SETTLED";
  }

  if (receipt.rejected.some((item) => !LEGACY_PROVEN_CITATION_REJECTIONS.has(item.reason_code))) {
    return "UNCERTAIN";
  }
  // V1 permits requested members with neither a resolution nor a rejection.
  // Their absence cannot establish that verification settled or evidence failed.
  if (receipt.resolved_count + receipt.rejected.length !== receipt.requested_count) {
    return "UNCERTAIN";
  }
  return receipt.rejected.length > 0 ? "PROVEN_INVALID" : "SETTLED";
}
