import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
function beforeK4() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql", "0005_model_gateway.sql",
    "0006_integrity.sql", "0007_manual_understanding.sql", "0008_model_providers.sql"]) db.exec(migration(name));
  db.exec("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('s','Paper','text','owner',1,1)");
  db.exec("INSERT INTO source_revision(id,source_id,revision_no,created_by,created_at) VALUES('r','s',1,'owner',1)");
  return db;
}
function upsert(db: DatabaseSync, id: string, ordinal: number, statement: string) {
  db.prepare("INSERT INTO claim(id,source_revision_id,ordinal,kind,statement,quote,block_index,start_byte,end_byte,created_at) VALUES(?,'r',?,'method',?,'source quote',1,0,12,1)"
    + " ON CONFLICT(source_revision_id,ordinal) DO UPDATE SET statement=excluded.statement")
    .run(id, ordinal, statement);
}
const indexed = (db: DatabaseSync) => db.prepare("SELECT claim_id FROM claim_fts ORDER BY claim_id").all().map((row) => row.claim_id);
const matching = (db: DatabaseSync, query: string) => db.prepare("SELECT claim_id FROM claim_fts WHERE claim_fts MATCH ? ORDER BY claim_id")
  .all(query).map((row) => row.claim_id);

describe("K4 claim FTS current verified prefix", () => {
  it("backfills only the published prefix and searches Russian literal trigrams", () => {
    const db = beforeK4();
    try {
      upsert(db, "a", 0, "Модель обучается на корпусе");
      upsert(db, "b", 1, "Unpublished trailing claim");
      db.exec("UPDATE source_revision SET claim_count=1 WHERE id='r'");
      db.exec(migration("0009_agents.sql"));
      expect(indexed(db)).toEqual(["a"]);
      expect(matching(db, '"обучается"')).toEqual(["a"]);
      expect(matching(db, '"Unpublished"')).toEqual([]);
    } finally { db.close(); }
  });

  it("indexes normal upserts before count publication and excludes retained rows after shrink", () => {
    const db = beforeK4();
    try {
      db.exec(migration("0009_agents.sql"));
      db.exec("UPDATE source_revision SET distill_state='running' WHERE id='r'");
      db.exec("BEGIN");
      upsert(db, "a", 0, "Original mechanism");
      upsert(db, "b", 1, "Trailing result");
      expect(indexed(db)).toEqual([]);
      db.exec("UPDATE source_revision SET claim_count=2 WHERE id='r' AND distill_state='running'");
      db.exec("COMMIT");
      expect(indexed(db)).toEqual(["a", "b"]);
      db.exec("BEGIN");
      upsert(db, "a-next", 0, "Corrected mechanism");
      db.exec("UPDATE source_revision SET claim_count=1 WHERE id='r' AND distill_state='running'");
      db.exec("COMMIT");
      expect(indexed(db)).toEqual(["a"]);
      expect(matching(db, '"Corrected"')).toEqual(["a"]);
      expect(matching(db, '"Original"')).toEqual([]);
      expect(matching(db, '"Trailing"')).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM claim").get()?.n).toBe(2);
    } finally { db.close(); }
  });

  it("refreshes existing text and a missing prefix row after checked recovery publishes the same count first", () => {
    const db = beforeK4();
    try {
      db.exec(migration("0009_agents.sql"));
      upsert(db, "a", 0, "Original mechanism");
      upsert(db, "c", 2, "Retained trailing claim");
      db.exec("UPDATE source_revision SET distill_state='partial',claim_count=2,distill_report_key='original' WHERE id='r'");
      expect(indexed(db)).toEqual(["a"]);
      db.exec("BEGIN");
      db.exec("UPDATE source_revision SET distill_state='done',claim_count=2,distill_report_key='checked' WHERE id='r' AND distill_state='partial' AND distill_report_key='original'");
      upsert(db, "a-recovered", 0, "Corrected mechanism");
      upsert(db, "b", 1, "Recovered prefix claim");
      db.exec("COMMIT");
      expect(indexed(db)).toEqual(["a", "b"]);
      expect(matching(db, '"Corrected"')).toEqual(["a"]);
      expect(matching(db, '"Original"')).toEqual([]);
      expect(matching(db, '"Recovered"')).toEqual(["b"]);
      expect(matching(db, '"Retained"')).toEqual([]);
      db.exec("UPDATE source_revision SET claim_count=1 WHERE id='r'");
      expect(indexed(db)).toEqual(["a"]);
      expect(matching(db, '"Recovered"')).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM claim").get()?.n).toBe(3);
    } finally { db.close(); }
  });
});
