import { failBackup } from "./shared.js";

// ER-34 O2 exhaustive durable-state coverage. Every tracked Core table must be
// classified; any unclassified table/column fails closed. R2/Queue/Search/
// Workflow/DO state is covered as rebuild-only, never authority.

export type DurableStatus =
  | "CANONICAL_EXPORTED"
  | "REBUILD_REQUIRED"
  | "TRANSIENT_EXCLUDED"
  | "NOT_A_BACKUP";

export const CANONICAL_EXPORTED_TABLES: ReadonlySet<string> = new Set([
  "source_namespace_ownership",
  "source",
  "source_revision",
  "project",
  "project_source_membership",
  "source_tag",
  "scope_snapshot",
  "evidence_handle",
  "evidence_handle_invalidation",
  "investigation",
  "artifact_head",
  "artifact_revision",
  "wiki_head",
  "wiki_revision",
  "model_generation",
  "exchange_generation",
  "projection_generation",
  "backup_epoch",
  "erasure_hold",
  "purge_ledger",
]);

const REBUILD_REQUIRED_TABLES: ReadonlySet<string> = new Set([
  "source_readiness",
  "operation_intent",
  "operation_attempt",
  "operation_receipt",
  "outbox",
  "job",
  "investigation_event",
  "investigation_checkpoint",
  "evidence_freeze",
  "claim_audit",
  "coverage_receipt",
  "artifact_revision",
  "research_debt",
  "budget_reservation",
  "erasure_case",
  "erasure_execution",
  "erasure_dependency_registry",
  "erasure_target",
  "erasure_stage_receipt",
  "erasure_dependent_invalidation",
  "backup_purge_obligation",
  "erasure_terminal_guard",
  "federation_reference_manifest",
  "federation_job",
  "navigation_artifact",
  "source_admission_policy",
  "bundle_ingest_operation",
  "source_acquisition_candidate",
  "qualification_report",
  "source_admission_decision",
  "bundle_ingest_commit_guard",
  "projection_terminal_guard",
  "scope_access_grant",
  "evidence_handle_identity",
  "evidence_resolution_receipt",
  "evidence_resolution_guard",
  "citation_resolution_receipt",
  "citation_resolution_guard",
  "scope_read_policy",
  "orientation_request",
  "orientation_authority_epoch",
  "google_exchange_connection",
  "drive_observation",
  "incident",
  "health_snapshot",
  "google_oauth_intent",
]);

const TRANSIENT_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "operation_execution_lease",
  "delivery_inbox",
  "drive_cursor",
]);

const NOT_A_BACKUP_TABLES: ReadonlySet<string> = new Set([
  "schema_state",
  "d1_migrations",
  "sqlite_sequence",
  "sqlite_master",
  "backup_epoch_receipt",
  "backup_offsite_expiry",
  "backup_destination_authority",
  "backup_offsite_copy_part",
  "backup_offsite_copy_receipt",
  "backup_export_cut",
]);

export function classifyDurableTable(table: string): DurableStatus {
  if (CANONICAL_EXPORTED_TABLES.has(table)) return "CANONICAL_EXPORTED";
  if (REBUILD_REQUIRED_TABLES.has(table)) return "REBUILD_REQUIRED";
  if (TRANSIENT_EXCLUDED_TABLES.has(table)) return "TRANSIENT_EXCLUDED";
  if (NOT_A_BACKUP_TABLES.has(table)) return "NOT_A_BACKUP";
  failBackup("BACKUP_COVERAGE_GAP", `backup durable table ${table} has no backup classification; refusing selective export`, false, { table });
}

export async function listDurableTables(database: D1Database): Promise<readonly string[]> {
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<Record<string, unknown>>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup durable-table inventory is unavailable", true, {}, cause);
  }
  const names: string[] = [];
  for (const row of result.results ?? []) {
    const name = (row as Record<string, unknown>)["name"];
    if (typeof name !== "string" || name.length === 0) failBackup("BACKUP_ROW_INVALID", "backup table inventory carries a malformed name");
    if (name.startsWith("sqlite_") && name !== "sqlite_sequence" && name !== "sqlite_master") {
      failBackup("BACKUP_COVERAGE_GAP", `backup durable table ${name} has no backup classification`, false, { table: name });
    }
    names.push(name);
  }
  return names.sort();
}

export function assertExhaustiveTableCoverage(existing: readonly string[]): void {
  for (const table of existing) classifyDurableTable(table);
}

export interface NonD1Coverage {
  readonly kind: string;
  readonly source: string;
  readonly status: DurableStatus;
}

export const NON_D1_COVERAGE: readonly NonD1Coverage[] = [
  { kind: "d1-core", source: "core-db", status: "CANONICAL_EXPORTED" },
  { kind: "r2-evidence", source: "evidence-bucket", status: "CANONICAL_EXPORTED" },
  { kind: "r2-work", source: "work-bucket", status: "CANONICAL_EXPORTED" },
  { kind: "r2-backup-parts", source: "part-store", status: "CANONICAL_EXPORTED" },
  { kind: "d1-search", source: "search-db", status: "REBUILD_REQUIRED" },
  { kind: "ai-search", source: "managed-index", status: "REBUILD_REQUIRED" },
  { kind: "queue", source: "queue-transient", status: "REBUILD_REQUIRED" },
  { kind: "workflow", source: "workflow-transient", status: "REBUILD_REQUIRED" },
  { kind: "durable-object", source: "do-transient", status: "TRANSIENT_EXCLUDED" },
  { kind: "d1-time-travel", source: "time-travel", status: "NOT_A_BACKUP" },
  { kind: "offsite-copy", source: "offsite-destination", status: "CANONICAL_EXPORTED" },
];

export function rebuildManifestLines(): readonly string[] {
  return NON_D1_COVERAGE.filter((entry) => entry.status !== "CANONICAL_EXPORTED")
    .map((entry) => JSON.stringify({ kind: entry.kind, source: entry.source, status: entry.status }));
}
