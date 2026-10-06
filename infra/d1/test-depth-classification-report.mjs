import assert from "node:assert/strict";
import console from "node:console";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const secretMarker = "CLASSIFICATION_FIXTURE_SECRET_SQL_RECEIVER";
const recovered = Array.from({ length: 37 }, (_, index) => ({
  location: index < 3
    ? `packages/research/model-resolved-site-${index}.ts:${index + 1}`
    : `packages/d1-fixture/recovered-${index}.ts:${index + 1}`,
  sql: `SELECT '${secretMarker}'`,
  receiver: `db.${secretMarker}`,
  targetStore: index % 2 === 0 ? "core" : "search",
  targetStatus: "resolved-direct-binding",
  bindingArity: index % 4,
  bindingProvenance: "direct-bind",
}));
const unresolved = Array.from({ length: 43 }, (_, index) => ({
  location: `packages/d1-fixture/unresolved-${index}.ts:${index + 1}`,
  receiver: `db.${secretMarker}`,
  targetStore: index % 2 === 0 ? "unknown" : "core",
  targetStatus: index % 2 === 0 ? "unresolved-receiver" : "resolved-direct-binding",
  bindingArity: index % 3 === 0 ? null : 2,
  bindingProvenance: index % 3 === 0 ? "dynamic-bind-arguments" : "direct-bind",
  classification: ["missing-prepare-argument", "dynamic-or-unresolved-sql", "static-unrecognized-sql"][index % 3],
  reason: index === 42 ? secretMarker : [
    "missing-prepare-argument",
    "dynamic-or-unresolved",
    "non-sql-prepare-argument",
  ][index % 3],
}));
const inventory = {
  queries: recovered,
  unresolved,
  reportedUnresolved: unresolved.slice(0, 30),
  scannedFiles: 812,
  excludedFixtureFiles: ["tests/fixture-one.ts", "tests/fixture-two.ts"],
  strictTargetQualification: true,
  privateMarker: secretMarker,
};
const statuses = recovered.map((query) => query.targetStore === "core"
  ? ["OK", "SQL_COMPILE_FAILED"]
  : ["SQL_COMPILE_FAILED", "OK"]);

const harness = String.raw`
import copy
import io
import json
import os
import runpy
import sqlite3
import sys

payload = json.loads(sys.stdin.read())
namespace = runpy.run_path(sys.argv[1], run_name="classification_fixture")
before = copy.deepcopy(payload)

def forbidden_compiler(*args, **kwargs):
    raise AssertionError("compiler was invoked by the report fixture")

namespace["sqlite3"].connect = forbidden_compiler
emit = namespace["emit_classification_details"]
os.environ.pop("D1_DEPTH_CLASSIFICATION_DETAILS", None)
default_output = io.StringIO()
assert emit(payload["inventory"], payload["statuses"], default_output) is False
assert default_output.getvalue() == ""

os.environ["D1_DEPTH_CLASSIFICATION_DETAILS"] = "1"
opt_in_output = io.StringIO()
assert emit(payload["inventory"], payload["statuses"], opt_in_output) is True
assert payload == before
sys.stdout.write(opt_in_output.getvalue())
`;

const compiler = process.platform === "win32"
  ? [["python", []], ["py", ["-3"]], ["python3", []]]
  : [["python3", []], ["python", []]];
const script = fileURLToPath(new URL("./check-expression-depth.py", import.meta.url));
let result;
for (const [command, prefix] of compiler) {
  result = spawnSync(command, [...prefix, "-c", harness, script], {
    input: JSON.stringify({ inventory, statuses }),
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (result.error?.code === "ENOENT") continue;
  break;
}
assert.ok(result, "Python >=3.11 is required for the focused report fixture");
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr);

const lines = result.stdout.trimEnd().split(/\r?\n/);
assert.equal(lines.length, 1, "opt-in report must emit one JSON record");
const record = JSON.parse(lines[0]);
assert.equal(record.recordType, "D1_DEPTH_CLASSIFICATION_DETAILS");
assert.equal(record.strictTargetQualification, true);
assert.equal(record.strictQualificationPass, false);
assert.equal(record.scannedFiles, 812);
assert.equal(record.counts.recoveredQueries, recovered.length);
assert.equal(record.counts.unresolvedSites, unresolved.length);
assert.equal(record.recovered.length, recovered.length);
assert.equal(record.unresolved.length, unresolved.length);
assert.equal(record.unresolved[0].reason, "missing-prepare-argument");
assert.equal(record.unresolved[1].reason, "dynamic-or-unresolved");
assert.equal(record.unresolved[2].reason, "non-sql-prepare-argument");
assert.equal(record.unresolved[42].reason, "unrecognized-reason");
assert.equal(JSON.stringify(record).includes(secretMarker), false);

const forbiddenKeys = new Set(["sql", "receiver"]);
function assertWhitelistedKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertWhitelistedKeys(item);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `private field leaked: ${key}`);
      assertWhitelistedKeys(child);
    }
  }
}
assertWhitelistedKeys(record);
console.log("D1_DEPTH_CLASSIFICATION_FIXTURE PASS recovered=37 unresolved=43 default=unchanged opt_in=one_record compiler=not_invoked");
