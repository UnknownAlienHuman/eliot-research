import { ArtifactReadNotFoundError, type AuthenticatedRequestContext, type ResearchRunStatus } from "@eliotr/interfaces";
import { ResearchRunHistoryQuerySchema, VersionedRefSchema, type VersionedRef, type ResearchRunHistoryVisibilityState } from "@eliotr/contracts";
import { CatalogInputError, OrientationError, ScopeServiceError } from "@eliotr/cloudflare-navigation";
import { ArtifactDraftReadError } from "@eliotr/cloudflare-research";
import {
  readHistoricalResearchArtifactLocator,
} from "@eliotr/cloudflare-research-stages";
import { prepareReauthenticatedRunRead } from "./research-run-read-authorization.js";
import { runControlStatus } from "./research-run-control.js";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
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
  readonly principal_ref: unknown;
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
      "AND r.client_class=?6 AND r.scope_snapshot_id=?4 AND r.scope_snapshot_revision=?5 " +
      "LIMIT 2",
    ).bind(draft.intent_id, draft.intent_revision, principalRef, scope.id, scope.revision, draft.origin_client_class)
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


// The v4 read has independent bounds for each collection. Candidate budgets do
// not replace any authority check or claim a bound on internal reader queries.
const RECENT_VISIBLE_LIMIT = 8;
const RECENT_CANDIDATE_BATCH = 8;
const RECENT_RAW_CANDIDATE_BUDGET = 32;
const RECENT_CANDIDATE_QUERY_BUDGET = 4;
type RecentVisibilityScan = ResearchRunHistoryVisibilityState;
interface VisibleRecentEntry<Entry> {
  readonly entry: Entry;
  readonly require_current?: () => Promise<void>;
}

async function scanVisibleRecent<Row, Entry>(
  readCandidates: (after: Row | null, limit: number) => Promise<readonly Row[]>,
  authorize: (row: Row) => Promise<VisibleRecentEntry<Entry> | null>,
): Promise<{ entries: Entry[]; checks: (() => Promise<void>)[]; state: RecentVisibilityScan }> {
  const entries: Entry[] = [];
  const checks: (() => Promise<void>)[] = [];
  let after: Row | null = null;
  let scanned = 0;
  for (let query = 0; query < RECENT_CANDIDATE_QUERY_BUDGET && scanned < RECENT_RAW_CANDIDATE_BUDGET; query += 1) {
    const limit = Math.min(RECENT_CANDIDATE_BATCH, RECENT_RAW_CANDIDATE_BUDGET - scanned);
    const rows = await readCandidates(after, limit);
    if (rows.length > limit) invalidHistory("Recent history candidate batch is oversized");
    for (const row of rows) {
      scanned += 1;
      const visible = await authorize(row);
      if (visible === null) continue;
      entries.push(visible.entry);
      if (visible.require_current !== undefined) checks.push(visible.require_current);
      if (entries.length === RECENT_VISIBLE_LIMIT) return { entries, checks, state: "TARGET_REACHED" };
    }
    if (rows.length < limit) return { entries, checks, state: "SOURCE_EXHAUSTED" };
    after = rows[rows.length - 1] ?? null;
  }
  return { entries, checks, state: "BUDGET_STOPPED" };
}

