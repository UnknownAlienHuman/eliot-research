import type { AuthenticatedRequestContext } from "./http.js";
import type { RawNormalizedAdmissionResult } from "./owner-api.js";

/** References select an observation; the authenticated owner supplies authority. */
export interface WorkspaceCandidateAdmissionRequest {
  readonly observation: {
    readonly principal_ref: string;
    readonly deployment_generation: string;
    readonly auth_profile: "service-token" | "managed-oauth";
    readonly google_transport: "gemini-mcp";
    readonly idempotency_key: string;
    readonly plan_id: string;
    readonly plan_sha256: string;
    readonly observation_id: string;
  };
  readonly capture_id: string;
  readonly conversion_operation_id: string;
  readonly idempotency_key: string;
}

export interface WorkspaceOwnerApi {
  admitWorkspaceCandidate(context: AuthenticatedRequestContext, request: WorkspaceCandidateAdmissionRequest): Promise<RawNormalizedAdmissionResult>;
  workspaceCandidateStatus(context: AuthenticatedRequestContext, captureId: string, admissionOperationId: string): Promise<RawNormalizedAdmissionResult>;
}
