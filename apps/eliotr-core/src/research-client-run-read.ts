import {
  createProjectClientRunReadAuthority, requireHistoricalScopeOrigin,
} from "@eliotr/cloudflare-navigation";
import { WorkflowCheckpointError, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { readProjectClientHistoricalResearchCoverage } from "@eliotr/cloudflare-research-stages";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import {
  createRunArtifactReadback, requireRunStatusContinuity, type ResearchRunRead,
} from "./research-run-read-authorization.js";
import type { Env } from "./env.js";

export interface ProjectClientRunRead extends ResearchRunRead {
  readonly can_read_report: boolean;
}
function stale(): never { throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE"); }
function corrupt(): never { throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"); }

/** Reauthorize a known owner's project run for the actual service caller.
 * This never writes an execution grant, starts a stage or substitutes an owner context. */
export async function prepareProjectClientRunRead(
  env: Env, context: AuthenticatedRequestContext, operationId: string,
): Promise<ProjectClientRunRead | null> {
  const authority = await createProjectClientRunReadAuthority(env.CORE_DB, context, operationId);
  if (authority === null) return null;
  const { binding, original, lease } = authority;
  const originalRef = { id: original.snapshot_id, revision: original.revision };
  // These fields select/validate the recorded row only. "owner-read" skips execution
  // renewal; all permission comes from the independent current service authority below.
  const recordedLookup = { principal_ref: binding.principal_ref, credential_generation: binding.credential_generation,
    deployment_generation: binding.deployment_generation };
  const store = new WorkflowCheckpointStore(env.CORE_DB);
  const requireCurrent = async () => {
    await requireHistoricalScopeOrigin(env.CORE_DB, originalRef, original);
    await requireResearchDeploymentCompatibility(env.CORE_DB, binding.deployment_generation, env.DEPLOYMENT_GENERATION);
    await authority.requireCurrent();
    const head = await store.head(binding.investigation_id);
    if (head.principal_ref !== binding.principal_ref || head.scope_snapshot_id !== originalRef.id ||
        head.scope_snapshot_revision !== originalRef.revision || head.policy_authority_ref !== binding.policy_authority_ref ||
        head.deployment_generation !== binding.deployment_generation) stale();
    await requireHistoricalScopeOrigin(env.CORE_DB, originalRef, original);
    await lease.requireGrantCurrent();
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
  return { status, handler_generation: binding.handler_generation, requireCurrent,
    can_read_report: lease.grant.allowed_operations.includes("report") };
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
