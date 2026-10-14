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
  CANONICAL_EXPORTED_TABLES,
  classifyDurableTable,
  listDurableTables,
} from "./coverage.js";

// ER-34 O2 / issue #374. Migration 0141 introduces the immutable
// managed-target assignment event history and 0143 its derived current
// read model. The event history is the canonical assignment authority
// source and is exported as portable provenance; the current head is
// rebuild-required and is derived from that history by the 0143
// projection, never trusted from stale portable bytes.

const ASSIGNMENT_EVENT_INTRODUCTION = "0141_managed_target_assignment.sql";
const ASSIGNMENT_CURRENT_INTRODUCTION = "0143_managed_target_assignment_current.sql";

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

function canonicalMigrationNames(): string[] {
  return readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
}

function migratedCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const migrations = canonicalMigrationNames();
  expect(migrations.length).toBeGreaterThan(90);
  for (const name of migrations) db.exec(readFileSync(resolve(migrationDirectory, name), "utf8"));
  return db;
}

function createOwnedProject(db: DatabaseSync, projectId: string, principal: string): void {
  db.prepare(`INSERT INTO project(
    project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,
    default_model_profile_ref,default_depth_profile_ref,created_at
  ) VALUES (?1,'Managed target assignment coverage','private','retention-default','source-policy-default',
    'model-profile-default','depth-default','2026-10-14T00:00:00.000Z')`).run(projectId);
  db.prepare(`INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at)
    VALUES (?1,?2,'deployment-1','2026-10-14T00:00:00.000Z','2026-10-14T00:00:00.000Z')`)
    .run(projectId, principal);
}

const EVENT_COLUMNS = `project_id,event_revision,expected_event_revision,event_kind,project_generation,
  project_owner_principal_ref,target_namespace,managed_instance_id,managed_generation,
  target_profile_identity_sha256,previous_assignment_revision,actor_kind,actor_principal_ref,
  authorization_receipt_ref,created_at`;

interface AssignmentTarget {
  readonly namespace: string;
  readonly instance: string;
  readonly generation: string;
  readonly profile: string;
}

function appendEvent(db: DatabaseSync, projectId: string, principal: string, eventRevision: number, expectedRevision: number, eventKind: "ASSIGN" | "RETIRE", target: AssignmentTarget | null, previousRevision: number | null, createdAt: string): void {
  db.prepare(`INSERT INTO managed_target_assignment_event(
    ${EVENT_COLUMNS}
  ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`).run(
    projectId, eventRevision, expectedRevision, eventKind, 1, principal,
    target?.namespace ?? null, target?.instance ?? null, target?.generation ?? null,
    target?.profile ?? null, previousRevision, "OWNER", principal,
    `receipt-${eventRevision}`, createdAt,
  );
}

