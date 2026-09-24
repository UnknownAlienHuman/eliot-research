import type { ScopeSnapshot, VersionedRef, ProjectClientGrant } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type { EvidenceAccessContext, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { authorizeProjectClientGrant, createProjectClientScopeAuthority, readClientGrant,
  readClientGrantSpend, ClientGrantError } from "@eliotr/cloudflare-navigation";
import { readResearchOwnerSpendPolicyTemplate, readResearchModelSpendPolicy,
  type WorkflowPrincipal, type ResearchOwnerSpendPolicyTemplate, type ResearchModelSpendPolicy } from "@eliotr/cloudflare-research";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { resolveResearchOwnerSpendPolicy } from "./research-owner-spend-policy.js";
import type { Env } from "./env.js";

function denied(message: string): never { throw new ClientGrantError("CLIENT_RUN_AUTHORITY_STALE", 403, message); }

interface SponsoredRun {
  readonly grant: ProjectClientGrant;
  readonly template: ResearchOwnerSpendPolicyTemplate;
  readonly binding: { readonly policy_sha256: string; readonly deployment_generation: string; readonly expires_at: string };
}
async function sponsorship(env: Env, grantId: string, revision: number, deployment: string): Promise<SponsoredRun> {
  const grant = await readClientGrant(env.CORE_DB, grantId);
  if (!grant || grant.state !== "ACTIVE" || grant.revision !== revision || !grant.allowed_operations.includes("run") ||
      !grant.spend_policy_ref || Date.parse(grant.expires_at) <= Date.now()) denied("Current run delegation and explicit sponsorship are required");
  const binding = await readClientGrantSpend(env.CORE_DB, grant);
  const template = readResearchOwnerSpendPolicyTemplate(env.ELIOTR_MODEL_SPEND_POLICY_JSON,
    env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF ?? "");
  const hash = await sha256Utf8(canonicalJson(template));
  if (!binding || template.principal_ref !== grant.grantor_principal_ref || template.policy_ref !== grant.spend_policy_ref ||
      template.deployment_generation !== deployment || binding.deployment_generation !== deployment ||
      binding.policy_sha256 !== hash || binding.expires_at !== template.expires_at || Date.parse(binding.expires_at) <= Date.now()) {
    denied("The installed sponsor approval differs from the immutable grant revision");
  }
  return { grant, template, binding };
}

/** Fresh HTTP admission uses the verified service identity, never a reconstructed owner context. */
export async function prepareClientResearchAdmission(env: Env, context: AuthenticatedRequestContext,
  request: QueryRequest, operationId: string): Promise<Awaited<ReturnType<typeof createProjectClientScopeAuthority>>> {
  const schema = await env.CORE_DB.prepare("SELECT value FROM schema_state WHERE key='project_client_execution_generation'")
    .first<string>("value");
  if (schema !== "project-client-execution-v1") {
    throw new ClientGrantError("CLIENT_GRANT_SCHEMA_NOT_READY", 503, "Machine Research requires migration 0076", true);
  }
  if (request.scope_expression.kind !== "PROJECT") denied("Machine Research requires one explicit PROJECT");
  const lease = await authorizeProjectClientGrant(env.CORE_DB, context,
    { operation: "run", project_id: request.scope_expression.project_id });
  const approved = await sponsorship(env, lease.grant.grant_id, lease.grant.revision, env.DEPLOYMENT_GENERATION);
  await lease.requireGrantCurrent();
  const delegated = await createProjectClientScopeAuthority(env.CORE_DB, context, request.scope_expression, Date.now,
    { operation_id: operationId, expires_at_ms: Date.parse(approved.binding.expires_at) });
  if (canonicalJson(delegated.lease.grant) !== canonicalJson(lease.grant)) denied("Delegation changed during admission");
  return delegated;
}

interface OriginRow {
  readonly client_class: string;
  readonly project_client_grant_id: string | null;
  readonly project_client_grant_revision: number | null;
  readonly project_client_run_operation_id: string | null;
}

/** Durable provenance replaces the expired HTTP request, not its actor or its grant revision. */
export async function requireClientResearchExecution(env: Env, access: EvidenceAccessContext,
  scope: Pick<ScopeSnapshot, "snapshot_id" | "revision">, operationId: string, deployment: string): Promise<SponsoredRun> {
  const row = await env.CORE_DB.prepare("SELECT client_class,project_client_grant_id,project_client_grant_revision," +
    "project_client_run_operation_id FROM scope_access_grant_effective WHERE snapshot_id=?1 AND snapshot_revision=?2 " +
    "AND principal_ref=?3 AND credential_generation=?4 AND client_class=?5 AND project_client_operation='run' " +
    "AND project_client_run_operation_id=?6 AND state='ACTIVE' AND julianday(expires_at)>julianday('now') LIMIT 1")
    .bind(scope.snapshot_id, scope.revision, access.principal_ref, access.credential_generation, access.client_class, operationId)
    .first<OriginRow>();
  if (!row?.project_client_grant_id || row.project_client_grant_revision === null || row.project_client_run_operation_id !== operationId ||
      (access.client_class !== "trusted_agent" && access.client_class !== "named_api_client")) denied("Original delegated execution is no longer current");
  const approved = await sponsorship(env, row.project_client_grant_id, row.project_client_grant_revision, deployment);
  if (approved.grant.grantee.subject !== access.principal_ref || approved.grant.grantee.authentication_method !== "service_token") {
    denied("Execution actor differs from the originating delegation");
  }
  const stillCurrent = await env.CORE_DB.prepare("SELECT 1 FROM scope_access_grant_effective WHERE snapshot_id=?1 " +
    "AND snapshot_revision=?2 AND principal_ref=?3 AND client_class=?4 AND credential_generation=?5 " +
    "AND project_client_operation='run' AND project_client_run_operation_id=?6 AND project_client_grant_id=?7 " +
    "AND project_client_grant_revision=?8 LIMIT 1")
    .bind(scope.snapshot_id, scope.revision, access.principal_ref, access.client_class, access.credential_generation,
      operationId, approved.grant.grant_id, approved.grant.revision).first();
  if (stillCurrent === null) denied("Execution authority changed while resolving sponsorship");
  return approved;
}

/** Derive only the recorded class from canonical rows; native payloads cannot choose authorization. */
export async function loadResearchExecutionAccess(env: Env, operationId: string, principal: WorkflowPrincipal): Promise<EvidenceAccessContext> {
  const row = await env.CORE_DB.prepare("SELECT g.client_class,g.project_client_grant_id,g.project_client_grant_revision," +
    "g.project_client_run_operation_id,r.scope_snapshot_id,r.scope_snapshot_revision " +
    "FROM research_workflow_current r JOIN scope_access_grant_effective g ON g.snapshot_id=r.scope_snapshot_id " +
    "AND g.snapshot_revision=r.scope_snapshot_revision AND g.principal_ref=r.principal_ref " +
    "AND g.credential_generation=r.credential_generation AND g.authorization_receipt_ref=r.authorization_receipt_ref " +
    "WHERE r.operation_id=?1 AND r.principal_ref=?2 AND r.credential_generation=?3 AND r.deployment_generation=?4 LIMIT 1")
    .bind(operationId, principal.principal_ref, principal.credential_generation, principal.deployment_generation)
    .first<OriginRow & { scope_snapshot_id: string; scope_snapshot_revision: number }>();
  if (!row) denied("Workflow execution authority is unavailable");
  if (row.client_class !== "owner_pwa" && row.client_class !== "trusted_agent" && row.client_class !== "named_api_client") {
    denied("Unsupported workflow actor class");
  }
  const access: EvidenceAccessContext = { principal_ref: principal.principal_ref, client_class: row.client_class,
    credential_generation: principal.credential_generation };
  if (row.project_client_grant_id === null) {
    if (row.client_class !== "owner_pwa") denied("Unbound service execution is forbidden");
  } else await requireClientResearchExecution(env, access,
    { snapshot_id: row.scope_snapshot_id, revision: row.scope_snapshot_revision }, operationId, principal.deployment_generation);
  return access;
}

export async function resolveResearchExecutionSpend(env: Env, navigation: NavigationReadAuthority,
  operationId: string, deployment: string, policyGeneration: string): Promise<ResearchModelSpendPolicy> {
  const grant = await navigation.current();
  const common = { raw: env.ELIOTR_MODEL_SPEND_POLICY_JSON, provenance: env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF ?? "",
    access: navigation.access, deployment_generation: deployment, policy_generation: policyGeneration,
    policy_authority_ref: navigation.scope.policy_authority_ref, scope_expires_at: navigation.scope.expires_at, authorization: grant };
  if (navigation.access.client_class === "owner_pwa") return resolveResearchOwnerSpendPolicy(common).policy;
  const approved = await requireClientResearchExecution(env, navigation.access, navigation.scope, operationId, deployment);
  const expiry = Math.min(Date.parse(grant.expires_at), Date.parse(navigation.scope.expires_at), Date.parse(approved.binding.expires_at));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) denied("Execution spend authority expired");
  // Only actor/scope-varying fields change. Routes, quotas and policy identity come from the exact approved template.
  return readResearchModelSpendPolicy(canonicalJson({ ...approved.template,
    protocol: "eliotr.research-delegated-model-spend-policy.v1",
    principal_ref: navigation.access.principal_ref, client_class: navigation.access.client_class,
    credential_generation: navigation.access.credential_generation, policy_generation: policyGeneration,
    policy_authority_ref: navigation.scope.policy_authority_ref, expires_at: new Date(expiry).toISOString(),
    sponsor_principal_ref: approved.grant.grantor_principal_ref, sponsor_policy_sha256: approved.binding.policy_sha256 }), common.provenance);
}

