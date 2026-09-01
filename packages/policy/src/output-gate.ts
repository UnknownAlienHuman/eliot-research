import type {
  CitationResolutionReceipt,
  ClaimAuditItem,
  CompletionDisposition,
  EvidenceHandle,
  VersionedRef,
} from "@eliotr/contracts";

export interface PublicationCandidate {
  readonly candidate_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly claim_audit_items: readonly ClaimAuditItem[];
  readonly completion_disposition: CompletionDisposition;
  readonly citation_resolution_receipt: CitationResolutionReceipt;
  readonly contains_source_derived_policy_instruction: boolean;
  readonly authority_elevation_detected: boolean;
}

export interface OutputGateDecision {
  readonly publishable: boolean;
  readonly reason_codes: readonly string[];
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function claimHandles(items: readonly ClaimAuditItem[]): readonly EvidenceHandle[] {
  return items.flatMap((item) => [
    ...item.exact_support_handles,
    ...item.counterevidence_handles,
  ]);
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function evaluateOutputGate(candidate: PublicationCandidate): OutputGateDecision {
  const reasons: string[] = [];
  const receipt = candidate.citation_resolution_receipt;
  const handles = claimHandles(candidate.claim_audit_items);
  const expectedHandleKeys = handles.map((handle) => refKey(handle.handle_ref));
  const requestedHandleKeys = receipt.requested_handle_refs.map(refKey);
  const resolvedHandleKeys = receipt.resolved.map((item) => refKey(item.handle_ref));
  const scopeKey = refKey(candidate.scope_snapshot_ref);

  if (refKey(receipt.scope_snapshot_ref) !== scopeKey) reasons.push("CITATION_SCOPE_MISMATCH");
  if (handles.some((handle) => refKey(handle.scope_snapshot_ref) !== scopeKey)) {
    reasons.push("CITATION_SCOPE_MISMATCH");
  }
  if (handles.some((handle) => handle.terminal_state !== "LIVE")) reasons.push("NON_LIVE_CITATION");
  if (!exactSet(expectedHandleKeys, requestedHandleKeys)) reasons.push("CITATION_SET_MISMATCH");
  if (
    !receipt.all_material_citations_resolved ||
    receipt.rejected.length > 0 ||
    receipt.resolved_count !== receipt.requested_count ||
    !exactSet(requestedHandleKeys, resolvedHandleKeys)
  ) {
    reasons.push("CITATION_RESOLUTION_NOT_100_PERCENT");
  }

  const handleByKey = new Map(handles.map((handle) => [refKey(handle.handle_ref), handle]));
  if (receipt.resolved.some((item) => handleByKey.get(refKey(item.handle_ref))?.excerpt_sha256 !== item.excerpt_sha256)) {
    reasons.push("CITATION_DIGEST_MISMATCH");
  }
  if (candidate.contains_source_derived_policy_instruction) reasons.push("SOURCE_DERIVED_POLICY_INSTRUCTION");
  if (candidate.authority_elevation_detected) reasons.push("UNSUPPORTED_AUTHORITY_ELEVATION");
  if (candidate.claim_audit_items.some((item) => item.disposition === "UNSUPPORTED" || item.disposition === "CONTRADICTED")) {
    reasons.push("MATERIAL_CLAIM_FAILED_AUDIT");
  }
  return { publishable: reasons.length === 0, reason_codes: [...new Set(reasons)] };
}
