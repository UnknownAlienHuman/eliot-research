import type { ProjectClientGrantPut } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ClientGrantError, readClientGrantSpend } from "@eliotr/cloudflare-navigation";
import { readResearchOwnerSpendPolicyTemplate } from "@eliotr/cloudflare-research";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { requireClientResearchExecution } from "./research-client-execution.js";
import type { ReauthenticatedRunRead } from "./research-run-read-authorization.js";
import type { ProjectClientRunRead } from "./research-client-run-read.js";

function denied(message: string): never { throw new ClientGrantError("CLIENT_GRANT_SPEND_DENIED", 403, message); }

export async function requireProjectClientSpendSchema(env: Env): Promise<void> {
  let ready = false;
  try {
    const row = await env.CORE_DB.prepare("SELECT value FROM schema_state WHERE key='project_client_spend_generation'")
      .first<{ readonly value: string }>();
    ready = row?.value === "project-client-spend-v1";
  } catch { /* Missing migration is unavailable, never permission. */ }
  if (!ready) throw new ClientGrantError("CLIENT_GRANT_SCHEMA_NOT_READY", 503, "Migration 0075 is required before grant mutation or recovery", true);
}

/** Validate the existing installed approval. A public policy name is never itself permission. */
async function installedSponsorship(env: Env, principal: string, policyRef: string, deployment: string) {
  let policy;
  try {
    policy = readResearchOwnerSpendPolicyTemplate(env.ELIOTR_MODEL_SPEND_POLICY_JSON,
      env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF ?? "");
  } catch { denied("Delegation requires an installed, explicit owner spend template"); }
  if (policy.principal_ref !== principal || policy.policy_ref !== policyRef ||
      policy.deployment_generation !== deployment || Date.parse(policy.expires_at) <= Date.now()) {
    denied("Installed spend approval does not match this grantor, policy, deployment and time");
  }
  return Object.freeze({ policy_sha256: await sha256Utf8(canonicalJson(policy)),
    deployment_generation: policy.deployment_generation, expires_at: policy.expires_at });
}

/** Called only by the owner grant API; the validated fingerprint is stored on that grant revision. */
export async function authorizeProjectClientSpend(
  env: Env, context: AuthenticatedRequestContext, input: ProjectClientGrantPut,
) {
  if (context.client_class !== "owner_pwa" || !context.access || context.request.signal.aborted ||
      context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= Date.now() ||
      input.spend_policy_ref === undefined) denied("Current owner approval is required");
  return installedSponsorship(env, context.principal_ref, input.spend_policy_ref, env.DEPLOYMENT_GENERATION);
}

export interface ProjectClientRecoverySpend {
  readonly policy_decision_ref: string;
  readonly valid_until_ms: number;
  requireCurrent(): Promise<void>;
}

/** Sponsorship permits a recovery command, not a replacement run or new scope.
 * The original owner or machine execution and every W2/W3 budget remain mandatory. */
