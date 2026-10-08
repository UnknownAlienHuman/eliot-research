import type { EvidenceHandle, ResolvedEvidence } from "./evidence.js";
import type { VersionedRef } from "./common.js";
import type { LocatorCandidate } from "./retrieval.js";

export type VerifyEvidenceRequest =
  | { readonly scope_snapshot_ref: VersionedRef; readonly locator_candidate: LocatorCandidate }
  | { readonly scope_snapshot_ref: VersionedRef; readonly handle_ref: VersionedRef };

export interface VerifyEvidenceResult {
  readonly resolved_evidence: ResolvedEvidence;
  readonly handle: EvidenceHandle;
}
