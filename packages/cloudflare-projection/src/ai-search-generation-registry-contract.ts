import type {
  AiSearchGenerationDeclaration,
  AiSearchGenerationArchiveRequest,
  AiSearchGenerationRecord,
  AiSearchGenerationRegistry,
  AiSearchGenerationState,
  AiSearchPromotionRequest,
  AiSearchRollbackRequest,
  AiSearchShadowObservation,
} from "./ai-search-generation.js";
import type {
  ManagedGenerationArchiveAuthorizationRequest,
  ManagedGenerationArchiveAuthorizationV1,
  ManagedGenerationCurrentAuthorityV1,
  ManagedGenerationDesiredManifestReadback,
  ManagedGenerationPromotionEvidenceAuthorityPort,
  ManagedGenerationPromotionEvidenceV2,
  ManagedGenerationPromotionHoldRequest,
  ManagedGenerationPromotionHoldV1,
  ManagedGenerationPromotionTarget,
} from "./managed-generation-promotion-evidence.js";

export type {
  ManagedGenerationArchiveAuthorizationRequest,
  ManagedGenerationArchiveAuthorizationV1,
  ManagedGenerationCurrentAuthorityV1,
  ManagedGenerationDesiredManifestReadback,
  ManagedGenerationPromotionEvidenceAuthorityPort,
  ManagedGenerationPromotionEvidenceV2,
  ManagedGenerationPromotionHoldRequest,
  ManagedGenerationPromotionHoldV1,
  ManagedGenerationPromotionTarget,
};

export const AI_SEARCH_GENERATION_REGISTRY_SCHEMA =
  "eliotr.ai-search-generation-registry.v2" as const;
export const AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1 =
  "eliotr.ai-search-generation-registry.v1" as const;
export const AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES = 256 * 1024;

export type AiSearchGenerationRegistryOperation =
  | "DECLARE"
  | "OBSERVE"
  | "QUALIFY"
  | "PROMOTE"
  | "ROLLBACK"
  | "ARCHIVE";

export type AiSearchGenerationRegistryDisposition =
  | "CREATED"
  | "UPDATED"
  | "REPLAY"
  | "RECONCILED"
  | "QUALIFIED"
  | "ROLLED_BACK"
  | "ARCHIVED"
  | "EXISTING";

export type AiSearchGenerationRegistryAmbiguousEffect =
  | "NONE"
  | "REGISTRY_CAS"
  | "WRITER_DRAIN";

export type AiSearchGenerationRegistryErrorCode =
  | "AI_SEARCH_REGISTRY_INPUT_INVALID"
  | "AI_SEARCH_REGISTRY_READ_FAILED"
  | "AI_SEARCH_REGISTRY_READBACK_INVALID"
  | "AI_SEARCH_REGISTRY_GENERATION_CONFLICT"
  | "AI_SEARCH_REGISTRY_WRITE_CONFLICT"
  | "AI_SEARCH_REGISTRY_WRITE_FAILED"
  | "AI_SEARCH_REGISTRY_WRITE_UNCERTAIN"
  | "AI_SEARCH_REGISTRY_READBACK_MISMATCH"
  | "AI_SEARCH_REGISTRY_EVIDENCE_UNAVAILABLE"
  | "AI_SEARCH_REGISTRY_EVIDENCE_STALE"
  | "AI_SEARCH_REGISTRY_ARCHIVE_DENIED"
  | "AI_SEARCH_REGISTRY_DRAIN_UNCERTAIN";

export class AiSearchGenerationRegistryError extends Error {
  public readonly code: AiSearchGenerationRegistryErrorCode;
  public readonly retryable: boolean;
  public readonly ambiguous_effect: AiSearchGenerationRegistryAmbiguousEffect;

  public constructor(
    code: AiSearchGenerationRegistryErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly ambiguous_effect?: AiSearchGenerationRegistryAmbiguousEffect;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AiSearchGenerationRegistryError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous_effect = options.ambiguous_effect ?? "NONE";
  }
}

export function aiSearchGenerationRegistryFailure(
  code: AiSearchGenerationRegistryErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly ambiguous_effect?: AiSearchGenerationRegistryAmbiguousEffect;
    readonly cause?: unknown;
  } = {},
): never {
  throw new AiSearchGenerationRegistryError(code, message, options);
}

