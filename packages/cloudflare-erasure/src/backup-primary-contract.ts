import type { ErasureFence, ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import type { BACKUP_R2_PAYLOAD_PROTOCOL } from "@eliotr/backup-o2";
import type {
  BackupPrimaryWriterQualificationInput,
  BackupPrimaryWriterQualificationReceipt,
} from "./types.js";
import type {
  BackupProducerQuiescenceSnapshot,
} from "./backup-producer-quiescence-contract.js";

export interface BackupEpochScopePart {
  readonly manifest: string;
  readonly index: number;
  readonly part_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface BackupEpochScopePayloadPart {
  readonly object_identity_digest: string;
  readonly index: number;
  readonly count: number;
  readonly part_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface BackupEpochScopeDraft {
  readonly epoch_id: string;
  readonly schema_generation: string;
  readonly migration_ledger_digest: string;
  readonly manifest_digests: Readonly<Record<string, string>>;
  readonly group_digests: Readonly<Record<string, string>>;
  readonly manifest_protocol: string;
  readonly part_index: readonly BackupEpochScopePart[];
  readonly r2_payload_protocol?: typeof BACKUP_R2_PAYLOAD_PROTOCOL;
  readonly payload_part_index?: readonly BackupEpochScopePayloadPart[];
  readonly purge_ledger_revision: number;
  readonly purge_ledger_digest: string;
  readonly r2_object_count: number;
  readonly r2_total_bytes: number;
  readonly audit_sample_receipt_ref: string;
  readonly vector_digest: string;
  readonly vector_manifest_digest: string;
  readonly cut_id: string;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface VerifiedBackupSourceRows {
  readonly source_rows: readonly { readonly table: string; readonly row: Readonly<Record<string, unknown>> }[];
}

export interface BackupEpochScopeArchive {
  readonly epoch_id: unknown;
  readonly verification_state: unknown;
  readonly read_draft_json: () => Promise<unknown>;
  readonly read_plaintext_part: (part: BackupEpochScopePart, draft: BackupEpochScopeDraft) => Promise<Uint8Array | null>;
}

export interface BackupEpochScopeSubject {
  readonly kind: "source" | "source-revision";
  readonly source_id: string;
  readonly source_owner_generation: string;
  readonly source_revision_ref?: string;
  readonly content_sha256?: string;
  readonly object_residency_key_digest?: string;
}

export type VerifyBackupEpochManifests = (input: {
  readonly draft: BackupEpochScopeDraft;
  readonly plaintext_parts: readonly { readonly manifest: string; readonly index: number; readonly bytes: Uint8Array }[];
}) => Promise<VerifiedBackupSourceRows>;

export interface BackupEpochScopeRequest {
  readonly subjects: readonly BackupEpochScopeSubject[];
  readonly archives: readonly BackupEpochScopeArchive[];
  readonly copy_authority_epoch_ids: readonly string[];
  readonly verify_manifests: VerifyBackupEpochManifests;
}

export interface BackupEpochScopePort {
  scopeBackupEpochsForSubjects(
    input: BackupEpochScopeRequest,
  ): Promise<readonly (readonly string[])[]>;
}

export interface BackupPrimaryObjectPin {
  readonly key: string;
  readonly epoch_id: string;
  readonly manifest: string;
  readonly part_index: number;
  readonly part_sha256: string;
  readonly payload_identity_digest?: string;
  readonly payload_part_count?: number;
  readonly size_bytes: number;
  readonly etag: string;
  readonly custom_metadata: Readonly<Record<string, string>>;
}

export interface BackupPrimaryPartInventorySnapshot {
  readonly object_count: number;
  readonly inventory_digest: string;
  readonly objects: readonly BackupPrimaryObjectPin[];
  readonly missing_keys: readonly string[];
}

export interface BackupEpochScopeInventory {
  readonly archives: readonly BackupEpochScopeArchive[];
  readonly copy_authority_epoch_ids: readonly string[];
  readonly primary_parts: BackupPrimaryPartInventorySnapshot;
}

export interface BackupExportCutPin {
  readonly cut_id: string;
  readonly cut_digest: string;
  readonly state: "OPEN" | "ACCEPTED" | "REJECTED";
}

export interface BackupExportCutInventory {
  readonly cuts: readonly BackupExportCutPin[];
  readonly inventory_digest: string;
}

export interface BackupPrimaryReplayHeader {
  readonly erasure_closure_digest: string;
  readonly producer_claims_digest: string;
  readonly canonical_epoch_count: number;
  readonly canonical_epochs_digest: string;
  readonly export_cut_inventory_digest: string;
}

export interface BackupPrimaryReplaySnapshot {
  readonly header: BackupPrimaryReplayHeader;
  readonly targets: ReadonlyMap<string, PurgeTarget>;
  readonly parts: readonly BackupPrimaryObjectPin[];
  readonly allowed_missing_keys: ReadonlySet<string>;
}

export interface BackupPrimaryClosureSealRequest {
  readonly now: () => number;
  readonly request: ErasureRequest;
  readonly fence: ErasureFence;
  readonly request_sha256: string;
  readonly closure_digest: string;
  readonly producer: BackupProducerQuiescenceSnapshot;
  readonly cuts: BackupExportCutInventory;
  readonly qualification: BackupPrimaryWriterQualificationReceipt;
  readonly primary_parts: BackupPrimaryPartInventorySnapshot;
  readonly targets: readonly PurgeTarget[];
}

export interface BackupPrimaryInventoryPort {
  readEpochScopeInventory(options?: {
    readonly allowed_missing_keys?: ReadonlySet<string>;
  }): Promise<BackupEpochScopeInventory>;
  readExportCutInventory(): Promise<BackupExportCutInventory>;
  loadReplay(input: {
    readonly fence: ErasureFence;
    readonly now_ms: number;
  }): Promise<BackupPrimaryReplaySnapshot | null>;
  sealClosure(input: BackupPrimaryClosureSealRequest): Promise<void>;
}

export function backupPrimaryQualificationInput(
  fence: ErasureFence,
  requestSha256: string,
  producer: BackupProducerQuiescenceSnapshot,
  cuts: BackupExportCutInventory,
  primary: BackupPrimaryPartInventorySnapshot,
): BackupPrimaryWriterQualificationInput {
  return {
    protocol: "eliotr.backup-primary-writer-qualification-input.v1",
    erasure_id: fence.erasure_id,
    revision: fence.revision,
    fence,
    request_sha256: requestSha256,
    producer_claim_count: producer.claim_count,
    producer_claims_digest: producer.claims_digest,
    export_cut_count: cuts.cuts.length,
    export_cut_inventory_digest: cuts.inventory_digest,
    primary_prefix_object_count: primary.object_count,
    primary_prefix_inventory_digest: primary.inventory_digest,
  };
}

export function toBackupPrimaryReplaySnapshot(input: {
  readonly header: BackupPrimaryReplayHeader;
  readonly targets: ReadonlyMap<string, PurgeTarget>;
  readonly parts: readonly BackupPrimaryObjectPin[];
  readonly allowed_missing_keys: ReadonlySet<string>;
}): BackupPrimaryReplaySnapshot {
  return input;
}
