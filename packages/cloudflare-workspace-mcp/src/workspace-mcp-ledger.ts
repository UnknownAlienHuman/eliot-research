import type {
  WorkspaceMcpObservationV2,
  WorkspaceMcpPlanV2,
  WorkspaceMcpPlanV2Result,
  WorkspaceMcpReceiptV2,
} from "@eliotr/contracts";

export interface WorkspaceMcpPlanStoreInput {
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: "service-token" | "managed-oauth";
  readonly google_transport: "gemini-mcp";
  readonly idempotency_key: string;
  readonly input_fingerprint: string;
  readonly plan_id: string;
  readonly plan_sha256: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly plan: WorkspaceMcpPlanV2;
}

export type WorkspaceMcpPlanStoreResult =
  | { readonly state: "COMMITTED" | "REPLAY"; readonly plan: unknown }
  | { readonly state: "CONFLICT"; readonly code: "IDEMPOTENCY_CONFLICT" | "PLAN_EXPIRED" }
  | { readonly state: "UNKNOWN"; readonly plan_id?: string; readonly plan_sha256?: string };

export interface WorkspaceMcpPlanLookup {
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: "service-token" | "managed-oauth";
  readonly google_transport: "gemini-mcp";
  readonly idempotency_key: string;
  readonly plan_id: string;
}

export type WorkspaceMcpPlanLookupResult =
  | { readonly state: "FOUND"; readonly plan: unknown }
  | { readonly state: "NOT_FOUND" }
  | { readonly state: "UNKNOWN" };

export interface WorkspaceMcpObservationStoreInput {
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: "service-token" | "managed-oauth";
  readonly google_transport: "gemini-mcp";
  readonly idempotency_key: string;
  readonly plan_id: string;
  readonly plan_sha256: string;
  readonly observation_id: string;
  readonly observation_sha256: string;
  readonly receipt_sha256: string;
  readonly disposition: "OBSERVED_MATCH" | "OBSERVED_MISMATCH";
  readonly reason_codes: readonly string[];
  readonly receipt: WorkspaceMcpReceiptV2;
  readonly observation: WorkspaceMcpObservationV2;
  readonly observed_at: string;
}

export type WorkspaceMcpObservationStoreResult =
  | { readonly state: "COMMITTED" | "REPLAY"; readonly observation: unknown }
  | { readonly state: "UNKNOWN" };

export interface WorkspaceMcpCandidateStore {
  readonly issuePlan: (input: WorkspaceMcpPlanStoreInput) => Promise<WorkspaceMcpPlanStoreResult>;
  readonly loadPlan: (input: WorkspaceMcpPlanLookup) => Promise<WorkspaceMcpPlanLookupResult>;
  readonly recordObservation: (input: WorkspaceMcpObservationStoreInput) => Promise<WorkspaceMcpObservationStoreResult>;
}

export type WorkspaceMcpPlanResult = WorkspaceMcpPlanV2Result;
