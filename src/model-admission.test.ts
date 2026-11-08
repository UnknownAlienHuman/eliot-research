import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { admitTurn } from "./cost";
import { modelOutputLimit, modelTokenLimit, requestedOutputLimit, type ModelSpec } from "./models";

const model: ModelSpec = { route: "gateway:fixture/model", id: "model", label: "Fixture",
  contextTokens: 64000, maxOutputTokens: null, outputReserveTokens: 8192, checkedOn: "2026-11-04", enabled: true };

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001_library", "0002_ask", "0003_distill", "0005_model_gateway", "0006_integrity", "0007_manual_understanding", "0008_model_providers"])
    db.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8"));
  db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES ('p','Fixture',0,0)").run();
  db.prepare("INSERT INTO chat(id,project_id,created_by,created_at,updated_at) VALUES ('c','p','owner',0,0)").run();
  const insert = db.prepare("INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,token_limit,created_at) VALUES ('c',?,'gateway:fixture/model','empty','[]','none',?,?,0)");
  insert.run("terminal", "completed", 72192);
  insert.run("old-started", "started", 72192);
  insert.run("new", "started", null);
  const legacy = db.prepare("SELECT * FROM chat_turn WHERE turn_id='terminal'").get();
  db.exec(readFileSync(new URL("../migrations/0012_model_admission.sql", import.meta.url), "utf8"));
  const env = { DB: { prepare(sql: string) {
    const operations = (args: SQLInputValue[]) => ({
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    });
    return { ...operations([]), bind: (...args: SQLInputValue[]) => operations(args) };
  } } } as unknown as Env;
  return { db, env, legacy };
}

