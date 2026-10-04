import type { AuthenticatedRequestContext, CreateProjectRequest, ProjectOwnerListRequest, ProjectOwnerListResult, UpdateProjectRequest } from "@eliotr/interfaces";
import { MAX_IDEMPOTENCY_BYTES, fail, validIdentifier } from "@eliotr/cloudflare-navigation/project-owner-contract.js";
import type { ProjectOwnerActor, ProjectOwnerResult as NavigationProjectOwnerResult } from "@eliotr/cloudflare-navigation/project-owner-contract.js";

export {
  IDENTIFIER,
  SHA256,
  MAX_TITLE_LENGTH,
  MAX_TITLE_BYTES,
  MAX_SOURCE_IDS,
  MAX_PROJECTS,
  MAX_IDEMPOTENCY_BYTES,
  MAX_RESPONSE_BYTES,
  PROJECT_PROTOCOL,
  PROJECT_LIST_PROTOCOL,
  ProjectOwnerError,
  fail,
  utf8Length,
  validIdentifier,
  inputIdentifier,
  storedIdentifier,
  storedSha,
  canonicalTime,
  nowValue,
  normalizeTitle,
  normalizeSourceIds,
  normalizeCreate,
  normalizeUpdate,
} from "@eliotr/cloudflare-navigation/project-owner-contract.js";
export type {
  ProjectOwnerErrorCode,
  ProjectOwnerCreateInput,
  ProjectOwnerUpdateInput,
  ProjectOwnerResult,
  ProjectBaseRow,
  ProjectBase,
  MembershipRow,
  MutationReceiptRow,
  StoredMutation,
} from "@eliotr/cloudflare-navigation/project-owner-contract.js";

export const CLIENT_CLASS = "owner_pwa" as const;
export type OwnerContext = ProjectOwnerActor;

/** Core-only HTTP service; context is verified before passing the actor to navigation. */
export interface ProjectOwnerService {
  create(context: AuthenticatedRequestContext, request: CreateProjectRequest): Promise<NavigationProjectOwnerResult>;
  read(context: AuthenticatedRequestContext, projectId: string): Promise<NavigationProjectOwnerResult>;
  list(context: AuthenticatedRequestContext, request?: ProjectOwnerListRequest): Promise<ProjectOwnerListResult>;
  update(context: AuthenticatedRequestContext, projectId: string, request: UpdateProjectRequest): Promise<NavigationProjectOwnerResult>;
}

export function authenticatedActorSnapshot(context: AuthenticatedRequestContext): ProjectOwnerActor {
  if (!validIdentifier(context.principal_ref) || !validIdentifier(context.credential_generation)) {
    fail("PROJECT_OWNER_REQUIRED", 403, "an authenticated owner session is required");
  }
  return Object.freeze({ principal_ref: context.principal_ref, credential_generation: context.credential_generation });
}

export function contextSnapshot(context: AuthenticatedRequestContext): ProjectOwnerActor {
  if (context.client_class !== CLIENT_CLASS) {
    fail("PROJECT_OWNER_REQUIRED", 403, "an authenticated owner session is required");
  }
  return authenticatedActorSnapshot(context);
}

export function idempotencyKey(context: AuthenticatedRequestContext, supplied: string | undefined): string {
  const value = supplied ?? context.request.headers.get("idempotency-key") ?? undefined;
  if (!validIdentifier(value, MAX_IDEMPOTENCY_BYTES)) {
    fail("PROJECT_INPUT_INVALID", 400, "Idempotency-Key is required and invalid");
  }
  return value;
}
