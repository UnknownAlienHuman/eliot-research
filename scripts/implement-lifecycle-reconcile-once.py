from __future__ import annotations

from pathlib import Path
import json
import re

ROOT = Path.cwd()
MIGRATIONS = ROOT / "infra/d1/core/migrations"


def split_definitions(body: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    escaped = False
    for index, char in enumerate(body):
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {'"', "'", "`"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append(body[start:index].strip())
            start = index + 1
    parts.append(body[start:].strip())
    return [part for part in parts if part]


def identifier(value: str) -> str:
    return value.strip().strip('"`[]')


def quote(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


sql = "\n".join(
    path.read_text(encoding="utf-8")
    for path in sorted(MIGRATIONS.glob("*.sql"))
)
match = re.search(
    r"CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+[\"`\[]?outbox[\"`\]]?\s*\((.*?)\)\s*;",
    sql,
    flags=re.IGNORECASE | re.DOTALL,
)
if match is None:
    raise SystemExit("committed Core migration stream has no outbox table")

definitions = split_definitions(match.group(1))
columns: dict[str, str] = {}
primary_key: str | None = None
for definition in definitions:
    if re.match(r"^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|CHECK\b|FOREIGN\s+KEY\b)", definition, re.IGNORECASE):
        table_pk = re.search(r"PRIMARY\s+KEY\s*\(\s*([\"`\[]?[A-Za-z_][A-Za-z0-9_]*[\"`\]]?)", definition, re.IGNORECASE)
        if table_pk is not None:
            primary_key = identifier(table_pk.group(1))
        continue
    token = re.match(r"^([\"`\[]?[A-Za-z_][A-Za-z0-9_]*[\"`\]]?)\s+(.+)$", definition, re.DOTALL)
    if token is None:
        continue
    name = identifier(token.group(1))
    columns[name] = token.group(2)
    if re.search(r"\bPRIMARY\s+KEY\b", token.group(2), re.IGNORECASE):
        primary_key = name

if "state" not in columns:
    raise SystemExit("outbox table has no state column")
if primary_key is None:
    for candidate in ("outbox_id", "event_id", "id"):
        if candidate in columns:
            primary_key = candidate
            break
if primary_key is None:
    raise SystemExit("outbox primary key could not be derived")


def first_column(candidates: tuple[str, ...]) -> str | None:
    return next((candidate for candidate in candidates if candidate in columns), None)


lease_expiry = first_column((
    "lease_expires_at",
    "lease_expires_at_ms",
    "leased_until",
    "lease_until",
    "lease_deadline",
))
lease_owner = first_column(("lease_owner", "leased_by", "lease_id", "lease_token"))
retry_at = first_column((
    "next_attempt_at",
    "next_attempt_at_ms",
    "retry_at",
    "retry_after",
    "retry_after_ms",
))
updated_at = first_column(("updated_at", "updated_at_ms", "modified_at"))


def time_kind(column: str | None) -> str:
    if column is None:
        return "none"
    definition = columns[column]
    return "integer" if re.search(r"\bINT(?:EGER)?\b", definition, re.IGNORECASE) else "text"


lease_kind = time_kind(lease_expiry)
retry_kind = time_kind(retry_at)
capabilities = {
    "primary_key": primary_key,
    "lease_expiry": lease_expiry,
    "lease_owner": lease_owner,
    "retry_at": retry_at,
    "updated_at": updated_at,
    "lease_time_kind": lease_kind,
    "retry_time_kind": retry_kind,
}


def update_assignments(*, clear_lease: bool) -> list[str]:
    values = [f'{quote("state")} = \'PENDING\'']
    if clear_lease:
        if lease_owner is not None:
            values.append(f"{quote(lease_owner)} = NULL")
        if lease_expiry is not None:
            values.append(f"{quote(lease_expiry)} = NULL")
    if updated_at is not None:
        values.append(f"{quote(updated_at)} = ?1")
    return values


def repair_sql(state: str, due_column: str, clear_lease: bool) -> str:
    assignments = ", ".join(update_assignments(clear_lease=clear_lease))
    return (
        f"UPDATE {quote('outbox')} SET {assignments} "
        f"WHERE {quote(primary_key)} IN ("
        f"SELECT {quote(primary_key)} FROM {quote('outbox')} "
        f"WHERE {quote('state')} = '{state}' AND {quote(due_column)} <= ?2 "
        f"ORDER BY {quote(due_column)}, {quote(primary_key)} LIMIT ?3"
        ") AND "
        f"{quote('state')} = '{state}' AND {quote(due_column)} <= ?2"
    )


lease_sql = None if lease_expiry is None else repair_sql("LEASED", lease_expiry, True)
retry_sql = None if retry_at is None else repair_sql("FAILED", retry_at, False)

module = f'''export interface LifecycleReconciliationResult {{
  readonly repaired: number;
  readonly still_pending: number;
}}

export const OUTBOX_RECONCILIATION_CAPABILITIES = Object.freeze({json.dumps(capabilities, ensure_ascii=False, indent=2)} as const);

const MAX_RECONCILE = 1_000;
const COUNT_PENDING_SQL = "SELECT COUNT(*) AS pending_count FROM outbox WHERE state IN ('PENDING','LEASED','FAILED')";
const LEASE_REPAIR_SQL: string | null = {json.dumps(lease_sql)};
const FAILED_RETRY_SQL: string | null = {json.dumps(retry_sql)};

export class LifecycleReconciliationError extends Error {{
  public readonly code: string;
  public readonly retryable: boolean;
  public constructor(code: string, message: string, retryable = false) {{
    super(message);
    this.name = "LifecycleReconciliationError";
    this.code = code;
    this.retryable = retryable;
  }}
}}

function checkedCount(value: unknown, label: string): number {{
  if (!Number.isSafeInteger(value) || (value as number) < 0) {{
    throw new LifecycleReconciliationError(
      "LIFECYCLE_RECONCILIATION_READBACK_INVALID",
      `D1 returned an invalid ${{label}}`,
      true,
    );
  }}
  return value as number;
}}

async function pendingCount(database: D1Database): Promise<number> {{
  const row = await database.prepare(COUNT_PENDING_SQL).first<{{ pending_count: number }}>();
  return checkedCount(row?.pending_count ?? 0, "pending outbox count");
}}

function timeValue(kind: "integer" | "text" | "none", nowMs: number): number | string {{
  return kind === "integer" ? nowMs : new Date(nowMs).toISOString();
}}

async function executeRepair(
  database: D1Database,
  sql: string,
  nowValue: number | string,
  limit: number,
): Promise<number> {{
  const result = await database.prepare(sql).bind(nowValue, nowValue, limit).run();
  return checkedCount(result.meta.changes ?? 0, "repaired-row count");
}}

export async function reconcileApplicationLifecycle(
  database: D1Database,
  limit: number,
  now: () => number = Date.now,
): Promise<LifecycleReconciliationResult> {{
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECONCILE) {{
    throw new RangeError("reconcile limit must be an integer in [1, 1000]");
  }}
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {{
    throw new LifecycleReconciliationError(
      "LIFECYCLE_RECONCILIATION_CLOCK_INVALID",
      "reconciliation clock is invalid",
    );
  }}

  const before = await pendingCount(database);
  if (before === 0) return {{ repaired: 0, still_pending: 0 }};
  if (LEASE_REPAIR_SQL === null && FAILED_RETRY_SQL === null) {{
    throw new LifecycleReconciliationError(
      "LIFECYCLE_RECONCILIATION_NOT_COMPOSED",
      "pending outbox effects exist but the committed schema exposes no safe lease or retry boundary",
      false,
    );
  }}

  let repaired = 0;
  if (LEASE_REPAIR_SQL !== null && repaired < limit) {{
    repaired += await executeRepair(
      database,
      LEASE_REPAIR_SQL,
      timeValue({json.dumps(lease_kind)}, nowMs),
      limit - repaired,
    );
  }}
  if (FAILED_RETRY_SQL !== null && repaired < limit) {{
    repaired += await executeRepair(
      database,
      FAILED_RETRY_SQL,
      timeValue({json.dumps(retry_kind)}, nowMs),
      limit - repaired,
    );
  }}
  if (repaired > limit) {{
    throw new LifecycleReconciliationError(
      "LIFECYCLE_RECONCILIATION_LIMIT_BROKEN",
      "reconciliation repaired more rows than authorized",
      true,
    );
  }}
  return {{ repaired, still_pending: await pendingCount(database) }};
}}
'''

unit_test = r'''import { describe, expect, it } from "vitest";
import {
  LifecycleReconciliationError,
  OUTBOX_RECONCILIATION_CAPABILITIES,
  reconcileApplicationLifecycle,
} from "../src/lifecycle-reconciler.js";

interface Step {
  readonly kind: "first" | "run";
  readonly value: unknown;
}

function database(steps: readonly Step[]): D1Database {
  const pending = [...steps];
  const statement = {
    bind: (..._values: unknown[]) => statement,
    first: async () => {
      const step = pending.shift();
      if (step?.kind !== "first") throw new Error("unexpected D1 first");
      return step.value;
    },
    run: async () => {
      const step = pending.shift();
      if (step?.kind !== "run") throw new Error("unexpected D1 run");
      return step.value;
    },
  };
  return { prepare: () => statement } as unknown as D1Database;
}

describe("application lifecycle reconciliation", () => {
  it("rejects invalid limits before touching D1", async () => {
    await expect(reconcileApplicationLifecycle(database([]), 0))
      .rejects.toBeInstanceOf(RangeError);
    await expect(reconcileApplicationLifecycle(database([]), 1_001))
      .rejects.toBeInstanceOf(RangeError);
  });

  it("returns an exact empty result without inventing repairs", async () => {
    await expect(reconcileApplicationLifecycle(database([
      { kind: "first", value: { pending_count: 0 } },
    ]), 10)).resolves.toEqual({ repaired: 0, still_pending: 0 });
  });

  it("repairs only schema-supported rows and reports exact D1 readback", async () => {
    const repairStatements = Number(OUTBOX_RECONCILIATION_CAPABILITIES.lease_expiry !== null)
      + Number(OUTBOX_RECONCILIATION_CAPABILITIES.retry_at !== null);
    if (repairStatements === 0) {
      await expect(reconcileApplicationLifecycle(database([
        { kind: "first", value: { pending_count: 2 } },
      ]), 10)).rejects.toMatchObject({ code: "LIFECYCLE_RECONCILIATION_NOT_COMPOSED" });
      return;
    }
    const steps: Step[] = [{ kind: "first", value: { pending_count: 3 } }];
    for (let index = 0; index < repairStatements; index += 1) {
      steps.push({ kind: "run", value: { meta: { changes: index === 0 ? 2 : 0 } } });
    }
    steps.push({ kind: "first", value: { pending_count: 1 } });
    await expect(reconcileApplicationLifecycle(database(steps), 10, () => 1_800_000_000_000))
      .resolves.toEqual({ repaired: 2, still_pending: 1 });
  });

  it("fails closed on invalid D1 counts", async () => {
    await expect(reconcileApplicationLifecycle(database([
      { kind: "first", value: { pending_count: -1 } },
    ]), 10)).rejects.toBeInstanceOf(LifecycleReconciliationError);
  });
});
'''

(ROOT / "apps/eliotr-core/src/lifecycle-reconciler.ts").write_text(
    module,
    encoding="utf-8",
    newline="\n",
)
(ROOT / "apps/eliotr-core/test/lifecycle-reconciler.test.ts").write_text(
    unit_test,
    encoding="utf-8",
    newline="\n",
)

composition_path = ROOT / "apps/eliotr-core/src/composition-root.ts"
composition = composition_path.read_text(encoding="utf-8")
reconcile_import = 'import { reconcileApplicationLifecycle } from "./lifecycle-reconciler.js";\n'
if reconcile_import not in composition:
    composition = reconcile_import + composition

# Remove the old count-only helper once it has no caller.
helper_start = composition.find("async function countPendingOutbox(")
if helper_start >= 0:
    brace = composition.find("{", helper_start)
    depth = 0
    index = brace
    while index < len(composition):
        if composition[index] == "{":
            depth += 1
        elif composition[index] == "}":
            depth -= 1
            if depth == 0:
                end = composition.find("\n", index)
                composition = composition[:helper_start] + composition[(len(composition) if end < 0 else end + 1):]
                break
        index += 1

marker = "    async reconcile(limit: number) {"
start = composition.find(marker)
if start < 0:
    raise SystemExit("ApplicationLifecycle.reconcile method anchor missing")
brace = composition.find("{", start)
depth = 0
index = brace
end = -1
while index < len(composition):
    if composition[index] == "{":
        depth += 1
    elif composition[index] == "}":
        depth -= 1
        if depth == 0:
            end = index + 1
            break
    index += 1
if end < 0:
    raise SystemExit("ApplicationLifecycle.reconcile block is unterminated")
replacement = '''    async reconcile(limit: number) {
      return reconcileApplicationLifecycle(input.env.CORE_DB, limit);
    }'''
composition = composition[:start] + replacement + composition[end:]
composition_path.write_text(composition, encoding="utf-8", newline="\n")

manifest_path = ROOT / "docs/agent-work/manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))


def find_packet(value: object, packet_id: str):
    if isinstance(value, dict):
        if value.get("id") == packet_id:
            return value
        for child in value.values():
            found = find_packet(child, packet_id)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_packet(child, packet_id)
            if found is not None:
                return found
    return None


owned = [
    "apps/eliotr-core/src/lifecycle-reconciler.ts",
    "apps/eliotr-core/test/lifecycle-reconciler.test.ts",
]
packet = find_packet(manifest, "ER-24")
if packet is None:
    raise SystemExit("ER-24 packet missing")
key = "owned_paths" if "owned_paths" in packet else "ownedPaths"
for value in owned:
    if value not in packet[key]:
        packet[key].append(value)
manifest_path.write_text(
    json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
    newline="\n",
)

docs = list((ROOT / "docs/agent-work").glob("ER-24-*.md"))
if len(docs) != 1:
    raise SystemExit("ER-24 packet document is ambiguous")
doc_path = docs[0]
doc = doc_path.read_text(encoding="utf-8")
heading = re.search(r"(?im)^##\s+Owned paths\s*$", doc)
if heading is None:
    raise SystemExit("ER-24 Owned paths heading missing")
insert_at = heading.end()
additions = "".join(f"\n- `{value}`" for value in owned if f"`{value}`" not in doc)
doc_path.write_text(doc[:insert_at] + additions + doc[insert_at:], encoding="utf-8", newline="\n")

print(json.dumps(capabilities, indent=2))
