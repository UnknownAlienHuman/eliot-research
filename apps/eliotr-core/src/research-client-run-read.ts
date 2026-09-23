import {
  createProjectClientRunReadAuthority, requireHistoricalScopeOrigin,
} from "@eliotr/cloudflare-navigation";
import { WorkflowCheckpointError, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { readProjectClientHistoricalResearchCoverage } from "@eliotr/cloudflare-research-stages";
import type { ProjectClientGrant } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import {
  createRunArtifactReadback, requireRunStatusContinuity, type ResearchRunRead,
} from "./research-run-read-authorization.js";
import type { Env } from "./env.js";

export interface ProjectClientRunRead extends ResearchRunRead {
  readonly can_read_report: boolean;
  readonly client_grant: ProjectClientGrant;
  readonly project_generation: number;
  readonly controlFence: () => Promise<ProjectClientRunCancelFence>;
}
export interface ProjectClientRunCancelFence {
  readonly client_grant: ProjectClientGrant;
  readonly project_generation: number;
  readonly ledger_epoch: number;
  readonly orientation_epoch: number;
  readonly valid_until_ms: number;
}
function stale(): never { throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE"); }
function corrupt(): never { throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"); }

/** Reauthorize a known owner's project run for the actual service caller.
 * This never writes an execution grant, starts a stage or substitutes an owner context. */
export async function prepareProjectClientRunRead(
  env: Env, context: AuthenticatedRequestContext, operationId: string,
  operation: "status" | "cancel" = "status",
): Promise<ProjectClientRunRead | null> {
  const authority = await createProjectClientRunReadAuthority(env.CORE_DB, context, operationId, Date.now, operation);
  if (authority === null) return null;
  const { binding, original, lease } = authority;
  const originalRef = { id: original.snapshot_id, revision: original.revision };
  // These fields select/validate the recorded row only. "owner-read" skips execution
  // renewal; all permission comes from the independent current service authority below.
  const recordedLookup = { principal_ref: binding.principal_ref, credential_generation: binding.credential_generation,
    deployment_generation: binding.deployment_generation };
  const store = new WorkflowCheckpointStore(env.CORE_DB);
  const currentAuthorization = async () => {
    await requireHistoricalScopeOrigin(env.CORE_DB, originalRef, original);
    await requireResearchDeploymentCompatibility(env.CORE_DB, binding.deployment_generation, env.DEPLOYMENT_GENERATION);
    const validUntil = await authority.requireCurrent();
    const head = await store.head(binding.investigation_id);
    if (head.principal_ref !== binding.principal_ref || head.scope_snapshot_id !== originalRef.id ||
        head.scope_snapshot_revision !== originalRef.revision || head.policy_authority_ref !== binding.policy_authority_ref ||
        head.deployment_generation !== binding.deployment_generation) stale();
    if (operation === "cancel") {
      const policy = await env.CORE_DB.prepare("SELECT 1 AS present FROM investigation_current_policy " +
        "WHERE policy_generation=?1 AND policy_authority_ref=?2 AND state='ACTIVE' LIMIT 1")
        .bind(head.policy_generation, head.policy_authority_ref).first();
      if (policy === null) stale();
    }
    await requireHistoricalScopeOrigin(env.CORE_DB, originalRef, original);
    await lease.requireGrantCurrent();
    if (validUntil <= Date.now()) stale();
    return validUntil;
  };
  const requireCurrent = async () => { await currentAuthorization(); };
  const controlFence = async (): Promise<ProjectClientRunCancelFence> => {
    if (operation !== "cancel") stale();
    // Capture before validation, so a concurrent upstream change cannot become
    // an accidentally trusted newer epoch at the mutation boundary.
    const epochs = await env.CORE_DB.prepare(
      "SELECT (SELECT generation FROM investigation_ledger_epoch WHERE singleton=1) AS ledger_epoch, " +
      "(SELECT generation FROM orientation_authority_epoch WHERE singleton=1) AS orientation_epoch",
    ).first<{ ledger_epoch: number; orientation_epoch: number }>();
    if (!epochs || !Number.isSafeInteger(epochs.ledger_epoch) || epochs.ledger_epoch < 1 ||
        !Number.isSafeInteger(epochs.orientation_epoch) || epochs.orientation_epoch < 1) corrupt();
    const validUntil = await currentAuthorization();
    return { ...epochs, client_grant: lease.grant, project_generation: lease.project_generation, valid_until_ms: validUntil };
  };
  await requireCurrent();
  const first = await store.readRunStatus(operationId, recordedLookup, "owner-read");
  if (first === null || first.investigation_id !== binding.investigation_id ||
      first.principal_ref !== binding.principal_ref || first.credential_generation !== binding.credential_generation ||
      first.deployment_generation !== binding.deployment_generation || first.scope_snapshot_id !== originalRef.id ||
      first.scope_snapshot_revision !== originalRef.revision) corrupt();
  await requireCurrent();
  const status = await store.readRunStatus(operationId, recordedLookup, "owner-read");
  if (status === null) corrupt();
  requireRunStatusContinuity(first, status);
  await requireCurrent();
  return { status, handler_generation: binding.handler_generation, requireCurrent, controlFence,
    client_grant: lease.grant, project_generation: lease.project_generation,
    can_read_report: operation === "status" && lease.grant.allowed_operations.includes("report") };
}

/** Status alone discloses no result reference. Report discovery reuses exact
 * historical coverage and the same delegated report reader as a known-reference GET. */
export async function readProjectClientRunAnswer(
  env: Env, context: AuthenticatedRequestContext, read: ProjectClientRunRead,
  materializeHandlerGeneration: string,
): Promise<ResearchRunStatus["answer"]> {
  if (!read.can_read_report || read.status.state !== "ENGINE_COMPLETED" ||
      read.handler_generation !== materializeHandlerGeneration) return { availability: "unavailable" };
  const historical = await readProjectClientHistoricalResearchCoverage({
    database: env.CORE_DB, work_bucket: env.WORK_BUCKET, operation_id: read.status.operation_id,
    reader: context, original_principal_ref: read.status.principal_ref,
    require_current: read.requireCurrent, require_artifact: createRunArtifactReadback(env, context, read),
  });
  await read.requireCurrent();
  if (historical === null) corrupt();
  return { availability: "draft", artifact_ref: historical.artifact_ref };
}