describe("strict migrated model admission", () => {
  it.each(["included", "standard"])("admits native GLM with legacy %s untouched and keeps one claim", async (mode) => {
    const f = fixture();
    const native = { ...model, route: "workers-ai:@cf/zai-org/glm-4.7-flash", id: "@cf/zai-org/glm-4.7-flash" };
    try {
      f.db.prepare("UPDATE settings SET native_usage_mode=? WHERE id=1").run(mode);
      const settings = f.db.prepare("SELECT * FROM settings WHERE id=1").get();
      const results = await Promise.allSettled([admitTurn(f.env, "c", "new", native), admitTurn(f.env, "c", "new", native)]);
      expect(results.filter((r) => r.status === "fulfilled")).toEqual([{ status: "fulfilled", value: null }]);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(f.db.prepare("SELECT * FROM settings WHERE id=1").get()).toEqual(settings);
      expect(f.db.prepare("SELECT token_limit,token_limit_kind,input_tokens,output_tokens FROM chat_turn WHERE turn_id='new'").get())
        .toEqual({ token_limit: null, token_limit_kind: "unknown", input_tokens: null, output_tokens: null });
    } finally { f.db.close(); }
  });

  it("preserves legacy terminal values and only marks already admitted started rows", () => {
    const f = fixture();
    try {
      expect(f.db.prepare("SELECT turn_id,token_limit,token_limit_kind FROM chat_turn ORDER BY turn_id").all()).toEqual([
        { turn_id: "new", token_limit: null, token_limit_kind: null },
        { turn_id: "old-started", token_limit: 72192, token_limit_kind: "legacy" },
        { turn_id: "terminal", token_limit: 72192, token_limit_kind: null },
      ]);
      expect(() => f.db.prepare("UPDATE chat_turn SET token_limit_kind='legacy' WHERE turn_id='terminal'").run()).toThrow("terminal_chat_turn_is_immutable");
      const row = f.db.prepare("SELECT * FROM chat_turn WHERE turn_id='terminal'").get();
      if (!row) throw new Error("The legacy receipt disappeared.");
      const { token_limit_kind, ...unchanged } = row;
      expect(token_limit_kind).toBeNull();
      expect(unchanged).toEqual(f.legacy);
      expect(() => f.db.prepare("UPDATE chat_turn SET state='partial',token_limit=NULL WHERE turn_id='old-started'").run()).toThrow("admission_is_immutable");
    } finally { f.db.close(); }
  });

  it("claims an unknown bound exactly once under concurrent admission", async () => {
    const f = fixture();
    try {
      const results = await Promise.allSettled([admitTurn(f.env, "c", "new", model), admitTurn(f.env, "c", "new", model)]);
      expect(results.filter((r) => r.status === "fulfilled")).toEqual([{ status: "fulfilled", value: null }]);
      expect(f.db.prepare("SELECT token_limit,token_limit_kind FROM chat_turn WHERE turn_id='new'").get())
        .toEqual({ token_limit: null, token_limit_kind: "unknown" });
      await expect(admitTurn(f.env, "c", "new", model)).rejects.toMatchObject({ code: "conflict" });
      expect(() => f.db.prepare("UPDATE chat_turn SET token_limit_kind=NULL WHERE turn_id='new'").run()).toThrow("admission_is_immutable");
      expect(() => f.db.prepare("UPDATE chat_turn SET token_limit=10 WHERE turn_id='new'").run()).toThrow("admission_is_immutable");
      expect(() => f.db.prepare("UPDATE chat_turn SET state='partial',token_limit=10,input_tokens=1,output_tokens=1 WHERE turn_id='new'").run()).toThrow("admission_is_immutable");
      f.db.prepare("UPDATE chat_turn SET state='failed',token_limit=0,input_tokens=0,cached_tokens=0,output_tokens=0 WHERE turn_id='new'").run();
      expect(f.db.prepare("SELECT state,token_limit,token_limit_kind FROM chat_turn WHERE turn_id='new'").get())
        .toEqual({ state: "failed", token_limit: 0, token_limit_kind: "unknown" });
    } finally { f.db.close(); }
  });

  it("records the Crouton combined window once without changing reported usage or old admissions", async () => {
    const f = fixture();
    const crouton = { ...model, contextTokens: 1048576, contextWindowTokens: 1048576, maxOutputTokens: 943718 };
    try {
      await expect(admitTurn(f.env, "c", "new", crouton)).resolves.toBe(1048576);
      await expect(admitTurn(f.env, "c", "new", crouton)).rejects.toMatchObject({ code: "conflict" });
      f.db.prepare("UPDATE chat_turn SET state='completed',input_tokens=43702,cached_tokens=0,output_tokens=1049 WHERE turn_id='new'").run();
      expect(f.db.prepare("SELECT token_limit,token_limit_kind,input_tokens,output_tokens FROM chat_turn WHERE turn_id='new'").get())
        .toEqual({ token_limit: 1048576, token_limit_kind: "published", input_tokens: 43702, output_tokens: 1049 });
      await expect(admitTurn(f.env, "c", "old-started", crouton)).rejects.toMatchObject({ code: "conflict" });
      expect(f.db.prepare("SELECT token_limit FROM chat_turn WHERE turn_id='old-started'").get()).toEqual({ token_limit: 72192 });
    } finally { f.db.close(); }
  });

  it("caps total capacity only by a known combined window, independently of reserve", () => {
    const known = { ...model, maxOutputTokens: 32768 };
    expect(modelTokenLimit({ ...known, contextWindowTokens: 64000 })).toBe(64000);
    expect(modelTokenLimit({ ...known, contextWindowTokens: 80000 })).toBe(80000);
    expect(modelTokenLimit({ ...known, contextWindowTokens: 128000 })).toBe(96768);
    const differentReserve = { ...known, contextWindowTokens: 64000, outputReserveTokens: 1 };
    expect(modelTokenLimit(differentReserve)).toBe(64000);
    expect(modelTokenLimit({ ...model, contextWindowTokens: 64000 })).toBeNull();
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid combined accounting window %s", (contextWindowTokens) => {
    expect(() => modelTokenLimit({ ...model, contextWindowTokens, maxOutputTokens: 32768 })).toThrow();
  });

  it("uses independent declared input and output capacities, with no invented unknown maximum", () => {
    expect(modelTokenLimit(model)).toBeNull();
    expect(modelTokenLimit({ ...model, maxOutputTokens: 32768 })).toBe(96768);
    expect(modelTokenLimit({ ...model, maxOutputTokens: 4096 })).toBe(68096);
    expect(modelOutputLimit({ ...model, contextWindowTokens: 128000, maxOutputTokens: 65536 }, 40000)).toBe(65536);
    expect(modelOutputLimit({ ...model, contextTokens: 120000, contextWindowTokens: 128000, maxOutputTokens: 65536 }, 100000)).toBe(28000);
  });

  it("applies a job output budget independently from provider metadata and assembly reserve", () => {
    expect(requestedOutputLimit(model, 40000, 8192)).toBe(8192);
    expect(requestedOutputLimit({ ...model, maxOutputTokens: 4096 }, 40000, 8192)).toBe(4096);
    expect(requestedOutputLimit({ ...model, contextWindowTokens: 44000 }, 40000, 8192)).toBe(4000);
    expect(requestedOutputLimit({ ...model, contextWindowTokens: 44000, maxOutputTokens: 2048 }, 40000, 8192)).toBe(2048);
    // Without a published combined window, input-only context metadata does not reduce the explicit job budget.
    expect(requestedOutputLimit({ ...model, contextTokens: 64000 }, 63999, 8192)).toBe(8192);
    expect(model.maxOutputTokens).toBeNull();
    expect(model.outputReserveTokens).toBe(8192);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid job output budget %s", (requestedTokens) => {
    expect(() => requestedOutputLimit(model, 1024, requestedTokens)).toThrow();
  });
});
