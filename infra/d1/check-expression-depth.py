"""Compile repository D1 schema and recovered application SQL; never execute probe writes."""
from pathlib import Path
import json
import os
import re
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
DEPTH = 100
STORES = ("core", "search")
BINDING_PROVENANCES = frozenset({"direct-bind", "dynamic-bind-arguments", "direct-no-bind",
                                "indirect-or-unknown", "varies-by-invocation"})
DIRECT_TARGET_STATUS = "resolved-direct-binding"
LOCAL_ALIAS_TARGET_STATUS = "resolved-local-const-alias"
UNKNOWN_TARGET_STATUS = "unresolved-receiver"
DETAIL_REASONS = frozenset({"missing-prepare-argument", "dynamic-or-unresolved", "non-sql-prepare-argument"})
DETAIL_PREPARE_DECLARATION_KINDS = frozenset({
    "workers-d1-database",
    "workers-d1-session",
    "resolved-non-canonical",
    "unresolved",
    "unknown-no-shared-program",
})


def quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def category(error: sqlite3.Error) -> str:
    # Never print arbitrary SQL, row data, a provider response or an exception payload.
    if "expression tree is too large" in str(error).lower():
        return "EXPRESSION_DEPTH_EXCEEDED"
    message = str(error).lower()
    if ("incorrect number of bindings" in message
            or re.search(r"statement uses \d+, and there are \d+ supplied", message)
            or "did not supply a value for binding parameter" in message):
        return "SQL_BINDING_ARITY_MISMATCH"
    return "SQL_COMPILE_FAILED"


def valid_arity(value: object) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 0)


def valid_target_binding_evidence(value: object) -> bool:
    if value is None:
        return True
    if (not isinstance(value, dict) or set(value) != {"coverage", "exhaustive", "paths"}
            or value["coverage"] != "positive-paths-only" or value["exhaustive"] is not False
            or not isinstance(value["paths"], list) or not 1 <= len(value["paths"]) <= 8):
        return False
    for path in value["paths"]:
        if (not isinstance(path, dict) or set(path) != {"targetStore", "callsites"}
                or path["targetStore"] not in STORES or not isinstance(path["callsites"], list)
                or not 1 <= len(path["callsites"]) <= 12):
            return False
        if any(not isinstance(site, str) or not re.fullmatch(r"[^\s:]+(?:/[^\s:]+)*:\d+", site)
               for site in path["callsites"]):
            return False
    return True


def valid_binding(site: object) -> bool:
    if not isinstance(site, dict):
        return False
    target = site.get("targetStore")
    target_status = site.get("targetStatus")
    if target in STORES:
        if target_status not in (DIRECT_TARGET_STATUS, LOCAL_ALIAS_TARGET_STATUS):
            return False
    elif target == "unknown":
        if target_status != UNKNOWN_TARGET_STATUS:
            return False
    else:
        return False
    provenance = site.get("bindingProvenance")
    return (isinstance(site.get("receiver"), str)
            and valid_arity(site.get("bindingArity"))
            and isinstance(provenance, str) and provenance in BINDING_PROVENANCES
            and valid_target_binding_evidence(site.get("targetBindingEvidence")))


def valid_application_sql_entry(site: object, unresolved: bool = False) -> bool:
    if not isinstance(site, dict) or not isinstance(site.get("location"), str) or not valid_binding(site):
        return False
    if not unresolved:
        return isinstance(site.get("sql"), str)
    classification = site.get("classification")
    return (isinstance(site.get("reason"), str)
            and isinstance(classification, str)
            and classification in {"missing-prepare-argument", "dynamic-or-unresolved-sql", "static-unrecognized-sql"})


def detail_prepare_declaration_kind(site: object) -> str:
    """Project only the closed declaration-kind vocabulary into diagnostics."""
    if not isinstance(site, dict) or "prepareDeclarationKind" not in site:
        return "unknown-no-shared-program"
    value = site["prepareDeclarationKind"]
    return (value if isinstance(value, str) and value in DETAIL_PREPARE_DECLARATION_KINDS
            else "unrecognized-declaration-kind")


