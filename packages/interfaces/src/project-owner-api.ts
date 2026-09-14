import type { AuthenticatedRequestContext } from "./http.js";
import type { VersionedRef } from "@eliotr/contracts";

/** Owner management view; source_ids are server-authorized memberships, not grants. */
export interface ProjectOwnerResult {
  readonly protocol: "eliotr.project-owner.v1";
  readonly project_ref: VersionedRef;
  readonly title: string;
  readonly revision: number;
  readonly owner_principal_ref: string;
  readonly deployment_generation: string;
  readonly source_ids: readonly string[];
  readonly created_at: string;
}

export interface ProjectOwnerListResult {
  readonly protocol: "eliotr.project-owner-list.v1";
  readonly projects: readonly ProjectOwnerResult[];
  readonly next_project_id?: string;
}

export interface ProjectOwnerListRequest {
  readonly after_project_id?: string;
}

export interface CreateProjectRequest {
  readonly title: string;
  readonly source_ids: readonly string[];
  readonly idempotency_key: string;
}

export interface UpdateProjectRequest {
  readonly title: string;
  readonly source_ids: readonly string[];
  readonly expected_revision: number;
  readonly idempotency_key: string;
}

export interface ProjectOwnerApi {
  listProjects(context: AuthenticatedRequestContext, request?: ProjectOwnerListRequest): Promise<ProjectOwnerListResult>;
  createProject(context: AuthenticatedRequestContext, request: CreateProjectRequest): Promise<ProjectOwnerResult>;
  updateProject(
    context: AuthenticatedRequestContext,
    projectId: string,
    request: UpdateProjectRequest,
  ): Promise<ProjectOwnerResult>;
}
