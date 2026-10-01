from pathlib import Path
import sqlite3

ROOT = Path.cwd()
MIGRATIONS = sorted((ROOT / "infra/d1/core/migrations").glob("*.sql"))
TABLE = "computer_agent_preferred_dispatch_selection"


def load() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", cached_statements=0)
    db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 1000)
    for path in MIGRATIONS:
        db.executescript(path.read_text(encoding="utf-8"))
    db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
    return db


def insert_sql(db: sqlite3.Connection) -> str:
    columns = [row[1] for row in db.execute(f'PRAGMA table_xinfo("{TABLE}")') if row[6] == 0]
    fields = ",".join(f'"{name}"' for name in columns)
    values = ",".join("NULL" for _ in columns)
    return f'EXPLAIN INSERT INTO "{TABLE}" ({fields}) SELECT {values} WHERE 0'


def compile_case(label: str, keep: set[str] | None) -> None:
    db = load()
    try:
        triggers = db.execute(
            "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name", (TABLE,),
        ).fetchall()
        if keep is not None:
            for name, _ in triggers:
                if name not in keep:
                    db.execute(f'DROP TRIGGER "{name}"')
        try:
            db.execute(insert_sql(db)).close()
        except sqlite3.Error as error:
            print(f"DIAG {label} FAIL type={type(error).__name__} message={error}")
        else:
            print(f"DIAG {label} PASS")
    finally:
        db.close()


probe = load()
trigger_names = [row[0] for row in probe.execute(
    "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name", (TABLE,),
)]
probe.close()
print("DIAG triggers=" + ",".join(trigger_names))
compile_case("all", None)
compile_case("no-triggers", set())
for name in trigger_names:
    compile_case("only-" + name, {name})
