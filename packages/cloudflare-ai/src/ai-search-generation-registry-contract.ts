import type {
  AiSearchGenerationDeclaration,
  AiSearchGenerationRegistry,
  AiSearchPromotionRequest,
  AiSearchShadowObservation,
} from "./ai-search-generation.js";

export const AI_SEARCH_GENERATION_REGISTRY_SCHEMA =
  "eliotr.ai-search-generation-registry.v1" as const;
export const AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES = 256 * 1024;

export type AiSearchGenerationRegistryOperation =
  | "DECLARE"
  | "OBSERVE"
  | "PROMOTE";

export type AiSearchGenerationRegistryDisposition =
  | "CREATED"
  | "UPDATED"
  | "REPLAY"
  | "RECONCILED"
  | "EXISTING";

export type AiSearchGenerationRegistryAmbiguousEffect =
  | "NONE"
  | "REGISTRY_CAS";

export type AiSearchGenerationRegistryErrorCode =
  | "AI_SEARCH_REGISTRY_INPUT_INVALID"
  | "AI_SEARCH_REGISTRY_READ_FAILED"
  | "AI_SEARCH_REGISTRY_READBACK_INVALID"
  | "AI_SEARCH_REGISTRY_GENERATION_CONFLICT"
  | "AI_SEARCH_REGISTRY_WRITE_CONFLICT"
  | "AI_SEARCH_REGISTRY_WRITE_FAILED"
  | "AI_SEARCH_REGISTRY_WRITE_UNCERTAIN"
  | "AI_SEARCH_REGISTRY_READBACK_MISMATCH";

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
  readonly schema: typeof AI_SEARCH_GENERATION_REGISTRY_SCHEMA;
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
  readonly expected_revision: number | null;
  readonly expected_artifact_sha256: string | null;
  readonly artifact: AiSearchGenerationRegistryArtifact;
  readonly artifact_sha256: string;
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
}

export interface AiSearchGenerationRegistryService {
  read(namespace: string): Promise<AiSearchGenerationRegistrySnapshot | null>;
  declare(
    declaration: AiSearchGenerationDeclaration,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
  observe(
    namespace: string,
    observation: AiSearchShadowObservation,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
  promote(
    namespace: string,
    request: AiSearchPromotionRequest,
  ): Promise<AiSearchGenerationRegistryPersistenceReceipt>;
}
