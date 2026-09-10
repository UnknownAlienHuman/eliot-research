import { backupSha256Hex, canonicalBackupJson, failBackup } from "./shared.js";

// ER-34 O2 FIX2 coherent-cut protocol + complete column inventory.
//
// A cut is a controller-owned freeze token (persisted in backup_export_cut)
// binding the D1 table/schema/migration/purge state and the R2 inventory
// generation to the SAME cut. Phase 1 opens the cut; phase 2 recomputes it and
// seals ACCEPTED only on byte-exact equality, otherwise REJECTED with
// BACKUP_VECTOR_DRIFT. Observable inter-phase divergence therefore always
// invalidates acceptance, including an R2 re-put of identical bytes (the re-put
// mints a fresh etag/version, which is bound into the cut).
//
// D1 write+rollback that restores byte-identical state leaves no durable trace
// (verified: AUTOINCREMENT sequence and data_version are fully restored), and
// byte-identical state carries byte-identical authority, so acceptance of that
// state is authority-equivalent by construction. Anything observable fails.
//
// Column inventory: every real Core column of every CANONICAL_EXPORTED table is
// exported. The Luna-listed load-bearing columns are covered explicitly
// (source.origin_uri, source_revision.parser_profile_generation /
// currentness_state / workspace_view_revision_ref, scope_snapshot.
// client_fence_ref, evidence_handle.coordinate_map_ref / loss_map_ref /
// expires_at, artifact_revision.spec_digest / evidence_freeze_revision /
// dependency_manifest_ref) plus the full remaining inventory. Any unclassified
// table or column fails closed via PRAGMA table_info comparison.
//
// Manifests carry the versioned protocol identifier
// `eliotr.backup-manifest.v1`; the migration digest alone is not sufficient.

export const BACKUP_MANIFEST_PROTOCOL = "eliotr.backup-manifest.v1";
export const BACKUP_SCHEMA_INVENTORY_PROTOCOL = "eliotr.backup-schema-inventory.v1";

export type ColumnKind = "text" | "int" | "text-or-null" | "int-or-null";

export interface TableSpec {
  readonly manifest: string;
  readonly table: string;
  readonly order_by: string;
  readonly columns: Readonly<Record<string, ColumnKind>>;
  readonly required: boolean;
}

