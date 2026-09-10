import type {
  ArtifactRevision,
  ArtifactSectionRevision,
  ArtifactSpec,
  ObjectResidencyKey,
  OperationIntent,
  VersionedRef,
} from "@eliotr/contracts";
import type { ImmutableObjectReceipt } from "@eliotr/platform-cloudflare";

export type ArtifactDraftObjectKind =
  | "MANIFEST"
  | "SECTION_BODY"
  | "DEPENDENCY_MANIFEST"
  | "EVIDENCE_LEDGER"
  | "VERIFICATION_RECEIPT"
  | "EXPORT";

export interface ArtifactDraftSectionInput {
  readonly section: ArtifactSectionRevision;
  readonly bytes: Uint8Array;
  readonly residency: ObjectResidencyKey;
}

export interface ArtifactDraftReferencedObjectInput {
  readonly object_ref: string;
  readonly object_kind: Exclude<ArtifactDraftObjectKind, "MANIFEST" | "SECTION_BODY">;
  readonly bytes: Uint8Array;
  readonly residency: ObjectResidencyKey;
}

export interface PrepareArtifactDraftInput {
  readonly intent: OperationIntent;
  readonly topic?: string;
  readonly expected_draft_head_revision: number | null;
  readonly spec: ArtifactSpec;
  readonly revision: ArtifactRevision;
  readonly sections: readonly ArtifactDraftSectionInput[];
  readonly referenced_objects: readonly ArtifactDraftReferencedObjectInput[];
  readonly manifest_residency: ObjectResidencyKey;
}

export interface ArtifactDraftObjectReceipt {
  readonly object_ref: string;
  readonly object_kind: ArtifactDraftObjectKind;
  readonly section_ordinal: number | null;
  readonly residency: ObjectResidencyKey;
  readonly receipt: ImmutableObjectReceipt;
}

export interface PrepareArtifactDraftResult {
  readonly disposition: "CREATED" | "EXISTING";
  readonly artifact_ref: VersionedRef;
  readonly intent_ref: VersionedRef;
  readonly outbox_id: string;
  readonly draft_head_revision: number;
  readonly manifest: ArtifactDraftObjectReceipt;
  readonly objects: readonly ArtifactDraftObjectReceipt[];
}

export type ArtifactDraftErrorCode =
  | "ARTIFACT_DRAFT_INPUT_INVALID"
  | "ARTIFACT_DRAFT_IDEMPOTENCY_CONFLICT"
  | "ARTIFACT_DRAFT_HEAD_CONFLICT"
  | "ARTIFACT_DRAFT_R2_INTEGRITY"
  | "ARTIFACT_DRAFT_EFFECT_UNCERTAIN";

export class ArtifactDraftError extends Error {
  public readonly code: ArtifactDraftErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ArtifactDraftErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactDraftError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface PlannedObject {
  readonly object_ref: string;
  readonly object_kind: ArtifactDraftObjectKind;
  readonly section_ordinal: number | null;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly residency: ObjectResidencyKey;
  readonly residency_digest: string;
  readonly prefix: string;
  readonly content_type: string;
  readonly physical_key: string;
}

export interface ReservationRow {
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly artifact_revision: unknown;
  readonly request_sha256: unknown;
  readonly spec_digest: unknown;
  readonly manifest_r2_key: unknown;
  readonly expected_head_revision: unknown;
  readonly spec_ref_id: unknown;
  readonly spec_ref_revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly intent_json: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly planned_objects_json: unknown;
  readonly state: unknown;
}

export interface AuthorityRow {
  readonly intent_id: unknown;
  readonly revision: unknown;
  readonly operation_kind: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly policy_decision_ref: unknown;
  readonly budget_reservation_ref: unknown;
  readonly cancellation_ref: unknown;
  readonly created_at: unknown;
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_sha256: unknown;
}

export interface DraftBindingRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly expected_head_revision: unknown;
  readonly principal_ref: unknown;
  readonly spec_ref_id: unknown;
  readonly spec_ref_revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly manifest_sha256: unknown;
  readonly manifest_size_bytes: unknown;
  readonly created_at: unknown;
}

export interface DraftRevisionRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly kind: unknown;
  readonly spec_digest: unknown;
  readonly evidence_freeze_id: unknown;
  readonly evidence_freeze_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly dependency_manifest_ref: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
}

export interface DraftHeadRow {
  readonly artifact_id: unknown;
  readonly head_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly updated_at: unknown;
}

export interface DraftObjectRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly object_kind: unknown;
  readonly object_ref: unknown;
  readonly section_ordinal: unknown;
  readonly receipt_json: unknown;
  readonly residency_key_json: unknown;
  readonly residency_key_digest: unknown;
}
