import type { StageRequest } from "@eliotr/cloudflare-workflows";
import type { ModelAttemptReservation } from "./model-attempt-types.js";
import type { ModelOutputStorage, ResidencyDomainProfile } from "./research-model-output-store.js";

/** Trusted values derived from the durable STARTED attempt and frozen W2 request. */
export interface ModelOutputPreparationInput {
  readonly reservation: ModelAttemptReservation;
  readonly attempt_id: string;
  readonly started_at: string;
  readonly residency_domains: ResidencyDomainProfile;
}

export type ModelOutputPreparationHook = (input: ModelOutputPreparationInput) => Promise<void>;

export function residencyDomainsForRequest(request: StageRequest): ResidencyDomainProfile {
  const { content_digest: _contentDigest, ...residency_domains } = request.input_manifest.residency;
  return residency_domains;
}

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
