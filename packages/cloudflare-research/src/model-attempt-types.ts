import type {
  BudgetReservation,
  OperationAttempt,
  OperationIntent,
  OperationReceipt,
  VersionedRef,
} from "@eliotr/contracts";
import type { ModelCallInput, ModelCallReceipt } from "@eliotr/research";

export type ModelAttemptTerminalState = "SUCCEEDED" | "FAILED" | "CANCELLED";
export type ModelAttemptReadState = "RESERVED" | "STARTED" | "UNKNOWN" | ModelAttemptTerminalState;

/** Server-owned pricing estimate. It is a quote, never evidence of a provider charge. */
export interface ModelCostQuote {
  readonly quote_ref: string;
  readonly reservation_id: string;
  readonly operation_kind: OperationIntent["operation_kind"];
  readonly estimated_model_calls: number;
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
  readonly estimated_embedding_tokens: number;
  readonly quoted_neurons: number;
  readonly selected_routes: readonly string[];
  readonly platform_usd: number;
  readonly workers_ai_usd: number;
  readonly byok_usd: number;
  readonly max_total_usd: number;
  readonly workflow_steps: number;
  readonly expected_sources: number;
  readonly expected_sections: number;
  readonly confidence: number;
  readonly expires_at: string;
}

/** Values reloaded from the authenticated authority, never browser supplied. */
export interface ModelAttemptAuthority {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly policy_decision_ref: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly currentness_digest: string;
  readonly expires_at: string;
}

export interface ModelAttemptReservationInput {
  readonly intent: OperationIntent;
  readonly idempotency_key: string;
  readonly call: ModelCallInput;
  readonly quote: ModelCostQuote;
  readonly authority: ModelAttemptAuthority;
  /** Trusted W2 stage identity that authorizes this model boundary. */
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
}

export interface ModelAttemptReservation {
  readonly intent: OperationIntent;
  readonly reservation: BudgetReservation;
  readonly request_sha256: string;
  readonly request_json: string;
  readonly attempt_identity: string;
  readonly authority: ModelAttemptAuthority;
  readonly output_object_ref: string;
  readonly route_ref: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
}

export interface ModelAttemptStart {
  readonly reservation: ModelAttemptReservation;
  readonly attempt: OperationAttempt | null;
  readonly state: "STARTED" | "UNKNOWN" | ModelAttemptTerminalState;
  readonly should_invoke: boolean;
}

export interface ModelOutputBinding {
  readonly output_object_ref: string;
  readonly output_sha256: string;
  readonly output_size_bytes: number;
  readonly readback_sha256: string;
}

export type ModelAttemptSettlementInput =
  | {
      readonly attempt_id: string;
      readonly state: "SUCCEEDED";
      readonly receipt: ModelCallReceipt;
      readonly output: ModelOutputBinding;
    }
  | {
      readonly attempt_id: string;
      readonly state: "FAILED" | "CANCELLED";
      readonly error_code: string;
      readonly reason_codes?: readonly string[];
    };

export interface ModelAttemptReadback {
  readonly attempt_id: string;
  readonly intent: OperationIntent;
  readonly attempt: OperationAttempt;
  readonly state: ModelAttemptReadState;
  readonly persisted_state: OperationAttempt["state"];
  readonly request_sha256: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly authority: ModelAttemptAuthority;
  readonly receipt: ModelCallReceipt | null;
  readonly operation_receipt: OperationReceipt | null;
  readonly output: ModelOutputBinding | null;
  readonly error_code?: string;
  readonly reason_codes: readonly string[];
}

export interface ModelAttemptStore {
  reserve(input: ModelAttemptReservationInput): Promise<ModelAttemptReservation>;
  beginAttempt(reservation: ModelAttemptReservation): Promise<ModelAttemptStart>;
  settleAttempt(input: ModelAttemptSettlementInput): Promise<ModelAttemptReadback>;
  readByAttempt(attempt_id: string): Promise<ModelAttemptReadback | null>;
  readByIdempotency(input: { readonly principal_ref: string; readonly operation_kind: OperationIntent["operation_kind"]; readonly idempotency_key: string }): Promise<ModelAttemptReadback | null>;
  reconcileAttempt(attempt_id: string): Promise<ModelAttemptReadback | null>;
}

export type ModelAttemptErrorCode =
  | "MODEL_ATTEMPT_INPUT_INVALID"
  | "MODEL_ATTEMPT_AUTHORITY_STALE"
  | "MODEL_ATTEMPT_IDENTITY_CONFLICT"
  | "MODEL_ATTEMPT_BUDGET_EXPIRED"
  | "MODEL_ATTEMPT_CONFLICT"
  | "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN"
  | "MODEL_ATTEMPT_READBACK_CORRUPT";

export class ModelAttemptError extends Error {
  public readonly code: ModelAttemptErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ModelAttemptErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ModelAttemptError";
    this.code = code;
    this.retryable = retryable;
  }
}