/** Recent locators use the same current read authority as an opened run/report. */
export async function readOwnerResearchRuns(ports: ResearchRunListPorts, context: AuthenticatedRequestContext) {
  ports.authorize_owner_read(context);
  type RunRow = { operation_id: string; created_at: string; query: unknown };
  type RunEntry = { created_at: string; query?: string; status: ResearchRunStatus };
  const runsRead = scanVisibleRecent<RunRow, RunEntry>(async (after, limit) => {
    try {
      const result = await ports.database.prepare(
        "SELECT r.operation_id, r.created_at, h.goal AS query FROM research_workflow_run r " +
        "LEFT JOIN investigation_ledger_head h ON h.investigation_id=r.investigation_id " +
        "AND h.principal_ref=r.principal_ref " +
        "JOIN research_deployment_compatible c ON c.origin_deployment_generation=r.deployment_generation " +
        "AND c.active_deployment_generation=?2 WHERE (r.principal_ref=?1 OR EXISTS " +
        "(SELECT 1 FROM owner_machine_run_origin o WHERE o.operation_id=r.operation_id AND o.reader_principal_ref=?1)) " +
        "AND (?3 IS NULL OR r.created_at<?3 OR (r.created_at=?3 AND r.operation_id<?4)) " +
        "ORDER BY r.created_at DESC,r.operation_id DESC LIMIT ?5",
      ).bind(context.principal_ref, ports.deployment_generation, after?.created_at ?? null, after?.operation_id ?? null, limit)
        .all<RunRow>();
      if (!result.success) throw new Error("Research history read failed");
      return result.results;
    } catch {
      throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Research history is temporarily unavailable", 503, true);
    }
  }, async (row) => {
    if (typeof row.operation_id !== "string" || row.operation_id.length < 1 || typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at))) invalidHistory("Stored research history is invalid");
    try {
      const read = await prepareReauthenticatedRunRead(ports.run_read, context, row.operation_id);
      if (read === null) return null;
      // Recent is a locator projection. Opening a run still reads and verifies
      // its complete coverage and report lineage through the detailed reader.
      await read.requireCurrent();
      const status = runControlStatus(read.status);
      let query: string | undefined;
      if (row.query !== null && row.query !== undefined) {
        try { query = ResearchRunHistoryQuerySchema.parse(row.query); }
        catch { invalidHistory("Stored research query is invalid"); }
      }
      return { entry: { created_at: row.created_at, ...(query === undefined ? {} : { query }), status },
        require_current: read.requireCurrent };
    } catch (error) {
      if (error instanceof CatalogInputError && [403, 404, 409, 410].includes(error.status)) return null;
      if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_AUTHORITY_STALE") return null;
      throw error;
    }
  });

  type DraftEntry = { artifact_ref: VersionedRef; created_at: string; workflow_instance_id?: string };
  const draftsRead = scanVisibleRecent<SavedDraftRow, DraftEntry>(async (after, limit) => {
    try {
      const result = await ports.database.prepare(
        "SELECT b.artifact_id,b.revision,b.intent_id,b.intent_revision,b.scope_snapshot_id,b.scope_snapshot_revision,b.created_at,b.principal_ref," +
        "o.origin_client_class FROM artifact_draft_binding b JOIN owner_artifact_read_origin o " +
        "ON o.artifact_id=b.artifact_id AND o.artifact_revision=b.revision " +
        "WHERE o.reader_principal_ref=?1 AND (?2 IS NULL OR b.created_at<?2 OR " +
        "(b.created_at=?2 AND (b.artifact_id<?3 OR (b.artifact_id=?3 AND b.revision<?4)))) " +
        "ORDER BY b.created_at DESC,b.artifact_id DESC,b.revision DESC LIMIT ?5",
      ).bind(context.principal_ref, after?.created_at ?? null, after?.artifact_id ?? null, after?.revision ?? null, limit)
        .all<SavedDraftRow>();
      if (!result.success) throw new Error("Saved report history read failed");
      return result.results;
    } catch {
      throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Saved reports are temporarily unavailable", 503, true);
    }
  }, async (row) => {
    const ref = VersionedRefSchema.parse({ id: row.artifact_id, revision: row.revision });
    if (typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at))) invalidHistory("Saved report metadata is invalid");
    const originalRef = VersionedRefSchema.parse({ id: row.scope_snapshot_id, revision: row.scope_snapshot_revision });
    if (!["owner_pwa", "trusted_agent", "named_api_client"].includes(String(row.origin_client_class))) {
      invalidHistory("Saved report author class is invalid");
    }
    if (typeof row.principal_ref !== "string" || row.principal_ref.length < 1) invalidHistory("Saved report author is invalid");
    try {
      const read = await ports.prepare_artifact_read(context, ref, "report");
      if (!sameRef(read.original_scope_snapshot_ref, originalRef)) invalidHistory("Saved report origin changed");
      await read.requireCurrent();
      const operationId = await readHistoricalWorkflowId(ports, row, row.principal_ref, originalRef);
      let workflowInstanceId: string | undefined;
      if (operationId !== null) {
        const historical = await readHistoricalResearchArtifactLocator({
          database: ports.database, work_bucket: ports.work_bucket, operation_id: operationId,
          owner: { principal_ref: context.principal_ref, client_class: "owner_pwa" }, require_current: read.requireCurrent,
          artifact_ref: ref, original_scope_snapshot_ref: originalRef,
        });
        if (historical !== null) {
          if (!sameRef(historical.artifact_ref, ref) || historical.operation_id !== operationId) {
            invalidHistory("Saved report workflow artifact binding is inconsistent");
          }
          workflowInstanceId = operationId;
        }
      }
      return { entry: { artifact_ref: ref, created_at: row.created_at,
        ...(workflowInstanceId === undefined ? {} : { workflow_instance_id: workflowInstanceId }) }, require_current: read.requireCurrent };
    } catch (error) {
      if (expectedSavedDraftDenial(error)) return null;
      throw error;
    }
  });
  const [runs, drafts] = await Promise.all([runsRead, draftsRead]);
  const reportsByRun = new Map<string, VersionedRef>();
  for (const draft of drafts.entries) {
    const operationId = draft.workflow_instance_id;
    if (operationId === undefined) continue;
    const prior = reportsByRun.get(operationId);
    if (prior !== undefined && !sameRef(prior, draft.artifact_ref)) invalidHistory("Saved run has conflicting report locators");
    reportsByRun.set(operationId, draft.artifact_ref);
  }
  // A changed authority invalidates the whole response; it never silently turns
  // a previously selected locator into a complete short list.
  await Promise.all([...runs.checks, ...drafts.checks].map((requireCurrent) => requireCurrent()));
  return {
    protocol: "eliotr.research-runs.v5" as const,
    runs: runs.entries.map((entry) => {
      const artifact = reportsByRun.get(entry.status.workflow_instance_id);
      return artifact === undefined || entry.status.execution_state !== "ENGINE_COMPLETED" ? entry : {
        ...entry, status: { ...entry.status, answer: { availability: "draft" as const, artifact_ref: artifact } },
      };
    }), saved_drafts: drafts.entries,
    visibility_scan: { runs: runs.state, saved_drafts: drafts.state },
    configuration_state: ports.semantic_configuration_installed() ? "INSTALLED" as const : "MISSING" as const,
    checked_at: new Date().toISOString(),
  };
}
