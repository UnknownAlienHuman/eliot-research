import type {
  AbsenceVerificationReceipt,
  ErasureBlocker,
  ErasureDependencyClosure,
  ErasureFence,
  ErasureReceipt,
  ErasureRequest,
  PurgeAttemptReceipt,
  PurgeLocation,
  PurgeTarget,
} from "@eliotr/contracts";

export interface SourceRevisionInventoryRow {
  readonly source_revision_ref: string;
  readonly source_id: string;
  readonly original_r2_key?: string;
  readonly normalized_artifact_ref?: string;
  readonly content_sha256: string;
  readonly object_residency_key_digest: string;
  readonly purge_state: string;
}

export interface ProjectionInventoryRow {
  readonly source_revision_ref: string;
  readonly projection_generation: string;
  readonly work_manifest_ref?: string;
  readonly semantic_instance_id?: string;
  readonly semantic_generation?: string;
  readonly state: string;
}

export interface ProjectionItemInventoryRow {
  readonly item_key: string;
  readonly projection_generation: string;
}

export interface BackupEpochInventoryRow {
  readonly backup_epoch_id: string;
  readonly offsite_copy_ref: string;
  readonly purge_ledger_revision: number;
  readonly verification_state: string;
}

export interface RegisteredDependencyRow {
  readonly dependency_id: string;
  readonly exact_subject_ref: string;
  readonly location: PurgeLocation;
  readonly canonical_ref: string;
  readonly provider_ref?: string;
  readonly object_identity_digest: string;
  readonly shared_reference_key?: string;
  readonly retention_or_hold_ref?: string;
  readonly next_review_at?: string;
}

export interface ErasureInventoryPort {
  enumerate(request: ErasureRequest): Promise<ErasureDependencyClosure>;
}

export interface ErasureAuthorityPort {
  acquire(request: ErasureRequest): Promise<
    | { readonly disposition: "TERMINAL"; readonly receipt: ErasureReceipt }
    | { readonly disposition: "ACQUIRED"; readonly fence: ErasureFence }
  >;
  assertFence(fence: ErasureFence): Promise<void>;
  advance(
    fence: ErasureFence,
    expectedState: string,
    nextState: string,
    receiptRef: string,
    payloadDigest: string,
  ): Promise<void>;
  persistClosure(fence: ErasureFence, closure: ErasureDependencyClosure): Promise<void>;
  blockersFor(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
  ): Promise<readonly ErasureBlocker[]>;
  recordBlockedTarget(
    fence: ErasureFence,
    target: PurgeTarget,
    blocker: ErasureBlocker,
  ): Promise<void>;
  recordPurge(fence: ErasureFence, receipt: PurgeAttemptReceipt): Promise<void>;
  recordAbsence(fence: ErasureFence, receipt: AbsenceVerificationReceipt): Promise<void>;
  appendLedger(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
    completedTargets: readonly PurgeTarget[],
    blockers: readonly ErasureBlocker[],
  ): Promise<{ readonly ledger_entry_ref: string; readonly ledger_revision: number }>;
  recordInvalidations(
    fence: ErasureFence,
    invalidations: readonly ErasureDependentInvalidation[],
  ): Promise<void>;
  settle(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
    completedTargets: readonly PurgeTarget[],
    blockers: readonly ErasureBlocker[],
    ledger: { readonly ledger_entry_ref: string; readonly ledger_revision: number },
  ): Promise<ErasureReceipt>;
  fail(fence: ErasureFence, errorCode: string): Promise<void>;
}

export interface ErasureDependentInvalidation {
  readonly dependent_ref: string;
  readonly dependent_kind:
    | "EvidenceHandle"
    | "ScopeSnapshot"
    | "WikiRevision"
    | "ArtifactRevision"
    | "Investigation"
    | "ProjectionGeneration"
    | "RouteContinuation";
  readonly disposition: "REDACTED" | "PENDING_REVALIDATION" | "RETIRED" | "REVOKED";
  readonly receipt_ref: string;
}

export interface ErasureLocationPort {
  purge(
    request: ErasureRequest,
    fence: ErasureFence,
    target: PurgeTarget,
  ): Promise<PurgeAttemptReceipt>;
  verifyAbsent(
    request: ErasureRequest,
    fence: ErasureFence,
    target: PurgeTarget,
    purgeReceipt: PurgeAttemptReceipt,
  ): Promise<AbsenceVerificationReceipt>;
}

export interface ErasureLocationRegistry {
  forLocation(location: PurgeLocation): ErasureLocationPort | null;
}

export interface ErasureInvalidationPort {
  invalidate(
    request: ErasureRequest,
    fence: ErasureFence,
    closure: ErasureDependencyClosure,
    ledgerEntryRef: string,
  ): Promise<readonly ErasureDependentInvalidation[]>;
}

export interface BackupErasurePort {
  purge(epochRef: string, erasureRef: string): Promise<{ readonly receipt_ref: string }>;
  verifyAbsent(epochRef: string, erasureRef: string): Promise<{ readonly absent: boolean; readonly receipt_ref: string }>;
}

export interface ManagedSearchErasureItem {
  readonly id: string;
  readonly key: string;
}

export interface ManagedSearchErasurePage {
  readonly items: readonly ManagedSearchErasureItem[];
  readonly cursor?: string;
}

export interface ManagedSearchErasureInstance {
  list(cursor?: string): Promise<ManagedSearchErasurePage>;
  delete(itemId: string): Promise<void>;
  info(itemId: string): Promise<unknown | null>;
}

export interface ManagedSearchErasureNamespace {
  get(instanceId: string): ManagedSearchErasureInstance;
}
