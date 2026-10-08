import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { extractSourceText } from "../../infra/d1/extract-application-sql.mjs";

// Permanent source UPDATE-OF regression fixture. Run with `node` from repo root.
// It delegates compilation to the existing extractor and check-expression-depth.py functions;
// it does not implement a second SQL compiler or copy a production migration.
const checker = fileURLToPath(new URL("../../infra/d1/check-expression-depth.py", import.meta.url));
const fixtureSource = String.raw`
const targetSql = "UPDATE update_of_probe SET target=target WHERE 0";
const otherSql = "UPDATE update_of_probe SET other=other WHERE 0";

export function fixture(env) {
  env.CORE_DB.prepare(targetSql).bind();
  env.CORE_DB.prepare(otherSql).bind();
}
`;
const fixtureFile = fileURLToPath(new URL("./update-of-source.ts", import.meta.url));
const extracted = extractSourceText(fixtureSource, fixtureFile);
assert.equal(extracted.unresolved.length, 0);
assert.equal(extracted.queries.length, 2);
assert.deepEqual(extracted.queries.map(({ sql }) => sql), [
  "UPDATE update_of_probe SET target=target WHERE 0",
  "UPDATE update_of_probe SET other=other WHERE 0",
]);
assert.deepEqual(extracted.queries.map(({ bindingArity }) => bindingArity), [0, 0]);

const python = String.raw`
import json
import runpy
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

checker = sys.argv[1]
payload = json.loads(sys.stdin.read())
namespace = runpy.run_path(checker, run_name="update_of_source_coverage_fixture")
calibrate = namespace["calibrate"]
connection = namespace["connection"]
columns = namespace["columns"]
explain = namespace["explain"]
write_shapes = namespace["write_shapes"]
valid_application_sql_entry = namespace["valid_application_sql_entry"]
recovered = payload["queries"]
assert len(recovered) == 2
assert all(valid_application_sql_entry(query) for query in recovered)

# Existing calibration proves this SQLite build reports expression-depth overflow at 100.
calibrate()

deep_when = " OR ".join(f"NEW.target={value}" for value in range(120))
migration = f"""
CREATE TABLE update_of_probe (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL,
  other TEXT NOT NULL
);
CREATE TRIGGER update_of_probe_target_guard
AFTER UPDATE OF target ON update_of_probe
WHEN {deep_when}
BEGIN
  SELECT 1;
END;
"""

def category(query):
    try:
        # Preserve the extractor's SQL and binding arity unchanged.
        explain(db, query["sql"], query["bindingArity"])
    except sqlite3.Error as error:
        return namespace["category"](error)
    return "OK"

# Use an explicit base and verify the recursive cleanup target is its expected child before
# removal. Trigger creation is above the production probe limit; statement compilation is at 100.
base = Path(tempfile.mkdtemp(prefix="d1-update-of-base-")).resolve()
target = (base / "fixture").resolve()
db = None
try:
    target.mkdir()
    db = connection(1000)
    migration_path = target / "0001_update_of_source.sql"
    migration_path.write_text(migration, encoding="utf-8")
    db.executescript(migration_path.read_text(encoding="utf-8"))
    actual_columns = columns(db, "update_of_probe")
    assert actual_columns == ["id", "target", "other"]

    trigger_sql = db.execute(
        "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",
        ("update_of_probe_target_guard",),
    ).fetchone()[0]
    assert "UPDATE OF target ON update_of_probe" in trigger_sql

    shapes = dict(write_shapes("update_of_probe", actual_columns, {"UPDATE"}))
    generic = shapes["UPDATE_ALL"]
    expected_generic = (
        'UPDATE "update_of_probe" SET '
        + ",".join(f'"{name}"="{name}"' for name in actual_columns)
        + " WHERE 0"
    )
    assert generic == expected_generic
    assert shapes["UPDATE_FIRST"] == 'UPDATE "update_of_probe" SET "id"="id" WHERE 0'

    db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
    assert db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) == 100

    # The recovered source UPDATE is column-sensitive: UPDATE OF target is selected and
    # its deep WHEN expression fails at the configured limit.
    assert category(recovered[0]) == "EXPRESSION_DEPTH_EXCEEDED"
    # An UPDATE of an unrelated column does not select the UPDATE OF target trigger.
    assert category(recovered[1]) == "OK"
    # The existing generic all-column probe selects the same trigger and fails.
    assert category({"sql": generic, "bindingArity": 0}) == "EXPRESSION_DEPTH_EXCEEDED"
    # The first-column probe is derived from actual schema order and does not select it.
    assert category({"sql": shapes["UPDATE_FIRST"], "bindingArity": 0}) == "OK"
finally:
    if db is not None:
        db.close()
    resolved_target = target.resolve(strict=False)
    resolved_base = base.resolve(strict=False)
    assert resolved_target.parent == resolved_base
    if resolved_target.exists():
        shutil.rmtree(resolved_target)
    assert not resolved_target.exists()
    if resolved_base.exists():
        resolved_base.rmdir()
    assert not resolved_base.exists()

print("UPDATE_OF_SOURCE_COVERAGE_FIXTURE PASS extractor=2 source_column_sensitive=1 generic_from_actual_schema=1 unrelated_column=not_selected depth=100")
`;

const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", python, checker], {
  cwd: fileURLToPath(new URL("../..", import.meta.url)),
  input: JSON.stringify({ queries: extracted.queries }),
  encoding: "utf8",
  shell: false,
  timeout: 15_000,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr);
process.stdout.write(result.stdout);
