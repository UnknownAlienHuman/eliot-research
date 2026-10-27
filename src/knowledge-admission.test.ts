import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { admitDistill, admitKnowledge, admitTurn, monthlyUsage } from "./cost";
import { LibraryError } from "./library";
import type { ModelSpec } from "./models";

// Synthetic arithmetic fixture: one call reserves 80 input + 20 output = 100
// micro-USD. No provider catalogue, model dispatch or network is part of this test.
const MODEL: ModelSpec = {
  route: "test:knowledge-admission",
  id: "knowledge-admission-fixture",
  label: "Admission fixture",
  contextTokens: 80,
  maxOutputTokens: 20,
  inputMicrousdPerMillion: 1_000_000,
  cachedMicrousdPerMillion: null,
  outputMicrousdPerMillion: 1_000_000,
  checkedOn: "2026-10-27",
  enabled: true,
};

interface UsageRow {
  state: string;
  cost: number | null;
  calls: number;
  model: string | null;
  startedAt: number | null;
  checkedOn: string | null;
  error: string | null;
}

function fixture(budget: number) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  // Match the K6 Wrangler migration selection; K4/0004 stays excluded.
  for (const name of [
    "0001_library.sql", "0002_ask.sql", "0003_distill.sql",
    "0005_model_gateway.sql", "0006_integrity.sql", "0007_project_knowledge.sql",
  ]) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));

  const now = Date.now();
  db.prepare("UPDATE settings SET monthly_model_budget_microusd=? WHERE id=1").run(budget);
  for (const project of ["a", "b"]) {
    db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES(?,?,?,?)")
      .run(project, "Project " + project, now, now);
    db.prepare("INSERT INTO page(id,project_id,kind,title,created_at,updated_at) VALUES(?,?,'map',?,?,?)")
      .run("page-" + project, project, "Map " + project, now, now);
  }
  function addRevision(project: string, id: string, revisionNo: number, active = true) {
    db.prepare(`INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,mutation_id,created_at)
      VALUES(?,?,?,'proposed','job','owner',?,?,?)`)
      .run(id, "page-" + project, revisionNo, "page/" + id + "/body.md", "mutation-" + id, now);
    if (active) db.prepare("UPDATE project SET knowledge_page_id=?,knowledge_active_revision_id=? WHERE id=?")
      .run("page-" + project, id, project);
  }
  addRevision("a", "a1", 1);
  addRevision("b", "b1", 1);

  // A D1-shaped boundary only; predicates, aggregates and changes run in SQLite.
  // Expose no AI, Workflow or R2 binding: admission must remain storage-only.
  const env = { DB: {
    prepare(sql: string) {
      return {
        bind(...params: SQLInputValue[]) {
          return {
            async first<T>(): Promise<T | null> {
              return (db.prepare(sql).get(...params) as T | undefined) ?? null;
            },
            async run() {
              return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
            },
          };
        },
      };
    },
  } } as unknown as Env;

  function row(id: string): UsageRow {
    const result = db.prepare(`SELECT generation_state AS state,model_estimated_cost_microusd AS cost,
      model_calls AS calls,model,model_started_at AS startedAt,model_pricing_checked_on AS checkedOn,
      generation_error AS error FROM page_revision WHERE id=?`).get(id);
    if (!result) throw new Error("Missing fixture revision: " + id);
    return result as unknown as UsageRow;
  }
  function otherJobs(chatCost: number | null = null, distillCost: number | null = null) {
    db.prepare("INSERT INTO chat(id,project_id,created_by,created_at,updated_at) VALUES('chat-b','b','owner',?,?)").run(now, now);
    db.prepare(`INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,created_at,estimated_cost_microusd)
      VALUES('chat-b','turn-b',?,'empty','[]','none','started',?,?)`).run(MODEL.route, now, chatCost);
    db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('source-b','Source','text','owner',?,?)").run(now, now);
    db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,created_by,created_at,distill_state,
      distill_started_at,distill_estimated_cost_microusd) VALUES('distill-b','source-b',1,'owner',?,'queued',?,?)`)
      .run(now, distillCost === null ? null : now, distillCost);
  }
  return { db, env, now, row, addRevision, otherJobs };
}

describe("K6 knowledge budget admission on migrated SQLite", () => {
  it("counts prior Refresh revisions alongside chat and distill without overwriting historical spend", async () => {
    const f = fixture(1_000);
    try {
      f.otherJobs(11, 13);
      await expect(admitKnowledge(f.env, "a1", MODEL, 1)).resolves.toBe(true);
      f.db.prepare(`UPDATE page_revision SET generation_state='done',model_calls=1,
        model_estimated_cost_microusd=60,status='accepted' WHERE id='a1'`).run();
      f.db.prepare("UPDATE page SET head_revision_id='a1' WHERE id='page-a'").run();
      f.addRevision("a", "a2", 2);
      await expect(admitKnowledge(f.env, "a2", MODEL, 1)).resolves.toBe(true);

      const usage = await monthlyUsage(f.env);
      expect(usage.monthlyUsedMicrousd).toBe(11 + 13 + 60 + 100);
      expect(f.row("a1")).toMatchObject({ state: "done", cost: 60, calls: 1 });
      expect(f.row("a2")).toMatchObject({ state: "running", cost: 100, calls: 0 });

      // An older month's generated revision remains stored but does not enter this month.
      f.addRevision("a", "previous-month", 3, false);
      f.db.prepare(`UPDATE page_revision SET generation_state='done',model_calls=2,
        model_estimated_cost_microusd=999,model_started_at=? WHERE id='previous-month'`)
        .run(usage.monthStart - 1);
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(184);
    } finally { f.db.close(); }
  });

  it("admits only one of two competing projects against the shared monthly cap", async () => {
    const f = fixture(150);
    try {
      // Both calls read the same preflight total before their conditional UPDATEs.
      const admitted = await Promise.all([
        admitKnowledge(f.env, "a1", MODEL, 1),
        admitKnowledge(f.env, "b1", MODEL, 1),
      ]);
      expect(admitted.filter(Boolean)).toHaveLength(1);
      const rows = [f.row("a1"), f.row("b1")];
      expect(rows.filter((row) => row.state === "running")).toHaveLength(1);
      expect(rows.find((row) => row.state === "running")).toMatchObject({ cost: 100, calls: 0 });
      expect(rows.find((row) => row.state === "paused")).toMatchObject({ cost: 0, calls: 0, startedAt: null, model: null });
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(100);
    } finally { f.db.close(); }
  });

  it("makes competing chat and distill admissions account for an already reserved knowledge job", async () => {
    const f = fixture(200);
    try {
      f.otherJobs();
      const outcomes = await Promise.allSettled([
        admitKnowledge(f.env, "a1", MODEL, 2),
        admitTurn(f.env, "chat-b", "turn-b", MODEL),
        admitDistill(f.env, "distill-b", MODEL),
      ]);
      expect(outcomes[0]).toEqual({ status: "fulfilled", value: true });
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status !== "rejected") throw new Error("Competing chat was unexpectedly admitted");
      expect(outcomes[1].reason).toMatchObject({ code: "budget", status: 409 });
      expect(outcomes[2]).toEqual({ status: "fulfilled", value: false });
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(200);
      expect(f.row("a1")).toMatchObject({ cost: 200, calls: 0 });
      expect(f.db.prepare("SELECT estimated_cost_microusd AS cost FROM chat_turn WHERE turn_id='turn-b'").get())
        .toMatchObject({ cost: null });
      expect(f.db.prepare(`SELECT distill_state AS state,distill_estimated_cost_microusd AS cost,
        distill_calls AS calls FROM source_revision WHERE id='distill-b'`).get())
        .toMatchObject({ state: "paused", cost: null, calls: 0 });
    } finally { f.db.close(); }
  });

  it("admits maxCalls=0 with a null model at zero budget", async () => {
    const f = fixture(0);
    try {
      await expect(admitKnowledge(f.env, "a1", null, 0)).resolves.toBe(true);
      expect(f.row("a1")).toMatchObject({ state: "running", cost: 0, calls: 0, model: null, checkedOn: null });
      expect(f.row("a1").startedAt).toBeGreaterThanOrEqual(f.now);
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(0);
    } finally { f.db.close(); }
  });

  it.each([
    { name: "absent model", model: null },
    { name: "unknown input price", model: { ...MODEL, inputMicrousdPerMillion: null } },
    { name: "unknown output price", model: { ...MODEL, outputMicrousdPerMillion: null } },
    { name: "unknown context", model: { ...MODEL, contextTokens: null } },
    { name: "unknown output bound", model: { ...MODEL, maxOutputTokens: null } },
  ])("cannot admit paid calls with $name", async ({ model }) => {
    const f = fixture(1_000);
    try {
      // Exercise missing metadata at the runtime boundary rather than inventing
      // non-null catalogue facts to satisfy ModelSpec's compile-time contract.
      const admitted = await admitKnowledge(f.env, "a1", model as unknown as ModelSpec | null, 1)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(LibraryError);
          expect(error).toMatchObject({ code: "unavailable", status: 503 });
          return false;
        });
      expect(admitted).toBe(false);
      const row = f.row("a1");
      expect(row.state).not.toBe("running");
      expect(row.startedAt).toBeNull();
      expect(row.calls).toBe(0);
      expect(row.cost === null || row.cost === 0).toBe(true);
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(0);
    } finally { f.db.close(); }
  });

  it("cannot reserve or spend against a revision that is no longer active", async () => {
    const f = fixture(1_000);
    try {
      f.addRevision("a", "a2", 2);
      await expect(admitKnowledge(f.env, "a1", MODEL, 2)).resolves.toBe(false);
      expect(f.row("a1")).toMatchObject({ calls: 0, startedAt: null, model: null, checkedOn: null });
      expect(f.row("a1").state).not.toBe("running");
      expect(f.row("a1").cost === null || f.row("a1").cost === 0).toBe(true);
      expect(f.row("a2")).toMatchObject({ state: "none", cost: null, calls: 0, startedAt: null });
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(0);
    } finally { f.db.close(); }
  });

  it("pauses a Refresh without adding a reservation or erasing the prior revision's spend", async () => {
    const f = fixture(150);
    try {
      await expect(admitKnowledge(f.env, "a1", MODEL, 1)).resolves.toBe(true);
      f.db.prepare("UPDATE page_revision SET generation_state='done',model_calls=1 WHERE id='a1'").run();
      const before = { ...f.row("a1") };
      f.addRevision("a", "a2", 2);
      await expect(admitKnowledge(f.env, "a2", MODEL, 1)).resolves.toBe(false);
      expect(f.row("a2")).toMatchObject({ state: "paused", cost: 0, calls: 0, startedAt: null, model: null });
      expect(f.row("a2").error).toMatch(/budget/i);
      expect(f.row("a1")).toEqual(before);
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(100);
      await expect(admitKnowledge(f.env, "a2", MODEL, 1)).resolves.toBe(false);
      expect((await monthlyUsage(f.env)).monthlyUsedMicrousd).toBe(100);
    } finally { f.db.close(); }
  });
});
