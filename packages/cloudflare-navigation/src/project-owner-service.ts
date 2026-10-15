import type {
  AuthenticatedRequestContext,
  CreateProjectRequest,
  ProjectOwnerListRequest,
  ProjectOwnerListResult,
  UpdateProjectRequest,
} from "@eliotr/interfaces";
import { sha256Utf8, type PreparedIntentWithOutboxMutation } from "@eliotr/platform-cloudflare";
import {
  CLIENT_CLASS,
  MAX_SOURCE_IDS,
  PROJECT_LIST_PROTOCOL,
  ProjectOwnerError,
  authenticatedActorSnapshot,
  contextSnapshot,
  fail,
  idempotencyKey,
  inputIdentifier,
  normalizeCreate,
  normalizeUpdate,
  nowValue,
  storedIdentifier,
  validIdentifier,
  type PreparedProjectAttachment,
  type ProjectOwnerActor,
  type ProjectOwnerCapability,
  type ProjectOwnerCreateInput,
  type ProjectBase,
  type ProjectOwnerResult as InternalProjectOwnerResult,
  type ProjectOwnerService,
  type ProjectOwnerSourceAuthority,
  type ProjectOwnerUpdateInput,
} from "./project-owner-contract.js";
import {
  checkExisting,
  createReceiptJson,
  currentMembershipsReadableGuard,
  eligibleCount,
  eligibleSourceCte,
  exactBatchResults,
  groupMemberships,
  projectResult,
  readBase,
  readMembershipIds,
  readProjectBases,
  readReceipt,
  sourceMembershipsReadable,
} from "./project-owner-storage.js";
import { prepareProjectAttachment } from "./project-client-attachment.js";

interface ActiveProjectMembershipRow {
  readonly source_id: unknown;
  readonly role: unknown;
  readonly membership_generation: unknown;
  readonly project_generation: unknown;
}

interface ActiveProjectMembership {
  readonly source_id: string;
  readonly role: string;
}

async function readCurrentMemberships(database: D1Database, projectId: string): Promise<readonly ActiveProjectMembership[]> {
  let result: { readonly results?: readonly ActiveProjectMembershipRow[] };
  try {
    result = await database.prepare(
      "SELECT m.source_id,m.role,m.membership_generation,p.generation AS project_generation " +
      "FROM project_source_membership m JOIN project p ON p.project_id=m.project_id " +
      "WHERE m.project_id=?1 AND m.valid_to IS NULL ORDER BY m.source_id LIMIT ?2",
    ).bind(projectId, MAX_SOURCE_IDS + 1).all<ActiveProjectMembershipRow>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project memberships read is unavailable", true, cause);
  }
  if (!Array.isArray(result.results) || result.results.length > MAX_SOURCE_IDS) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project has too many active memberships", true);
  }
  const rows = result.results.map((row) => {
    const sourceId = storedIdentifier(row.source_id, "active membership source id");
    if (typeof row.role !== "string" || row.role.length === 0 ||
        !Number.isSafeInteger(row.membership_generation) || Number(row.membership_generation) < 1 ||
        !Number.isSafeInteger(row.project_generation) || Number(row.project_generation) < 1 ||
        Number(row.membership_generation) > Number(row.project_generation)) {
      fail("PROJECT_STORAGE_UNAVAILABLE", 503, "stored active project membership generation is invalid", true);
    }
    return Object.freeze({ source_id: sourceId, role: row.role });
  });
  if (new Set(rows.map((row) => row.source_id)).size !== rows.length) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project has duplicate active memberships", true);
  }
  return Object.freeze(rows);
}

export { ProjectOwnerError } from "./project-owner-contract.js";
export type {
  ProjectOwnerActor,
  ProjectOwnerCapability,
  ProjectOwnerCreateInput,
  ProjectOwnerErrorCode,
  ProjectOwnerResult,
  ProjectOwnerService,
  ProjectOwnerSourceAuthority,
  ProjectOwnerUpdateInput,
  PreparedProjectAttachment,
  ProjectAttachmentBinding,
} from "./project-owner-contract.js";

