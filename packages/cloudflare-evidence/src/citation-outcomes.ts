import type {
  CitationResolutionOutcome,
  CitationResolutionRejection,
  VersionedRef,
} from "@eliotr/contracts";
import { EvidenceRuntimeError } from "./types.js";

/** Convert resolver failures into typed outcomes without treating uncertainty as rejection. */
export function citationOutcomeForError(
  handle_ref: VersionedRef,
  error: unknown,
): CitationResolutionOutcome {
  if (!(error instanceof EvidenceRuntimeError)) {
    return { handle_ref, outcome: "VERIFY_UNAVAILABLE" };
  }
  switch (error.code) {
    case "EVIDENCE_HANDLE_NOT_FOUND":
    case "EVIDENCE_SCOPE_MISMATCH":
      return { handle_ref, outcome: "INVALID_REFERENCE" };
    case "EVIDENCE_SCOPE_NOT_FOUND":
    case "EVIDENCE_SCOPE_INVALIDATED":
    case "EVIDENCE_SCOPE_EXPIRED":
    case "EVIDENCE_AUTHORIZATION_DENIED":
    case "EVIDENCE_SOURCE_NOT_FOUND":
    case "EVIDENCE_SOURCE_NOT_LIVE":
    case "EVIDENCE_OWNER_GENERATION_MISMATCH":
    case "EVIDENCE_HANDLE_NOT_LIVE":
      return { handle_ref, outcome: "AUTHORITY_REVOKED" };
    case "EVIDENCE_SOURCE_QUARANTINED":
      return { handle_ref, outcome: "SOURCE_QUARANTINED" };
    case "EVIDENCE_OBJECT_INTEGRITY":
    case "EVIDENCE_RANGE_INVALID":
    case "EVIDENCE_IDENTITY_CONFLICT":
      return { handle_ref, outcome: "CONTENT_MISMATCH" };
    case "EVIDENCE_OBJECT_NOT_FOUND":
    case "EVIDENCE_STORAGE_UNAVAILABLE":
      return { handle_ref, outcome: "STORAGE_UNAVAILABLE" };
    case "EVIDENCE_SETTLEMENT_UNCERTAIN":
      return { handle_ref, outcome: "EFFECT_UNKNOWN" };
    default:
      return { handle_ref, outcome: "VERIFY_UNAVAILABLE" };
  }
}

/** Only proof-bearing outcomes may enter the receipt's rejected projection. */
export function citationRejectionForOutcome(
  outcome: CitationResolutionOutcome,
): CitationResolutionRejection | null {
  switch (outcome.outcome) {
    case "INVALID_REFERENCE":
    case "AUTHORITY_REVOKED":
    case "CONTENT_MISMATCH":
      return { handle_ref: outcome.handle_ref, reason_code: outcome.outcome };
    default:
      return null;
  }
}
