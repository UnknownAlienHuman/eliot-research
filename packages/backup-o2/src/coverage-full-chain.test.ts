/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertCoreTableMigrationPresence,
  assertExportColumnCoverage,
  coreTableSpecsForMigrationNames,
  readCoreColumnInventory,
  TABLE_SPECS,
} from "./coherent-cut.js";
import {
  assertExhaustiveTableCoverage,
  CANONICAL_EXPORTED_TABLES,
  classifyDurableTable,
  listDurableTables,
} from "./coverage.js";

const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../infra/d1/core/migrations");
const PROVIDER_AUTHORITY_TABLES = [
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
  "research_provider_key_model_use_unverified_execution",
] as const;
const SERVICE_MODEL_PROVIDER_TABLES = [
  "service_model_provider_operation",
  "service_model_provider_catalog_preference",
] as const;
const CATALOG_MODEL_USE_TABLES = [
  "research_catalog_model_use_authorization",
  "provider_native_model_catalog_v2_evidence",
  "provider_native_model_catalog_v2_revocation",
  "provider_native_model_catalog_v2_failure",
  "provider_native_model_catalog_v2_unverified_execution",
] as const;
const RECENT_CANONICAL_TABLES = [
  "project_guide_binding",
  "doctor_delivery_outbox",
  "projection_managed_item_effect",
  "queue_owner_replay",
  "queue_terminal_observation",
  "research_workflow_authorized_read_stage_completion",
  "research_workflow_native_stage_completion",
] as const;

