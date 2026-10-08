import type { RawCaptureReceipt } from "@eliotr/cloudflare-raw-ingest";
import type {
  AuthenticatedRequestContext,
  RawNormalizedAdmissionRequest,
  RawNormalizedAdmissionResult,
  WorkspaceCandidateAdmissionRequest as WorkspaceCandidateAdmissionRequestDto,
} from "@eliotr/interfaces";
import type { WorkspaceMcpCandidateStore } from "./workspace-mcp-ledger.js";

export type WorkspaceCandidateAdmissionRequest = WorkspaceCandidateAdmissionRequestDto;
export type WorkspaceCandidateAdmissionResult = RawNormalizedAdmissionResult;

export class WorkspaceCandidateAdmissionServiceError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(code: string, status: number, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkspaceCandidateAdmissionServiceError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface WorkspaceCandidateOwnerAuthorizationInput {
  readonly owner_principal_ref: string;
  readonly owner_credential_generation: string;
  readonly mcp_principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: "service-token" | "managed-oauth";
  readonly source_namespace_id: string;
}

export interface WorkspaceCandidateOwnerAuthorizationPort {
  readonly assertCurrent: (input: WorkspaceCandidateOwnerAuthorizationInput, nowMs: number) => unknown;
}

export interface WorkspaceOwnerAuthorizationErrorLike {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly retryable: boolean;
}

export interface WorkspaceCandidateAdmissionRawNormalizedPort {
  readonly admit: (
    context: AuthenticatedRequestContext,
    captureId: string,
    request: RawNormalizedAdmissionRequest,
  ) => Promise<RawNormalizedAdmissionResult>;
  readonly getStatus: (
    context: AuthenticatedRequestContext,
    captureId: string,
    admissionOperationId: string,
  ) => Promise<RawNormalizedAdmissionResult>;
}

export interface WorkspaceCandidateAdmissionDependencies {
  readonly database: D1Database;
  readonly workspaceCandidateStore: WorkspaceMcpCandidateStore;
  readonly rawNormalized: WorkspaceCandidateAdmissionRawNormalizedPort;
  readonly readCapture: (
    context: AuthenticatedRequestContext,
    captureId: string,
  ) => Promise<RawCaptureReceipt | null>;
  /** The server-selected deployment identity; it is never supplied by the request body. */
  readonly expectedDeploymentGeneration: string;
  /** The server-selected MCP profile; it is never inferred from the ledger row. */
  readonly expectedAuthProfile: "service-token" | "managed-oauth";
  /** Optional operator-installed grant for importing a different MCP principal's observation. */
  readonly ownerAuthorization?: WorkspaceCandidateOwnerAuthorizationPort;
  readonly is_owner_authorization_error: (error: unknown) => error is WorkspaceOwnerAuthorizationErrorLike;
  readonly is_raw_normalized_admission_error: (error: unknown) => boolean;
  readonly now?: () => number;
}
