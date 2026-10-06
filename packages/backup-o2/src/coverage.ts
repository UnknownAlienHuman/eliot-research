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
  "backup_epoch_manifest_binding",
  "backup_epoch_verification_receipt",
  "erasure_hold",
  "purge_ledger",
  // Durable Core state named by architecture §16.1. Full explicit column
  // specs live in core-table-specs.ts; no PRAGMA wildcard export is used.
  "investigation_ledger_event",
  "investigation_ledger_command",
  "investigation_ledger_head",
  "investigation_ledger_epoch",
  "research_workflow_run",
  "research_run_configuration",
  "research_workflow_attempt",
  "research_workflow_checkpoint",
  "research_workflow_citation_binding",
  "retrieval_query_result",
  "retrieval_query_trace",
  "retrieval_exhaustive_job",
  "retrieval_exhaustive_shard",
  "retrieval_exhaustive_workflow",
  "raw_file_capture",
  "raw_markdown_conversion",
  "raw_normalized_admission",
  "workspace_mcp_observation",
  "workspace_mcp_raw_normalized_admission",
  "artifact_draft_reservation",
  "artifact_draft_head",
  "artifact_draft_binding",
  "artifact_draft_object",
  "research_model_attempt",
  "research_reference_manifest",
  "research_model_fingerprint",
  "research_model_output",
  "research_model_pricing_snapshot",
  "dynamic_route_candidate",
  "dynamic_route_active_generation",
  "dynamic_route_qualification_proof",
  "dynamic_route_active_qualification",
  "dynamic_route_qualification_revocation",
  "research_project_model_configuration_revision",
  "wiki_publication_proposal",
  "wiki_publication_authority",
  "wiki_publication_revision",
  "wiki_publication_head",
  "wiki_publication_outbox",
  "wiki_owner_edit_binding",
  "source_namespace_initialization",
  "raw_ingest_erasure_member",
  "model_route_qualification_probe",
  "model_route_qualification_dispatch",
  "project_mutation_guard",
  "project_mutation_receipt",
  "research_report_admission",
  "research_external_agent_task",
  "research_external_agent_task_progress",
  "research_external_agent_task_payload",
  "research_computer_agent_route_binding",
  "project_computer_agent_route",
  "project_computer_agent_route_entry",
  "computer_agent_dispatch",
  "computer_agent_dispatch_acceptance",
  "computer_agent_dispatch_abandonment",
  "computer_agent_dispatch_decline",
  "computer_agent_dispatch_reassignment",
  "computer_agent_preferred_dispatch_selection",
  "computer_agent_preferred_dispatch_settlement",
  "research_model_spend_admission",
  "research_semantic_config_revision",
  // Durable action history and idempotency authority. Restoring source data
  // without these records could replay paid or externally visible effects.
  "operation_intent",
  "operation_attempt",
  "operation_receipt",
  "outbox",
  "job",
  "delivery_inbox",
  "investigation_event",
  "investigation_checkpoint",
  "evidence_freeze",
  "claim_audit",
  "coverage_receipt",
  "research_debt",
  "budget_reservation",
  "erasure_case",
  "erasure_execution",
  "erasure_dependency_registry",
  "erasure_target",
  "erasure_stage_receipt",
  "erasure_dependent_invalidation",
  "erasure_terminal_guard",
  "backup_purge_obligation",
  "erasure_admission_request",
  "federation_reference_manifest",
  "federation_job",
  "navigation_artifact",
  "bundle_ingest_operation",
  "bundle_ingest_commit_guard",
  "source_acquisition_candidate",
  "qualification_report",
  "source_admission_decision",
  "drive_observation",
  "incident",
  "evidence_resolution_receipt",
  "citation_resolution_receipt",
  "orientation_request",
  "orientation_authority_epoch",
  "google_oauth_intent_receipt",
  // Historical authorization facts are portable provenance only. They are
  // never rehydrated as current admission, ownership, or credentials.
  "historical_scope_access_grant",
  "historical_project_client_grant",
  // Scope-policy history is portable provenance, never transferable current
  // authority; the live scope_read_policy table remains NOT_A_BACKUP below.
  "scope_read_policy_lease_refresh_receipt",
  "scope_read_policy_history_event",
  "scope_read_policy_identity",
  "scope_read_policy_snapshot_baseline",
  // Immutable acceptance and per-call COW effect history must survive recovery.
  "artifact_publication_receipt",
  "artifact_publication_head",
  "artifact_section_revise_run",
  "artifact_section_revise_attempt",
  "artifact_section_revise_spend_admission",
  // Owner-created provider-key and native qualification facts are immutable
  // idempotency/proof history. Active provider keys and current project grants
  // remain NOT_A_BACKUP; these records are portable provenance only.
  "research_provider_key_configuration_operation",
  "research_provider_key_model_use_operation",
  "research_provider_key_model_use_stage_operation",
  "research_provider_key_model_price_observation",
  "provider_native_model_preparation",
  "provider_native_model_qualification_attempt",
  "provider_native_model_qualification_observation",
  "provider_native_model_candidate",
  "provider_native_model_qualification_proof",
  "provider_native_model_qualification_revocation",
]);

