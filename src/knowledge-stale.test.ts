import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Exercise the shipped schema and K6 triggers directly, with foreign keys enabled.
// No copied trigger SQL, D1 mocks, Workflow, model or network boundary.
describe("K6 page staleness on migrated SQLite", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const name of [
      "0001_library.sql", "0002_ask.sql", "0003_distill.sql",
      "0005_model_gateway.sql", "0006_integrity.sql", "0007_project_knowledge.sql",
    ]) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));

    for (const projectId of ["a", "b"]) {
      db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES(?,?,0,0)")
        .run(projectId, "Project " + projectId);
    }
    for (const sourceId of ["shared", "other", "new"]) {
      db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES(?,?,'text','owner',0,0)")
        .run(sourceId, sourceId);
      db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at)
        VALUES(?,?,1,'readable','owner',0)`).run(sourceId + "-v1", sourceId);
      db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run(sourceId + "-v1", sourceId);
    }
    db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at)
      VALUES('shared-v2','shared',2,'readable','owner',1)`).run();
    for (const projectId of ["a", "b"]) {
      for (const sourceId of ["shared", "other"]) {
        db.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES(?,?,'owner',0)")
          .run(projectId, sourceId);
      }
    }
  });

  afterEach(() => { db.close(); });

  function addHead(pageId: string, revisionNo: number, inputs: string[]): void {
    const revisionId = pageId + "-r" + revisionNo;
    db.prepare(`INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,inputs_json,mutation_id,created_at)
      VALUES(?,?,?,'accepted','job','owner',?,?,?,?)`)
      .run(revisionId, pageId, revisionNo, "page/" + revisionId + "/body.md", JSON.stringify(inputs), "mutation-" + revisionId, revisionNo);
    db.prepare("UPDATE page SET head_revision_id=? WHERE id=?").run(revisionId, pageId);
  }

  function addPage(pageId: string, projectId: string, inputs: string[], kind: "wiki" | "map" = "wiki"): void {
    db.prepare("INSERT INTO page(id,project_id,kind,title,created_at,updated_at) VALUES(?,?,?,?,0,0)")
      .run(pageId, projectId, kind, pageId);
    addHead(pageId, 1, inputs);
  }

  it("stales heads using the replaced revision across projects while leaving unrelated inputs current", () => {
    addPage("a-dependent", "a", ["other-v1", "shared-v1"]);
    addPage("a-unrelated", "a", ["other-v1"]);
    addPage("b-dependent", "b", ["shared-v1"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM page WHERE freshness='current'").get()).toEqual({ count: 3 });

    db.prepare("UPDATE source SET current_revision_id='shared-v2' WHERE id='shared'").run();

    expect(db.prepare("SELECT id,freshness FROM page ORDER BY id").all()).toEqual([
      { id: "a-dependent", freshness: "stale" },
      { id: "a-unrelated", freshness: "current" },
      { id: "b-dependent", freshness: "stale" },
    ]);
    expect(db.prepare("SELECT current_revision_id FROM source WHERE id='shared'").get())
      .toEqual({ current_revision_id: "shared-v2" });
  });

  it("ignores an old accepted non-head revision when replacing its source", () => {
    addPage("dependent", "a", ["shared-v1"]);
    addPage("history-only", "a", ["shared-v1"]);
    addHead("history-only", 2, ["other-v1"]);
    expect(db.prepare("SELECT head_revision_id,freshness FROM page WHERE id='history-only'").get())
      .toEqual({ head_revision_id: "history-only-r2", freshness: "current" });

    db.prepare("UPDATE source SET current_revision_id='shared-v2' WHERE id='shared'").run();

    expect(db.prepare("SELECT id,freshness FROM page ORDER BY id").all()).toEqual([
      { id: "dependent", freshness: "stale" },
      { id: "history-only", freshness: "current" },
    ]);
    expect(db.prepare("SELECT status,inputs_json FROM page_revision WHERE id='history-only-r1'").get())
      .toEqual({ status: "accepted", inputs_json: '["shared-v1"]' });
  });

  it("limits detach staleness to the affected project's dependencies and map anchor", () => {
    for (const projectId of ["a", "b"]) {
      addPage(projectId + "-dependent", projectId, ["shared-v1"]);
      addPage(projectId + "-map", projectId, ["other-v1"], "map");
      addPage(projectId + "-unrelated", projectId, ["other-v1"]);
      db.prepare("UPDATE project SET knowledge_page_id=? WHERE id=?").run(projectId + "-map", projectId);
    }

    db.prepare("DELETE FROM project_source WHERE project_id='a' AND source_id='shared'").run();

    expect(db.prepare("SELECT id,freshness FROM page ORDER BY id").all()).toEqual([
      { id: "a-dependent", freshness: "stale" },
      { id: "a-map", freshness: "stale" },
      { id: "a-unrelated", freshness: "current" },
      { id: "b-dependent", freshness: "current" },
      { id: "b-map", freshness: "current" },
      { id: "b-unrelated", freshness: "current" },
    ]);
    expect(db.prepare("SELECT project_id FROM project_source WHERE source_id='shared'").all())
      .toEqual([{ project_id: "b" }]);
  });

  it("does not stale a current head on detach merely because an older page revision used that source", () => {
    addPage("dependent", "a", ["shared-v1"]);
    addPage("history-only", "a", ["shared-v1"]);
    addHead("history-only", 2, ["other-v1"]);

    db.prepare("DELETE FROM project_source WHERE project_id='a' AND source_id='shared'").run();

    expect(db.prepare("SELECT id,freshness FROM page ORDER BY id").all()).toEqual([
      { id: "dependent", freshness: "stale" },
      { id: "history-only", freshness: "current" },
    ]);
  });

  it("stales only the attaching project's anchored map, keeping Wiki pages and other maps current", () => {
    addPage("a-map", "a", ["shared-v1"], "map");
    addPage("a-unanchored-map", "a", ["shared-v1"], "map");
    addPage("a-wiki", "a", ["other-v1"]);
    addPage("b-map", "b", ["shared-v1"], "map");
    addPage("b-wiki", "b", ["other-v1"]);
    for (const projectId of ["a", "b"]) {
      db.prepare("UPDATE project SET knowledge_page_id=? WHERE id=?").run(projectId + "-map", projectId);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM page WHERE freshness='current'").get()).toEqual({ count: 5 });

    db.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES('a','new','owner',1)").run();

    expect(db.prepare("SELECT id,freshness FROM page ORDER BY id").all()).toEqual([
      { id: "a-map", freshness: "stale" },
      { id: "a-unanchored-map", freshness: "current" },
      { id: "a-wiki", freshness: "current" },
      { id: "b-map", freshness: "current" },
      { id: "b-wiki", freshness: "current" },
    ]);
  });
});
