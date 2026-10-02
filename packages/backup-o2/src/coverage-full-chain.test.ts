/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  assertExportColumnCoverage,
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
});