def connection(depth: int = DEPTH) -> sqlite3.Connection:
    # A previously cached statement could otherwise bypass recompilation after setlimit.
    db = sqlite3.connect(":memory:", cached_statements=0)
    db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, depth)
    if db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) != depth:
        db.close()
        raise RuntimeError("LIMIT_UNAVAILABLE")
    return db


def calibrate() -> None:
    """Prove this compiler distinguishes a deep trigger from an ordinary INSERT."""
    db = connection(1000)
    try:
        db.execute("CREATE TABLE depth_probe(value INTEGER)")
        predicates = " OR ".join(f"NEW.value={value}" for value in range(120))
        db.execute("CREATE TRIGGER depth_probe_guard AFTER INSERT ON depth_probe "
                   f"WHEN {predicates} BEGIN SELECT 1; END")
        sql = "EXPLAIN INSERT INTO depth_probe SELECT NULL WHERE 0"
        db.execute(sql).close()
        db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, DEPTH)
        if db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) != DEPTH:
            raise RuntimeError("LIMIT_UNAVAILABLE")
        try:
            db.execute(sql).close()
        except sqlite3.Error as error:
            if category(error) != "EXPRESSION_DEPTH_EXCEEDED":
                raise RuntimeError("CALIBRATION_FAILED") from None
        else:
            raise RuntimeError("CALIBRATION_FAILED")
        db.execute("DROP TRIGGER depth_probe_guard")
        db.execute(sql).close()
        try:
            explain(db, "SELECT * FROM __d1_depth_negative_probe__")
        except sqlite3.Error as error:
            if category(error) != "SQL_COMPILE_FAILED":
                raise RuntimeError("NEGATIVE_COMPILER_CALIBRATION_FAILED") from None
        else:
            raise RuntimeError("NEGATIVE_COMPILER_CALIBRATION_FAILED")
    finally:
        db.close()


def columns(db: sqlite3.Connection, name: str) -> list[str]:
    # Hidden/generated columns cannot be INSERTed/UPDATEd explicitly.
    return [row[1] for row in db.execute(f"PRAGMA table_xinfo({quoted(name)})") if row[6] == 0]


def explain(
    db: sqlite3.Connection,
    sql: str,
    binding_arity: int | None = None,
    capture_rows: bool = False,
) -> list[tuple] | None:
    """Compile with inert bindings, optionally enforcing the source .bind() arity."""
    statement = "EXPLAIN " + sql
    if binding_arity is not None:
        try:
            cursor = db.execute(statement, (None,) * binding_arity)
        except sqlite3.ProgrammingError as error:
            message = str(error)
            # Recent Python versions require mappings for named SQLite parameters.
            # Permit that form only when its distinct names account for the known
            # positional D1 binding arity; otherwise preserve the arity failure.
            if "named placeholders" in message or "named placeholder" in message:
                names = set(re.findall(r"(?<![\w])[:@$]([A-Za-z_][A-Za-z_0-9]*)", sql))
                if names and len(names) == binding_arity:
                    cursor = db.execute(statement, {name: None for name in names})
                else:
                    raise
            else:
                raise
        if capture_rows:
            return cursor.fetchall()
        cursor.close()
        return None
    try:
        cursor = db.execute(statement)
    except sqlite3.ProgrammingError as error:
        message = str(error)
        positional = re.search(r"statement uses (\d+), and there are 0 supplied", message)
        if positional:
            cursor = db.execute(statement, (None,) * int(positional[1]))
        elif "You did not supply a value for binding parameter" in message:
            names = set(re.findall(r"(?<![\w])[\:@$]([A-Za-z_][A-Za-z_0-9]*)", sql))
            if names:
                cursor = db.execute(statement, {name: None for name in names})
            else:
                raise
        else:
            raise
    if capture_rows:
        return cursor.fetchall()
    cursor.close()
    return None


def write_shapes(name: str, names: list[str], operations: set[str]):
    target = quoted(name)
    fields = ",".join(quoted(field) for field in names)
    if "INSERT" in operations:
        values = ",".join("NULL" for _ in names)
        yield "INSERT", f"INSERT INTO {target} ({fields}) SELECT {values} WHERE 0"
    if "UPDATE" in operations:
        field = quoted(names[0])
        yield "UPDATE_FIRST", f"UPDATE {target} SET {field}={field} WHERE 0"
        # Activate UPDATE OF triggers for every writable column, not only the first.
        assignments = ",".join(f"{quoted(field)}={quoted(field)}" for field in names)
        yield "UPDATE_ALL", f"UPDATE {target} SET {assignments} WHERE 0"
    if "DELETE" in operations:
        yield "DELETE", f"DELETE FROM {target} WHERE 0"


