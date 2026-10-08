import { ArtifactReadNotFoundError, type AuthenticatedRequestContext, type ResearchRunStatus } from "@eliotr/interfaces";
import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { CatalogInputError, OrientationError, ScopeServiceError } from "@eliotr/cloudflare-navigation";
import { ArtifactDraftReadError } from "@eliotr/cloudflare-research";
import {
  readHistoricalResearchCoverage,
  type HistoricalResearchArtifactBinding,
} from "@eliotr/cloudflare-research-stages";
import { prepareReauthenticatedRunRead } from "./research-run-read-authorization.js";
import type { ResearchRunReadEnvironment, ReopenedResearchRunDraft } from "./research-run-read-authorization.js";

export interface ResearchArtifactReadAuthorization {
  readonly original_scope_snapshot_ref: VersionedRef;
  readonly requireCurrent: () => Promise<void>;
}

export interface ResearchRunListPorts {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly deployment_generation: string;
  readonly run_read: ResearchRunReadEnvironment;
  readonly authorize_owner_read: (context: AuthenticatedRequestContext) => void;
  readonly run_status: (context: AuthenticatedRequestContext, operation_id: string) => Promise<ResearchRunStatus>;
  readonly prepare_artifact_read: (
    context: AuthenticatedRequestContext, artifact_ref: VersionedRef, operation: "report",
  ) => Promise<ResearchArtifactReadAuthorization>;
  readonly reopen_owner_artifact_draft: (
    context: AuthenticatedRequestContext, artifact_ref: VersionedRef,
  ) => Promise<ReopenedResearchRunDraft>;
  readonly semantic_configuration_installed: () => boolean;
}

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