/** Same-token status for a machine-authored run. It cannot turn a new grant into old execution authority. */
export async function authorizeMachineRunRead(env: Env, context: AuthenticatedRequestContext, operationId: string) {
  const row = await env.CORE_DB.prepare("SELECT r.scope_snapshot_id,r.scope_snapshot_revision,r.deployment_generation," +
    "g.project_client_grant_revision,g.project_client_grant_id FROM research_workflow_run r JOIN scope_access_grant g " +
    "ON g.snapshot_id=r.scope_snapshot_id AND g.snapshot_revision=r.scope_snapshot_revision AND g.principal_ref=r.principal_ref " +
    "AND g.credential_generation=r.credential_generation WHERE r.operation_id=?1 AND r.principal_ref=?2 " +
    "AND r.credential_generation=?3 AND g.client_class=?4 AND g.project_client_operation='run' LIMIT 1")
    .bind(operationId, context.principal_ref, context.credential_generation, context.client_class)
    .first<{ scope_snapshot_id: string; scope_snapshot_revision: number; deployment_generation: string;
      project_client_grant_revision: number; project_client_grant_id: string }>();
  if (!row) return null;
  const lease = await authorizeProjectClientGrant(env.CORE_DB, context,
    { operation: "status", required_revision: row.project_client_grant_revision });
  if (lease.grant.grant_id !== row.project_client_grant_id) denied("Status grant differs from the execution origin");
  const scope: VersionedRef = { id: row.scope_snapshot_id, revision: row.scope_snapshot_revision };
  const requireCurrent = async () => {
    await lease.requireGrantCurrent();
    await requireClientResearchExecution(env, context, { snapshot_id: scope.id, revision: scope.revision }, operationId, row.deployment_generation);
  };
  await requireCurrent();
  return { lease, requireCurrent, can_read_report: lease.grant.allowed_operations.includes("report") };
}

