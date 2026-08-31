import type { BundleAdmissionReceipt, NormalizedBundleManifest, ObjectResidencyKey, QualificationReport, SourceAdmissionDecision } from "@eliotr/contracts";
import type { BundlePromotionAuthorization, BundlePromotionReceipt } from "./ingest-types.js";
export type { BundlePromotionReceipt } from "./ingest-types.js";

export type IngestOperationState = "PREPARING" | "UPLOAD_REQUIRED" | "VERIFIED" | "AUTHORIZED" | "PROMOTED" | "COMMITTED" | "QUARANTINED" | "REJECTED";

export interface IngestAdmissionPolicySnapshot {
  readonly source_namespace_id: string;
  readonly revision: number;
  readonly authorized_principal_refs: readonly string[];
  readonly allowed_ownership_modes: readonly NormalizedBundleManifest["origin"]["ownership_mode"][];
  readonly source_class: string;
  readonly assurance_ceiling: SourceAdmissionDecision["assurance_ceiling"];
  readonly instruction_taint: SourceAdmissionDecision["instruction_taint"];
  readonly allowed_effects: SourceAdmissionDecision["allowed_effects"];
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly license_policy_ref: string;
  readonly default_storage_policy: string;
  readonly default_residency_profile_id: string;
  readonly default_retention_policy_id: string;
  readonly minimum_quality_state: NormalizedBundleManifest["quality"]["state"];
  readonly created_at: string;
}
export interface PreparedIngestOperation {
  readonly operation_id: string;
  readonly principal_ref: string;
  readonly origin_authentication_receipt_ref: string;
  readonly idempotency_key: string;
  readonly input_fingerprint: string;
  readonly manifest_sha256: string;
  readonly manifest: NormalizedBundleManifest;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
  readonly source_namespace_id: string;
  readonly owner_system_id: string;
  readonly source_owner_generation: string;
  readonly source_revision_ref: string;
  readonly source_id: string;
  readonly expected_head_revision_ref: string | null;
  readonly residency_key: ObjectResidencyKey;
  readonly residency_key_digest: string;
  readonly policy: IngestAdmissionPolicySnapshot;
  readonly policy_snapshot_sha256: string;
  readonly candidate_id: string;
  readonly staging_session_ref: string | null;
  readonly qualification_report_ref: string | null;
  readonly decision_receipt_ref: string | null;
  readonly promotion_receipt_ref: string | null;
  readonly state: IngestOperationState;
  readonly bundle_receipt: BundleAdmissionReceipt | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
}
export interface PrepareIngestAuthorityInput {
  readonly principal_ref: string;
  readonly origin_authentication_receipt_ref: string;
  readonly idempotency_key: string;
  readonly manifest: NormalizedBundleManifest;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
  readonly residency_key: ObjectResidencyKey;
}
export interface PrepareIngestAuthorityResult {
  readonly disposition: "CREATED" | "EXISTING";
  readonly operation: PreparedIngestOperation;
}
export interface RecordQualificationDecisionInput {
  readonly operation_id: string;
  readonly staging_session_ref: string;
  readonly qualification: QualificationReport;
  readonly decision: SourceAdmissionDecision;
}
export interface CommitAdmittedBundleInput {
  readonly operation_id: string;
  readonly staging_session_ref: string;
  readonly promotion_receipt: BundlePromotionReceipt;
  readonly bundle_receipt: BundleAdmissionReceipt;
}
export interface IngestAdmissionAuthority {
  prepare(input: PrepareIngestAuthorityInput): Promise<PrepareIngestAuthorityResult>;
  bindStagingSession(operationId: string, stagingSessionRef: string): Promise<PreparedIngestOperation>;
  load(operationId: string): Promise<PreparedIngestOperation | null>;
  loadForPrincipal(operationId: string, principalRef: string): Promise<PreparedIngestOperation | null>;
  recordQualificationDecision(input: RecordQualificationDecisionInput): Promise<PreparedIngestOperation>;
  finalizeNonAdmitted(operationId: string, receipt: BundleAdmissionReceipt): Promise<BundleAdmissionReceipt>;
  authorizePromotion(input: BundlePromotionAuthorization, admissionReceiptRef: string): Promise<boolean>;
  commitAdmitted(input: CommitAdmittedBundleInput): Promise<BundleAdmissionReceipt>;
}
