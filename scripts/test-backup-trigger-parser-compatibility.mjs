import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const migrations = [
  {
    file: "0116_backup_epoch_producer_fence.sql",
    count: 4,
    originalSha256: "f5ca9a65411158aef794b934a0ea89f9c01453a06bdf2591b9b0427e6cacd9bc",
  },
  {
    file: "0117_backup_erasure_primary_closure.sql",
    count: 25,
    originalSha256: "3987689e495802f9e8b066ac118e166dfe9e741cc9707896f67f57ac37013242",
  },
  {
    file: "0118_backup_primary_writer_qualification.sql",
    count: 1,
    originalSha256: "c71673447dd1f27e0a6795e7446a33c6fbc7a1fbf65b872c1d7d20082415092b",
  },
  {
    file: "0119_backup_epoch_manifest_bindings.sql",
    count: 3,
    originalSha256: "9497a9d31187b2901258bfe4a1cd6823357eb1269483ac8fd160d130d2e3177c",
  },
];
const compatibilityComment = "-- D1 native parser compatibility: parenthesize trigger CASE guards (workers-sdk#4727).\n";
const guardPattern = /SELECT \(CASE WHEN[\s\S]*?END\);/gu;
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");

let totalGuards = 0;
for (const migration of migrations) {
  const path = resolve("infra/d1/core/migrations", migration.file);
  const source = await readFile(path, "utf8");
  assert.equal(source.split(compatibilityComment).length - 1, 1, `${migration.file}: compatibility comment count`);

  const matches = [...source.matchAll(guardPattern)];
  assert.equal(matches.length, migration.count, `${migration.file}: parenthesized guard count`);
  assert.doesNotMatch(source, /SELECT CASE WHEN/gu, `${migration.file}: unparenthesized guard remains`);

  const restored = source
    .replace(compatibilityComment, "")
    .replace(guardPattern, (guard) => guard
      .replace("SELECT (CASE WHEN", "SELECT CASE WHEN")
      .replace(/END\);$/u, "END;"));
  assert.equal(digest(restored), migration.originalSha256, `${migration.file}: unexpected SQL changes`);
  totalGuards += matches.length;
}
assert.equal(totalGuards, 33, "total D1 trigger CASE guard count");

const db = new DatabaseSync(":memory:");
try {
  db.exec(`
    CREATE TABLE guard_fixture (guard_value INTEGER);
    CREATE TRIGGER guard_fixture_abort BEFORE INSERT ON guard_fixture BEGIN
      SELECT (CASE WHEN NEW.guard_value = 1 THEN RAISE(ABORT, 'blocked') END);
    END;
  `);
  assert.throws(() => db.prepare("INSERT INTO guard_fixture VALUES (1)").run(), /blocked/u);
  db.prepare("INSERT INTO guard_fixture VALUES (0)").run();
  db.prepare("INSERT INTO guard_fixture VALUES (NULL)").run();
  assert.deepEqual(db.prepare("SELECT guard_value FROM guard_fixture ORDER BY rowid").all()
    .map(({ guard_value }) => guard_value), [0, null]);
} finally {
  db.close();
}

console.log(`backup trigger parser compatibility: PASS (${totalGuards} guards; byte-preserving predicates; true/false/NULL)`);