const REBUILD_REQUIRED_TABLES: ReadonlySet<string> = new Set([
  "source_readiness",
  // Change-feed offsets are derived from authoritative Core events and are
  // regenerated after restore rather than treated as source records.
  "research_change_feed",
  "evidence_handle_identity",
  "health_snapshot",
]);

const TRANSIENT_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "operation_execution_lease",
  "drive_cursor",
  // Short-lived guards and plans carry no committed user payload or external
  // action result; the owning controller reissues them after restore.
  "investigation_ledger_guard",
  "workspace_mcp_plan",
  "mcp_client_diagnostic_challenge",
  "wiki_owner_publication_guard",
  "computer_agent_connection_qualification_binding",
  "raw_ingest_erasure_guard",
  "projection_terminal_guard",
  "evidence_resolution_guard",
  "citation_resolution_guard",
  "artifact_publication_mutation_guard",
]);

const NOT_A_BACKUP_TABLES: ReadonlySet<string> = new Set([
  "schema_state",
  "d1_migrations",
  "sqlite_sequence",
  "sqlite_master",
  "backup_epoch_receipt",
  // Writer fencing is controller-only idempotency authority. Including it in
  // its own source vector would make admission mutate the vector it snapshots.
  "backup_epoch_producer_claim",
  // These rows are live erasure execution authority. Restoring them as source
  // data could revive a deletion plan or transfer its current lease fence.
  "backup_erasure_primary_closure",
  "backup_erasure_primary_claim_pin",
  "backup_erasure_primary_cut_pin",
  "backup_erasure_primary_target_pin",
  "backup_erasure_primary_part_pin",
  "backup_erasure_primary_delete_item",
  "backup_erasure_primary_handoff",
  // Qualification and operation rows govern the active writer controller;
  // restoring them cannot grant current write or retirement authority.
  "backup_primary_writer_qualification",
  "backup_primary_writer_operation",
  "backup_primary_writer_current",
  "backup_offsite_expiry",
  "backup_destination_authority",
  "backup_offsite_copy_part",
  "backup_offsite_copy_receipt",
  "backup_offsite_nonce_authority",
  "backup_export_cut",
  // O4 retains controller-only replay authority; portable recovery cannot
  // recreate the original grant from copy digests or claim erasure closure.
  "backup_offsite_copy_replay_authority",
  "backup_erasure_replay_obligation",
  // Restore lifecycle rows are target-bound controller authority, not
  // portable source state. An ATTEMPTING/UNKNOWN row cannot be reconstructed
  // from source data without proving side-effect settlement; a receipt is
  // valid only for its exact target and purge frontier. Copying these rows
  // could replay or falsely suppress a restore after deployment recovery.
  "backup_restore_intent",
  "backup_restore_attempt",
  "backup_restore_receipt",
  // Restore target profiles, per-restore permissions, revocations and the
  // immutable request binding are target-local current authority. Exporting
  // any of these would let a recovered epoch revive an old grant.
  "backup_restore_target_profile",
  "backup_restore_target_profile_revocation",
  "backup_restore_permission",
  "backup_restore_permission_revocation",
  "backup_restore_admission_binding",
  // Installation-local policies, credentials and current grants must be
  // re-admitted at the restored controller, never copied as transferable.
  "investigation_current_policy",
  "investigation_current_deployment",
  "investigation_ledger_authority",
  "google_oauth_reconnect_intent",
  "google_oauth_disconnect_receipt",
  "google_exchange_connection",
  // In-flight OAuth state contains encrypted credentials/secrets; users must
  // start a fresh authorization after controller recovery.
  "google_oauth_intent",
  "erasure_admission_policy",
  "retrieval_scope_profile",
  "project_owner",
  // The current selected project model configuration is owner-controlled
  // authority. Restore the immutable revision history, then require the live
  // owner to select it again under current admission and route qualification.
  "research_project_model_configuration_selection",
  "project_client_grant",
  "dynamic_route_rest_binding",
  "computer_agent_connection",
  "source_admission_policy",
  "scope_access_grant",
  "scope_read_policy",
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
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", "backup durable-table inventory returned an incomplete result", true);
  }
  const names: string[] = [];
  for (const row of result.results) {
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
