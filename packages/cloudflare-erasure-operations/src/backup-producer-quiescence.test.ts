import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import m0001 from "../../../infra/d1/core/migrations/0001_initial.sql?raw";
import m0008 from "../../../infra/d1/core/migrations/0008_erasure_closure.sql?raw";
import m0018 from "../../../infra/d1/core/migrations/0018_backup_o2_replay_authority.sql?raw";
import m0019 from "../../../infra/d1/core/migrations/0019_backup_o2_replay_authority_fix.sql?raw";
import m0116 from "../../../infra/d1/core/migrations/0116_backup_epoch_producer_fence.sql?raw";
import m0117 from "../../../infra/d1/core/migrations/0117_backup_erasure_primary_closure.sql?raw";
import { createD1BackupProducerQuiescencePort } from "./backup-producer-quiescence.js";

const CUT_DIGEST = "c".repeat(64);
const CUT_ID = `cut-${CUT_DIGEST.slice(0, 32)}`;
const NOW = "2026-10-05T00:00:00.000Z";
const MIGRATIONS = [
  "0001_initial.sql", "0008_erasure_closure.sql", "0018_backup_o2_replay_authority.sql",
  "0019_backup_o2_replay_authority_fix.sql", "0116_backup_epoch_producer_fence.sql",
  "0117_backup_erasure_primary_closure.sql",
] as const;

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

function seedActiveErasure(database: DatabaseSync): void {
  const erasureId = "erasure-test";
  const requestJson = JSON.stringify({ erasure_id: erasureId, revision: 1 });
  database.prepare(`INSERT INTO erasure_case
    (erasure_id,revision,state,exact_subject_refs_json,requested_locations_json,completed_locations_json,
      blocked_locations_json,legal_basis_ref,deadline,created_at,updated_at)
    VALUES (?1,1,'REQUESTED','["subject-test"]','["Primary"]','[]','[]','legal-basis',?2,?3,?3)`)
    .run(erasureId, "2027-10-05T00:00:00.000Z", NOW);
  database.prepare(`INSERT INTO erasure_execution
    (erasure_id,revision,request_json,request_sha256,state,lease_owner,lease_generation,lease_until,
      closure_digest,terminal_receipt_json,terminal_receipt_sha256,purge_ledger_revision,last_error_code,created_at,updated_at)
    VALUES (?1,1,?2,?3,'REQUESTED',NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,?4,?4)`)
    .run(erasureId, requestJson, "e".repeat(64), NOW);
}

describe("Operations backup producer quiescence", () => {
  it.each(["OPEN", "REJECTED", "ACCEPTED"] as const)("blocks on unowned %s cuts", async (state) => {
    const database = openDatabase();
    try {
      seedActiveErasure(database);
      database.prepare("INSERT INTO backup_export_cut (cut_id,cut_digest,state,created_at) VALUES (?1,?2,?3,?4)")
        .run(CUT_ID, CUT_DIGEST, state, NOW);
      await expect(createD1BackupProducerQuiescencePort(d1Database(database)).assertQuiescent({
        erasure_id: "erasure-test",
        revision: 1,
      })).rejects.toMatchObject({ code: "BACKUP_PURGE_BLOCKED" });
    } finally {
      database.close();
    }
  });
});
