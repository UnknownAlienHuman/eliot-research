import type { StageRequest } from "./types.js";
import type { ModelAttemptReservation } from "./model-attempt-types.js";
import type { ModelOutputStorage, ResidencyDomainProfile } from "./research-model-output-store.js";

/**
 * Trusted inputs for the pre-provider output binding.  The handler constructs
 * this value from the durable STARTED attempt and the frozen W2 request; it is
 * not a public request shape.
 */
export interface ModelOutputPreparationInput {
  readonly reservation: ModelAttemptReservation;
  readonly attempt_id: string;
  readonly started_at: string;
  readonly residency_domains: ResidencyDomainProfile;
}

export type ModelOutputPreparationHook = (input: ModelOutputPreparationInput) => Promise<void>;

/** Removes the unknown output content digest while retaining the W2 residency domains. */
export function residencyDomainsForRequest(request: StageRequest): ResidencyDomainProfile {
  const { content_digest: _contentDigest, ...residency_domains } = request.input_manifest.residency;
  return residency_domains;
}

/**
 * Binds the handler's trusted attempt identity to the real output store.  The
 * store performs the durable STARTED-attempt and authority checks itself.
 */
export function createModelOutputPreparationHook(
  storage: Pick<ModelOutputStorage, "prepareOutputBinding">,
): ModelOutputPreparationHook {
  return async ({ reservation, attempt_id, started_at, residency_domains }) => {
    await storage.prepareOutputBinding({
      attempt_id,
      output_object_ref: reservation.output_object_ref,
      principal_ref: reservation.authority.principal_ref,
      stage_attempt_ref: reservation.stage_attempt_ref,
      stage_request_sha256: reservation.stage_request_sha256,
      request_sha256: reservation.request_sha256,
      workflow_budget_receipt_ref: reservation.workflow_budget_receipt_ref,
      residency_domains,
      created_at: started_at,
    });
  };
}
