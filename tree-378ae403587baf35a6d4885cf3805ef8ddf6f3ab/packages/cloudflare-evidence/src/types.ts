import type {
  CitationResolutionReceipt,
  EffectCeiling,
  EvidenceAnchor,
  EvidenceHandle,
  EvidenceHandleTerminalState,
  EvidenceResolutionReceipt,
  InstructionTaint,
  LocatorCandidate,
  ResolvedEvidence,
  ScopeSnapshot,
  SourceAssurance,
  VersionedRef,
} from "@eliotr/contracts";

export type EvidenceRuntimeErrorCode =
  | "EVIDENCE_INPUT_INVALID"
  | "EVIDENCE_SCOPE_NOT_FOUND"
  | "EVIDENCE_SCOPE_INVALIDATED"
  | "EVIDENCE_SCOPE_EXPIRED"
  | "EVIDENCE_AUTHORIZATION_DENIED"
  | "EVIDENCE_SOURCE_NOT_FOUND"
  | "EVIDENCE_SOURCE_NOT_LIVE"
  | "EVIDENCE_OWNER_GENERATION_MISMATCH"
  | "EVIDENCE_SCOPE_MISMATCH"
  | "EVIDENCE_LOCATOR_NOT_RESOLVABLE"
  | "EVIDENCE_PRECISION_UNSUPPORTED"
  | "EVIDENCE_OBJECT_NOT_FOUND"
  | "EVIDENCE_OBJECT_INTEGRITY"
  | "EVIDENCE_RANGE_INVALID"
  | "EVIDENCE_HANDLE_NOT_FOUND"
  | "EVIDENCE_HANDLE_NOT_LIVE"
  | "EVIDENCE_IDENTITY_CONFLICT"
  | "EVIDENCE_SETTLEMENT_UNCERTAIN"
  | "CITATION_SET_INVALID";

export class EvidenceRuntimeError extends Error {
  public readonly code: EvidenceRuntimeErrorCode;
  public readonly retryable: boolean;
  public readonly invalidation_state?: Exclude<EvidenceHandleTerminalState, "LIVE">;

  public constructor(
    code: EvidenceRuntimeErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly invalidation_state?: Exclude<EvidenceHandleTerminalState, "LIVE">;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EvidenceRuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.invalidation_state !== undefined) this.invalidation_state = options.invalidation_state;
  }
}

export interface EvidenceAccessContext {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly credential_generation: string;
}

export interface ScopeAuthority {
  readonly snapshot: ScopeSnapshot;
  readonly invalidated_at: string | null;
  readonly invalidation_reason: string | null;
}

export interface ScopeAuthorization {
  readonly authorization_receipt_ref: string;
  readonly policy_authority_ref: string;
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly expires_at: string;
}

export interface EvidenceSourceAuthority {
  readonly source_id: string;
  readonly owner_system_id: string;
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
  readonly source_revision_ref: string;
  readonly source_title: string;
  readonly source_class: string;
  readonly content_sha256: string;
  readonly object_residency_key_digest: string;
  readonly normalized_artifact_ref: string;
  readonly purge_state: "LIVE" | "QUARANTINED" | "PURGE_REQUESTED" | "REDACTED" | "RETENTION_BLOCKED";
  readonly admission_receipt_ref: string;
  readonly source_assurance_ceiling: SourceAssurance;
  readonly instruction_taint: InstructionTaint;
  readonly allowed_effects: EffectCeiling;
  readonly allowed_use: readonly string[];
  readonly disclosure_ceiling: string;
  readonly admission_expires_at?: string;
}

export interface CandidateAnchorAuthority {
  readonly anchor: EvidenceAnchor;
  readonly item_key: string;
  readonly content_sha256: string;
  readonly coordinate_map_ref?: string;
  readonly projection_generation: string;
}

export interface MaterializedEvidenceExcerpt {
  readonly exact_excerpt: string;
  readonly excerpt_sha256: string;
  readonly excerpt_byte_length: number;
  readonly normalized_object_ref: string;
  readonly normalized_object_ref_digest: string;
  readonly source_object_size: number;
  readonly source_object_sha256: string;
}

export interface PersistEvidenceResolutionInput {
  readonly proposed_handle: EvidenceHandle;
  readonly identity_digest: string;
  readonly resolution_receipt: EvidenceResolutionReceipt;
  readonly resolution_receipt_json: string;
  readonly resolution_receipt_sha256: string;
  readonly normalized_object_ref: string;
  readonly authorization: ScopeAuthorization;
  readonly access: EvidenceAccessContext;
  readonly scope: ScopeAuthority;
  readonly source: EvidenceSourceAuthority;
}


export interface PersistCitationResolutionInput {
  readonly receipt: CitationResolutionReceipt;
  readonly receipt_json: string;
  readonly receipt_sha256: string;
  readonly access: EvidenceAccessContext;
  readonly scope: ScopeAuthority;
  readonly authorization: ScopeAuthorization;
}

export interface EvidenceAuthorityPort {
  loadScope(ref: VersionedRef): Promise<ScopeAuthority | null>;
  authorizeScope(
    scope: ScopeAuthority,
    access: EvidenceAccessContext,
  ): Promise<ScopeAuthorization>;
  loadSource(sourceRevisionRef: string): Promise<EvidenceSourceAuthority | null>;
  resolveCandidate(candidate: LocatorCandidate): Promise<CandidateAnchorAuthority>;
  loadHandle(ref: VersionedRef): Promise<EvidenceHandle | null>;
  persistResolution(input: PersistEvidenceResolutionInput): Promise<{
    readonly handle: EvidenceHandle;
    readonly receipt: EvidenceResolutionReceipt;
  }>;
  persistCitationReceipt(input: PersistCitationResolutionInput): Promise<CitationResolutionReceipt>;
  invalidateHandle(
    handle: EvidenceHandle,
    state: Exclude<EvidenceHandleTerminalState, "LIVE">,
    reasonCode: string,
    observedAt: string,
  ): Promise<EvidenceHandle>;
}

export interface EvidenceContentPort {
  materialize(
    source: EvidenceSourceAuthority,
    anchor: EvidenceAnchor,
  ): Promise<MaterializedEvidenceExcerpt>;
}

export interface EvidenceResolverDependencies {
  readonly authority: EvidenceAuthorityPort;
  readonly content: EvidenceContentPort;
  readonly now?: () => number;
}

export interface ResolveCandidateInput {
  readonly candidate: LocatorCandidate;
  readonly scope_snapshot_ref: VersionedRef;
  readonly access: EvidenceAccessContext;
}

export interface ResolveHandleInput {
  readonly handle_ref: VersionedRef;
  readonly expected_scope_snapshot_ref?: VersionedRef;
  readonly access: EvidenceAccessContext;
}

export interface CitationResolutionResult {
  readonly receipt: CitationResolutionReceipt;
  readonly resolved_evidence: readonly ResolvedEvidence[];
}

export interface CloudflareEvidenceResolver {
  resolveCandidate(input: ResolveCandidateInput): Promise<ResolvedEvidence>;
  resolveHandle(input: ResolveHandleInput): Promise<ResolvedEvidence>;
  resolveCitationSet(input: {
    readonly handle_refs: readonly VersionedRef[];
    readonly scope_snapshot_ref: VersionedRef;
    readonly access: EvidenceAccessContext;
  }): Promise<CitationResolutionResult>;
}
