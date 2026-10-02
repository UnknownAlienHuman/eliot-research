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
});
