import type { OperationIntent, VersionedRef } from "@eliotr/contracts";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ModelAttemptAuthority, ModelCostQuote } from "./model-attempt-types.js";

/** Exact durable W2 key, before the W3 model reservation exists. */
export interface ResearchSynthesisSpendAdmissionReadRequest {
  readonly operation_id: string;
  readonly stage_index: 12 | 14;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly workflow_budget_receipt_ref: string;
}

/**
 * The immutable admission projection needed by synthesis preparation. It is
 * defined beside the durable reader so execution has no dependency on the
 * higher-level Research preparation adapter.
 */
export interface ResearchSynthesisSpendAdmissionRecord extends ResearchSynthesisSpendAdmissionReadRequest {
  readonly authorization_ref: string;
  readonly decision_digest: string;
  readonly reservation_id: string;
  readonly quote_ref: string;
  readonly route_ref: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly workflow_authorization_receipt_ref: string;
  readonly policy_generation: string;
  readonly currentness_digest: string;
  readonly expires_at: string;
  readonly intent: OperationIntent;
  readonly admission_ref: VersionedRef;
  readonly admission_sha256: string;
  readonly created_at: string;
  readonly quote: ModelCostQuote;
  readonly authority: ModelAttemptAuthority;
  readonly deployment: ModelRouteDeployment;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
}

/** Read-only projection port implemented by the durable W3 admission store. */
export interface ResearchModelSpendAdmissionPreparationPort {
  readPreparation(input: ResearchSynthesisSpendAdmissionReadRequest): Promise<ResearchSynthesisSpendAdmissionRecord | null>;
}