def check_store(store: str, application_queries: list[dict], application_status: list[list[str]]) -> tuple[int, int]:
    directory = ROOT / "infra" / "d1" / store / "migrations"
    migrations = sorted(directory.glob("*.sql"))
    if not migrations:
        raise RuntimeError("MIGRATIONS_MISSING")
    db = connection()
    failures = 0
    statements = 0
    try:
        # Set the limit before applying migrations; migration SQL is checked too.
        for path in migrations:
            try:
                db.executescript(path.read_text(encoding="utf-8"))
            except sqlite3.Error as error:
                print(f"FAIL {store} migration={path.name} {category(error)}")
                return 0, 1
        objects = dict(db.execute("SELECT name,type FROM sqlite_schema WHERE type IN ('table','view')"))
        triggers = db.execute("SELECT tbl_name,sql FROM sqlite_schema WHERE type='trigger'").fetchall()
        tables = sorted({name for name, _ in triggers if objects.get(name) == "table"})
        views = sorted(name for name, kind in objects.items() if kind == "view")
        writable_views: dict[str, set[str]] = {}
        for name, sql in triggers:
            if objects.get(name) != "view":
                continue
            match = re.search(r"\bINSTEAD\s+OF\s+(INSERT|UPDATE|DELETE)\b", sql, re.IGNORECASE)
            if match is None:
                raise RuntimeError("UNKNOWN_VIEW_TRIGGER")
            writable_views.setdefault(name, set()).add(match[1].upper())

        def compile_shape(name: str, kind: str, sql: str) -> None:
            nonlocal statements, failures
            statements += 1
            try:
                explain(db, sql)
            except sqlite3.Error as error:
                failures += 1
                print(f"FAIL {store} object={name} shape={kind} {category(error)}")

        for name in tables:
            fields = columns(db, name)
            if not fields:
                raise RuntimeError("WRITABLE_COLUMNS_MISSING")
            for kind, sql in write_shapes(name, fields, {"INSERT", "UPDATE", "DELETE"}):
                compile_shape(name, kind, sql)
        for name in views:
            compile_shape(name, "SELECT", f"SELECT * FROM {quoted(name)}")
        for name, operations in sorted(writable_views.items()):
            fields = columns(db, name)
            if not fields:
                raise RuntimeError("WRITABLE_COLUMNS_MISSING")
            for kind, sql in write_shapes(name, fields, operations):
                compile_shape(name, "VIEW_" + kind, sql)
        store_app_successes = 0
        for index, query in enumerate(application_queries):
            try:
                explain(db, query["sql"], query["bindingArity"])
                application_status[index].append("OK")
                store_app_successes += 1
            except sqlite3.Error as error:
                failure = category(error)
                application_status[index].append(failure)
        rejected = len(application_queries) - store_app_successes
        print(f"D1_APP_SQL {store}: compiled={store_app_successes}/{len(application_queries)} candidate_schema_rejected={rejected}")
        print(f"D1_DEPTH {store}: migrations={len(migrations)} tables={len(tables)} "
              f"views={len(views)} statements={statements} failures={failures}")
        return statements, failures
    finally:
        db.close()


