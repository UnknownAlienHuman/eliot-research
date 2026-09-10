import type { ResolvedEvidence, RetrievalTrace, VersionedRef } from "@eliotr/contracts";
import type { RetrievalRequest } from "./ports.js";

export interface EvidencePack {
  readonly pack_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly resolved_evidence: readonly ResolvedEvidence[];
  readonly omitted_candidates: readonly { candidate_id: string; reason_code: string }[];
  readonly trace_ref: VersionedRef;
  readonly total_utf8_bytes: number;
}

export interface RetrievalResult {
  readonly evidence_pack: EvidencePack;
  readonly trace: RetrievalTrace;
  readonly coverage_claim: "NONE" | "SAMPLED" | "COMPLETE_SCOPE";
}

export interface RetrievalService {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
  verify(handleRef: VersionedRef, expectedScopeRef: VersionedRef): Promise<ResolvedEvidence>;
}