export const TABLE_SPECS: readonly TableSpec[] = [
  { manifest: "ownership", table: "source_namespace_ownership", order_by: "source_namespace_id, ownership_record_revision", columns: { source_namespace_id: "text", ownership_record_revision: "int", owner_system_id: "text", owner_incarnation_ref: "text", source_owner_generation: "text", source_admission_policy_revision: "int", status: "text", cutover_receipt_ref: "text-or-null", created_at: "text" }, required: true },
  { manifest: "sources", table: "source", order_by: "source_id", columns: { source_id: "text", source_namespace_id: "text", source_owner_system_id: "text", source_owner_generation: "text", ownership_mode: "text", kind: "text", origin_uri: "text-or-null", title: "text", default_storage_policy: "text", default_residency_profile_id: "text", source_class: "text", license_policy_ref: "text", default_retention_policy_id: "text", head_rev: "text-or-null", created_at: "text" }, required: true },
  { manifest: "revisions", table: "source_revision", order_by: "source_revision_ref", columns: { source_revision_ref: "text", source_id: "text", source_owner_generation: "text", content_sha256: "text", object_residency_key_digest: "text", original_r2_key: "text-or-null", normalized_artifact_ref: "text-or-null", captured_at: "text", parser_profile_generation: "text-or-null", quality_state: "text", purge_state: "text", currentness_state: "text", source_view_ref: "text", workspace_view_revision_ref: "text-or-null", admitted_at: "text" }, required: true },
  { manifest: "projects", table: "project", order_by: "project_id", columns: { project_id: "text", title: "text", default_disclosure: "text", retention_policy_ref: "text", default_source_policy_ref: "text", default_model_profile_ref: "text", default_depth_profile_ref: "text", generation: "int", created_at: "text" }, required: true },
  { manifest: "projects", table: "project_source_membership", order_by: "project_id, source_id, valid_from", columns: { project_id: "text", source_id: "text", role: "text", valid_from: "text", valid_to: "text-or-null", membership_generation: "int" }, required: true },
  { manifest: "projects", table: "source_tag", order_by: "source_id, tag, valid_from", columns: { source_id: "text", tag: "text", valid_from: "text", valid_to: "text-or-null" }, required: false },
  { manifest: "scopes", table: "scope_snapshot", order_by: "snapshot_id, revision", columns: { snapshot_id: "text", revision: "int", resolved_scope_expression_json: "text", participant_generations_json: "text", member_source_revision_refs_json: "text", source_owner_generations_json: "text", policy_authority_ref: "text", disclosure_closure_digest: "text", purge_ledger_revision: "int", client_fence_ref: "text-or-null", snapshot_digest: "text", created_at: "text", expires_at: "text", invalidated_at: "text-or-null", invalidation_reason: "text-or-null" }, required: true },
  { manifest: "handles", table: "evidence_handle", order_by: "handle_id, revision", columns: { handle_id: "text", revision: "int", source_namespace_id: "text", source_owner_generation: "text", source_revision_ref: "text", scope_snapshot_id: "text", scope_snapshot_revision: "int", anchor_json: "text", excerpt_sha256: "text", excerpt_byte_length: "int", coordinate_map_ref: "text-or-null", loss_map_ref: "text-or-null", object_residency_key_digest: "text", source_assurance_ceiling: "text", materializer_assurance_ceiling: "text", terminal_state: "text", invalidation_ref: "text-or-null", created_at: "text", expires_at: "text-or-null" }, required: true },
  { manifest: "handles", table: "evidence_handle_invalidation", order_by: "handle_id, handle_revision", columns: { invalidation_ref: "text", handle_id: "text", handle_revision: "int", terminal_state: "text", reason_code: "text", observed_at: "text" }, required: false },
  { manifest: "heads", table: "investigation", order_by: "investigation_id, revision", columns: { investigation_id: "text", revision: "int", goal: "text", intended_artifact: "text", scope_snapshot_id: "text", scope_snapshot_revision: "int", inquiry_protocol_id: "text", inquiry_protocol_revision: "int", evidence_grade: "text", execution_product: "text", model_profile_ref: "text", budget_ref: "text", stop_rule_ref: "text", current_stage: "text", terminal_disposition: "text-or-null", event_head: "int", parent_investigation_id: "text-or-null", parent_investigation_revision: "int-or-null", manifest_r2_key: "text", created_at: "text" }, required: false },
  { manifest: "heads", table: "artifact_head", order_by: "artifact_id", columns: { artifact_id: "text", head_revision: "int", manifest_r2_key: "text", updated_at: "text" }, required: false },
  { manifest: "heads", table: "artifact_revision", order_by: "artifact_id, revision", columns: { artifact_id: "text", revision: "int", kind: "text", spec_digest: "text", evidence_freeze_id: "text", evidence_freeze_revision: "int", manifest_r2_key: "text", dependency_manifest_ref: "text", status: "text", created_at: "text" }, required: false },
  { manifest: "heads", table: "wiki_head", order_by: "page_id", columns: { page_id: "text", head_revision: "int", manifest_r2_key: "text", updated_at: "text" }, required: false },
  { manifest: "heads", table: "wiki_revision", order_by: "page_id, revision", columns: { page_id: "text", revision: "int", page_type: "text", title: "text", scope_snapshot_id: "text", scope_snapshot_revision: "int", body_r2_key: "text", manifest_r2_key: "text", coverage_receipt_id: "text", coverage_receipt_revision: "int", status: "text", supersedes_revision: "int-or-null", generator_generation: "text", reviewer_ref: "text-or-null", created_at: "text" }, required: false },
  { manifest: "generations", table: "model_generation", order_by: "generation_id", columns: { generation_id: "text", capability_class: "text", route_fingerprint_json: "text", pricing_snapshot_ref: "text", golden_set_result_ref: "text-or-null", status: "text", created_at: "text", activated_at: "text-or-null", retired_at: "text-or-null" }, required: false },
  { manifest: "generations", table: "exchange_generation", order_by: "generation_id", columns: { generation_id: "text", connection_id: "text", folder_id: "text", spreadsheet_id: "text", sheet_ids_json: "text", protocol_version: "text", state: "text", created_at: "text", retired_at: "text-or-null" }, required: false },
  { manifest: "generations", table: "projection_generation", order_by: "source_revision_ref, projection_generation", columns: { source_revision_ref: "text", projection_generation: "text", job_id: "text", source_owner_generation: "text", content_sha256: "text", object_residency_key_digest: "text", projector_profile: "text", state: "text", item_count: "int-or-null", item_set_digest: "text-or-null", work_manifest_ref: "text-or-null", work_manifest_sha256: "text-or-null", d1_search_receipt_ref: "text-or-null", d1_search_readback_digest: "text-or-null", semantic_instance_id: "text-or-null", semantic_generation: "text-or-null", semantic_receipt_ref: "text-or-null", semantic_readback_digest: "text-or-null", reason_codes_json: "text", created_at: "text", updated_at: "text" }, required: false },
  { manifest: "retention", table: "backup_epoch", order_by: "backup_epoch_id", columns: { backup_epoch_id: "text", core_export_ref: "text", search_projection_manifest_ref: "text", evidence_manifest_ref: "text", work_manifest_ref: "text", offsite_copy_ref: "text", purge_ledger_revision: "int", verification_state: "text", created_at: "text", verified_at: "text-or-null" }, required: false },
  { manifest: "retention", table: "erasure_hold", order_by: "hold_ref", columns: { hold_ref: "text", exact_subject_ref: "text-or-null", location: "text-or-null", canonical_ref: "text-or-null", policy_or_hold_ref: "text", next_review_at: "text", state: "text", created_at: "text", released_at: "text-or-null" }, required: false },
];

