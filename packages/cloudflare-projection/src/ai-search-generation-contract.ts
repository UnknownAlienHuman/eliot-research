import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import type { ManagedGenerationPromotionEvidenceV2 } from "./managed-generation-promotion-evidence.js";

export type AiSearchGenerationState =
  | "DECLARED"
  | "SHADOW_BUILDING"
  | "SHADOW_COMPLETE"
  | "ACTIVE"
  | "INACTIVE_QUALIFIED"
  | "INACTIVE_UNQUALIFIED"
  | "RETIRED"
  | "BLOCKED";

export type AiSearchGenerationErrorCode =
  | "AI_SEARCH_PROFILE_INVALID"
  | "AI_SEARCH_PROFILE_IMMUTABLE_MISMATCH"
  | "AI_SEARCH_GENERATION_INVALID"
  | "AI_SEARCH_GENERATION_NOT_FOUND"
  | "AI_SEARCH_GENERATION_STATE_INVALID"
  | "AI_SEARCH_SHADOW_PROGRESS_INVALID"
  | "AI_SEARCH_SHADOW_INCOMPLETE"
  | "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED"
  | "AI_SEARCH_ACTIVE_HEAD_CONFLICT"
  | "AI_SEARCH_ROLLBACK_CONFLICT"
  | "AI_SEARCH_GENERATION_MIXED";

export class AiSearchGenerationError extends Error {
  public readonly code: AiSearchGenerationErrorCode;

  public constructor(code: AiSearchGenerationErrorCode, message: string) {
    super(message);
    this.name = "AiSearchGenerationError";
    this.code = code;
  }
}

export interface AiSearchGenerationDeclaration {
  readonly namespace: string;
  /** Logical corpus generation. Omitted only by legacy callers that used profile.generation. */
  readonly generation?: string;
  readonly profile: AiSearchInstanceProfile;
  readonly expected_item_count: number;
  readonly declared_at: string;
}

export interface AiSearchGenerationRecord {
  readonly namespace: string;
  readonly generation: string;
  readonly profile: AiSearchInstanceProfile;
  readonly state: AiSearchGenerationState;
  readonly expected_item_count: number;
  readonly indexed_item_count: number;
  readonly readback_item_count: number;
  readonly failed_item_count: number;
  readonly mismatch_count: number;
  readonly golden_set_result_ref?: string;
  readonly promotion_evidence_v2?: ManagedGenerationPromotionEvidenceV2;
  readonly declared_at: string;
  readonly observed_at?: string;
  readonly activated_at?: string;
  readonly inactive_at?: string;
  readonly retired_at?: string;
}

export interface AiSearchShadowObservation {
  readonly generation: string;
  readonly indexed_item_count: number;
  readonly readback_item_count: number;
  readonly failed_item_count: number;
  readonly mismatch_count: number;
  readonly observed_at: string;
}

export interface AiSearchGenerationRegistry {
  readonly active_head_generation: string | null;
  readonly generations: readonly AiSearchGenerationRecord[];
}

export interface AiSearchPromotionRequest {
  readonly expected_active_head_generation: string | null;
  readonly target_generation: string;
  readonly promoted_at: string;
}

export interface AiSearchRollbackRequest {
  readonly expected_active_head_generation: string;
  readonly target_generation: string;
  readonly rolled_back_at: string;
}

export interface AiSearchGenerationArchiveRequest {
  readonly generation: string;
}