export interface ProjectMembershipIndexMutationInput {
  readonly operation: "CREATE" | "UPDATE";
  readonly project_id: string;
  readonly principal_ref: string;
  readonly mutation_principal_ref: string;
  readonly mutation_idempotency_key: string;
  readonly request_sha256: string;
  readonly project_revision: number;
  readonly created_at: string;
}

export type ProjectMembershipIndexOutboxPlanner = (
  input: ProjectMembershipIndexMutationInput,
) => Promise<PreparedIntentWithOutboxMutation>;

export interface ProjectOwnerCapabilityOptions {
  readonly database: D1Database;
  readonly deployment_generation: string;
  readonly now?: () => number;
  readonly source_authority: ProjectOwnerSourceAuthority;
  readonly prepare_project_membership_index?: ProjectMembershipIndexOutboxPlanner;
}

async function mutationIntroducedMembership(
  database: D1Database,
  input: ProjectMembershipIndexMutationInput,
): Promise<boolean> {
  let row: { readonly membership_change: unknown } | null;
  try {
    row = await database.prepare(
      "SELECT CASE " +
      "WHEN ?5>1 AND NOT EXISTS (SELECT 1 FROM project_mutation_receipt previous " +
      "WHERE previous.project_id=mutation_receipt.project_id AND previous.project_revision=mutation_receipt.project_revision-1) THEN -1 " +
      "WHEN EXISTS (SELECT 1 FROM json_each(mutation_receipt.response_json,'$.source_ids') added " +
      "WHERE NOT EXISTS (SELECT 1 FROM project_mutation_receipt previous, " +
      "json_each(previous.response_json,'$.source_ids') prior " +
      "WHERE previous.project_id=mutation_receipt.project_id AND previous.project_revision=mutation_receipt.project_revision-1 " +
      "AND prior.value=added.value)) THEN 1 ELSE 0 END AS membership_change " +
      "FROM project_mutation_receipt mutation_receipt WHERE mutation_receipt.principal_ref=?1 AND mutation_receipt.idempotency_key=?2 " +
      "AND mutation_receipt.operation=?3 AND mutation_receipt.project_id=?4 AND mutation_receipt.request_sha256=?6 " +
      "AND mutation_receipt.project_revision=?5 LIMIT 1",
    ).bind(
      input.mutation_principal_ref,
      input.mutation_idempotency_key,
      input.operation,
      input.project_id,
      input.project_revision,
      input.request_sha256,
    ).first<{ membership_change: unknown }>();
  } catch (cause) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project membership-index receipt read is unavailable", true, cause);
  }
  if (row === null) {
    fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project membership-index mutation receipt is missing", true);
  }
  if (row.membership_change === -1) {
    fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "prior project revision receipt is missing", true);
  }
  if (row.membership_change !== 0 && row.membership_change !== 1) {
    fail("PROJECT_STORAGE_UNAVAILABLE", 503, "project membership-index receipt shape is invalid", true);
  }
  return row.membership_change === 1;
}

async function ensureMembershipIndexOutbox(
  database: D1Database,
  planner: ProjectMembershipIndexOutboxPlanner | undefined,
  input: ProjectMembershipIndexMutationInput,
  prepared?: PreparedIntentWithOutboxMutation,
): Promise<void> {
  if (planner === undefined || !await mutationIntroducedMembership(database, input)) return;
  const plan = prepared ?? await planner(input);
  let existing: Awaited<ReturnType<PreparedIntentWithOutboxMutation["readback"]>>;
  try {
    existing = await plan.readback();
  } catch (cause) {
    fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project membership-index outbox readback is unavailable", true, cause);
  }
  if (existing !== null) return;

  try {
    const results = await database.batch([...plan.statements]);
    plan.assertBatchResults(results);
  } catch (cause) {
    try {
      if (await plan.readback() !== null) return;
    } catch {
      // Preserve the original uncertain append as the cause below.
    }
    fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project membership-index outbox append is uncertain", true, cause);
  }
  let settled: Awaited<ReturnType<PreparedIntentWithOutboxMutation["readback"]>>;
  try {
    settled = await plan.readback();
  } catch (cause) {
    fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project membership-index outbox readback is unavailable", true, cause);
  }
  if (settled === null) {
    fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project membership-index outbox readback is missing", true);
  }
}

