import { createNavigationReadAuthority, loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { OrientationError, ScopeServiceError, reauthorizeOwnerHistoricalScope } from "@eliotr/cloudflare-navigation";
import { ArtifactDraftReadError, WorkflowCheckpointError, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import type { WorkflowRunStatus } from "@eliotr/cloudflare-research";
import { readHistoricalResearchCoverage } from "@eliotr/cloudflare-research-stages";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { NavigationError } from "@eliotr/retrieval";
import type { Env } from "./env.js";
import { reopenOwnerArtifactDraft } from "./research-artifact-reauthorization-http.js";

interface RunBinding {
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly handler_generation: string;
}
export interface ReauthenticatedRunRead {
  readonly status: WorkflowRunStatus;
  readonly handler_generation: string;
  readonly requireCurrent: () => Promise<void>;
}

function stale(): never { throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE"); }
function corrupt(): never { throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT"); }

function requireActiveRequest(context: AuthenticatedRequestContext): void {
  if (context.request.signal.aborted) throw new WorkflowCheckpointError("WORKFLOW_CANCELLED");
  const access = context.access;
  if (access !== undefined && (access.principal_ref !== context.principal_ref ||
      access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(access.expires_at)) || Date.parse(access.expires_at) <= Date.now())) stale();
}

function mapReadFailure(error: unknown): never {
  if (error instanceof WorkflowCheckpointError) throw error;
  if (error instanceof ScopeServiceError || error instanceof NavigationError || error instanceof OrientationError ||
      error instanceof ArtifactDraftReadError) {
    // Failures in the current read authority must never turn into an old-credential fallback.
    if (("status" in error && error.status >= 500) ||
        (error instanceof ScopeServiceError && error.code === "SCOPE_PERSISTENCE_INVALID")) throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_UNAVAILABLE");
    stale();
  }
  throw error;
}

function sameIdentity(left: WorkflowRunStatus, right: WorkflowRunStatus): void {
  if (left.operation_id !== right.operation_id || left.investigation_id !== right.investigation_id ||
      left.initial_revision !== right.initial_revision || left.principal_ref !== right.principal_ref ||
      left.credential_generation !== right.credential_generation ||
      left.deployment_generation !== right.deployment_generation ||
      left.scope_snapshot_id !== right.scope_snapshot_id || left.scope_snapshot_revision !== right.scope_snapshot_revision ||
      right.next_stage_index < left.next_stage_index ||
      (left.state !== "ACTIVE" && right.state !== left.state)) corrupt();
}

/** A refreshed owner session can read history; it cannot renew execution authority.
 * The stored credential is provenance only. All authorization uses the current caller.
 * Deployment continuity is deliberately left to the separate deployment contract. */
export async function prepareReauthenticatedRunRead(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
): Promise<ReauthenticatedRunRead | null> {
  if (context.client_class !== "owner_pwa") stale();
  requireActiveRequest(context);
  const binding = await env.CORE_DB.prepare(
    "SELECT credential_generation, deployment_generation, handler_generation FROM research_workflow_run " +
    "WHERE operation_id=?1 AND principal_ref=?2 LIMIT 1",
  ).bind(operationId, context.principal_ref).first<RunBinding>();
  if (binding === null || binding.credential_generation === context.credential_generation ||
      binding.deployment_generation !== env.DEPLOYMENT_GENERATION) return null;
  if (typeof binding.credential_generation !== "string" || typeof binding.handler_generation !== "string") corrupt();

  const principal = {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
  const store = new WorkflowCheckpointStore(env.CORE_DB);
  // The store filters by owner and validates the recorded state/receipts. Its
  // returned metadata is not disclosed until independent current authorization.
  const first = await store.readRunStatus(operationId, principal);
  if (first === null || first.credential_generation !== binding.credential_generation ||
      first.deployment_generation !== binding.deployment_generation) corrupt();
  const originalRef = { id: first.scope_snapshot_id, revision: first.scope_snapshot_revision };
  const original = await loadScopeAuthority(env.CORE_DB, originalRef);
  if (original === null) stale();
  const historical = await reauthorizeOwnerHistoricalScope({
    database: env.CORE_DB, access: context, original_ref: originalRef, original: original.snapshot,
  }).catch(mapReadFailure);
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB, access: context, scope_snapshot: historical.scope,
    require_current: historical.requireCurrent,
  });
  const requireCurrent = async () => {
    requireActiveRequest(context);
    const authorization = await navigation.current().catch(mapReadFailure);
    await navigation.sources(historical.scope.member_source_revision_refs, authorization).catch(mapReadFailure);
    // Keep the recorded W1/W2 owner and scope linkage. Current read permission
    // does not authorize substitution of another investigation or source set.
    const head = await store.head(first.investigation_id);
    if (head.principal_ref !== context.principal_ref || head.scope_snapshot_id !== originalRef.id ||
        head.scope_snapshot_revision !== originalRef.revision) stale();
    requireActiveRequest(context);
  };
  await requireCurrent();
  const status = await store.readRunStatus(operationId, principal);
  if (status === null) corrupt();
  sameIdentity(first, status);
  await requireCurrent();
  return { status, handler_generation: binding.handler_generation, requireCurrent };
}

/** Reuse the historical coverage and artifact readers, never impersonate the
 * old principal to make the original materialization reader accept a new JWT. */
export async function readReauthenticatedRunAnswer(
  env: Env,
  context: AuthenticatedRequestContext,
  read: ReauthenticatedRunRead,
  materializeHandlerGeneration: string,
): Promise<ResearchRunStatus["answer"]> {
  if (read.status.state !== "ENGINE_COMPLETED" || read.handler_generation !== materializeHandlerGeneration) {
    return { availability: "unavailable" };
  }
  const historical = await readHistoricalResearchCoverage({
    database: env.CORE_DB, work_bucket: env.WORK_BUCKET, operation_id: read.status.operation_id,
    owner: { principal_ref: context.principal_ref, client_class: "owner_pwa" },
    require_current: read.requireCurrent,
    require_artifact: async ({ artifact_ref, original_scope_snapshot_ref }) => {
      if (original_scope_snapshot_ref.id !== read.status.scope_snapshot_id ||
          original_scope_snapshot_ref.revision !== read.status.scope_snapshot_revision) corrupt();
      const reopened = await reopenOwnerArtifactDraft(env, context, artifact_ref).catch(mapReadFailure);
      if (!("sections" in reopened.artifact) || reopened.artifact.status !== "DRAFT" ||
          reopened.artifact_ref.id !== artifact_ref.id || reopened.artifact_ref.revision !== artifact_ref.revision ||
          reopened.original_scope_snapshot_ref.id !== original_scope_snapshot_ref.id ||
          reopened.original_scope_snapshot_ref.revision !== original_scope_snapshot_ref.revision) corrupt();
      return {
        artifact_ref: reopened.artifact_ref, original_scope_snapshot_ref: reopened.original_scope_snapshot_ref,
        status: "DRAFT", evidence_freeze_ref: reopened.artifact.evidence_freeze_ref,
        dependency_manifest_ref: reopened.artifact.dependency_manifest_ref,
      };
    },
  });
  await read.requireCurrent();
  if (historical === null) corrupt();
  return { availability: "draft", artifact_ref: historical.artifact_ref };
}