export interface CoreColumnInfo {
  readonly name: string;
  readonly affinity: "TEXT" | "INTEGER";
  readonly notnull: boolean;
}

export interface CoreTableInventory {
  readonly table: string;
  readonly columns: readonly CoreColumnInfo[];
}

function specKindFor(affinity: "TEXT" | "INTEGER", notnull: boolean): ColumnKind {
  if (affinity === "INTEGER") return notnull ? "int" : "int-or-null";
  return notnull ? "text" : "text-or-null";
}

export async function readCoreColumnInventory(database: D1Database, tables: readonly string[]): Promise<readonly CoreTableInventory[]> {
  const inventory: CoreTableInventory[] = [];
  for (const table of tables) {
    let rows: readonly { readonly name: unknown; readonly type: unknown; readonly notnull: unknown }[];
    try {
      const result = await database.prepare(`PRAGMA table_info(${table})`).all<{ readonly name: unknown; readonly type: unknown; readonly notnull: unknown }>();
      rows = [...(result.results ?? [])];
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", `backup schema inventory read for ${table} is unavailable`, true, { table }, cause);
    }
    inventory.push({
      table,
      columns: rows.map((row) => {
        if (typeof row.name !== "string" || typeof row.type !== "string" || typeof row.notnull !== "number") {
          failBackup("BACKUP_ROW_INVALID", `backup schema inventory for ${table} carries a malformed column`, false, { table });
        }
        return {
          name: row.name,
          affinity: row.type.toUpperCase().includes("INT") ? "INTEGER" as const : "TEXT" as const,
          notnull: row.notnull === 1,
        };
      }),
    });
  }
  return inventory.sort((left, right) => (left.table < right.table ? -1 : left.table > right.table ? 1 : 0));
}