function mutationJson(operation: "CREATE" | "UPDATE", context: ProjectOwnerActor, projectId: string,
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

function verifiedActor(actor: ProjectOwnerActor): ProjectOwnerActor {
  if (!validIdentifier(actor.principal_ref) || !validIdentifier(actor.credential_generation)) {
    fail("PROJECT_OWNER_REQUIRED", 403, "an authenticated owner session is required");
  }
  return actor;
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

export function createProjectOwnerCapability(options: ProjectOwnerCapabilityOptions): ProjectOwnerCapability {
  const now = options.now ?? Date.now;
  const deploymentGeneration = inputIdentifier(options.deployment_generation, "deployment_generation");

  async function read(actorInput: ProjectOwnerActor, rawProjectId: string): Promise<InternalProjectOwnerResult> {
    const owner = verifiedActor(actorInput);
    const projectId = inputIdentifier(rawProjectId, "project_id");
    const clock = nowValue(now);
    const base = await readBase(options.database, owner.principal_ref, projectId);
    if (base === null) fail("PROJECT_NOT_FOUND", 404, "project was not found");
    const rows = await options.source_authority.readMembershipIds(options.database, owner.principal_ref, [projectId], clock.iso);
    const grouped = groupMemberships(rows, [projectId]);
    return projectResult(base, grouped.get(projectId) ?? []);
  }

  async function list(actorInput: ProjectOwnerActor, afterProjectId?: string): Promise<ProjectOwnerListResult> {
    const owner = verifiedActor(actorInput);
    const clock = nowValue(now);
    const cursor = afterProjectId === undefined ? undefined : inputIdentifier(afterProjectId, "project cursor");
    const page = await readProjectBases(options.database, owner.principal_ref, cursor);
    const ids = page.bases.map((base) => base.project_id);
    const memberships = groupMemberships(await options.source_authority.readMembershipIds(options.database, owner.principal_ref, ids, clock.iso), ids);
    return projectPage(page.bases, memberships, page.has_more);
  }

  async function create(actorInput: ProjectOwnerActor, input: ProjectOwnerCreateInput, key: string): Promise<InternalProjectOwnerResult> {
    const owner = verifiedActor(actorInput);
    inputIdentifier(key, "idempotency_key");
    const derivedDigest = await sha256Utf8(mutationJson("CREATE", owner, "derived", key, input));
    const projectId = createProjectId(derivedDigest);
    const requestSha = await sha256Utf8(mutationJson("CREATE", owner, projectId, key, input));
    const existingMutation = await readReceipt(options.database, owner.principal_ref, key);
    const existing = checkExisting(existingMutation, "CREATE", projectId, requestSha);
    if (existing !== null && existingMutation !== null) {
      await ensureMembershipIndexOutbox(options.database, options.prepare_project_membership_index, {
        operation: "CREATE",
        project_id: projectId,
        principal_ref: owner.principal_ref,
        mutation_principal_ref: owner.principal_ref,
        mutation_idempotency_key: key,
        request_sha256: requestSha,
        project_revision: existing.revision,
        created_at: existingMutation.created_at,
      });
      return existing;
    }

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
    const cte = options.source_authority.eligibleSourceCte("?2", "?3", "?4", "?1");
    const membershipIndexMutation: ProjectMembershipIndexMutationInput = {
      operation: "CREATE",
      project_id: projectId,
      principal_ref: owner.principal_ref,
      mutation_principal_ref: owner.principal_ref,
      mutation_idempotency_key: key,
      request_sha256: requestSha,
      project_revision: 1,
      created_at: clock.iso,
    };
    const membershipIndexPlan = input.source_ids.length === 0 || options.prepare_project_membership_index === undefined
      ? undefined
      : await options.prepare_project_membership_index(membershipIndexMutation);
    try {
      const mutationStatements = [
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
          `${options.source_authority.eligibleSourceCte("?2", "?3", "?4", "?1")} INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to,membership_generation) ` +
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
      ];
      const results = await options.database.batch([
        ...mutationStatements,
        ...(membershipIndexPlan?.statements ?? []),
      ]);
      exactBatchResults(results, [
        1, 1, 1, input.source_ids.length, 1, 1,
        ...(membershipIndexPlan === undefined ? [] : [1, 1]),
      ]);
      membershipIndexPlan?.assertBatchResults(results, mutationStatements.length);
    } catch (cause) {
      const racedMutation = await readReceipt(options.database, owner.principal_ref, key);
      const raced = checkExisting(racedMutation, "CREATE", projectId, requestSha);
      if (raced !== null && racedMutation !== null) {
        await ensureMembershipIndexOutbox(options.database, options.prepare_project_membership_index, {
          ...membershipIndexMutation,
          created_at: racedMutation.created_at,
        }, membershipIndexPlan);
        return raced;
      }
      const base = await readBase(options.database, owner.principal_ref, projectId);
      if (base !== null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project creation settled without a receipt", true, cause);
      if (await options.source_authority.eligibleCount(options.database, input.source_ids, owner.principal_ref, clock.iso) !== input.source_ids.length) {
        fail("PROJECT_SOURCE_DENIED", 403, "one or more sources are no longer current or readable");
      }
      if (cause instanceof ProjectOwnerError) throw cause;
      fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project creation outcome is uncertain", true, cause);
    }
    const receipt = await readReceipt(options.database, owner.principal_ref, key);
    if (receipt === null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project creation receipt is missing", true);
    return checkExisting(receipt, "CREATE", projectId, requestSha) as InternalProjectOwnerResult;
  }

  async function update(actorInput: ProjectOwnerActor, rawProjectId: string, input: ProjectOwnerUpdateInput,
    suppliedKey: string, attachment?: PreparedProjectAttachment): Promise<InternalProjectOwnerResult> {
    const actorContext = verifiedActor(actorInput);
    const projectId = inputIdentifier(rawProjectId, "project_id");
    inputIdentifier(suppliedKey, "idempotency_key");
    const owner = attachment === undefined ? actorContext
      : { principal_ref: attachment.binding.owner_principal_ref, credential_generation: actorContext.credential_generation };
    const actor = attachment?.actor_principal_ref ?? actorContext.principal_ref;
    const key = attachment?.receipt_key ?? suppliedKey;
    const requestSha = attachment?.request_sha256 ?? await sha256Utf8(mutationJson("UPDATE", actorContext, projectId, key, input));
    const receipt = () => readReceipt(options.database, actor, key, attachment?.binding);
    const disclose = (result: InternalProjectOwnerResult) => attachment?.disclose(result) ?? Promise.resolve(result);
    const existingMutation = await receipt();
    const existing = checkExisting(existingMutation, "UPDATE", projectId, requestSha);
    if (existing !== null && existingMutation !== null) {
      await ensureMembershipIndexOutbox(options.database, options.prepare_project_membership_index, {
        operation: "UPDATE",
        project_id: projectId,
        principal_ref: owner.principal_ref,
        mutation_principal_ref: actor,
        mutation_idempotency_key: key,
        request_sha256: requestSha,
        project_revision: existing.revision,
        created_at: existingMutation.created_at,
      });
      return disclose(existing);
    }
    const before = await readBase(options.database, owner.principal_ref, projectId);
    if (before === null) fail("PROJECT_NOT_FOUND", 404, "project was not found");
    if (before.revision !== input.expected_revision) fail("PROJECT_REVISION_CONFLICT", 409, "project revision is stale");
    const clock = nowValue(now);
    const activeMemberships = await readCurrentMemberships(options.database, projectId);
    const activeBySource = new Map(activeMemberships.map((membership) => [membership.source_id, membership]));
    const requestedSources = new Set(input.source_ids);
    const closeMembershipIds = activeMemberships.filter((membership) =>
      !requestedSources.has(membership.source_id) ||
      (attachment === undefined && membership.role !== "member")).map((membership) => membership.source_id);
    const insertMembershipIds = input.source_ids.filter((sourceId) => {
      const current = activeBySource.get(sourceId);
      return current === undefined || (attachment === undefined && current.role !== "member");
    });
    if (attachment !== undefined && (input.title !== before.title ||
        activeMemberships.some((membership) => !requestedSources.has(membership.source_id)))) {
      fail("PROJECT_SOURCE_DENIED", 403, "Project attachment cannot rename the project or remove a member");
    }
    const readableRows = await options.source_authority.readMembershipIds(options.database, owner.principal_ref, [projectId], clock.iso);
    const readableMemberships = groupMemberships(readableRows, [projectId]).get(projectId) ?? [];
    if (!sourceMembershipsReadable(activeMemberships.map((membership) => membership.source_id), readableMemberships)) {
      fail("PROJECT_SOURCE_DENIED", 403, "update cannot remove a source that is no longer readable");
    }
    const nextRevision = input.expected_revision + 1;
    if (!Number.isSafeInteger(nextRevision)) fail("PROJECT_INPUT_INVALID", 400, "project revision is too large");
    const responseBase: ProjectBase = {
      ...before, title: input.title, revision: nextRevision,
      deployment_generation: deploymentGeneration,
    };
    const responseJson = createReceiptJson(responseBase, input.source_ids);
    const responseSha = await sha256Utf8(responseJson);
    const sourceJson = JSON.stringify(input.source_ids);
    const cte = options.source_authority.eligibleSourceCte("?2", "?3", attachment === undefined ? "?4" : "'now'", "?1");
    const attachmentArgs = await attachment?.before_write() ?? [];
    const grantColumns = attachment === undefined ? "" : ",project_client_grant_id,project_client_grant_revision,client_authority_expires_at";
    const grantArgs = attachment?.guard_values() ?? [];
    const membershipIndexMutation: ProjectMembershipIndexMutationInput = {
      operation: "UPDATE",
      project_id: projectId,
      principal_ref: owner.principal_ref,
      mutation_principal_ref: actor,
      mutation_idempotency_key: key,
      request_sha256: requestSha,
      project_revision: nextRevision,
      created_at: clock.iso,
    };
    const membershipIndexPlan = insertMembershipIds.length === 0 || options.prepare_project_membership_index === undefined
      ? undefined
      : await options.prepare_project_membership_index(membershipIndexMutation);
    try {
      const mutationStatements = [
        options.database.prepare(
          `${cte} UPDATE project SET title=?5,generation=?6 ` +
          "WHERE project_id=?1 AND generation=?7 " +
          "AND EXISTS (SELECT 1 FROM project_owner po WHERE po.project_id=?1 AND po.principal_ref=?3) " +
          "AND NOT EXISTS (SELECT 1 FROM project_source_membership old WHERE old.project_id=?1 AND old.valid_to IS NULL " +
          "AND julianday(old.valid_from)>=julianday(?4)) " +
          "AND " + options.source_authority.currentMembershipsReadableGuard() + " " +
          "AND (SELECT COUNT(*) FROM requested)=?8 AND (SELECT COUNT(*) FROM eligible)=?8" +
          (attachment === undefined ? "" : attachment.cas_sql),
        ).bind(projectId, sourceJson, owner.principal_ref, clock.iso, input.title, nextRevision, input.expected_revision,
          input.source_ids.length, ...attachmentArgs),
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
          "AND source_id IN (SELECT value FROM json_each(?7)) " +
          "AND EXISTS (SELECT 1 FROM project_mutation_guard g WHERE g.project_id=?1 AND g.principal_ref=?6 AND g.idempotency_key=?5) " +
          "AND EXISTS (SELECT 1 FROM project WHERE project_id=?1 AND generation=?3) " +
          "AND EXISTS (SELECT 1 FROM project_owner WHERE project_id=?1 AND principal_ref=?4)",
        ).bind(projectId, clock.iso, nextRevision, owner.principal_ref, key, actor,
          JSON.stringify(closeMembershipIds)),
        options.database.prepare(
          `${cte} INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to,membership_generation) ` +
          "SELECT ?1,e.source_id,'member',?4,NULL,p.generation FROM eligible e " +
          "JOIN project p ON p.project_id=?1 AND p.generation=?5 " +
          "JOIN project_mutation_guard g ON g.project_id=p.project_id AND g.principal_ref=?7 AND g.idempotency_key=?6 " +
          "JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=?3 " +
          "WHERE e.source_id IN (SELECT value FROM json_each(?8))",
        ).bind(projectId, sourceJson, owner.principal_ref, clock.iso, nextRevision, key, actor,
          JSON.stringify(insertMembershipIds)),
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
      ];
      const results = await options.database.batch([
        ...mutationStatements,
        ...(membershipIndexPlan?.statements ?? []),
      ]);
      exactBatchResults(results, [
        1, 1, 1, closeMembershipIds.length, insertMembershipIds.length, 1, 1,
        ...(membershipIndexPlan === undefined ? [] : [1, 1]),
      ]);
      membershipIndexPlan?.assertBatchResults(results, mutationStatements.length);
    } catch (cause) {
      const racedMutation = await receipt();
      const raced = checkExisting(racedMutation, "UPDATE", projectId, requestSha);
      if (raced !== null && racedMutation !== null) {
        await ensureMembershipIndexOutbox(options.database, options.prepare_project_membership_index, {
          ...membershipIndexMutation,
          created_at: racedMutation.created_at,
        }, membershipIndexPlan);
        return disclose(raced);
      }
      const errorName = cause instanceof Error && cause.name.length > 0 && cause.name.length <= 128
        ? cause.name : "UNCLASSIFIED";
      const errorMessage = cause instanceof Error && cause.message.length > 0
        ? cause.message.slice(0, 500) : "UNCLASSIFIED";
      console.error("project-owner-update-failed", { name: errorName, message: errorMessage });
      const current = await readBase(options.database, owner.principal_ref, projectId);
      if (current === null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project update lost its owner row", true, cause);
      if (current.revision !== input.expected_revision) fail("PROJECT_REVISION_CONFLICT", 409, "project revision changed concurrently");
      if (await options.source_authority.eligibleCount(options.database, input.source_ids, owner.principal_ref, clock.iso) !== input.source_ids.length) {
        fail("PROJECT_SOURCE_DENIED", 403, "one or more sources are no longer current or readable");
      }
      if (cause instanceof ProjectOwnerError) throw cause;
      fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project update outcome is uncertain", true, cause);
    }
    const settled = await receipt();
    if (settled === null) fail("PROJECT_SETTLEMENT_UNCERTAIN", 503, "project update receipt is missing", true);
    return disclose(checkExisting(settled, "UPDATE", projectId, requestSha) as InternalProjectOwnerResult);
  }

  return Object.freeze({
    create: (actor: ProjectOwnerActor, input: ProjectOwnerCreateInput, key: string) => create(actor, input, key),
    read,
    list,
    update: (actor: ProjectOwnerActor, projectId: string, input: ProjectOwnerUpdateInput,
      key: string, attachment?: PreparedProjectAttachment) => update(actor, projectId, input, key, attachment),
  });
}

export interface ProjectOwnerServiceOptions {
  readonly database: D1Database;
  readonly deployment_generation: string;
  readonly now?: () => number;
  readonly prepare_project_membership_index?: ProjectMembershipIndexOutboxPlanner;
}

/**
 * Authenticated-request adapter over the Navigation project capability. Core supplies the context
 * only after its existing Access verification; this module does not authenticate callers.
 */
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
    ...(options.prepare_project_membership_index === undefined
      ? {}
      : { prepare_project_membership_index: options.prepare_project_membership_index }),
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
    update: async (context: AuthenticatedRequestContext, projectId: string, request: UpdateProjectRequest): Promise<InternalProjectOwnerResult> => {
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
