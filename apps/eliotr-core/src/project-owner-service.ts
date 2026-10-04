import type {
  AuthenticatedRequestContext,
  CreateProjectRequest,
  ProjectOwnerListRequest,
  ProjectOwnerListResult,
  UpdateProjectRequest,
} from "@eliotr/interfaces";
import { createProjectOwnerCapability } from "@eliotr/cloudflare-navigation";
import type { PreparedProjectAttachment, ProjectOwnerSourceAuthority } from "@eliotr/cloudflare-navigation";
import {
  CLIENT_CLASS,
  authenticatedActorSnapshot,
  contextSnapshot,
  fail,
  idempotencyKey,
  inputIdentifier,
  normalizeCreate,
  normalizeUpdate,
  type ProjectOwnerResult,
  type ProjectOwnerService,
} from "./project-owner-contract.js";
import { prepareProjectAttachment } from "./project-client-attachment.js";
import {
  currentMembershipsReadableGuard,
  eligibleCount,
  eligibleSourceCte,
  readMembershipIds,
} from "./project-owner-storage.js";

export { ProjectOwnerError } from "./project-owner-contract.js";
export type {
  ProjectOwnerCreateInput,
  ProjectOwnerErrorCode,
  ProjectOwnerResult,
  ProjectOwnerService,
  ProjectOwnerUpdateInput,
} from "./project-owner-contract.js";

export interface ProjectOwnerServiceOptions {
  readonly database: D1Database;
  readonly deployment_generation: string;
  readonly now?: () => number;
}

/** Core authenticates callers and supplies current source/grant authority to the package capability. */
export function createProjectOwnerService(options: ProjectOwnerServiceOptions): ProjectOwnerService {
  const now = options.now ?? Date.now;
  const sourceAuthority: ProjectOwnerSourceAuthority = {
    eligibleSourceCte,
    currentMembershipsReadableGuard,
    eligibleCount,
    readMembershipIds,
  };
  const capability = createProjectOwnerCapability({
    database: options.database,
    deployment_generation: options.deployment_generation,
    now,
    source_authority: sourceAuthority,
  });

  return Object.freeze({
    create: async (context: AuthenticatedRequestContext, request: CreateProjectRequest) => {
      const actor = contextSnapshot(context);
      const input = normalizeCreate(request);
      const key = idempotencyKey(context, request.idempotency_key);
      return capability.create(actor, input, key);
    },
    read: (context: AuthenticatedRequestContext, projectId: string) => {
      const actor = contextSnapshot(context);
      return capability.read(actor, projectId);
    },
    list: (context: AuthenticatedRequestContext, request?: ProjectOwnerListRequest): Promise<ProjectOwnerListResult> => {
      const actor = contextSnapshot(context);
      const rawCursor = request?.after_project_id ?? new URL(context.request.url).searchParams.get("after_project_id") ?? undefined;
      const cursor = rawCursor === undefined ? undefined : inputIdentifier(rawCursor, "project cursor");
      return capability.list(actor, cursor);
    },
    update: async (context: AuthenticatedRequestContext, projectId: string, request: UpdateProjectRequest): Promise<ProjectOwnerResult> => {
      inputIdentifier(projectId, "project_id");
      const input = normalizeUpdate(request);
      const suppliedKey = idempotencyKey(context, request.idempotency_key);
      if (context.request.headers.has("idempotency-key") && context.request.headers.get("idempotency-key") !== suppliedKey) {
        fail("PROJECT_INPUT_INVALID", 400, "Idempotency-Key conflicts with the request");
      }
      if (Object.keys(request).some((field) => !["title", "source_ids", "expected_revision", "idempotency_key"].includes(field))) {
        fail("PROJECT_INPUT_INVALID", 400, "Project update contains unknown fields");
      }
      const actor = context.client_class === CLIENT_CLASS ? contextSnapshot(context) : authenticatedActorSnapshot(context);
      const attachment: PreparedProjectAttachment | undefined = context.client_class === CLIENT_CLASS
        ? undefined
        : await prepareProjectAttachment(options.database, context, projectId, input, suppliedKey, now);
      return capability.update(actor, projectId, input, suppliedKey, attachment);
    },
  });
}
