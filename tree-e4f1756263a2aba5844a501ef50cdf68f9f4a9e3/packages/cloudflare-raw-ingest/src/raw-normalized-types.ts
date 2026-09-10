import { SNAPSHOT_VIEW_PROTOCOL, SNAPSHOT_VIEW_REF_PREFIX, type NormalizedBundleManifest, type SnapshotViewWitness } from "@eliotr/contracts";
import type { PrepareBundleUploadRequest } from "@eliotr/interfaces";

export const RAW_NORMALIZED_CANDIDATE_PROTOCOL = "eliotr.raw-normalized-candidate.v1" as const;
export const RAW_NORMALIZED_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type SnapshotViewObservationFreshness = "observed_with_age" | "unknown";

/** The immutable, server-verified witness for a captured source observation. */
export { SNAPSHOT_VIEW_PROTOCOL, SNAPSHOT_VIEW_REF_PREFIX };
export type { SnapshotViewWitness };

export interface RawNormalizedCapture {
  readonly capture_id: string;
  readonly principal_ref: string;
  readonly owner_system_id: string;
  readonly source_namespace_id: string;
  readonly source_revision_ref: string;
  readonly source_logical_id: string;
  readonly source_owner_generation: string;
  readonly original_file_name: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
  readonly residency_key_digest: string;
}

export interface RawNormalizedConversion {
  readonly protocol: "eliotr.raw-markdown-conversion.v1";
  readonly state: "COMPLETE";
  readonly operation_id: string;
  readonly capture_id: string;
  readonly content_sha256: string;
  readonly output_sha256: string;
  readonly output_bytes: number;
  readonly detected_mime: string;
  readonly format: "markdown" | "text";
  readonly tokens: number;
}

export interface RawNormalizedOutputReadback {
  readonly object_key: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size_bytes: number;
}

export interface RawNormalizedResidencyAndDisclosure {
  readonly scope_domain_id: string;
  readonly access_domain_id: string;
  readonly confidentiality_domain_id: string;
  readonly encryption_key_domain_id: string;
  readonly retention_domain_id: string;
  readonly erasure_domain_id: string;
  readonly disclosure_ceiling: string;
  readonly allowed_use: readonly string[];
  readonly expiry?: string;
}

export interface RawNormalizedCandidatePolicy {
  readonly policy_snapshot_sha256: string;
  readonly policy_revision: number;
  readonly ownership_mode: "immutable_import" | "federated_reference" | "ownership_cutover";
  readonly origin_location_class: "local_only" | "cloud" | "external";
  readonly residency_and_disclosure: RawNormalizedResidencyAndDisclosure;
  readonly analyzer: string;
  readonly analyzer_version: string;
  readonly profile: string;
  readonly config_hash: string;
  readonly purpose: string;
  readonly workspace_view_revision_ref?: string;
  readonly ownership_cutover_receipt_ref?: string;
}

export interface RawNormalizedCandidateReaderInput {
  readonly capture: RawNormalizedCapture;
  readonly conversion: RawNormalizedConversion;
  readonly output: RawNormalizedOutputReadback;
  readonly snapshot_view: SnapshotViewWitness;
  readonly policy: RawNormalizedCandidatePolicy;
}

export interface RawNormalizedBundleCandidate {
  readonly protocol: typeof RAW_NORMALIZED_CANDIDATE_PROTOCOL;
  readonly candidate_ref: string;
  readonly capture_id: string;
  readonly conversion_operation_id: string;
  readonly source_view_ref: string;
  readonly output_object_key: string;
  readonly output_sha256: string;
  readonly output_bytes: number;
  readonly snapshot_view: SnapshotViewWitness;
  readonly manifest: NormalizedBundleManifest;
  readonly manifest_bytes: Uint8Array;
  readonly hashes_bytes: Uint8Array;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
}

export interface RawNormalizedAdmissionPreparation {
  readonly candidate: RawNormalizedBundleCandidate;
  readonly request: PrepareBundleUploadRequest;
}
