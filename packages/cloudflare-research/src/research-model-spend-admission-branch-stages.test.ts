/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// S37 follow-up: migration 0096 rebuilds research_model_spend_admission so
// branch stages 8 (ANALYZE_BRANCHES) and 9 (COUNTER_SEARCH) can be stored.
// Migration 0046 constrained stage_index to (12, 13, 14), which made the
// 0095 role column (branch stages always carry a role) unreachable -- any
// stage 8/9 insert aborted on the 0046 CHECK and the w2 guard only mapped
// 12/13/14.
//
// These tests apply the REAL migration chain on a scratch SQLite DB and
// assert the repair. The BEFORE INSERT authority guards (shape/w2/deployment)
// enforce the live workflow chain, which is orthogonal to the stage/role
// CHECKs under test, so they are dropped test-only where CHECK semantics are
// exercised; trigger presence and trigger SQL are asserted on the untouched
// migrated schema.

const MIGRATIONS = resolve(__dirname, "../../../infra/d1/core/migrations");
const FILES = readdirSync(MIGRATIONS).sort().filter((f) => f.endsWith(".sql"));

function freshDb(through?: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of FILES) {
    if (through !== undefined && file > through) break;
    db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
  }
  return db;
}

// Verbatim CREATE TRIGGER block from a migration file.
function triggerSql(file: string, name: string): string {
  const text = readFileSync(resolve(MIGRATIONS, file), "utf8");
  const m = text.match(new RegExp(`CREATE TRIGGER ${name}[\\s\\S]*?\\nEND;`, "u"));
  if (!m) throw new Error(`trigger ${name} not found in ${file}`);
  return m[0];
}

const SHA = "a".repeat(64);
const CREATED = "2026-10-01T12:00:00.000Z";
const EXPIRES = "2027-10-01T00:00:00.000Z";
const QUOTE_EXP = "2028-01-01T00:00:00.000Z";

// Shape-guard-consistent row: every JSON blob agrees with the scalar
// columns, exactly as the 0046 shape guard demands.
function makeRow(stage: number, role: string | null, s: string): Record<string, SQLInputValue> {
  const ids = {
    authorization_ref: `auth-${s}`, operation_id: `op-${s}`, workflow_operation_id: `wop-${s}`,
    stage_attempt_ref: `att-${s}`, workflow_budget_receipt_ref: `bwr-${s}`,
    intent_id: `intent-${s}`, reservation_id: `res-${s}`, quote_ref: `q-${s}`,
    principal_ref: `p-${s}`, policy_decision_ref: `pd-${s}`, policy_generation: "pg-1",
    scope_snapshot_id: `ss-${s}`, workflow_authorization_receipt_ref: `war-${s}`,
    route_ref: `route-${s}`,
  };
  const deployment = {
    route_ref: ids.route_ref, route_version: "v1", prompt_generation: "pg-1",
    schema_generation: "sg-1", parameters_digest: SHA, pricing_snapshot_ref: "price-1",
  };
  return {
    ...ids,
    stage_index: stage,
    stage_request_sha256: SHA,
    stage_request_json: JSON.stringify({ protocol: "x", stage }),
    intent_revision: 1,
    intent_json: JSON.stringify({
      intent_ref: { id: ids.intent_id, revision: 1 }, principal_ref: ids.principal_ref,
      policy_decision_ref: ids.policy_decision_ref, budget_reservation_ref: ids.reservation_id,
      operation_kind: "research.run",
    }),
    quote_json: JSON.stringify({
      quote_ref: ids.quote_ref, reservation_id: ids.reservation_id,
      operation_kind: "research.run", expires_at: QUOTE_EXP,
    }),
    authority_json: JSON.stringify({
      principal_ref: ids.principal_ref, client_class: "owner_pwa",
      credential_generation: "cg-1", deployment_generation: "dg-1",
      policy_decision_ref: ids.policy_decision_ref, policy_generation: ids.policy_generation,
      currentness_digest: SHA,
      scope_snapshot_ref: { id: ids.scope_snapshot_id, revision: 1 }, expires_at: QUOTE_EXP,
    }),
    client_class: "owner_pwa", credential_generation: "cg-1", deployment_generation: "dg-1",
    currentness_digest: SHA, scope_snapshot_revision: 1,
    expected_deployment_json: JSON.stringify(deployment),
    approval_json: JSON.stringify({
      protocol: "eliotr.research-model-spend-approval.v1", approved: 1,
      authorization_ref: ids.authorization_ref, decision_digest: SHA,
      policy_decision_ref: ids.policy_decision_ref, policy_generation: ids.policy_generation,
      currentness_digest: SHA, expires_at: EXPIRES,
      expected_deployment: deployment,
    }),
    admission_revision: 1, admission_sha256: SHA, decision_digest: SHA,
    max_input_bytes: 100, max_output_bytes: 100,
    expires_at: EXPIRES, created_at: CREATED, role,
  };
}
const COLUMNS = Object.keys(makeRow(12, null, "probe"));

