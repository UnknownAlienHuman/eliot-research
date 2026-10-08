import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const directory = new URL("../infra/d1/core/migrations/", import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
const migrations = await Promise.all(files.map(async (name) => [name, await readFile(new URL(name, directory), "utf8")]));
const changed = new Map([
  ["0098_artifact_publication_authority.sql", { cases: 10,
    original: "1e471a6958e77010ca956e17f7b2ffeba4e3a780823b359f56ca0dde4d3a5fa2" }],
  ["0099_backup_erasure_replay.sql", { cases: 3,
    original: "11632388c55446dd5abe376993ef3fd12967a6932acbd4840c995795d39fe89a" }],
]);
const bareCases = (sql) => sql.replace(/\(CASE\b/gu, "CASE").replace(/\bEND\)/gu, "END");
const statements = [
  "INSERT INTO artifact_publication_receipt DEFAULT VALUES",
  "INSERT INTO artifact_publication_head VALUES('missing',1,1,'missing','ACCEPTED','2026-10-03T00:00:00Z')",
  "UPDATE artifact_publication_head SET publication_revision=publication_revision+1,disposition='ACCEPTED'",
  "INSERT INTO backup_offsite_copy_replay_authority DEFAULT VALUES",
  "UPDATE backup_offsite_copy_replay_authority SET state='COMMITTED',committed_at='2026-10-03T00:00:00Z'",
  "INSERT INTO backup_erasure_replay_obligation DEFAULT VALUES",
];

function fixture(original = false) {
  const db = new DatabaseSync(":memory:");
  try {
    for (const [name, sql] of migrations) db.exec(original && changed.has(name) ? bareCases(sql) : sql);
    return db;
  } catch (error) { db.close(); throw error; }
}

test("0098/0099 add exactly thirteen matched CASE wrappers and preserve every original byte otherwise", () => {
  for (const [name, sql] of migrations.filter(([name]) => changed.has(name))) {
    const expected = changed.get(name);
    assert.equal([...sql.matchAll(/\bCASE\b/gu)].length, expected.cases, name);
    assert.equal([...sql.matchAll(/\(CASE\b/gu)].length, expected.cases, name);
    assert.equal([...sql.matchAll(/\bEND\)/gu)].length, expected.cases, name);
    assert.equal(createHash("sha256").update(bareCases(sql)).digest("hex"), expected.original, name);
  }
});

test("the complete migration chain and all six affected DML plans retain identical authority predicates", () => {
  const original = fixture(true);
  const fixed = fixture();
  try {
    for (const sql of statements) {
      // Ignore source text and per-connection virtual-table pointers, retaining their identity order.
      const plan = (db) => {
        const pointers = new Map();
        return db.prepare(`EXPLAIN ${sql}`).all().filter((row) => row.opcode !== "Trace").map((row) => {
          if (row.opcode !== "VOpen") return row;
          if (!pointers.has(row.p4)) pointers.set(row.p4, pointers.size);
          return { ...row, p4: pointers.get(row.p4) };
        });
      };
      assert.deepEqual(plan(fixed), plan(original), sql);
    }
    assert.deepEqual(fixed.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { original.close(); fixed.close(); }
});

test("publication and backup inserts deny missing authority without inserting rows", () => {
  const db = fixture();
  const failures = [
    [statements[0], "ARTIFACT_PUBLICATION_OPERATION_GUARD", "artifact_publication_receipt"],
    [statements[1], "ARTIFACT_PUBLICATION_HEAD_CAS", "artifact_publication_head"],
    [statements[3], "BACKUP_COPY_REPLAY_AUTHORITY_INVALID", "backup_offsite_copy_replay_authority"],
    [statements[5], "BACKUP_ERASURE_REPLAY_TARGET_INVALID", "backup_erasure_replay_obligation"],
  ];
  try {
    for (const [sql, code, table] of failures) {
      assert.throws(() => db.exec(sql), new RegExp(code, "u"));
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
  } finally { db.close(); }
});

test("publication CAS and backup commitment updates deny absent receipts atomically", () => {
  const db = fixture();
  try {
    // Seed isolated rows without granting authority; the production update guards stay installed.
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("INSERT INTO artifact_publication_head VALUES('missing',1,1,'missing','PENDING_REVALIDATION','2026-10-03T00:00:00Z')");
    db.exec("PRAGMA foreign_keys=ON");
    const guard = db.prepare("SELECT sql FROM sqlite_master WHERE name='backup_copy_replay_shape_guard'").get().sql;
    db.exec("DROP TRIGGER backup_copy_replay_shape_guard");
    db.prepare("INSERT INTO backup_offsite_copy_replay_authority VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("copy", "epoch", "destination", "owner", "policy", "{}", "key", "2026-10-04T00:00:00Z",
        "primary", "{}", "a".repeat(64), "b".repeat(64), "c".repeat(64), "2026-10-03T00:00:00Z",
        "INTENT", "2026-10-03T00:00:00Z", null);
    db.exec(guard);
    assert.throws(() => db.exec(statements[2]), /ARTIFACT_PUBLICATION_HEAD_CAS/u);
    assert.deepEqual({ ...db.prepare("SELECT publication_revision,disposition FROM artifact_publication_head").get() },
      { publication_revision: 1, disposition: "PENDING_REVALIDATION" });
    assert.throws(() => db.exec(statements[4]), /BACKUP_COPY_REPLAY_IDENTITY_CONFLICT/u);
    assert.deepEqual({ ...db.prepare("SELECT state,committed_at FROM backup_offsite_copy_replay_authority").get() },
      { state: "INTENT", committed_at: null });
  } finally { db.close(); }
});