async function readHistoricalWorkflowId(
  ports: ResearchRunListPorts,
  draft: SavedDraftRow,
  principalRef: string,
  scope: VersionedRef,
): Promise<string | null> {
  if (typeof draft.intent_id !== "string" || !Number.isSafeInteger(draft.intent_revision) ||
      (draft.intent_revision as number) < 1) invalidHistory("Saved report intent binding is invalid");
  let result: D1Result<HistoricalWorkflowRow>;
  try {
    result = await ports.database.prepare(
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
  ports: ResearchRunListPorts,
  context: AuthenticatedRequestContext,
  artifactRef: VersionedRef,
  originalScopeRef: VersionedRef,
): Promise<HistoricalResearchArtifactBinding> {
  const reopened = await ports.reopen_owner_artifact_draft(context, artifactRef);
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
export async function readOwnerResearchRuns(ports: ResearchRunListPorts, context: AuthenticatedRequestContext) {
  ports.authorize_owner_read(context);
  let rows: { operation_id: string; created_at: string }[];
  try {
    const result = await ports.database.prepare(
      "SELECT r.operation_id, r.created_at FROM research_workflow_run r " +
      "JOIN research_deployment_compatible c ON c.origin_deployment_generation=r.deployment_generation " +
      "AND c.active_deployment_generation=?2 WHERE (r.principal_ref=?1 OR EXISTS " +
      "(SELECT 1 FROM owner_machine_run_origin o WHERE o.operation_id=r.operation_id AND o.reader_principal_ref=?1)) " +
      "ORDER BY r.created_at DESC, r.operation_id DESC LIMIT 8",
    ).bind(context.principal_ref, ports.deployment_generation)
      .all<{ operation_id: string; created_at: string }>();
    if (!result.success) throw new Error("Research history read failed");
    rows = result.results;
  } catch {
    throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Research history is temporarily unavailable", 503, true);
  }
  const runs: { created_at: string; status: ResearchRunStatus }[] = [];
  const runChecks: (() => Promise<void>)[] = [];
  for (const row of rows) {
    if (typeof row.operation_id !== "string" || typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at))) {
      throw new CatalogInputError("RESEARCH_HISTORY_INVALID", "Stored research history is invalid", 503, true);
    }
    try {
      const status = await ports.run_status(context, row.operation_id);
      const read = await prepareReauthenticatedRunRead(ports.run_read, context, row.operation_id);
      if (read !== null) runChecks.push(read.requireCurrent);
      runs.push({ created_at: row.created_at, status });
    } catch (error) {
      // A revoked, purged, expired or missing run must disappear from this session.
      if (error instanceof CatalogInputError && [403, 404, 409, 410].includes(error.status)) continue;
      throw error;
    }
  }
  // Historical report locators contain no document text; every saved draft still uses
  // the full read reauthorization path before its locator is listed.
  const drafts = await ports.database.prepare(
    "SELECT b.artifact_id,b.revision,b.intent_id,b.intent_revision,b.scope_snapshot_id,b.scope_snapshot_revision,b.created_at," +
    "o.origin_client_class FROM artifact_draft_binding b JOIN owner_artifact_read_origin o " +
    "ON o.artifact_id=b.artifact_id AND o.artifact_revision=b.revision " +
    "WHERE o.reader_principal_ref=?1 ORDER BY b.created_at DESC,b.artifact_id DESC LIMIT 8",
  ).bind(context.principal_ref).all<SavedDraftRow>();
  if (!drafts.success) throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Saved reports are temporarily unavailable", 503, true);
  const savedDrafts: { artifact_ref: VersionedRef; created_at: string; workflow_instance_id?: string }[] = [];
  const draftChecks: (() => Promise<void>)[] = [];
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
        const read = await ports.prepare_artifact_read(context, ref, "report");
        if (!sameRef(read.original_scope_snapshot_ref, originalRef)) invalidHistory("Saved report origin changed");
        await read.requireCurrent();
        savedDrafts.push({ artifact_ref: ref, created_at: row.created_at });
        draftChecks.push(read.requireCurrent);
      } catch (error) {
        if (expectedSavedDraftDenial(error)) continue;
        throw error;
      }
      // Do not expose machine run controls or owner Wiki promotion via a report locator.
      continue;
    }
    try {
      const read = await ports.prepare_artifact_read(context, ref, "report");
      if (!sameRef(read.original_scope_snapshot_ref, originalRef)) invalidHistory("Saved report origin changed");
      await read.requireCurrent();
      const operationId = await readHistoricalWorkflowId(ports, row, context.principal_ref, originalRef);
      let workflowInstanceId: string | undefined;
      if (operationId !== null) {
        const historical = await readHistoricalResearchCoverage({
          database: ports.database,
          work_bucket: ports.work_bucket,
          operation_id: operationId,
          owner: { principal_ref: context.principal_ref, client_class: "owner_pwa" },
          require_current: read.requireCurrent,
          require_artifact: ({ artifact_ref, original_scope_snapshot_ref }) =>
            readReauthorizedHistoricalArtifact(ports, context, artifact_ref, original_scope_snapshot_ref),
        });
        if (historical !== null) {
          if (!sameRef(historical.artifact_ref, ref) || historical.provenance.operation_id !== operationId) {
            invalidHistory("Saved report workflow artifact binding is inconsistent");
          }
          workflowInstanceId = operationId;
        }
      }
      savedDrafts.push({ artifact_ref: ref, created_at: row.created_at, ...(workflowInstanceId === undefined ? {} : { workflow_instance_id: workflowInstanceId }) });
      draftChecks.push(read.requireCurrent);
    } catch (error) {
      if (expectedSavedDraftDenial(error)) continue;
      throw error;
    }
  }
  for (const requireCurrent of runChecks) await requireCurrent();
  for (const requireCurrent of draftChecks) await requireCurrent();
  return {
    protocol: "eliotr.research-runs.v3" as const,
    runs,
    saved_drafts: savedDrafts,
    configuration_state: ports.semantic_configuration_installed() ? "INSTALLED" as const : "MISSING" as const,
    checked_at: new Date().toISOString(),
  };
}