function insertRow(db: DatabaseSync, stage: number, role: string | null, suffix: string): void {
  const r = makeRow(stage, role, suffix);
  db.prepare(
    `INSERT INTO research_model_spend_admission (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`,
  ).run(...COLUMNS.map((c) => r[c] as SQLInputValue));
}

function tryInsert(db: DatabaseSync, stage: number, role: string | null, suffix: string): boolean {
  try {
    insertRow(db, stage, role, suffix);
    return true;
  } catch {
    return false;
  }
}

const GUARD_TRIGGERS = [
  "research_model_spend_admission_shape_guard",
  "research_model_spend_admission_w2_guard",
  "research_model_spend_admission_deployment_guard",
];

function tableSql(db: DatabaseSync): string {
  return (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='research_model_spend_admission'",
  ).get() as { sql: string }).sql;
}

describe("0096 research_model_spend_admission branch stages", () => {
  it("applies the full migration chain and widens the stage CHECK", { timeout: 120_000 }, () => {
    const db = freshDb();
    try {
      const sql = tableSql(db);
      expect(sql).toContain("CHECK(stage_index IN (8, 9, 12, 13, 14))");
      expect(sql).not.toContain("CHECK(stage_index IN (12, 13, 14))");
      expect(sql).toContain("role TEXT CHECK");
      expect(sql).toContain(") STRICT");
      expect(sql).toContain("PRIMARY KEY(operation_id, stage_index)");
    } finally {
      db.close();
    }
  });

  it("recreates all triggers, the lookup index, and leaves no staging objects", { timeout: 120_000 }, () => {
    const db = freshDb();
    try {
      const triggers = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='research_model_spend_admission' ORDER BY name",
      ).all() as { name: string }[];
      expect(triggers.map((t) => t.name)).toEqual([
        "research_model_spend_admission_deployment_guard",
        "research_model_spend_admission_immutable",
        "research_model_spend_admission_no_delete",
        "research_model_spend_admission_shape_guard",
        "research_model_spend_admission_w2_guard",
      ]);
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='research_model_spend_admission' AND name NOT LIKE 'sqlite_%'",
      ).all() as { name: string }[];
      expect(indexes.map((i) => i.name)).toEqual(["research_model_spend_admission_lookup_idx"]);
      const staging = db.prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE '%_research_model_spend_admission_0095%' OR name LIKE '%_0096_admission_copy_guard%'",
      ).all();
      expect(staging).toEqual([]);
      const w2 = (db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='research_model_spend_admission_w2_guard'",
      ).get() as { sql: string }).sql;
      expect(w2).toContain("WHEN 8 THEN 'ANALYZE_BRANCHES'");
      expect(w2).toContain("WHEN 9 THEN 'COUNTER_SEARCH'");
      expect(w2).toContain("WHEN 12 THEN 'SYNTHESIZE'");
      expect(w2).toContain("WHEN 13 THEN 'VERIFY'");
      expect(w2).toContain("WHEN 14 THEN 'AUDIT_CLAIMS'");
    } finally {
      db.close();
    }
  });

  it("rejects stage 8 before 0096 (the repaired defect)", { timeout: 120_000 }, () => {
    const db = freshDb("0095_research_model_spend_admission_role.sql");
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const t of GUARD_TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
      expect(tryInsert(db, 8, "SUPPORT", "pre8")).toBe(false);
      expect(tryInsert(db, 12, null, "pre12")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("preserves pre-0096 rows byte-identical across the rebuild", { timeout: 120_000 }, () => {
    const db = freshDb("0095_research_model_spend_admission_role.sql");
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const t of GUARD_TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
      insertRow(db, 12, null, "legacy12");
      insertRow(db, 13, null, "legacy13");
      insertRow(db, 14, null, "legacy14");
      // Restore the guards from their canonical migration text so the
      // pre-0096 DB is trigger-complete before the rebuild runs.
      db.exec(triggerSql("0046_research_model_spend_admission.sql", "research_model_spend_admission_shape_guard"));
      db.exec(triggerSql("0084_d1_authority_expression_depth.sql", "research_model_spend_admission_w2_guard"));
      db.exec(triggerSql("0057_model_spend_renewed_qualification.sql", "research_model_spend_admission_deployment_guard"));
      const before = db.prepare("SELECT * FROM research_model_spend_admission ORDER BY stage_index").all();
      expect(before).toHaveLength(3);
      db.exec(readFileSync(resolve(MIGRATIONS, "0096_research_model_spend_admission_branch_stages.sql"), "utf8"));
      const after = db.prepare("SELECT * FROM research_model_spend_admission ORDER BY stage_index").all();
      expect(after).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("enforces the stage/role matrix after 0096", { timeout: 120_000 }, () => {
    const db = freshDb("0095_research_model_spend_admission_role.sql");
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const t of GUARD_TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
      db.exec(triggerSql("0046_research_model_spend_admission.sql", "research_model_spend_admission_shape_guard"));
      db.exec(triggerSql("0084_d1_authority_expression_depth.sql", "research_model_spend_admission_w2_guard"));
      db.exec(triggerSql("0057_model_spend_renewed_qualification.sql", "research_model_spend_admission_deployment_guard"));
      db.exec(readFileSync(resolve(MIGRATIONS, "0096_research_model_spend_admission_branch_stages.sql"), "utf8"));
      // Test-only isolation for CHECK semantics; authority logic is orthogonal.
      db.exec("PRAGMA foreign_keys = OFF");
      for (const t of GUARD_TRIGGERS) db.exec(`DROP TRIGGER ${t}`);
      // Branch stages require a role.
      expect(tryInsert(db, 8, "SUPPORT", "m8s")).toBe(true);
      expect(tryInsert(db, 8, "COUNTER", "m8c")).toBe(true);
      expect(tryInsert(db, 9, "SUPPORT", "m9s")).toBe(true);
      expect(tryInsert(db, 9, "COUNTER", "m9c")).toBe(true);
      // Non-branch stages never carry a role.
      expect(tryInsert(db, 12, null, "m12")).toBe(true);
      expect(tryInsert(db, 13, null, "m13")).toBe(true);
      expect(tryInsert(db, 14, null, "m14")).toBe(true);
      // Negatives: missing role on branch stages, role on other stages,
      // and stages outside the admitted set.
      expect(tryInsert(db, 8, null, "n8")).toBe(false);
      expect(tryInsert(db, 9, null, "n9")).toBe(false);
      expect(tryInsert(db, 12, "SUPPORT", "n12")).toBe(false);
      expect(tryInsert(db, 13, "COUNTER", "n13")).toBe(false);
      expect(tryInsert(db, 14, "SUPPORT", "n14")).toBe(false);
      expect(tryInsert(db, 7, null, "n7")).toBe(false);
      expect(tryInsert(db, 10, "SUPPORT", "n10")).toBe(false);
      expect(tryInsert(db, 15, null, "n15")).toBe(false);
    } finally {
      db.close();
    }
  });
});
