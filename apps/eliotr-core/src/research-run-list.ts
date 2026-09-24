import { ArtifactReadNotFoundError, type AuthenticatedRequestContext, type ResearchRunStatus } from "@eliotr/interfaces";
import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { createOwnerScopeAuthority, OrientationError, ScopeServiceError } from "@eliotr/cloudflare-navigation";
import { ArtifactDraftReadError } from "@eliotr/cloudflare-research";
import {
  readHistoricalResearchCoverage,
  type HistoricalResearchArtifactBinding,
} from "@eliotr/cloudflare-research-stages";
import type { Env } from "./env.js";
import { createResearchRunService } from "./research-session.js";
import { CatalogInputError } from "./catalog-service.js";
import { prepareArtifactReadReauthorization, reopenOwnerArtifactDraft } from "./research-artifact-reauthorization-http.js";
import { prepareReauthenticatedRunRead } from "./research-run-read-authorization.js";
import { researchSemanticConfigurationInstalled } from "./research-semantic-server.js";

interface SavedDraftRow {
  readonly origin_client_class: unknown;
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly created_at: unknown;
}

interface HistoricalWorkflowRow {
  readonly admission_operation_id: unknown;
  readonly admission_principal_ref: unknown;
  readonly admission_scope_snapshot_id: unknown;
  readonly admission_scope_snapshot_revision: unknown;
  readonly workflow_operation_id: unknown;
  readonly workflow_principal_ref: unknown;
  readonly workflow_scope_snapshot_id: unknown;
  readonly workflow_scope_snapshot_revision: unknown;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function invalidHistory(message: string): never {
  throw new CatalogInputError("RESEARCH_HISTORY_INVALID", message, 503, true);
}

function expectedSavedDraftDenial(error: unknown): boolean {
  if (error instanceof ArtifactReadNotFoundError) return true;
  if (error instanceof ScopeServiceError && error.code === "SCOPE_SNAPSHOT_STALE") return true;
  if (error instanceof OrientationError || error instanceof ArtifactDraftReadError) {
    return [403, 404, 409, 410].includes(error.status);
  }
  return error instanceof CatalogInputError && error.code === "RESEARCH_HISTORY_AUTHORITY_STALE" &&
    [403, 404, 409, 410].includes(error.status);
}

async function requireSavedDraftSourceAccess(
  authority: ReturnType<typeof createOwnerScopeAuthority>,
  original: Awaited<ReturnType<typeof loadScopeAuthority>> & {},
): Promise<void> {
  if (original === null) invalidHistory("Saved report scope is missing");
  await authority.requireReadPolicy();
  const sources = await authority.sources(original.snapshot.member_source_revision_refs);
  if (sources.length !== original.snapshot.member_source_revision_refs.length || sources.some((source) =>
    !source.authority.allowed_use.includes("research") ||
    source.authority.source_owner_generation !== original.snapshot.source_owner_generations[source.authority.source_revision_ref])) {
    throw new CatalogInputError("RESEARCH_HISTORY_AUTHORITY_STALE", "Saved report source access is no longer current", 409);
  }
}

async function readHistoricalWorkflowId(
  env: Env,
  draft: SavedDraftRow,
  principalRef: string,
  scope: VersionedRef,
): Promise<string | null> {
  if (typeof draft.intent_id !== "string" || !Number.isSafeInteger(draft.intent_revision) ||
      (draft.intent_revision as number) < 1) invalidHistory("Saved report intent binding is invalid");
  let result: D1Result<HistoricalWorkflowRow>;
  try {
    result = await env.CORE_DB.prepare(
      "SELECT r.operation_id AS admission_operation_id,r.principal_ref AS admission_principal_ref," +
      "r.scope_snapshot_id AS admission_scope_snapshot_id,r.scope_snapshot_revision AS admission_scope_snapshot_revision," +
      "w.operation_id AS workflow_operation_id,w.principal_ref AS workflow_principal_ref," +
      "w.scope_snapshot_id AS workflow_scope_snapshot_id,w.scope_snapshot_revision AS workflow_scope_snapshot_revision " +
      "FROM research_report_admission r JOIN research_workflow_run w " +
      "ON w.operation_id=r.operation_id AND w.principal_ref=r.principal_ref " +
      "AND w.scope_snapshot_id=r.scope_snapshot_id AND w.scope_snapshot_revision=r.scope_snapshot_revision " +
      "WHERE r.intent_id=?1 AND r.intent_revision=?2 AND r.principal_ref=?3 " +
      "AND r.client_class='owner_pwa' AND r.scope_snapshot_id=?4 AND r.scope_snapshot_revision=?5 " +
      "LIMIT 2",
    ).bind(draft.intent_id, draft.intent_revision, principalRef, scope.id, scope.revision)
      .all<HistoricalWorkflowRow>();
  } catch {
    throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Saved report history is temporarily unavailable", 503, true);
  }
  if (!result.success) throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Saved report history is temporarily unavailable", 503, true);
  if (result.results.length > 1) invalidHistory("Saved report has multiple workflow bindings");
  const row = result.results[0];
  if (row === undefined) return null;
  if (typeof row.admission_operation_id !== "string" || row.admission_operation_id.length < 1 ||
      row.admission_principal_ref !== principalRef || row.admission_scope_snapshot_id !== scope.id ||
      row.admission_scope_snapshot_revision !== scope.revision ||
      row.workflow_operation_id !== row.admission_operation_id || row.workflow_principal_ref !== principalRef ||
      row.workflow_scope_snapshot_id !== scope.id || row.workflow_scope_snapshot_revision !== scope.revision) {
    invalidHistory("Saved report workflow binding is inconsistent");
  }
  return row.admission_operation_id;
}

async function readReauthorizedHistoricalArtifact(
  env: Env,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
  originalScopeRef: VersionedRef,
): Promise<HistoricalResearchArtifactBinding> {
  const reopened = await reopenOwnerArtifactDraft(env, context, artifactRef);
  if (!sameRef(reopened.artifact_ref, artifactRef) ||
      !sameRef(reopened.original_scope_snapshot_ref, originalScopeRef) ||
      !("sections" in reopened.artifact) || reopened.artifact.status !== "DRAFT") {
    throw new ArtifactDraftReadError("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "Saved report artifact binding is inconsistent");
  }
  return {
    artifact_ref: reopened.artifact_ref,
    original_scope_snapshot_ref: reopened.original_scope_snapshot_ref,
    status: "DRAFT",
    evidence_freeze_ref: reopened.artifact.evidence_freeze_ref,
    dependency_manifest_ref: reopened.artifact.dependency_manifest_ref,
  };
}

/** Recent run locators are re-authorized through the same reader as an opened run. */
export async function readOwnerResearchRuns(env: Env, context: AuthenticatedRequestContext) {
  if (context.client_class !== "owner_pwa") {
    throw new CatalogInputError("RESEARCH_OWNER_REQUIRED", "Research history requires an owner session", 403);
  }
  let rows: { operation_id: string; created_at: string }[];
  try {
    const result = await env.CORE_DB.prepare(
      "SELECT r.operation_id, r.created_at FROM research_workflow_run r " +
      "JOIN research_deployment_compatible c ON c.origin_deployment_generation=r.deployment_generation " +
      "AND c.active_deployment_generation=?2 WHERE (r.principal_ref=?1 OR EXISTS " +
      "(SELECT 1 FROM owner_machine_run_origin o WHERE o.operation_id=r.operation_id AND o.reader_principal_ref=?1)) " +
      "ORDER BY r.created_at DESC, r.operation_id DESC LIMIT 8",
    ).bind(context.principal_ref, env.DEPLOYMENT_GENERATION)
      .all<{ operation_id: string; created_at: string }>();
    if (!result.success) throw new Error("Research history read failed");
    rows = result.results;
  } catch {
    throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Research history is temporarily unavailable", 503, true);
  }
  const service = createResearchRunService(env);
  const runs: { created_at: string; status: ResearchRunStatus }[] = [];
  const runChecks: (() => Promise<void>)[] = [];
  for (const row of rows) {
    if (typeof row.operation_id !== "string" || typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at))) {
      throw new CatalogInputError("RESEARCH_HISTORY_INVALID", "Stored research history is invalid", 503, true);
    }
    try {
      const status = await service.runStatus(context, row.operation_id);
      const read = await prepareReauthenticatedRunRead(env, context, row.operation_id);
      if (read !== null) runChecks.push(read.requireCurrent);
      runs.push({ created_at: row.created_at, status });
    } catch (error) {
      // A revoked, purged, expired or missing run must disappear from this session.
      if (error instanceof CatalogInputError && [403, 404, 409, 410].includes(error.status)) continue;
      throw error;
    }
  }
  // Historical report locators contain no document text. Recheck the current owner's
  // source policy before listing them; POST reauthorization performs full disclosure checks.
  const authority = createOwnerScopeAuthority(env.CORE_DB, context);
  const drafts = await env.CORE_DB.prepare(
    "SELECT b.artifact_id,b.revision,b.intent_id,b.intent_revision,b.scope_snapshot_id,b.scope_snapshot_revision,b.created_at," +
    "o.origin_client_class FROM artifact_draft_binding b JOIN owner_artifact_read_origin o " +
    "ON o.artifact_id=b.artifact_id AND o.artifact_revision=b.revision " +
    "WHERE o.reader_principal_ref=?1 ORDER BY b.created_at DESC,b.artifact_id DESC LIMIT 8",
  ).bind(context.principal_ref).all<SavedDraftRow>();
  if (!drafts.success) throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Saved reports are temporarily unavailable", 503, true);
  const savedDrafts: { artifact_ref: VersionedRef; created_at: string; workflow_instance_id?: string }[] = [];
  const machineDraftChecks: (() => Promise<void>)[] = [];
  for (const row of drafts.results) {
    const ref = VersionedRefSchema.parse({ id: row.artifact_id, revision: row.revision });
    if (typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) invalidHistory("Saved report metadata is invalid");
    const originalRef = VersionedRefSchema.parse({
      id: row.scope_snapshot_id, revision: row.scope_snapshot_revision,
    });
    if (!["owner_pwa", "trusted_agent", "named_api_client"].includes(String(row.origin_client_class))) {
      invalidHistory("Saved report author class is invalid");
    }
    if (row.origin_client_class !== "owner_pwa") {
      try {
        const read = await prepareArtifactReadReauthorization(env, context, ref, "report");
        if (!sameRef(read.original_scope_snapshot_ref, originalRef)) invalidHistory("Saved report origin changed");
        await read.requireCurrent();
        savedDrafts.push({ artifact_ref: ref, created_at: row.created_at });
        machineDraftChecks.push(read.requireCurrent);
      } catch (error) {
        if (expectedSavedDraftDenial(error)) continue;
        throw error;
      }
      // Do not expose machine run controls or owner Wiki promotion via a report locator.
      continue;
    }
    const original = await loadScopeAuthority(env.CORE_DB, originalRef);
    if (original === null || original.invalidated_at !== null) continue;
    try {
      await requireSavedDraftSourceAccess(authority, original);
      const operationId = await readHistoricalWorkflowId(env, row, context.principal_ref, originalRef);
      let workflowInstanceId: string | undefined;
      if (operationId !== null) {
        const historical = await readHistoricalResearchCoverage({
          database: env.CORE_DB,
          work_bucket: env.WORK_BUCKET,
          operation_id: operationId,
          owner: { principal_ref: context.principal_ref, client_class: "owner_pwa" },
          require_current: () => requireSavedDraftSourceAccess(authority, original),
          require_artifact: ({ artifact_ref, original_scope_snapshot_ref }) =>
            readReauthorizedHistoricalArtifact(env, context, artifact_ref, original_scope_snapshot_ref),
        });
        if (historical !== null) {
          if (!sameRef(historical.artifact_ref, ref) || historical.provenance.operation_id !== operationId) {
            invalidHistory("Saved report workflow artifact binding is inconsistent");
          }
          workflowInstanceId = operationId;
        }
      }
      savedDrafts.push({ artifact_ref: ref, created_at: row.created_at, ...(workflowInstanceId === undefined ? {} : { workflow_instance_id: workflowInstanceId }) });
    } catch (error) {
      if (expectedSavedDraftDenial(error)) continue;
      throw error;
    }
  }
  for (const requireCurrent of runChecks) await requireCurrent();
  for (const requireCurrent of machineDraftChecks) await requireCurrent();
  return {
    protocol: "eliotr.research-runs.v3" as const,
    runs,
    saved_drafts: savedDrafts,
    configuration_state: researchSemanticConfigurationInstalled(env) ? "INSTALLED" as const : "MISSING" as const,
    checked_at: new Date().toISOString(),
  };
}