export interface AiSearchGenerationRegistryArtifact {
  readonly schema:
    | typeof AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1
    | typeof AI_SEARCH_GENERATION_REGISTRY_SCHEMA;
  readonly namespace: string;
  readonly revision: number;
  readonly registry: AiSearchGenerationRegistry;
}

export interface AiSearchGenerationRegistrySnapshot {
  readonly artifact: AiSearchGenerationRegistryArtifact;
  readonly artifact_sha256: string;
}

export interface AiSearchGenerationRegistryCasCommand {
  readonly namespace: string;
  readonly operation: AiSearchGenerationRegistryOperation;
  readonly generation: string;
  readonly expected_revision: number | null;
  readonly expected_artifact_sha256: string | null;
  readonly artifact: AiSearchGenerationRegistryArtifact;
  readonly artifact_sha256: string;
  readonly promotion_hold?: ManagedGenerationPromotionHoldV1;
  readonly archive_authorization?: ManagedGenerationArchiveAuthorizationV1;
}

export type AiSearchGenerationRegistryStoreOutcome =
  | "APPLIED"
  | "REPLAY"
  | "CONFLICT";

export interface AiSearchGenerationRegistryStoreReceipt {
  readonly outcome: AiSearchGenerationRegistryStoreOutcome;
  readonly namespace: string;
  readonly revision: number;
  readonly artifact_sha256: string;
  readonly transition_sha256: string | null;
}

/**
 * Minimal durable authority port. A backend must apply the entire bounded
 * registry artifact atomically under revision + digest compare-and-swap.
 */
export interface AiSearchGenerationRegistryStorePort {
  read(namespace: string): Promise<unknown | null>;
  compareAndSwap(command: AiSearchGenerationRegistryCasCommand): Promise<unknown>;
}

export interface AiSearchGenerationRegistryPersistenceReceipt {
  readonly operation: AiSearchGenerationRegistryOperation;
  readonly disposition: AiSearchGenerationRegistryDisposition;
  readonly namespace: string;
  readonly generation: string;
  readonly previous_revision: number | null;
  readonly revision: number;
  readonly artifact_sha256: string;
  readonly active_head_generation: string | null;
  readonly transition_sha256?: string;
}

export interface AiSearchGenerationRegistryTransitionRecord {
  readonly generation: string;
  readonly previous_state: AiSearchGenerationState | null;
  readonly next_state: AiSearchGenerationState | null;
  readonly previous_record_sha256: string | null;
  readonly next_record_sha256: string | null;
  readonly profile_identity_sha256: string;
  readonly previous_evidence_sha256: string | null;
  readonly next_evidence_sha256: string | null;
  readonly archived_record?: AiSearchGenerationRecord;
  readonly archive_authorization?: ManagedGenerationArchiveAuthorizationV1;
}

export interface AiSearchGenerationRegistryTransitionEvent {
  readonly protocol: "eliotr.ai-search-generation-registry-transition.v1";
  readonly namespace: string;
  readonly operation: AiSearchGenerationRegistryOperation;
  readonly generation: string;
  readonly previous_revision: number | null;
  readonly revision: number;
  readonly previous_artifact_sha256: string | null;
  readonly artifact_sha256: string;
  readonly previous_active_head_generation: string | null;
  readonly active_head_generation: string | null;
  readonly changed_generations: readonly AiSearchGenerationRegistryTransitionRecord[];
  readonly promotion_hold?: ManagedGenerationPromotionHoldV1;
}

export interface AiSearchGenerationRegistryService {
  read(namespace: string): Promise<AiSearchGenerationRegistrySnapshot | null>;
  declare(
    declaration: Omit<AiSearchGenerationDeclaration, "expected_item_count">,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
  observe(
    namespace: string,
    observation: AiSearchShadowObservation,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
  promote(
    namespace: string,
    request: AiSearchPromotionRequest,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
  qualify(
    namespace: string,
    request: { readonly generation: string },
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
  rollback(
    namespace: string,
    request: AiSearchRollbackRequest,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
  archive(
    namespace: string,
    request: AiSearchGenerationArchiveRequest,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
}

export interface AiSearchGenerationRegistryServiceOptions {
  /** Required for all mutations; this port must read the existing canonical owners. */
  readonly promotion_evidence?: ManagedGenerationPromotionEvidenceAuthorityPort;
}

export type AiSearchGenerationTargetForEvidence = ManagedGenerationPromotionTarget;
