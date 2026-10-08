import {
  createWorkspaceCandidateAdmissionService as createService,
  WorkspaceCandidateAdmissionServiceError,
  type WorkspaceCandidateAdmissionDependencies as PackageDependencies,
  type WorkspaceCandidateAdmissionRequest,
  type WorkspaceCandidateAdmissionResult,
  type WorkspaceCandidateAdmissionRawNormalizedPort,
} from "@eliotr/cloudflare-workspace-mcp/workspace-candidate-admission-service";
import { RawNormalizedAdmissionError } from "./raw-normalized-admission.js";
import {
  WorkspaceOwnerAuthorizationError,
  type WorkspaceOwnerAuthorization,
} from "./workspace-owner-authorization.js";

export type {
  WorkspaceCandidateAdmissionRequest,
  WorkspaceCandidateAdmissionResult,
  WorkspaceCandidateAdmissionRawNormalizedPort,
};

export interface WorkspaceCandidateAdmissionDependencies extends Omit<PackageDependencies,
  "is_owner_authorization_error" | "is_raw_normalized_admission_error"> {
  readonly ownerAuthorization?: WorkspaceOwnerAuthorization;
}

export class WorkspaceCandidateAdmissionError extends RawNormalizedAdmissionError {
  public constructor(code: string, status: number, message: string, retryable = false, cause?: unknown) {
    super(code, status, message, retryable, cause);
    this.name = "WorkspaceCandidateAdmissionError";
  }
}

function map(error: unknown): never {
  if (error instanceof WorkspaceCandidateAdmissionServiceError) {
    throw new WorkspaceCandidateAdmissionError(error.code, error.status,
      error.message, error.retryable, error.cause);
  }
  throw error;
}

export function createWorkspaceCandidateAdmissionService(input: WorkspaceCandidateAdmissionDependencies) {
  const service = createService({
    ...input,
    is_owner_authorization_error: (error) => error instanceof WorkspaceOwnerAuthorizationError,
    is_raw_normalized_admission_error: (error) => error instanceof RawNormalizedAdmissionError,
  });
  return {
    admit: async (...args: Parameters<typeof service.admit>) => {
      try { return await service.admit(...args); } catch (error) { map(error); }
    },
    getStatus: async (...args: Parameters<typeof service.getStatus>) => {
      try { return await service.getStatus(...args); } catch (error) { map(error); }
    },
  };
}
