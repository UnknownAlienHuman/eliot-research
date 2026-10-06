import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { backupSha256Hex } from "./shared.js";
import { canonicalizeSchemaSql } from "./migration-gate.js";
import {
  BACKUP_PRODUCER_ERASURE_SCHEMA_SHA256,
  BACKUP_PRODUCER_FENCE_MIGRATION_SHA256,
  BACKUP_PRODUCER_FENCE_SCHEMA_SHA256,
} from "./epoch-producer-fence.js";
import { openExportCut, type CutInputs } from "./coherent-cut.js";
import m0001 from "../../../infra/d1/core/migrations/0001_initial.sql?raw";
import m0008 from "../../../infra/d1/core/migrations/0008_erasure_closure.sql?raw";
import m0018 from "../../../infra/d1/core/migrations/0018_backup_o2_replay_authority.sql?raw";
import m0019 from "../../../infra/d1/core/migrations/0019_backup_o2_replay_authority_fix.sql?raw";
import m0116 from "../../../infra/d1/core/migrations/0116_backup_epoch_producer_fence.sql?raw";
import m0117 from "../../../infra/d1/core/migrations/0117_backup_erasure_primary_closure.sql?raw";

const DIGEST = "a".repeat(64);
const CUT_DIGEST = "c".repeat(64);
const CUT_ID = `cut-${CUT_DIGEST.slice(0, 32)}`;
const PREFIX = "backup-parts/epoch-test/";
const NOW = "2026-10-05T00:00:00.000Z";
const MIGRATIONS = [
  "0001_initial.sql", "0008_erasure_closure.sql", "0018_backup_o2_replay_authority.sql",
  "0019_backup_o2_replay_authority_fix.sql", "0116_backup_epoch_producer_fence.sql",
  "0117_backup_erasure_primary_closure.sql",
] as const;
const CUT_INPUTS: CutInputs = {
  schema_generation: "schema-test",
  migration_ledger_digest: DIGEST,
  table_digests: { source: { count: 0, digest: DIGEST } },
  purge_frontier: 0,
  purge_digest: DIGEST,
  r2_generation: DIGEST,
  schema_inventory_digest: DIGEST,
};

interface SqlObjectRow {
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  readonly sql: string;
}

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(m0001);
  database.exec(m0008);
  database.exec(m0018);
  database.exec(m0019);
  database.exec(m0116);
  database.exec(m0117);
  for (const [index, migration] of MIGRATIONS.entries()) {
    database.prepare("INSERT INTO d1_migrations (name,applied_at) VALUES (?1,?2)")
      .run(migration, `2026-10-05T00:00:${String(index).padStart(2, "0")}.000Z`);
  }
  return database;
}

function d1Database(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const bound = (values: readonly (string | number | null)[]) => ({
        async all<T>() {
          return { results: statement.all(...values) as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>;
        },
        async first<T>() {
          return (statement.get(...values) as unknown as T | undefined) ?? null;
        },
        async run<T>() {
          statement.run(...values);
          return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
        },
      });
      return { bind(...values: (string | number | null)[]) { return bound(values); }, ...bound([]) };
    },
  } as unknown as D1Database;
}


async function schemaDigest(database: DatabaseSync, tableNames: readonly string[]): Promise<string> {
  const placeholders = tableNames.map(() => "?").join(",");
  const rows = database.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE type IN ('table','index','trigger') AND tbl_name IN (${placeholders}) AND sql IS NOT NULL`)
    .all(...tableNames) as unknown as SqlObjectRow[];
  rows.sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return backupSha256Hex(rows.map((row) => `${row.type} ${row.name} ${canonicalizeSchemaSql(row.sql)}`).join("\n"));
}

describe("0116 backup producer state constraints", () => {
  it("pins the migration bytes and exact producer and 0117 erasure DDL", async () => {
    const database = openDatabase();
    try {
      expect(await backupSha256Hex(m0116.replace(/\r\n/g, "\n"))).toBe(BACKUP_PRODUCER_FENCE_MIGRATION_SHA256);
      expect(await schemaDigest(database, ["backup_epoch_producer_claim"])).toBe(BACKUP_PRODUCER_FENCE_SCHEMA_SHA256);
      expect(await schemaDigest(database, ["erasure_case", "erasure_execution"])).toBe(BACKUP_PRODUCER_ERASURE_SCHEMA_SHA256);
    } finally {
      database.close();
    }
  });

  it("distinguishes a newly inserted cut from an existing same-content cut", async () => {
    const database = openDatabase();
    try {
      const first = await openExportCut(d1Database(database), CUT_INPUTS, NOW);
      expect(first).toMatchObject({ inserted: true, state: "OPEN" });
      const existing = await openExportCut(d1Database(database), CUT_INPUTS, NOW);
      expect(existing).toMatchObject({ cut_id: first.cut_id, cut_digest: first.cut_digest, inserted: false, state: "OPEN" });
      database.prepare("UPDATE backup_export_cut SET state='ACCEPTED' WHERE cut_id=?1").run(first.cut_id);
      const accepted = await openExportCut(d1Database(database), CUT_INPUTS, NOW);
      expect(accepted).toMatchObject({ cut_id: first.cut_id, inserted: false, state: "ACCEPTED" });
    } finally {
      database.close();
    }
  });


  it.each([
    ["part_prefix", null, CUT_ID, CUT_DIGEST],
    ["cut_id", PREFIX, null, CUT_DIGEST],
    ["cut_digest", PREFIX, CUT_ID, null],
  ] as const)("rejects WRITING with NULL %s despite SQLite CHECK NULL semantics", (_field, partPrefix, cutId, cutDigest) => {
    const database = openDatabase();
    try {
      database.prepare(`INSERT INTO backup_epoch_producer_claim
        (idempotency_key,base_intent_digest,attempt_nonce,state,created_at,updated_at)
        VALUES (?1,?2,?3,'CAPTURING','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`)
        .run(`claim-${_field}`, DIGEST, "00000000-0000-4000-8000-000000000001");

      expect(() => database.prepare(`UPDATE backup_epoch_producer_claim SET
        state='WRITING',epoch_id='epoch-test',part_prefix=?1,cut_id=?2,cut_digest=?3,
        vector_digest=?4,manifest_digest=?5,intent_digest=?6,updated_at='2026-10-05T00:01:00.000Z'
        WHERE idempotency_key=?7`)
        .run(partPrefix, cutId, cutDigest, DIGEST, DIGEST, DIGEST, `claim-${_field}`)).toThrow();

      expect(database.prepare("SELECT state FROM backup_epoch_producer_claim WHERE idempotency_key=?1")
        .get(`claim-${_field}`)).toMatchObject({ state: "CAPTURING" });
    } finally {
      database.close();
    }
  });
});
