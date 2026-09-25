"""Compile repository D1 schema at the observed depth limit; never execute probe writes."""
from pathlib import Path
import re
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
DEPTH = 100
STORES = ("core", "search")


def quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def category(error: sqlite3.Error) -> str:
    # Never print arbitrary SQL, row data, a provider response or an exception payload.
    if "expression tree is too large" in str(error).lower():
        return "EXPRESSION_DEPTH_EXCEEDED"
    return "SQL_COMPILE_FAILED"


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
    finally:
        db.close()


def columns(db: sqlite3.Connection, name: str) -> list[str]:
    # Hidden/generated columns cannot be INSERTed/UPDATEd explicitly.
    return [row[1] for row in db.execute(f"PRAGMA table_xinfo({quoted(name)})") if row[6] == 0]


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


def check_store(store: str) -> tuple[int, int]:
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
                db.execute("EXPLAIN " + sql).close()
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
        print(f"D1_DEPTH {store}: migrations={len(migrations)} tables={len(tables)} "
              f"views={len(views)} statements={statements} failures={failures}")
        return statements, failures
    finally:
        db.close()


def main() -> int:
    if sys.version_info < (3, 11) or sqlite3.sqlite_version_info < (3, 45, 0):
        print("D1_DEPTH_SETUP_FAILED: require Python >=3.11 and SQLite >=3.45.")
        return 2
    started = time.monotonic()
    try:
        calibrate()
        print(f"D1_DEPTH compiler=SQLite/{sqlite3.sqlite_version} limit={DEPTH} calibration=PASS")
        results = [check_store(store) for store in STORES]
    except (sqlite3.Error, OSError, RuntimeError):
        print("D1_DEPTH_SETUP_FAILED: compiler, calibration or schema inventory unavailable.")
        return 2
    failures = sum(result[1] for result in results)
    print(f"D1_DEPTH {'FAIL' if failures else 'PASS'}: failures={failures} "
          f"elapsed_seconds={time.monotonic() - started:.3f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
