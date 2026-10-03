import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = await readFile(new URL("../infra/d1/core/migrations/0083_research_runtime_failures.sql", import.meta.url), "utf8");
const shapeNames = ["research_workflow_first_failure_json_shape", "research_workflow_latest_failure_json_shape",
  "research_workflow_attempt_failure_shape"];
const shapes = shapeNames.map((name) => {
  const match = migration.match(new RegExp(`^CREATE TRIGGER ${name}\\b[\\s\\S]*?^END;`, "mu"));
  assert.ok(match, `Missing shape trigger: ${name}`);
  return match[0];
});

// D1 /query rejects bare CASE..END in these bodies although SQLite accepts it.
// The production read-only EXPLAIN contrast is recorded in the operator receipt.
// Guard the supported spelling separately from testing the SQL predicates below.
function caseExpressions(sql) {
  const tokens = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\bCASE\b/giu;
  return [...sql.matchAll(tokens)].filter((match) => /^CASE$/iu.test(match[0])).map((match) => ({
    parenthesized: sql.slice(0, match.index).trimEnd().endsWith("("),
  }));
}

test("the three /query failure shapes parenthesize outer and nested CASE expressions", () => {
  assert.deepEqual(shapes.map((sql) => caseExpressions(sql).length), [3, 3, 4]);
  for (const sql of shapes) assert.ok(caseExpressions(sql).every((expression) => expression.parenthesized));
  const reportedFailure = "CREATE TRIGGER t AFTER INSERT ON demo BEGIN SELECT CASE WHEN 1 THEN 1 END; END;";
  assert.equal(caseExpressions(reportedFailure)[0].parenthesized, false);
  assert.equal(caseExpressions("SELECT 'CASE', (CASE WHEN 1 THEN 1 END)")[0].parenthesized, true);
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE research_workflow_run (
    operation_id TEXT PRIMARY KEY, first_failure_json TEXT, latest_failure_json TEXT);
  CREATE TABLE research_workflow_attempt (
    attempt_ref TEXT PRIMARY KEY, first_failure_json TEXT, request_json TEXT NOT NULL);`);
  for (const sql of shapes) db.exec(sql);
  db.prepare("INSERT INTO research_workflow_run(operation_id) VALUES(?)").run("run-fixture");
  db.prepare("INSERT INTO research_workflow_attempt(attempt_ref,request_json) VALUES(?,?)")
    .run("attempt-fixture", JSON.stringify({ stage: "SYNTHESIZE" }));
  return db;
}

const stage = { code: "MODEL_GATEWAY_RESPONSE_INVALID", phase: "STAGE", stage: "SYNTHESIZE", retryable: false };
const preparation = { code: "WORKFLOW_STORAGE_UNAVAILABLE", phase: "PREPARATION", retryable: true };
const runCases = [
  ["preparation storage retry", preparation, true],
  ["stage diagnostic", stage, true],
  ["recovery diagnostic", { ...stage, phase: "RECOVERY" }, true],
  ["unknown field", { ...stage, diagnostic: "unadmitted" }, false],
  ["unknown code", { ...stage, code: "UNADMITTED_CODE" }, false],
  ["stage cannot grant retry", { ...stage, retryable: true }, false],
  ["retry requires preparation storage failure", { ...preparation, code: "WORKFLOW_CONFLICT" }, false],
  ["preparation cannot carry a stage", { ...preparation, stage: "SYNTHESIZE" }, false],
  ["boolean type required", { ...stage, retryable: "false" }, false],
  ["stage required", { code: stage.code, phase: "STAGE", retryable: false }, false],
];

test("run first/latest shapes preserve valid metadata and deny unapproved metadata atomically", () => {
  for (const column of ["first_failure_json", "latest_failure_json"]) {
    for (const [label, payload, allowed] of runCases) {
      const db = fixture();
      try {
        const bytes = JSON.stringify(payload);
        const update = () => db.prepare(`UPDATE research_workflow_run SET ${column}=? WHERE operation_id=?`)
          .run(bytes, "run-fixture");
        if (allowed) update();
        else assert.throws(update, /WORKFLOW_CONFLICT/u, `${column}: ${label}`);
        const readback = db.prepare(`SELECT ${column} AS value FROM research_workflow_run WHERE operation_id=?`)
          .get("run-fixture");
        assert.equal(readback.value, allowed ? bytes : null, `${column}: ${label}`);
      } finally { db.close(); }
    }
  }
});

test("attempt shape binds diagnostic phase and stage to its existing request", () => {
  const cases = [
    ["matching stage", stage, true],
    ["matching recovery", { ...stage, phase: "RECOVERY" }, true],
    ["preparation cannot enter an attempt", preparation, false],
    ["other valid stage cannot enter this attempt", { ...stage, stage: "PLAN" }, false],
    ["unknown field", { ...stage, extra: 1 }, false],
    ["unknown code", { ...stage, code: "UNADMITTED_CODE" }, false],
    ["retry authority cannot be introduced", { ...stage, retryable: true }, false],
    ["stage cannot be omitted", { code: stage.code, phase: "STAGE", retryable: false }, false],
  ];
  for (const [label, payload, allowed] of cases) {
    const db = fixture();
    try {
      const bytes = JSON.stringify(payload);
      const update = () => db.prepare("UPDATE research_workflow_attempt SET first_failure_json=? WHERE attempt_ref=?")
        .run(bytes, "attempt-fixture");
      if (allowed) update();
      else assert.throws(update, /WORKFLOW_CONFLICT/u, label);
      assert.equal(db.prepare("SELECT first_failure_json AS value FROM research_workflow_attempt WHERE attempt_ref=?")
        .get("attempt-fixture").value, allowed ? bytes : null, label);
    } finally { db.close(); }
  }
});