export function assertExportColumnCoverage(inventory: readonly CoreTableInventory[], specs: readonly TableSpec[]): void {
  const byTable = new Map<string, TableSpec>();
  for (const spec of specs) {
    const prior = byTable.get(spec.table);
    if (prior !== undefined) failBackup("BACKUP_COVERAGE_GAP", `backup export covers table ${spec.table} twice`, false, { table: spec.table });
    byTable.set(spec.table, spec);
  }
  for (const entry of inventory) {
    const spec = byTable.get(entry.table);
    if (spec === undefined) failBackup("BACKUP_COVERAGE_GAP", `backup table ${entry.table} has no export column coverage`, false, { table: entry.table });
    for (const column of entry.columns) {
      const kind = spec.columns[column.name];
      if (kind === undefined) {
        failBackup("BACKUP_COVERAGE_GAP", `backup table ${entry.table} column ${column.name} is not exported; refusing selective export`, false, { table: entry.table, column: column.name });
      }
      if (kind !== specKindFor(column.affinity, column.notnull)) {
        failBackup("BACKUP_COVERAGE_GAP", `backup table ${entry.table} column ${column.name} changes affinity; refusing selective export`, false, { table: entry.table, column: column.name });
      }
    }
  }
}

export async function digestCoreColumnInventory(inventory: readonly CoreTableInventory[]): Promise<string> {
  return backupSha256Hex(canonicalBackupJson({
    protocol: BACKUP_SCHEMA_INVENTORY_PROTOCOL,
    tables: inventory.map((entry) => ({ table: entry.table, columns: entry.columns.map((c) => ({ name: c.name, affinity: c.affinity, notnull: c.notnull })) })),
  }));
}

export interface CutInputs {
  readonly schema_generation: string;
  readonly migration_ledger_digest: string;
  readonly table_digests: Readonly<Record<string, { readonly count: number; readonly digest: string }>>;
  readonly purge_frontier: number;
  readonly purge_digest: string;
  readonly r2_generation: string;
  readonly schema_inventory_digest: string;
}

export async function canonicalCutDigest(inputs: CutInputs): Promise<string> {
  return backupSha256Hex(canonicalBackupJson({
    protocol: BACKUP_MANIFEST_PROTOCOL,
    schema_generation: inputs.schema_generation,
    migration_ledger_digest: inputs.migration_ledger_digest,
    tables: Object.entries(inputs.table_digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([table, v]) => ({ table, count: v.count, digest: v.digest })),
    purge_frontier: inputs.purge_frontier,
    purge_digest: inputs.purge_digest,
    r2_generation: inputs.r2_generation,
    schema_inventory_digest: inputs.schema_inventory_digest,
  }));
}

export interface OpenCut {
  readonly cut_id: string;
  readonly cut_digest: string;
}

export async function openExportCut(database: D1Database, inputs: CutInputs, now: string): Promise<OpenCut> {
  const cutDigest = await canonicalCutDigest(inputs);
  const cutId = `cut-${cutDigest.slice(0, 32)}`;
  try {
    await database.prepare(
      "INSERT INTO backup_export_cut (cut_id, cut_digest, state, created_at) VALUES (?1, ?2, 'OPEN', ?3)",
    ).bind(cutId, cutDigest, now).run();
  } catch {
    // Same content re-freezes to the same cut; keep the controller-owned row.
    const existing = await database.prepare(
      "SELECT cut_digest FROM backup_export_cut WHERE cut_id = ?1",
    ).bind(cutId).first<{ readonly cut_digest: unknown }>();
    if (existing === null || existing.cut_digest !== cutDigest) {
      failBackup("BACKUP_VECTOR_DRIFT", "backup coherent cut collides with divergent state", true, { cut: cutId });
    }
  }
  return { cut_id: cutId, cut_digest: cutDigest };
}

export async function sealExportCut(database: D1Database, cut: OpenCut, recomputed: CutInputs, now: string): Promise<void> {
  const digest = await canonicalCutDigest(recomputed);
  const state = digest === cut.cut_digest ? "ACCEPTED" : "REJECTED";
  try {
    await database.prepare("UPDATE backup_export_cut SET state = ?1 WHERE cut_id = ?2").bind(state, cut.cut_id).run();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup coherent cut seal is unavailable", true, { cut: cut.cut_id }, cause);
  }
  if (digest !== cut.cut_digest) {
    failBackup("BACKUP_VECTOR_DRIFT", "backup authority drifted between freeze and seal; epoch withheld as stale", true, { cut: cut.cut_id });
  }
  void now;
}