function d1Database(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      const statement = db.prepare(query);
      return {
        bind(...values: unknown[]) {
          return {
            async all<T = unknown>() {
              return { success: true as const, results: statement.all(...values as SQLInputValue[]) as T[] };
            },
          };
        },
        async all<T = unknown>() {
          return { success: true as const, results: statement.all() as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

function migratedCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const migrations = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  expect(migrations.length).toBeGreaterThan(90);
  for (const name of migrations) db.exec(readFileSync(resolve(migrationDirectory, name), "utf8"));
  return db;
}

describe("ER-34 O2 full Core migration coverage", () => {
  it("classifies and explicitly exports every canonical column from the complete migration chain", async () => {
    const database = migratedCore();
    const d1 = d1Database(database);
    const tables = await listDurableTables(d1);
    expect(tables.length).toBeGreaterThan(150);
    assertExhaustiveTableCoverage(tables);

    const inventory = await readCoreColumnInventory(d1, [...CANONICAL_EXPORTED_TABLES].sort());
    assertExportColumnCoverage(inventory, TABLE_SPECS);
    expect(classifyDurableTable("scope_access_grant")).toBe("NOT_A_BACKUP");
    expect(classifyDurableTable("project_client_grant")).toBe("NOT_A_BACKUP");
    for (const table of ["backup_restore_target_profile", "backup_restore_target_profile_revocation",
      "backup_restore_permission", "backup_restore_permission_revocation", "backup_restore_admission_binding"]) {
      expect(classifyDurableTable(table)).toBe("NOT_A_BACKUP");
    }
    expect(classifyDurableTable("historical_scope_access_grant")).toBe("CANONICAL_EXPORTED");
    expect(classifyDurableTable("historical_project_client_grant")).toBe("CANONICAL_EXPORTED");
    for (const table of [
      "scope_read_policy_lease_refresh_receipt",
      "scope_read_policy_history_event",
      "scope_read_policy_identity",
      "scope_read_policy_snapshot_baseline",
    ]) {
      expect(classifyDurableTable(table)).toBe("CANONICAL_EXPORTED");
    }
    for (const table of PROVIDER_AUTHORITY_TABLES) {
      expect(classifyDurableTable(table)).toBe("CANONICAL_EXPORTED");
      expect(CANONICAL_EXPORTED_TABLES.has(table)).toBe(true);
      expect(TABLE_SPECS.some((spec) => spec.table === table)).toBe(true);
    }
    for (const table of SERVICE_MODEL_PROVIDER_TABLES) {
      expect(classifyDurableTable(table)).toBe("CANONICAL_EXPORTED");
      expect(CANONICAL_EXPORTED_TABLES.has(table)).toBe(true);
      expect(TABLE_SPECS.some((spec) => spec.table === table)).toBe(true);
    }
    for (const table of CATALOG_MODEL_USE_TABLES) {
      expect(classifyDurableTable(table)).toBe("CANONICAL_EXPORTED");
      expect(CANONICAL_EXPORTED_TABLES.has(table)).toBe(true);
      expect(TABLE_SPECS.some((spec) => spec.table === table)).toBe(true);
    }
    for (const table of RECENT_CANONICAL_TABLES) {
      expect(classifyDurableTable(table)).toBe("CANONICAL_EXPORTED");
      expect(CANONICAL_EXPORTED_TABLES.has(table)).toBe(true);
      expect(TABLE_SPECS.some((spec) => spec.table === table)).toBe(true);
    }
    expect(CANONICAL_EXPORTED_TABLES.has("scope_read_policy")).toBe(false);
    expect(classifyDurableTable("scope_read_policy")).toBe("NOT_A_BACKUP");
    expect(database.prepare("SELECT COUNT(*) AS n FROM historical_scope_access_grant").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM historical_project_client_grant").get()).toEqual({ n: 0 });
  });

  it("keeps portable grant provenance immutable and separate from active grants", () => {
    const database = migratedCore();
    database.prepare(`INSERT INTO historical_scope_access_grant(
      archive_revision,snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,
      policy_authority_ref,authorization_receipt_ref,allowed_use_json,disclosure_ceiling,state,expires_at,
      created_at,event_kind,recorded_at
    ) VALUES (1,'snapshot-old',1,'author-old','owner_pwa','credential-old','policy-old','receipt-old','[]',
      'local','EXPIRED','2025-01-01T00:00:00.000Z','2024-01-01T00:00:00.000Z','BACKFILL','2025-01-01T00:00:00.000Z')`).run();
    expect(() => database.prepare("UPDATE historical_scope_access_grant SET state='ACTIVE' WHERE archive_id=1").run()).toThrow();
    expect(() => database.prepare("DELETE FROM historical_scope_access_grant WHERE archive_id=1").run()).toThrow();
    expect(database.prepare("SELECT state FROM historical_scope_access_grant WHERE archive_id=1").get()).toEqual({ state: "EXPIRED" });
    expect(database.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").get()).toEqual({ n: 0 });
  });

  it("rejects a newly added table and an unlisted column instead of silently omitting either", async () => {
    const database = migratedCore();
    const d1 = d1Database(database);
    database.exec("CREATE TABLE unclassified_probe (probe_id TEXT PRIMARY KEY)");
    await expect(listDurableTables(d1).then(assertExhaustiveTableCoverage)).rejects.toMatchObject({ code: "BACKUP_COVERAGE_GAP" });

    database.exec("ALTER TABLE source ADD COLUMN unclassified_probe TEXT");
    const inventory = await readCoreColumnInventory(d1, ["source"]);
    expect(() => assertExportColumnCoverage(inventory, TABLE_SPECS)).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
  });

  it("keeps pre-0109 manifest inventory stable and rejects partial provider-authority schema chains", () => {
    const migrations = readdirSync(migrationDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const preProviderAuthority = migrations.filter((name) => name < "0109_research_provider_key_configuration.sql");
    const legacySpecs = coreTableSpecsForMigrationNames(preProviderAuthority);
    for (const table of PROVIDER_AUTHORITY_TABLES) {
      expect(legacySpecs.some((spec) => spec.table === table)).toBe(false);
    }
    const currentSpecs = coreTableSpecsForMigrationNames(migrations);
    for (const table of PROVIDER_AUTHORITY_TABLES) {
      expect(currentSpecs.some((spec) => spec.table === table)).toBe(true);
    }
    const beforeServiceModelProvider = migrations.filter((name) => name < "0152_service_model_provider_operation.sql");
    const beforeCatalogMode = migrations.filter((name) => name < "0157_service_model_provider_catalog_mode.sql");
    expect(coreTableSpecsForMigrationNames(beforeServiceModelProvider).some(
      (spec) => SERVICE_MODEL_PROVIDER_TABLES.includes(spec.table as typeof SERVICE_MODEL_PROVIDER_TABLES[number]),
    )).toBe(false);
    const preModeOperation = coreTableSpecsForMigrationNames(beforeCatalogMode)
      .find((spec) => spec.table === "service_model_provider_operation");
    expect(preModeOperation).toBeDefined();
    expect(preModeOperation?.columns.model_registration_mode).toBeUndefined();
    expect(coreTableSpecsForMigrationNames(beforeCatalogMode).some(
      (spec) => spec.table === "service_model_provider_catalog_preference",
    )).toBe(false);
    const currentProviderSpecs = currentSpecs.filter((spec) => SERVICE_MODEL_PROVIDER_TABLES.includes(
      spec.table as typeof SERVICE_MODEL_PROVIDER_TABLES[number],
    ));
    expect(currentProviderSpecs).toHaveLength(SERVICE_MODEL_PROVIDER_TABLES.length);
    expect(currentProviderSpecs.find((spec) => spec.table === "service_model_provider_operation")?.columns.model_registration_mode)
      .toBe("text");
    const newTableIntroductions = [
      ["research_workflow_native_stage_completion", "0127_research_workflow_native_stage_completion.sql"],
      ["projection_managed_item_effect", "0128_managed_item_effects.sql"],
      ["queue_terminal_observation", "0133_queue_terminal_observation.sql"],
      ["queue_owner_replay", "0136_queue_owner_replay.sql"],
      ["research_workflow_authorized_read_stage_completion", "0137_research_workflow_authorized_read_stage_completion.sql"],
      ["doctor_delivery_outbox", "0153_doctor_state.sql"],
      ["research_provider_key_model_use_unverified_execution", "0165_provider_key_model_use_unverified_execution.sql"],
      ["project_guide_binding", "0166_project_guide_binding.sql"],
    ] as const;
    for (const [table, introduction] of newTableIntroductions) {
      const beforeIntroduction = migrations.filter((name) => name < introduction);
      expect(coreTableSpecsForMigrationNames(beforeIntroduction).some((spec) => spec.table === table)).toBe(false);
    }
    const beforeFailureHistory = coreTableSpecsForMigrationNames(
      migrations.filter((name) => name < "0123_workflow_failure_outcomes.sql"),
    ).find((spec) => spec.table === "research_workflow_run");
    expect(beforeFailureHistory?.columns.failure_history_json).toBeUndefined();
    const beforeNativeStages = coreTableSpecsForMigrationNames(
      migrations.filter((name) => name < "0127_research_workflow_native_stage_completion.sql"),
    ).find((spec) => spec.table === "research_workflow_run");
    expect(beforeNativeStages?.columns.stage_effect_policy_generation).toBeUndefined();
    const beforeCitationOutcomes = coreTableSpecsForMigrationNames(
      migrations.filter((name) => name < "0124_citation_resolution_outcomes.sql"),
    ).find((spec) => spec.table === "citation_resolution_receipt");
    expect(beforeCitationOutcomes?.columns.outcomes_json).toBeUndefined();
    const beforeManagedItems = coreTableSpecsForMigrationNames(
      migrations.filter((name) => name < "0129_managed_item_protocol.sql"),
    ).find((spec) => spec.table === "projection_generation");
    expect(beforeManagedItems?.columns.managed_item_protocol).toBeUndefined();
    const beforeWorkflowBranchBinding = coreTableSpecsForMigrationNames(
      migrations.filter((name) => name < "0139_research_branch_role_workflow_binding.sql"),
    ).find((spec) => spec.table === "research_model_spend_admission");
    expect(beforeWorkflowBranchBinding?.columns.workflow_stage_request_sha256).toBeUndefined();
    expect(() => coreTableSpecsForMigrationNames([
      "0157_service_model_provider_catalog_mode.sql",
    ])).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));

    expect(() => coreTableSpecsForMigrationNames([
      "0109_research_provider_key_configuration.sql",
      "0111_provider_native_model_authority.sql",
    ])).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    expect(() => assertCoreTableMigrationPresence(
      ["research_provider_key_configuration_operation"], [],
    )).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    expect(() => assertCoreTableMigrationPresence(
      [], ["0109_research_provider_key_configuration.sql"],
    )).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    expect(() => assertCoreTableMigrationPresence(
      ["research_provider_key_model_use_unverified_execution"], ["0165_provider_key_model_use_unverified_execution.sql"],
    )).not.toThrow();
    expect(() => assertCoreTableMigrationPresence(
      ["research_provider_key_model_use_unverified_execution"], [],
    )).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    expect(() => assertCoreTableMigrationPresence(
      ["project_guide_binding"], ["0166_project_guide_binding.sql"],
    )).not.toThrow();
    expect(() => assertCoreTableMigrationPresence(
      ["project_guide_binding"], [],
    )).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    expect(() => assertCoreTableMigrationPresence(
      [], ["0166_project_guide_binding.sql"],
    )).toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    const restoreAuthority = [
      "backup_restore_target_profile", "backup_restore_target_profile_revocation", "backup_restore_permission",
      "backup_restore_permission_revocation", "backup_restore_admission_binding",
    ];
    expect(() => assertCoreTableMigrationPresence(restoreAuthority, ["0115_backup_restore_current_admission.sql"])).not.toThrow();
    expect(() => assertCoreTableMigrationPresence(restoreAuthority.slice(1), ["0115_backup_restore_current_admission.sql"]))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
  });

  it("fails closed when table or PRAGMA inventory queries return failed or malformed D1 results", async () => {
    for (const result of [{ success: false, results: [] }, { success: true }]) {
      const broken = {
        prepare() {
          return { async all() { return result; } };
        },
      } as unknown as D1Database;
      await expect(listDurableTables(broken)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
      await expect(readCoreColumnInventory(broken, ["source"]))
        .rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    }
  });

  it("keeps catalog model-use and native v2 inventory bound to their additive migration ledger", () => {
    const migrations = readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
    const introductions = [
      ["research_catalog_model_use_authorization", "0158_research_catalog_model_use_authority.sql"],
      ["provider_native_model_catalog_v2_evidence", "0159_provider_native_model_catalog_v2.sql"],
      ["provider_native_model_catalog_v2_revocation", "0159_provider_native_model_catalog_v2.sql"],
      ["provider_native_model_catalog_v2_failure", "0161_catalog_qualification_failure_reconciliation.sql"],
      ["provider_native_model_catalog_v2_unverified_execution", "0162_catalog_qualification_unverified_execution.sql"],
    ] as const;
    for (const [table, migration] of introductions) {
      expect(coreTableSpecsForMigrationNames(migrations.filter(name => name < migration))
        .some(spec => spec.table === table)).toBe(false);
      expect(coreTableSpecsForMigrationNames(migrations).some(spec => spec.table === table)).toBe(true);
    }
    for (const missing of ["0111_provider_native_model_authority.sql", "0156_global_provider_model_use.sql",
      "0157_service_model_provider_catalog_mode.sql", "0158_research_catalog_model_use_authority.sql"]) {
      expect(() => coreTableSpecsForMigrationNames(migrations.filter(name => name !== missing)))
        .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    }
    const catalogMigrations = ["0158_research_catalog_model_use_authority.sql", "0159_provider_native_model_catalog_v2.sql",
      "0161_catalog_qualification_failure_reconciliation.sql", "0162_catalog_qualification_unverified_execution.sql"];
    expect(() => assertCoreTableMigrationPresence(CATALOG_MODEL_USE_TABLES, catalogMigrations)).not.toThrow();
    expect(() => assertCoreTableMigrationPresence(CATALOG_MODEL_USE_TABLES.slice(0, 2), catalogMigrations))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    expect(() => assertCoreTableMigrationPresence(CATALOG_MODEL_USE_TABLES, catalogMigrations.slice(0, 1)))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
  });
});
