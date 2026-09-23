import { createNavigationReadAuthority, loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { OrientationError, ScopeServiceError, reauthorizeOwnerHistoricalScope } from "@eliotr/cloudflare-navigation";
import { ArtifactDraftReadError, WorkflowCheckpointError, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import type { WorkflowRunStatus } from "@eliotr/cloudflare-research";
import { readHistoricalResearchCoverage, type HistoricalResearchArtifactBinding } from "@eliotr/cloudflare-research-stages";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { NavigationError } from "@eliotr/retrieval";
import type { VersionedRef } from "@eliotr/contracts";
import type { Env } from "./env.js";
import { reopenOwnerArtifactDraft } from "./research-artifact-reauthorization-http.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";

interface RunBinding {
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly handler_generation: string;
}
export interface ResearchRunRead {
  readonly status: WorkflowRunStatus;
  readonly handler_generation: string;
  readonly requireCurrent: () => Promise<void>;
}
export interface ReauthenticatedRunRead extends ResearchRunRead {
  /** Captured only after current policy/source checks; used as a SQL TOCTOU
   * fence, never as a new source of permission or execution renewal. */
  readonly controlFence: () => Promise<ResearchRunControlFence>;
}
export interface ResearchRunControlFence {
  readonly scope_ref: VersionedRef;
  readonly authorization_receipt_ref: string;
  readonly ledger_epoch: number;
  readonly orientation_epoch: number;
  readonly valid_until_ms: number;
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

export function requireRunStatusContinuity(left: WorkflowRunStatus, right: WorkflowRunStatus): void {
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
  forControl = false,
): Promise<ReauthenticatedRunRead | null> {
  if (context.client_class !== "owner_pwa") stale();
  requireActiveRequest(context);
  const binding = await env.CORE_DB.prepare(
    "SELECT credential_generation, deployment_generation, handler_generation FROM research_workflow_run " +
    "WHERE operation_id=?1 AND principal_ref=?2 LIMIT 1",
  ).bind(operationId, context.principal_ref).first<RunBinding>();
  if (binding === null) return null;
  try {
    await requireResearchDeploymentCompatibility(env.CORE_DB, binding.deployment_generation, env.DEPLOYMENT_GENERATION);
  } catch {
    if (forControl) stale();
    return null;
  }
  if (!forControl && binding.credential_generation === context.credential_generation &&
      binding.deployment_generation === env.DEPLOYMENT_GENERATION) return null;
  if (typeof binding.credential_generation !== "string" || typeof binding.handler_generation !== "string") corrupt();

  const principal = {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    deployment_generation: binding.deployment_generation,
  };
  const store = new WorkflowCheckpointStore(env.CORE_DB);
  // The store filters by owner and validates the recorded state/receipts. Its
  // returned metadata is not disclosed until independent current authorization.
  const first = await store.readRunStatus(operationId, principal, "owner-read");
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
  const currentAuthorization = async () => {
    requireActiveRequest(context);
    const authorization = await navigation.current().catch(mapReadFailure);
    const sources = await navigation.sources(historical.scope.member_source_revision_refs, authorization).catch(mapReadFailure);
    // Keep the recorded W1/W2 owner and scope linkage. Current read permission
    // does not authorize substitution of another investigation or source set.
    const head = await store.head(first.investigation_id);
    if (head.principal_ref !== context.principal_ref || head.scope_snapshot_id !== originalRef.id ||
        head.scope_snapshot_revision !== originalRef.revision) stale();
    if (forControl) {
      await requireResearchDeploymentCompatibility(
        env.CORE_DB, binding.deployment_generation, env.DEPLOYMENT_GENERATION,
      ).catch(stale);
      const activePolicy = await env.CORE_DB.prepare(
        "SELECT 1 AS present FROM investigation_current_policy " +
        "WHERE policy_generation=?1 AND policy_authority_ref=?2 AND state='ACTIVE' LIMIT 1",
      ).bind(head.policy_generation, head.policy_authority_ref).first();
      if (activePolicy === null) stale();
    }
    requireActiveRequest(context);
    const validUntil = Math.min(Date.parse(historical.scope.expires_at), Date.parse(authorization.expires_at),
      context.access === undefined ? Infinity : Date.parse(context.access.expires_at),
      ...sources.flatMap((source) => source.admission_expires_at === undefined ? [] : [Date.parse(source.admission_expires_at)]));
    if (!Number.isSafeInteger(validUntil) || validUntil <= Date.now()) stale();
    return { authorization, validUntil };
  };
  const requireCurrent = async () => { await currentAuthorization(); };
  const controlFence = async (): Promise<ResearchRunControlFence> => {
    // Capture before the read-only recheck: a mutation during validation must
    // invalidate the final SQL, not become an accidentally trusted newer epoch.
    const epochs = await env.CORE_DB.prepare(
      "SELECT (SELECT generation FROM investigation_ledger_epoch WHERE singleton=1) AS ledger_epoch, " +
      "(SELECT generation FROM orientation_authority_epoch WHERE singleton=1) AS orientation_epoch",
    ).first<{ ledger_epoch: number; orientation_epoch: number }>();
    if (epochs === null || !Number.isSafeInteger(epochs.ledger_epoch) || epochs.ledger_epoch < 1 ||
        !Number.isSafeInteger(epochs.orientation_epoch) || epochs.orientation_epoch < 1) corrupt();
    const current = await currentAuthorization();
    return { ...epochs, scope_ref: { id: historical.scope.snapshot_id, revision: historical.scope.revision },
      authorization_receipt_ref: current.authorization.authorization_receipt_ref, valid_until_ms: current.validUntil };
  };
  await requireCurrent();
  const status = await store.readRunStatus(operationId, principal, "owner-read");
  if (status === null) corrupt();
  requireRunStatusContinuity(first, status);
  await requireCurrent();
  return { status, handler_generation: binding.handler_generation, requireCurrent, controlFence };
}

/** Current caller authorization stays in the shared artifact service. */
export function createRunArtifactReadback(
  env: Env, context: AuthenticatedRequestContext, read: ResearchRunRead,
): (input: { artifact_ref: VersionedRef; original_scope_snapshot_ref: VersionedRef }) => Promise<HistoricalResearchArtifactBinding> {
  return async ({ artifact_ref, original_scope_snapshot_ref }) => {
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
  };
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
    require_artifact: createRunArtifactReadback(env, context, read),
  });
  await read.requireCurrent();
  if (historical === null) corrupt();
  return { availability: "draft", artifact_ref: historical.artifact_ref };
}