/** A machine reads its own original report under current explicit read rights, not the grantor's identity. */
export async function prepareMachineArtifactScope(env: Env, context: AuthenticatedRequestContext,
  scope: ScopeSnapshot, operation: "report" | "evidence") {
  const row = await env.CORE_DB.prepare("SELECT project_client_run_operation_id AS operation_id," +
    "project_client_grant_id AS grant_id,project_client_grant_revision AS revision FROM scope_access_grant " +
    "WHERE snapshot_id=?1 AND snapshot_revision=?2 AND principal_ref=?3 AND client_class=?4 " +
    "AND credential_generation=?5 AND project_client_operation='run' LIMIT 1")
    .bind(scope.snapshot_id, scope.revision, context.principal_ref, context.client_class, context.credential_generation)
    .first<{ operation_id: string; grant_id: string; revision: number }>();
  if (!row) denied("The machine report requires its original execution identity");
  const lease = await authorizeProjectClientGrant(env.CORE_DB, context, { operation, required_revision: row.revision });
  if (lease.grant.grant_id !== row.grant_id || !lease.grant.allowed_operations.includes("report")) denied("Report reading is not delegated");
  const requireCurrent = async () => {
    await lease.requireGrantCurrent();
    await requireClientResearchExecution(env, context, scope, row.operation_id, env.DEPLOYMENT_GENERATION);
    return scope;
  };
  await requireCurrent();
  return { scope, requireCurrent };
}
