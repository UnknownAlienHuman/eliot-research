import type { AuthenticatedRequestContext, CreateProjectRequest, ProjectOwnerListRequest, ProjectOwnerListResult, UpdateProjectRequest } from "@eliotr/interfaces";
import { prepareProjectAttachment, PROJECT_ATTACHMENT_CAS } from "./project-client-attachment.js";
import { sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  CLIENT_CLASS,
  PROJECT_LIST_PROTOCOL,
  ProjectOwnerError,
  contextSnapshot,
  fail,
  idempotencyKey,
  inputIdentifier,
  normalizeCreate,
  normalizeUpdate,
  nowValue,
  type OwnerContext,
  type ProjectBase,
  type ProjectOwnerCreateInput,
  type ProjectOwnerResult as InternalProjectOwnerResult,
  type ProjectOwnerService,
  type ProjectOwnerUpdateInput,
} from "./project-owner-contract.js";
import {
  checkExisting,
  currentMembershipsReadableGuard,
  createReceiptJson,
  eligibleCount,
  eligibleSourceCte,
  exactBatchResults,
  groupMemberships,
  projectResult,
  readActiveMembershipIds,
  readBase,
  readMembershipIds,
  readProjectBases,
  readReceipt,
  sourceMembershipsReadable,
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

function mutationJson(operation: "CREATE" | "UPDATE", context: OwnerContext, projectId: string,
  key: string, input: ProjectOwnerCreateInput | ProjectOwnerUpdateInput): string {
  return JSON.stringify({
    protocol: "eliotr.project-owner-mutation.v1",
    operation,
    principal_ref: context.principal_ref,
    project_id: projectId,
    idempotency_key: key,
    input,
  });
}

function projectDefaults(projectId: string): {
  readonly default_disclosure: "private";
  readonly retention_policy_ref: string;
  readonly default_source_policy_ref: string;
  readonly default_model_profile_ref: string;
  readonly default_depth_profile_ref: string;
} {
  // These required project columns are metadata references only. They do not
  // mint policy, grants, model authority, or retention decisions.
  return {
    default_disclosure: "private",
    retention_policy_ref: `project-default-retention-${projectId}`,
    default_source_policy_ref: `project-default-source-${projectId}`,
    default_model_profile_ref: `project-default-model-${projectId}`,
    default_depth_profile_ref: `project-default-depth-${projectId}`,
  };
}

function createProjectId(digest: string): string {
  return `project-${digest.slice(0, 48)}`;
}

function pageCursor(context: AuthenticatedRequestContext, request: ProjectOwnerListRequest | undefined): string | undefined {
  const raw = request?.after_project_id ?? new URL(context.request.url).searchParams.get("after_project_id") ?? undefined;
  if (raw === undefined) return undefined;
  return inputIdentifier(raw, "project cursor");
}

function currentOwner(context: AuthenticatedRequestContext): OwnerContext {
  if (context.client_class !== CLIENT_CLASS) {
    fail("PROJECT_OWNER_REQUIRED", 403, "an authenticated owner session is required");
  }
  return contextSnapshot(context);
}

function projectPage(
  bases: readonly ProjectBase[],
  memberships: ReadonlyMap<string, readonly string[]>,
  hasMore: boolean,
): ProjectOwnerListResult {
  const projects = Object.freeze(bases.map((base) => projectResult(base, memberships.get(base.project_id) ?? [])));
  if (!hasMore) return Object.freeze({ protocol: PROJECT_LIST_PROTOCOL, projects });
  const nextProjectId = projects.at(-1)?.project_ref.id;
  if (nextProjectId === undefined) fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project page has no continuation cursor", true);
  return Object.freeze({ protocol: PROJECT_LIST_PROTOCOL, projects, next_project_id: nextProjectId });
}

export function createProjectOwnerService(options: ProjectOwnerServiceOptions): ProjectOwnerService {
  const now = options.now ?? Date.now;
  const deploymentGeneration = inputIdentifier(options.deployment_generation, "deployment_generation");

  async function read(context: AuthenticatedRequestContext, rawProjectId: string): Promise<InternalProjectOwnerResult> {
    const owner = currentOwner(context);
    const projectId = inputIdentifier(rawProjectId, "project_id");
    const clock = nowValue(now);
    const base = await readBase(options.database, owner.principal_ref, projectId);
    if (base === null) fail("PROJECT_NOT_FOUND", 404, "project was not found");
    const rows = await readMembershipIds(options.database, owner.principal_ref, [projectId], clock.iso);
    const grouped = groupMemberships(rows, [projectId]);
    return projectResult(base, grouped.get(projectId) ?? []);
  }

  async function list(context: AuthenticatedRequestContext, request?: ProjectOwnerListRequest): Promise<ProjectOwnerListResult> {
    const owner = currentOwner(context);
    const clock = nowValue(now);
    const cursor = pageCursor(context, request);
    const page = await readProjectBases(options.database, owner.principal_ref, cursor);
    const ids = page.bases.map((base) => base.project_id);
    const memberships = groupMemberships(await readMembershipIds(options.database, owner.principal_ref, ids, clock.iso), ids);
    return projectPage(page.bases, memberships, page.has_more);
  }

  async function create(context: AuthenticatedRequestContext, request: CreateProjectRequest): Promise<InternalProjectOwnerResult> {
    const owner = currentOwner(context);
    const input = normalizeCreate(request);
    const key = idempotencyKey(context, request.idempotency_key);
    const derivedDigest = await sha256Utf8(mutationJson("CREATE", owner, "derived", key, input));
    const projectId = createProjectId(derivedDigest);
    const requestSha = await sha256Utf8(mutationJson("CREATE", owner, projectId, key, input));
    const existing = checkExisting(await readReceipt(options.database, owner.principal_ref, key), "CREATE", projectId, requestSha);
    if (existing !== null) return existing;

    const clock = nowValue(now);
    const defaults = projectDefaults(projectId);
    const responseBase: ProjectBase = {
      project_id: projectId,
      title: input.title,
      revision: 1,
      created_at: clock.iso,
      principal_ref: owner.principal_ref,
      deployment_generation: deploymentGeneration,
    };
    const responseJson = createReceiptJson(responseBase, input.source_ids);
    const responseSha = await sha256Utf8(responseJson);
    const sourceJson = JSON.stringify(input.source_ids);
    const cte = eligibleSourceCte("?2", "?3", "?4", "?1");
    try {
      const results = await options.database.batch([
        options.database.prepare(
          `${cte} INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,` +
          "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
          "SELECT ?1,?5,?6,?7,?8,?9,?10,1,?11 WHERE (SELECT COUNT(*) FROM requested)=?12 AND (SELECT COUNT(*) FROM eligible)=?12",
        ).bind(projectId, sourceJson, owner.principal_ref, clock.iso, input.title, defaults.default_disclosure,
          defaults.retention_policy_ref, defaults.default_source_policy_ref, defaults.default_model_profile_ref,
          defaults.default_depth_profile_ref, clock.iso, input.source_ids.length),
        options.database.prepare(
          "INSERT INTO project_mutation_guard(principal_ref,idempotency_key,operation,project_id,expected_revision,next_revision,created_at) " +
          "VALUES (?1,?2,'CREATE',?3,0,1,?4)",
        ).bind(owner.principal_ref, key, projectId, clock.iso),
        options.database.prepare(
          "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
          "SELECT ?1,?2,?3,?4,?4 FROM project p JOIN project_mutation_guard g ON g.project_id=p.project_id " +
          "WHERE p.project_id=?1 AND p.generation=1 AND g.principal_ref=?2 AND g.idempotency_key=?5",
        ).bind(projectId, owner.principal_ref, deploymentGeneration, clock.iso, key),
        options.database.prepare(
          `${eligibleSourceCte("?2", "?3", "?4", "?1")} INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to,membership_generation) ` +
          "SELECT ?1,e.source_id,'member',?4,NULL,1 FROM eligible e JOIN project p ON p.project_id=?1 AND p.generation=1 " +
          "JOIN project_mutation_guard g ON g.project_id=p.project_id AND g.principal_ref=?3 AND g.idempotency_key=?5 " +
          "JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=?3",
        ).bind(projectId, sourceJson, owner.principal_ref, clock.iso, key),
        options.database.prepare(
          "INSERT INTO project_mutation_receipt(principal_ref,idempotency_key,operation,project_id,request_sha256,response_json,response_sha256,project_revision,deployment_generation,created_at) " +
          "SELECT ?1,?2,'CREATE',?3,?4,?5,?6,1,?7,?8 FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
          "JOIN project_mutation_guard g ON g.project_id=p.project_id AND g.principal_ref=?1 AND g.idempotency_key=?2 " +
          "WHERE p.project_id=?3 AND p.generation=1 AND o.principal_ref=?1",
        ).bind(owner.principal_ref, key, projectId, requestSha, responseJson, responseSha, deploymentGeneration, clock.iso),
        options.database.prepare(
          "DELETE FROM project_mutation_guard WHERE principal_ref=?1 AND idempotency_key=?2 AND project_id=?3",
        ).bind(owner.principal_ref, key, projectId),
      ]);
      exactBatchResults(results, [1, 1, 1, input.source_ids.length, 1, 1]);
    } catch (cause) {
      const raced = checkExisting(await readReceipt(options.database, owner.principal_ref, key), "CREATE", projectId, requestSha);
      if (raced !== null) return raced;
      const base = await readBase(options.database, owner.principal_ref, projectId);
      if (base !== null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project creation settled without a receipt", true, cause);
      if (await eligibleCount(options.database, input.source_ids, owner.principal_ref, clock.iso) !== input.source_ids.length) {
        fail("PROJECT_SOURCE_DENIED", 403, "one or more sources are no longer current or readable");
      }
      if (cause instanceof ProjectOwnerError) throw cause;
      fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project creation outcome is uncertain", true, cause);
    }
    const receipt = await readReceipt(options.database, owner.principal_ref, key);
    if (receipt === null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project creation receipt is missing", true);
    return checkExisting(receipt, "CREATE", projectId, requestSha) as InternalProjectOwnerResult;
  }

  async function update(context: AuthenticatedRequestContext, rawProjectId: string, request: UpdateProjectRequest): Promise<InternalProjectOwnerResult> {
    const projectId = inputIdentifier(rawProjectId, "project_id");
    const input = normalizeUpdate(request);
    const suppliedKey = idempotencyKey(context, request.idempotency_key);
    if (context.request.headers.has("idempotency-key") && context.request.headers.get("idempotency-key") !== suppliedKey) {
      fail("PROJECT_INPUT_INVALID", 400, "Idempotency-Key conflicts with the request");
    }
    if (Object.keys(request).some((field) => !["title", "source_ids", "expected_revision", "idempotency_key"].includes(field))) {
      fail("PROJECT_INPUT_INVALID", 400, "Project update contains unknown fields");
    }
    const attachment = context.client_class === CLIENT_CLASS ? undefined
      : await prepareProjectAttachment(options.database, context, projectId, input, suppliedKey, now);
    const owner = attachment === undefined ? currentOwner(context)
      : { principal_ref: attachment.binding.owner_principal_ref }; // Source-policy subject, never an authenticated owner context.
    const actor = context.principal_ref;
    const key = attachment?.receiptKey ?? suppliedKey;
    const requestSha = attachment?.requestSha ?? await sha256Utf8(mutationJson("UPDATE", currentOwner(context), projectId, key, input));
    const receipt = () => readReceipt(options.database, actor, key, attachment?.binding);
    const disclose = (result: InternalProjectOwnerResult) => attachment?.disclose(result) ?? Promise.resolve(result);
    const existing = checkExisting(await receipt(), "UPDATE", projectId, requestSha);
    if (existing !== null) return disclose(existing);
    const before = await readBase(options.database, owner.principal_ref, projectId);
    if (before === null) fail("PROJECT_NOT_FOUND", 404, "project was not found");
    if (before.revision !== input.expected_revision) fail("PROJECT_REVISION_CONFLICT", 409, "project revision is stale");
    const clock = nowValue(now);
    const activeMemberships = await readActiveMembershipIds(options.database, projectId);
    if (attachment !== undefined && (input.title !== before.title ||
        activeMemberships.some((id) => !input.source_ids.includes(id)))) {
      fail("PROJECT_SOURCE_DENIED", 403, "Project attachment cannot rename the project or remove a member");
    }
    const readableRows = await readMembershipIds(options.database, owner.principal_ref, [projectId], clock.iso);
    const readableMemberships = groupMemberships(readableRows, [projectId]).get(projectId) ?? [];
    if (!sourceMembershipsReadable(activeMemberships, readableMemberships)) {
      fail("PROJECT_SOURCE_DENIED", 403, "update cannot remove a source that is no longer readable");
    }
    const nextRevision = input.expected_revision + 1;
    if (!Number.isSafeInteger(nextRevision)) fail("PROJECT_INPUT_INVALID", 400, "project revision is too large");
    const responseBase: ProjectBase = { ...before, title: input.title, revision: nextRevision, deployment_generation: deploymentGeneration };
    const responseJson = createReceiptJson(responseBase, input.source_ids);
    const responseSha = await sha256Utf8(responseJson);
    const sourceJson = JSON.stringify(input.source_ids);
    const cte = eligibleSourceCte("?2", "?3", attachment === undefined ? "?4" : "'now'", "?1");
    const attachmentArgs = await attachment?.beforeWrite() ?? [];
    const grantColumns = attachment === undefined ? "" : ",project_client_grant_id,project_client_grant_revision,client_authority_expires_at";
    const grantArgs = attachment?.guardValues() ?? [];
    // Attachment may add membership, not silently reset a pre-existing membership role.
    const memberRole = attachment === undefined ? "'member'"
      : "COALESCE((SELECT prior.role FROM project_source_membership prior WHERE prior.project_id=?1 " +
        "AND prior.source_id=e.source_id AND prior.valid_to=?4 AND prior.membership_generation=?5-1 " +
        "ORDER BY prior.valid_from DESC LIMIT 1),'member')";
    try {
      const results = await options.database.batch([
        options.database.prepare(
          `${cte} UPDATE project SET title=?5,generation=?6 WHERE project_id=?1 AND generation=?7 ` +
          "AND EXISTS (SELECT 1 FROM project_owner po WHERE po.project_id=?1 AND po.principal_ref=?3) " +
          "AND NOT EXISTS (SELECT 1 FROM project_source_membership old WHERE old.project_id=?1 AND old.valid_to IS NULL " +
          "AND julianday(old.valid_from)>=julianday(?4)) " +
          "AND " + currentMembershipsReadableGuard() + " " +
          "AND (SELECT COUNT(*) FROM requested)=?8 AND (SELECT COUNT(*) FROM eligible)=?8" +
          (attachment === undefined ? "" : PROJECT_ATTACHMENT_CAS),
        ).bind(projectId, sourceJson, owner.principal_ref, clock.iso, input.title, nextRevision, input.expected_revision, input.source_ids.length, ...attachmentArgs),
        options.database.prepare(
          "INSERT INTO project_mutation_guard(principal_ref,idempotency_key,operation,project_id,expected_revision,next_revision,created_at" + grantColumns + ") " +
          "VALUES (?1,?2,'UPDATE',?3,?4,?5,?6" + (attachment === undefined ? "" : ",?7,?8,?9") + ")",
        ).bind(actor, key, projectId, input.expected_revision, nextRevision, clock.iso, ...grantArgs),
        options.database.prepare(
          "UPDATE project_owner SET deployment_generation=?2,updated_at=?3 WHERE project_id=?1 AND principal_ref=?4 " +
          "AND EXISTS (SELECT 1 FROM project_mutation_guard g WHERE g.project_id=?1 AND g.principal_ref=?7 AND g.idempotency_key=?6) " +
          "AND EXISTS (SELECT 1 FROM project WHERE project_id=?1 AND generation=?5)",
        ).bind(projectId, deploymentGeneration, clock.iso, owner.principal_ref, nextRevision, key, actor),
        options.database.prepare(
          "UPDATE project_source_membership SET valid_to=?2 WHERE project_id=?1 AND valid_to IS NULL " +
          "AND EXISTS (SELECT 1 FROM project_mutation_guard g WHERE g.project_id=?1 AND g.principal_ref=?6 AND g.idempotency_key=?5) " +
          "AND EXISTS (SELECT 1 FROM project WHERE project_id=?1 AND generation=?3) " +
          "AND EXISTS (SELECT 1 FROM project_owner WHERE project_id=?1 AND principal_ref=?4)",
        ).bind(projectId, clock.iso, nextRevision, owner.principal_ref, key, actor),
        options.database.prepare(
          `${cte} INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to,membership_generation) ` +
          `SELECT ?1,e.source_id,${memberRole},?4,NULL,?5 FROM eligible e JOIN project p ON p.project_id=?1 AND p.generation=?5 ` +
          "JOIN project_mutation_guard g ON g.project_id=p.project_id AND g.principal_ref=?7 AND g.idempotency_key=?6 " +
          "JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=?3",
        ).bind(projectId, sourceJson, owner.principal_ref, clock.iso, nextRevision, key, actor),
        options.database.prepare(
          "INSERT INTO project_mutation_receipt(principal_ref,idempotency_key,operation,project_id,request_sha256,response_json,response_sha256,project_revision,deployment_generation,created_at" + grantColumns + ") " +
          "SELECT ?1,?2,'UPDATE',?3,?4,?5,?6,?7,?8,?9" + (attachment === undefined ? "" : ",?11,?12,?13") +
          " FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
          "JOIN project_mutation_guard g ON g.project_id=p.project_id AND g.principal_ref=?1 AND g.idempotency_key=?2 " +
          "WHERE p.project_id=?3 AND p.generation=?7 AND o.principal_ref=?10",
        ).bind(actor, key, projectId, requestSha, responseJson, responseSha, nextRevision, deploymentGeneration, clock.iso, owner.principal_ref, ...grantArgs),
        options.database.prepare(
          "DELETE FROM project_mutation_guard WHERE principal_ref=?1 AND idempotency_key=?2 AND project_id=?3",
        ).bind(actor, key, projectId),
      ]);
      exactBatchResults(results, [1, 1, 1, null, input.source_ids.length, 1, 1]);
    } catch (cause) {
      const raced = checkExisting(await receipt(), "UPDATE", projectId, requestSha);
      if (raced !== null) return disclose(raced);
      const errorName = cause instanceof Error && cause.name.length > 0 && cause.name.length <= 128
        ? cause.name : "UNCLASSIFIED";
      const errorMessage = cause instanceof Error && cause.message.length > 0
        ? cause.message.slice(0, 500) : "UNCLASSIFIED";
      console.error("project-owner-update-failed", { name: errorName, message: errorMessage });
      const current = await readBase(options.database, owner.principal_ref, projectId);
      if (current === null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project update lost its owner row", true, cause);
      if (current.revision !== input.expected_revision) fail("PROJECT_REVISION_CONFLICT", 409, "project revision changed concurrently");
      if (await eligibleCount(options.database, input.source_ids, owner.principal_ref, clock.iso) !== input.source_ids.length) {
        fail("PROJECT_SOURCE_DENIED", 403, "one or more sources are no longer current or readable");
      }
      if (cause instanceof ProjectOwnerError) throw cause;
      fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project update outcome is uncertain", true, cause);
    }
    const settled = await receipt();
    if (settled === null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project update receipt is missing", true);
    return disclose(checkExisting(settled, "UPDATE", projectId, requestSha) as InternalProjectOwnerResult);
  }

  return Object.freeze({ create, read, list, update });
}
