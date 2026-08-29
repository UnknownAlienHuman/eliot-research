import type { VersionedRef } from "@eliotr/contracts";

export type StewardTrigger =
  | "RETRIEVAL_MISS" | "OWNER_FEEDBACK" | "SOURCE_REVISION" | "ACCEPTED_DEEP_OR_REPORT"
  | "CORE_SOURCE" | "SUSPECTED_CONTRADICTION" | "STALE_WIKI_PAGE" | "SCHEDULED_HEALTH";

export interface StewardDeterministicReport {
  readonly checked_hashes: number;
  readonly invalid_evidence_handle_refs: readonly VersionedRef[];
  readonly missing_projection_refs: readonly string[];
  readonly duplicate_projection_refs: readonly string[];
  readonly stale_publication_refs: readonly VersionedRef[];
  readonly outbox_lag_seconds: number;
  readonly dlq_count: number;
  readonly overdue_erasure_refs: readonly VersionedRef[];
  readonly reason_codes: readonly string[];
}

export interface StewardProposal {
  readonly kind: "QUERY_HINT" | "ALIAS" | "EVIDENCE_ATOM" | "ATLAS_REFRESH" | "CONFLICT_CANDIDATE" | "RESEARCH_GAP" | "SECTION_REVALIDATION";
  readonly payload_ref: string;
  readonly effect_ceiling: "CANDIDATE_ONLY";
}

export interface ResearchSteward {
  runDeterministicContour(): Promise<StewardDeterministicReport>;
  proposeSemanticWork(trigger: StewardTrigger, subjectRef: string): Promise<readonly StewardProposal[]>;
}
