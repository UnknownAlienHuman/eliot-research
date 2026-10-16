/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExportColumnCoverage, coreTableSpecsForMigrationNames, readCoreColumnInventory, TABLE_SPECS,
} from "../src/coherent-cut.js";
import {
  assertExhaustiveTableCoverage, CANONICAL_EXPORTED_TABLES, classifyDurableTable, listDurableTables,
} from "../src/coverage.js";

// 0141-0151 were canceled. Retained nonportable classifications must never
// become a reason to recreate their managed-project assignment topology.
const migrationDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../infra/d1/core/migrations");
const assignmentTables = ["managed_target_assignment_event", "managed_target_assignment_current"];
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function d1Database(db: DatabaseSync): D1Database {
  return { prepare(query: string) {
    const statement = db.prepare(query);
    const bound = (values: unknown[]) => ({
      async all<T>() { return { success: true, results: statement.all(...values as SQLInputValue[]) as T[] }; },
    });
    return { bind(...values: unknown[]) { return bound(values); }, ...bound([]) };
  } } as unknown as D1Database;
}

function canonicalMigrationNames(): string[] {
  return readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
}

function migratedCore(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const name of canonicalMigrationNames()) database.exec(readFileSync(resolve(migrationDirectory, name), "utf8"));
  return database;
}

describe("O2 excludes canceled managed-project assignment topology", () => {
  it("keeps canceled 0141-0151 migrations and assignment schema absent from the complete chain", async () => {
    expect(canonicalMigrationNames().filter(name => /^01(?:4[1-9]|5[01])_/u.test(name))).toEqual([]);
    const database = migratedCore();
    const tables = await listDurableTables(d1Database(database));
    for (const table of assignmentTables) expect(tables).not.toContain(table);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'managed_target_assignment_%'").all()).toEqual([]);
  });

  it("never exports assignment authority or invents column specs for its absent tables", async () => {
    const database = migratedCore();
    const specs = coreTableSpecsForMigrationNames(canonicalMigrationNames());
    for (const table of assignmentTables) {
      expect(CANONICAL_EXPORTED_TABLES.has(table)).toBe(false);
      expect(TABLE_SPECS.some(spec => spec.table === table)).toBe(false);
      expect(specs.some(spec => spec.table === table)).toBe(false);
    }
    expect(await readCoreColumnInventory(d1Database(database), assignmentTables))
      .toEqual([...assignmentTables].sort().map(table => ({ table, columns: [] })));
    expect(classifyDurableTable("project_owner")).toBe("NOT_A_BACKUP");
  });

  it("retains exhaustive canonical coverage without canceled assignment tables", async () => {
    const database = d1Database(migratedCore());
    const tables = await listDurableTables(database);
    expect(tables.length).toBeGreaterThan(150);
    assertExhaustiveTableCoverage(tables);
    const inventory = await readCoreColumnInventory(database, [...CANONICAL_EXPORTED_TABLES].sort());
    assertExportColumnCoverage(inventory, coreTableSpecsForMigrationNames(canonicalMigrationNames()));
  });

  it("still refuses an unclassified future durable table instead of silently exporting it", async () => {
    const database = migratedCore();
    database.exec("CREATE TABLE unclassified_future_assignment_probe (project_id TEXT PRIMARY KEY) STRICT");
    const tables = await listDurableTables(d1Database(database));
    expect(tables).toContain("unclassified_future_assignment_probe");
    expect(() => assertExhaustiveTableCoverage(tables))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
  });
});
