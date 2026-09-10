import type { EvidenceHandle, VersionedRef } from "@eliotr/contracts";

export interface CodeSnapshotProfile {
  readonly profile_ref: VersionedRef;
  readonly repository_identity: string;
  readonly commit_sha: string;
  readonly file_manifest_ref: string;
  readonly symbol_index_ref?: string;
  readonly exact_path_search_ready: boolean;
}

export interface ScholarlyMetadataProfile {
  readonly profile_ref: VersionedRef;
  readonly doi?: string;
  readonly study_type?: string;
  readonly population_or_dataset?: string;
  readonly sample_size?: number;
  readonly primary_outcomes: readonly string[];
  readonly limitation_handles: readonly EvidenceHandle[];
}

export interface ConversationEpisodeProfile {
  readonly profile_ref: VersionedRef;
  readonly event_stream_ref: string;
  readonly problem: string;
  readonly hypothesis_refs: readonly string[];
  readonly attempt_refs: readonly string[];
  readonly result_or_failure_refs: readonly string[];
  readonly diagnosis_refs: readonly string[];
  readonly correction_refs: readonly string[];
  readonly decision_refs: readonly string[];
  readonly later_regression_refs: readonly string[];
}

export interface StructuredDataProfile {
  readonly profile_ref: VersionedRef;
  readonly schema_ref: string;
  readonly dataset_object_ref: string;
  readonly row_handle_strategy: string;
  readonly query_engine: "NONE" | "R2_SQL";
  readonly exact_row_reads_ready: boolean;
}