def classification_detail_record(inventory: dict, application_status: list[list[str]]) -> dict:
    """Project validated inventory fields without SQL or receiver expressions."""
    queries = inventory["queries"]
    unresolved = inventory["unresolved"]
    recovered_rows = []
    unresolved_rows = []
    unknown_targets = 0
    unknown_arities = 0
    target_failures = 0
    compile_failures = 0

    for index, query in enumerate(queries):
        target = query["targetStore"]
        statuses = application_status[index]
        candidate_compiles = {store: statuses[STORES.index(store)] == "OK" for store in STORES}
        target_compile = candidate_compiles[target] if target in STORES else None
        if target == "unknown":
            unknown_targets += 1
            if not any(candidate_compiles.values()):
                compile_failures += 1
        elif target_compile is not True:
            target_failures += 1
            compile_failures += 1
        if query["bindingArity"] is None:
            unknown_arities += 1

        recovered_rows.append({
            "sourceLocation": query["location"],
            "targetStore": target,
            "targetStatus": query["targetStatus"],
            **({"targetBindingEvidence": query["targetBindingEvidence"]}
               if "targetBindingEvidence" in query else {}),
            "prepareDeclarationKind": detail_prepare_declaration_kind(query),
            "bindingArity": query["bindingArity"],
            "bindingProvenance": query["bindingProvenance"],
            "candidateSchemaCompiled": candidate_compiles,
            "targetSchemaCompiled": target_compile,
        })

    for site in unresolved:
        unresolved_rows.append({
            "sourceLocation": site["location"],
            "targetStore": site["targetStore"],
            "targetStatus": site["targetStatus"],
            "prepareDeclarationKind": detail_prepare_declaration_kind(site),
            "bindingArity": site["bindingArity"],
            "bindingProvenance": site["bindingProvenance"],
            "classification": site["classification"],
            "reason": site["reason"] if site["reason"] in DETAIL_REASONS else "unrecognized-reason",
        })

    unresolved_unknown_targets = sum(site["targetStore"] == "unknown" for site in unresolved)
    unresolved_unknown_arities = sum(site["bindingArity"] is None for site in unresolved)
    incomplete = bool(unknown_targets or unknown_arities or unresolved or target_failures)
    strict = inventory["strictTargetQualification"]
    qualification = "INCOMPLETE" if incomplete else "DIRECT_BINDINGS_PASS" if strict else "NOT_REQUESTED"
    return {
        "recordType": "D1_DEPTH_CLASSIFICATION_DETAILS",
        "schemaVersion": 1,
        "scannedFiles": inventory.get("scannedFiles", 0),
        "strictTargetQualification": strict,
        "targetQualification": qualification,
        "strictQualificationPass": strict and not incomplete,
        "counts": {
            "recoveredQueries": len(queries),
            "unresolvedSites": len(unresolved),
            "recoveredUnknownTargets": unknown_targets,
            "recoveredUnknownArities": unknown_arities,
            "unresolvedUnknownTargets": unresolved_unknown_targets,
            "unresolvedUnknownArities": unresolved_unknown_arities,
            "targetSchemaFailures": target_failures,
            "applicationCompileFailures": compile_failures,
            "excludedFixtureSources": len(inventory["excludedFixtureFiles"]),
        },
        "recovered": recovered_rows,
        "unresolved": unresolved_rows,
    }


def emit_classification_details(inventory: dict, application_status: list[list[str]], output=None) -> bool:
    """Emit one opt-in JSON record; default compiler output remains unchanged."""
    if os.environ.get("D1_DEPTH_CLASSIFICATION_DETAILS") != "1":
        return False
    destination = output if output is not None else sys.stdout
    record = classification_detail_record(inventory, application_status)
    destination.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")
    return True