describe("ER-34 O2 managed-target assignment table classification (issue #374)", () => {
  it("classifies both 0141/0143 tables from the complete migration chain", async () => {
    const database = migratedCore();
    const d1 = d1Database(database);
    const tables = await listDurableTables(d1);
    expect(tables).toContain("managed_target_assignment_event");
    expect(tables).toContain("managed_target_assignment_current");
    // Both 0141/0143 tables carry explicit reviewed dispositions, so
    // neither fails the exhaustive durable-table coverage gate that
    // every portable epoch runs before any table inventory read. The
    // full-chain gate itself stays blocked by seven pre-existing
    // unclassified tables from migrations 0120-0137, which are
    // separate baseline gaps outside this issue's narrow scope.

    expect(classifyDurableTable("managed_target_assignment_event")).toBe("CANONICAL_EXPORTED");
    expect(CANONICAL_EXPORTED_TABLES.has("managed_target_assignment_event")).toBe(true);
    expect(TABLE_SPECS.some((spec) => spec.table === "managed_target_assignment_event")).toBe(true);

    // The derived current head is rebuild-only: it is never a canonical
    // export and never carries a portable column spec.
    expect(classifyDurableTable("managed_target_assignment_current")).toBe("REBUILD_REQUIRED");
    expect(CANONICAL_EXPORTED_TABLES.has("managed_target_assignment_current")).toBe(false);
    expect(TABLE_SPECS.some((spec) => spec.table === "managed_target_assignment_current")).toBe(false);

    // The owner authority the event history anchors to stays re-admission
    // only, so restored assignment history cannot bypass owner reauthorization.
    expect(classifyDurableTable("project_owner")).toBe("NOT_A_BACKUP");
  });

  it("exports the immutable assignment event history with exact coherent-cut column coverage", async () => {
    const database = migratedCore();
    const d1 = d1Database(database);
    const specs = coreTableSpecsForMigrationNames(canonicalMigrationNames());
    const spec = specs.find((entry) => entry.table === "managed_target_assignment_event");
    expect(spec).toBeDefined();
    expect(spec?.manifest).toBe("projects");
    expect(spec?.order_by).toBe("project_id, event_revision");
    expect(spec?.required).toBe(true);

    // Coherent-shape negative: the spec must cover every real 0141 column
    // with its exact affinity and nullability, failing closed on drift.
    const inventory = await readCoreColumnInventory(d1, ["managed_target_assignment_event"]);
    assertExportColumnCoverage(inventory, specs);
    expect(inventory[0]?.columns.map((column) => `${column.name}:${column.affinity}:${column.notnull ? 1 : 0}`)).toEqual([
      "project_id:TEXT:1",
      "event_revision:INTEGER:1",
      "expected_event_revision:INTEGER:1",
      "event_kind:TEXT:1",
      "project_generation:INTEGER:1",
      "project_owner_principal_ref:TEXT:1",
      "target_namespace:TEXT:0",
      "managed_instance_id:TEXT:0",
      "managed_generation:TEXT:0",
      "target_profile_identity_sha256:TEXT:0",
      "previous_assignment_revision:INTEGER:0",
      "actor_kind:TEXT:1",
      "actor_principal_ref:TEXT:1",
      "authorization_receipt_ref:TEXT:1",
      "created_at:TEXT:1",
    ]);
  });

  it("binds the assignment event export to migration 0141 and enforces the dependent 0143 chain", async () => {
    const names = canonicalMigrationNames();
    expect(coreTableSpecsForMigrationNames(names).some((spec) => spec.table === "managed_target_assignment_event")).toBe(true);

    // A hand-picked pre-0141 ledger subset must not claim the table.
    const preAssignment = names.filter((name) => name < ASSIGNMENT_EVENT_INTRODUCTION);
    expect(coreTableSpecsForMigrationNames(preAssignment).some((spec) => spec.table === "managed_target_assignment_event")).toBe(false);

    // The 0143 derived read model cannot appear in a ledger without its
    // 0141 authority predecessor: the complete chain is required.
    expect(() => coreTableSpecsForMigrationNames([...preAssignment, ASSIGNMENT_CURRENT_INTRODUCTION]))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));

    // Table presence must agree with the introducing migration in both
    // directions: the complete live table inventory against the
    // complete migration ledger. A partial inventory would disagree
    // with every other introduced table and fail closed.
    const database = migratedCore();
    const liveTables = await listDurableTables(d1Database(database));
    expect(() => assertCoreTableMigrationPresence(liveTables, names)).not.toThrow();
    expect(() => assertCoreTableMigrationPresence(["managed_target_assignment_event"], []))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
    expect(() => assertCoreTableMigrationPresence([], [ASSIGNMENT_EVENT_INTRODUCTION]))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
  });

  it("derives the current assignment head from the canonical event history", () => {
    const database = migratedCore();
    const projectId = "assignment-coverage-project";
    const principal = "assignment-coverage-owner";
    createOwnedProject(database, projectId, principal);

    // The event history is the authority source: each append derives the
    // current head through the 0143 AFTER INSERT projection.
    appendEvent(database, projectId, principal, 1, 0, "ASSIGN", {
      namespace: "managed-ns", instance: "managed-instance", generation: "managed-gen",
      profile: "a".repeat(64),
    }, null, "2026-10-14T00:00:00.001Z");

    expect(database.prepare(`SELECT project_id,event_revision,event_kind,target_namespace,managed_instance_id,
      managed_generation,target_profile_identity_sha256 FROM managed_target_assignment_current WHERE project_id=?1`)
      .get(projectId)).toEqual({
      project_id: projectId,
      event_revision: 1,
      event_kind: "ASSIGN",
      target_namespace: "managed-ns",
      managed_instance_id: "managed-instance",
      managed_generation: "managed-gen",
      target_profile_identity_sha256: "a".repeat(64),
    });

    appendEvent(database, projectId, principal, 2, 1, "RETIRE", null, 1, "2026-10-14T00:00:00.002Z");

    expect(database.prepare("SELECT project_id,event_revision,event_kind FROM managed_target_assignment_current WHERE project_id=?1")
      .get(projectId)).toEqual({ project_id: projectId, event_revision: 2, event_kind: "RETIRE" });

    // The immutable audit and lost-ACK provenance is retained, never rewritten.
    expect(() => database.prepare("UPDATE managed_target_assignment_event SET event_kind='RETIRE' WHERE project_id=?1 AND event_revision=1").run(projectId))
      .toThrow(/MANAGED_TARGET_ASSIGNMENT_IMMUTABLE/);
    expect(() => database.prepare("DELETE FROM managed_target_assignment_event WHERE project_id=?1").run(projectId))
      .toThrow(/MANAGED_TARGET_ASSIGNMENT_IMMUTABLE/);
    expect(database.prepare("SELECT COUNT(*) AS n FROM managed_target_assignment_event WHERE project_id=?1").get(projectId)).toEqual({ n: 2 });
  });

  it("refuses an assignment append without the current owner row and still fails closed on unknown future tables", async () => {
    const database = migratedCore();
    const orphanProject = "assignment-orphan-project";
    database.prepare(`INSERT INTO project(
      project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,
      default_model_profile_ref,default_depth_profile_ref,created_at
    ) VALUES (?1,'Orphan','private','retention-default','source-policy-default','model-profile-default','depth-default','2026-10-14T00:00:00.000Z')`)
      .run(orphanProject);

    // Restore authority: the event history anchors to project_owner
    // (NOT_A_BACKUP), so an ASSIGN cannot be revived at a restore target
    // until the live owner has been re-admitted there.
    expect(() => appendEvent(database, orphanProject, "never-admitted-principal", 1, 0, "ASSIGN", {
      namespace: "managed-ns", instance: "managed-instance", generation: "managed-gen",
      profile: "b".repeat(64),
    }, null, "2026-10-14T00:00:00.001Z")).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS n FROM managed_target_assignment_current WHERE project_id=?1").get(orphanProject)).toEqual({ n: 0 });

    // Negative fixture: an unknown future Core table still fails closed
    // instead of silently joining a portable epoch.
    expect(() => classifyDurableTable("unclassified_future_assignment_probe"))
      .toThrowError(expect.objectContaining({ code: "BACKUP_COVERAGE_GAP" }));
  });
});