export async function prepareProjectClientRecoverySpend(
  env: Env, read: ProjectClientRunRead,
): Promise<ProjectClientRecoverySpend> {
  const grant = read.client_grant;
  if (!grant.allowed_operations.includes("recover") || grant.spend_policy_ref === undefined) {
    denied("Recovery requires separate recover permission and explicit model-spend sponsorship");
  }
  const recorded = await readClientGrantSpend(env.CORE_DB, grant);
  const installed = await installedSponsorship(env, grant.grantor_principal_ref,
    grant.spend_policy_ref, read.status.deployment_generation);
  if (recorded === null || canonicalJson(recorded) !== canonicalJson(installed)) {
    denied("Installed spend approval changed; an explicit new grant revision is required");
  }
  const requireCurrent = async () => {
    await read.requireCurrent();
    if (Date.parse(installed.expires_at) <= Date.now()) denied("Recovery sponsorship expired");
    const binding = await readClientGrantSpend(env.CORE_DB, grant);
    if (canonicalJson(binding) !== canonicalJson(recorded)) denied("Recovery sponsorship changed");
    // Read authorization is not permission to renew an expired original execution grant.
    const current = await env.CORE_DB.prepare("SELECT 1 AS ok FROM research_workflow_current r " +
      "JOIN project_client_run_control_origin c ON c.operation_id=r.operation_id " +
      "WHERE r.operation_id=?1 AND r.principal_ref=?2 AND r.deployment_generation=?3 " +
      "AND r.state IN ('ACTIVE','ENGINE_COMPLETED') AND c.client_grant_id=?4 " +
      "AND c.client_grant_revision=?5 AND c.project_generation=?6 LIMIT 1")
      .bind(read.status.operation_id, read.status.principal_ref, read.status.deployment_generation,
        grant.grant_id, grant.revision, read.project_generation).first();
    if (!current) denied("Original execution authority is no longer current; recovery cannot renew it");
    await read.requireCurrent();
    if (Date.parse(installed.expires_at) <= Date.now()) denied("Recovery sponsorship expired");
  };
  await requireCurrent();
  return { policy_decision_ref: `research-client-recovery:${await sha256Utf8(canonicalJson(grant))}:${read.project_generation}:${installed.policy_sha256}`,
    valid_until_ms: Date.parse(installed.expires_at), requireCurrent };
}

/** An owner's command cannot re-create the machine's expired/revoked execution.
 * Recorded credentials are used only to validate that immutable execution, never
 * to authenticate the caller or change the journal's actual owner attribution. */
export async function prepareOwnerMachineRecoverySpend(
  env: Env, context: AuthenticatedRequestContext, read: ReauthenticatedRunRead,
): Promise<ProjectClientRecoverySpend> {
  const origin = read.owner_machine;
  if (context.client_class !== "owner_pwa" || origin === undefined) denied("Original owner authority is required");
  const execution = { principal_ref: read.status.principal_ref,
    credential_generation: read.status.credential_generation, client_class: origin.origin_client_class };
  const scope = { snapshot_id: read.status.scope_snapshot_id, revision: read.status.scope_snapshot_revision };
  const approved = await requireClientResearchExecution(env, execution, scope,
    read.status.operation_id, read.status.deployment_generation);
  if (approved.grant.grantor_principal_ref !== context.principal_ref ||
      approved.grant.grant_id !== origin.client_grant_id || approved.grant.revision !== origin.client_grant_revision ||
      await sha256Utf8(canonicalJson(approved.grant)) !== origin.grant_record_sha256) denied("Original sponsorship does not belong to this owner");
  const expected = canonicalJson(approved);
  const validUntil = Math.min(Date.parse(origin.execution_deadline), Date.parse(approved.binding.expires_at));
  const requireCurrent = async () => {
    await read.requireCurrent();
    if (!Number.isSafeInteger(validUntil) || validUntil <= Date.now()) denied("Original execution or sponsorship expired");
    const current = await requireClientResearchExecution(env, execution, scope,
      read.status.operation_id, read.status.deployment_generation);
    if (canonicalJson(current) !== expected) denied("Original execution sponsorship changed");
    const row = await env.CORE_DB.prepare("SELECT 1 AS present FROM research_workflow_current r " +
      "JOIN owner_machine_run_origin o ON o.operation_id=r.operation_id WHERE r.operation_id=?1 " +
      "AND r.principal_ref=?2 AND r.deployment_generation=?3 AND r.state IN ('ACTIVE','ENGINE_COMPLETED') " +
      "AND o.reader_principal_ref=?4 AND o.project_id=?5 AND o.project_generation=?6 LIMIT 1")
      .bind(read.status.operation_id, read.status.principal_ref, read.status.deployment_generation,
        context.principal_ref, origin.project_id, origin.project_generation).first();
    if (row === null) denied("Recovery cannot replace expired or revoked execution");
    await read.requireCurrent();
    if (validUntil <= Date.now()) denied("Original execution or sponsorship expired");
  };
  await requireCurrent();
  return { policy_decision_ref: `research-owner-machine-recovery:${origin.grant_record_sha256}:${origin.project_generation}:${approved.binding.policy_sha256}`,
    valid_until_ms: validUntil, requireCurrent };
}
