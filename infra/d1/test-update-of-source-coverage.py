import json
import re
import runpy
import sqlite3
import sys
from pathlib import Path

checker = Path(__file__).with_name("check-expression-depth.py")
query = json.loads(sys.stdin.read())
namespace = runpy.run_path(checker, run_name="production_update_of_coverage")
calibrate = namespace["calibrate"]
connection = namespace["connection"]
columns = namespace["columns"]
explain = namespace["explain"]
write_shapes = namespace["write_shapes"]
valid_application_sql_entry = namespace["valid_application_sql_entry"]
category = namespace["category"]

assert valid_application_sql_entry(query)
assert query["targetStore"] == "unknown"
assert query["bindingArity"] == 11
assert query["targetBindingEvidence"]["exhaustive"] is False
assert any(path["targetStore"] == "core" for path in query["targetBindingEvidence"]["paths"])

root = Path(__file__).resolve().parents[2]
databases = {}
migration_counts = {}
try:
    calibrate()
    for store in ("core", "search"):
        migrations = sorted((root / "infra" / "d1" / store / "migrations").glob("*.sql"))
        assert migrations, f"{store} migrations must exist"
        db = connection(100)
        databases[store] = db
        for migration in migrations:
            db.executescript(migration.read_text(encoding="utf-8"))
        migration_counts[store] = len(migrations)

    core = databases["core"]
    search = databases["search"]
    target = "research_workflow_run"
    required = {
        "research_workflow_first_failure_json_shape",
        "research_workflow_latest_failure_json_shape",
        "research_workflow_failure_history_shape",
        "research_workflow_failure_history_alignment",
    }
    trigger_sql = {
        name: sql for name, sql in core.execute(
            "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=?",
            (target,),
        )
    }
    assert required.issubset(trigger_sql)
    assert "UPDATE OF first_failure_json" in trigger_sql["research_workflow_first_failure_json_shape"]
    assert "UPDATE OF latest_failure_json" in trigger_sql["research_workflow_latest_failure_json_shape"]
    assert core.execute(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
        (target,),
    ).fetchone() is not None
    assert search.execute(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
        (target,),
    ).fetchone() is None

    # EXPLAIN compiles the extracted production SQL and exposes the selected trigger
    # subprograms; it never executes a product UPDATE or reads product rows.
    rows = explain(core, query["sql"], query["bindingArity"], capture_rows=True)
    selected = {
        match.group(1)
        for row in rows
        for cell in row
        if isinstance(cell, str)
        for match in re.finditer(r"-- TRIGGER ([A-Za-z_][A-Za-z_0-9]*)", cell)
    }
    assert required.issubset(selected), f"production UPDATE did not select all column guards: {selected}"

    actual_columns = columns(core, target)
    unrelated = next(
        sql for kind, sql in write_shapes(target, actual_columns, {"UPDATE"})
        if kind == "UPDATE_FIRST"
    )
    assignment = unrelated.split(" SET ", 1)[1].split(" WHERE ", 1)[0]
    assert not any(column in assignment
                   for column in ("first_failure_json", "latest_failure_json", "failure_history_json"))
    unrelated_rows = explain(core, unrelated, 0, capture_rows=True)
    unrelated_selected = {
        match.group(1)
        for row in unrelated_rows
        for cell in row
        if isinstance(cell, str)
        for match in re.finditer(r"-- TRIGGER ([A-Za-z_][A-Za-z_0-9]*)", cell)
    }
    assert required.isdisjoint(unrelated_selected), "unrelated-column UPDATE selected failure JSON guards"

    try:
        explain(search, query["sql"], query["bindingArity"])
    except sqlite3.Error as error:
        assert category(error) == "SQL_COMPILE_FAILED"
    else:
        raise AssertionError("Search schema unexpectedly compiled the Core Workflow UPDATE")
finally:
    for db in databases.values():
        db.close()

print(
    "UPDATE_OF_PRODUCTION_SOURCE_COVERAGE PASS "
    f"source={query['location']} arity={query['bindingArity']} target=unknown "
    f"bounded_core_path=1 core_migrations={migration_counts['core']} "
    f"search_migrations={migration_counts['search']} selected_guards=4 unrelated_guards=0"
)