def main() -> int:
    if sys.version_info < (3, 11) or sqlite3.sqlite_version_info < (3, 45, 0):
        print("D1_DEPTH_SETUP_FAILED: require Python >=3.11 and SQLite >=3.45.")
        return 2
    started = time.monotonic()
    try:
        if len(sys.argv) != 2 or sys.argv[1] != "--application-sql-stdin":
            print("D1_DEPTH_SETUP_FAILED: invoke the Node wrapper to extract application SQL.")
            return 2
        inventory = json.load(sys.stdin)
        application_queries = inventory.get("queries")
        unresolved = inventory.get("unresolved")
        if not isinstance(application_queries, list) or not isinstance(unresolved, list):
            print("D1_DEPTH_SETUP_FAILED: application SQL inventory is invalid.")
            return 2
        if any(not valid_application_sql_entry(query) for query in application_queries):
            print("D1_DEPTH_SETUP_FAILED: recovered application SQL entry is invalid.")
            return 2
        if any(not valid_application_sql_entry(site, unresolved=True) for site in unresolved):
            print("D1_DEPTH_SETUP_FAILED: unresolved application SQL entry is invalid.")
            return 2
        strict_target_qualification = inventory.get("strictTargetQualification")
        if not isinstance(strict_target_qualification, bool):
            print("D1_DEPTH_SETUP_FAILED: target qualification mode is invalid.")
            return 2
        fixture_files = inventory.get("excludedFixtureFiles")
        if not isinstance(fixture_files, list) or any(not isinstance(path, str) for path in fixture_files):
            print("D1_DEPTH_SETUP_FAILED: fixture SQL classification is invalid.")
            return 2
        calibrate()
        print(f"D1_DEPTH compiler=SQLite/{sqlite3.sqlite_version} limit={DEPTH} calibration=PASS")
        application_status = [[] for _ in application_queries]
        results = [check_store(store, application_queries, application_status) for store in STORES]
    except (sqlite3.Error, OSError, RuntimeError):
        print("D1_DEPTH_SETUP_FAILED: compiler, calibration or schema inventory unavailable.")
        return 2
    app_failures = 0
    target_failures = 0
    unresolved_targets = 0
    unknown_arities = 0
    for query, statuses in zip(application_queries, application_status):
        target = query["targetStore"]
        target_status = statuses[STORES.index(target)] if target in STORES else None
        if target == "unknown":
            unresolved_targets += 1
        if query["bindingArity"] is None:
            unknown_arities += 1
        if target_status is not None and target_status != "OK":
            target_failures += 1
            app_failures += 1
            print(f"FAIL application object=source shape=PREPARE location={query['location']} "
                  f"TARGET_SCHEMA_{target_status}")
            other_store = "search" if target == "core" else "core"
            other_status = statuses[STORES.index(other_store)]
            if other_status == "OK":
                print(f"D1_APP_SQL cross_schema_only location={query['location']} "
                      f"target={target} candidate={other_store}")
        elif target_status is None and "OK" not in statuses:
            app_failures += 1
            failure_category = ("EXPRESSION_DEPTH_EXCEEDED" if statuses
                                and all(status == "EXPRESSION_DEPTH_EXCEEDED" for status in statuses)
                                else statuses[0] if statuses and len(set(statuses)) == 1
                                else "SQL_COMPILE_FAILED")
            print(f"FAIL application object=source shape=PREPARE location={query['location']} {failure_category}")
    if unresolved:
        print(f"D1_APP_SQL unresolved={len(unresolved)} (dynamic or non-SQL prepare sites; see bounded source list below)")
        for site in unresolved[:30]:
            arity = site["bindingArity"] if site["bindingArity"] is not None else "unknown"
            print(f"D1_APP_SQL unresolved {site['location']} class={site['classification']} "
                  f"target={site['targetStore']} arity={arity} reason={site['reason']}")
        if len(unresolved) > 30:
            print(f"D1_APP_SQL unresolved_sites_omitted={len(unresolved) - 30}")
    incomplete_targets = (unresolved_targets > 0 or unknown_arities > 0 or bool(unresolved)
                          or target_failures > 0)
    qualification = ("INCOMPLETE" if incomplete_targets else "DIRECT_BINDINGS_PASS"
                     if strict_target_qualification else "NOT_REQUESTED")
    print(f"D1_APP_SQL target_qualification={qualification} unresolved_targets={unresolved_targets} "
          f"unknown_arities={unknown_arities} unresolved_sites={len(unresolved)} target_failures={target_failures} "
          f"mode={'strict' if strict_target_qualification else 'depth-only'}")
    print(f"D1_APP_SQL recovered={len(application_queries)} failed={app_failures} unresolved={len(unresolved)} scanned_files={inventory.get('scannedFiles', 0)}")
    print(f"D1_APP_SQL excluded_fixture_sources={len(fixture_files)}")
    for path in fixture_files[:30]:
        print(f"D1_APP_SQL excluded_fixture {path} FIXTURE_ONLY_SQL")
    qualification_failure = strict_target_qualification and incomplete_targets
    failures = sum(result[1] for result in results) + app_failures + int(qualification_failure)
    if qualification_failure:
        print("FAIL D1_APP_SQL strict target qualification requires resolved targets, known bind arity, "
              "no unresolved prepare sites and successful target-schema compilation")
    print(f"D1_DEPTH {'FAIL' if failures else 'PASS'}: failures={failures} "
          f"elapsed_seconds={time.monotonic() - started:.3f}")
    emit_classification_details(inventory, application_status)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
