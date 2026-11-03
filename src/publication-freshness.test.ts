import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "./auth";
import { getPage, PAGE_FRESHNESS_SQL, saveAnswer } from "./pages";
import { decideProposal } from "./proposals";
import { commitRevision } from "./ingest-completion";
import { applyOcrJob } from "./ocr";

const owner: Actor = { type: "owner", id: "owner", authentication: "access" };
const body = "Old evidence — неизменный ответ. [R1:b1]";
const citations = [{ revisionId: "r1", sourceId: "source", block: 1, start: 0, end: 17, sourceTitle: "Original", deleted: false, label: "R1:b1" }];
type Statement = { sql: string; args: SQLInputValue[]; bind(...args: SQLInputValue[]): Statement; run(): Promise<unknown>; first(): Promise<unknown>; all(): Promise<unknown> };
type Mode = "save" | "accept";

// All real migrations and strict transactional SQLite: no swallowed SQL errors.
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((s) => /^\d+.*\.sql$/.test(s)).sort()) db.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  db.exec("INSERT INTO project(id,title,created_at,updated_at) VALUES('project','Publication',1,1); INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('source','Original','file','owner',1,1)");
  db.exec("INSERT INTO source_revision(id,source_id,revision_no,original_key,original_mime,readable_state,created_by,created_at) VALUES('r1','source',1,'source/r1/original','application/pdf','readable','owner',1); UPDATE source SET current_revision_id='r1'; INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES('project','source','owner',1)");
  db.exec("INSERT INTO chat(id,project_id,created_by,created_at,updated_at) VALUES('chat','project','owner',1,1); INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,created_at) VALUES('chat','turn','fixture','explicit','[\"r1\"]','whole','completed',1)");
  const objects = new Map<string, { bytes: Uint8Array; etag: string; size: number }>();
  let serial = 0, batches = 0;
  function put(key: string, value: string | Uint8Array | ArrayBuffer) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    const object = { bytes, etag: "etag-" + (++serial), size: bytes.byteLength }; objects.set(key, object); return object;
  }
  const control = { beforeBatch: undefined as (() => Promise<void> | void) | undefined, afterBatch: undefined as (() => Promise<void> | void) | undefined, failBatch: false, loseReply: false };
  const prepare = (sql: string): Statement => ({ sql, args: [], bind(...args) { return { ...this, args }; },
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; },
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; },
    async run() { return { meta: { changes: Number(db.prepare(this.sql).run(...this.args).changes) } }; } });
  const stored = { state: "completed", answer: body, citations, revisionIds: ["r1"] };
  const getStoredTurn = vi.fn(async () => structuredClone(stored));
  const bucketPut = vi.fn(async (key: string, value: string | Uint8Array | ArrayBuffer, options?: { onlyIf?: unknown }) => options?.onlyIf && objects.has(key) ? null : put(key, value));
  const env = { DB: { prepare, async batch(statements: Statement[]) {
    batches++;
    const before = control.beforeBatch; control.beforeBatch = undefined; await before?.();
    if (control.failBatch) { control.failBatch = false; throw new Error("D1 unavailable before commit"); }
    db.exec("BEGIN"); const results: unknown[] = [];
    try { for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    const after = control.afterBatch; control.afterBatch = undefined; await after?.();
    if (control.loseReply) { control.loseReply = false; throw new Error("D1 committed, reply lost"); }
    return results;
  } }, BUCKET: { put: bucketPut, async get(key: string) { const o = objects.get(key); return o ? { ...o, text: async () => new TextDecoder().decode(o.bytes), json: async () => JSON.parse(new TextDecoder().decode(o.bytes)) as unknown, arrayBuffer: async () => o.bytes.slice().buffer } : null; }, async head(key: string) { return objects.get(key) ?? null; }, async delete(key: string) { objects.delete(key); } }, CHAT: { getByName: () => ({ getStoredTurn }) } } as unknown as Env;
  const page = (pageId: string) => db.prepare("SELECT head_revision_id,freshness,updated_at FROM page WHERE id=?").get(pageId);
  function proposal(scope: unknown = stored.revisionIds, pageId = crypto.randomUUID(), base: string | null = null) {
    if (!db.prepare("SELECT id FROM page WHERE id=?").get(pageId)) db.prepare("INSERT INTO page(id,project_id,kind,title,created_at,updated_at) VALUES(?,'project','note','Publication',1,1)").run(pageId);
    const id = crypto.randomUUID(), no = (db.prepare("SELECT COUNT(*) AS n FROM page_revision WHERE page_id=?").get(pageId)?.n as number) + 1;
    put(`page/${id}/body.md`, body); put(`page/${id}/citations.json`, JSON.stringify(citations));
    db.prepare("INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,citations_key,inputs_json,mutation_id,created_at,base_revision_id) VALUES(?,?,?,'proposed','agent','agent:fixture',?,?,?,?,1,?)")
      .run(id, pageId, no, `page/${id}/body.md`, `page/${id}/citations.json`, JSON.stringify(scope), id, base);
    return { id, pageId, base };
  }
  const accept = (p: ReturnType<typeof proposal>, decision: "accept" | "reject" = "accept") => decideProposal(env, owner, { projectId: "project", revisionId: p.id, decision, expectedHeadRevisionId: p.base });
  function publication(mode: Mode, scope: string[] = ["r1"]) {
    stored.revisionIds = scope; const mutationId = crypto.randomUUID(), p = mode === "accept" ? proposal(scope) : null;
    return async () => {
      const result = p ? await accept(p) : await saveAnswer(env, owner, { projectId: "project", chatId: "chat", turnId: "turn", title: "Publication", mutationId });
      const pageId = "pageId" in result ? result.pageId : result.id;
      return getPage(env, owner, { projectId: "project", pageId });
    };
  }
  function pending(state = "pending") {
    db.prepare("INSERT INTO source_revision(id,source_id,revision_no,original_key,readable_state,created_by,created_at) VALUES('r2','source',2,'source/r2/original',?,'owner',2)").run(state);
  }
  async function replace() {
    pending(); const text = put("source/r2/text.md", "Replacement."), blocks = put("source/r2/blocks.json", "[]");
    await commitRevision(env, { revisionId: "r2", sourceId: "source", revisionNo: 2, originalKey: "source/r2/original", mime: "text/plain", filename: "replacement.txt" }, { outcome: "readable", converter: "local_text", readableSize: text.size, blockCount: 0, warning: null, textEtag: text.etag, blocksEtag: blocks.etag, tokens: 0, calls: 0, ms: 1 });
  }
  async function ocr() {
    db.exec("INSERT INTO source_ocr_job(id,project_id,source_id,base_revision_id,base_current_revision_id,model_route,model_snapshot,page_count,state,completed_pages,token_limit,created_by,created_at,updated_at) VALUES('ocr','project','source','r1','r1','fixture','{}',1,'ready',1,100,'owner',1,1)");
    return applyOcrJob(env, owner, { projectId: "project", sourceId: "source", jobId: "ocr", text: "Reviewed OCR replacement." });
  }
  return { db, env, stored, page, proposal, accept, publication, pending, replace, ocr, objects, control, bucketPut, getStoredTurn, batches: () => batches };
}

describe.each<Mode>(["save", "accept"])("%s publication freshness", (mode) => {
  it.each([
    ["current", "", "current"],
    ["readable with warnings", "UPDATE source_revision SET readable_state='readable_with_warnings' WHERE id='r1'", "current"],
    ["archived and detached", "UPDATE source SET state='archived'; DELETE FROM project_source", "current"],
    ["null head", "UPDATE source SET current_revision_id=NULL", "stale"],
    ["deleted revision", "UPDATE source_revision SET deleted_at=2 WHERE id='r1'", "stale"],
    ["deleted source", "UPDATE source SET state='deleted'", "stale"],
    ["unreadable revision", "UPDATE source_revision SET readable_state='failed' WHERE id='r1'", "stale"],
  ])("handles %s inputs", async (_name, sql, freshness) => {
    const h = fixture(); try {
      h.db.exec(sql); const result = await h.publication(mode)();
      expect(result.freshness).toBe(freshness); expect(result.body).toBe(body); expect(result.citations).toEqual(citations);
      expect(h.db.prepare("SELECT inputs_json FROM page_revision WHERE id=?").get(result.headRevisionId)?.inputs_json).toBe('["r1"]');
    } finally { h.db.close(); }
  });
  it.each(["pending", "failed", "needs_conversion"])("keeps the readable current head while a newer replacement is %s", async (state) => {
    const h = fixture(); try { h.pending(state); expect((await h.publication(mode)()).freshness).toBe("current"); } finally { h.db.close(); }
  });
  it.each([["missing", "r1"], ["r1", "missing"]])("includes uncited inputs and preserves their order: %j", async (...scope) => {
    const h = fixture(); try {
      const result = await h.publication(mode, scope)(); expect(result.freshness).toBe("stale"); expect(result.citations).toEqual(citations);
      expect(h.db.prepare("SELECT inputs_json FROM page_revision WHERE id=?").get(result.headRevisionId)?.inputs_json).toBe(JSON.stringify(scope));
    } finally { h.db.close(); }
  });
  it("treats an empty recorded scope as current", async () => {
    const h = fixture(); try { expect((await h.publication(mode, [])()).freshness).toBe("current"); } finally { h.db.close(); }
  });
  it("stales a changed uncited contextual input while the cited source remains current", async () => {
    const h = fixture(); try {
      h.db.exec("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('context','Uncited context','text','owner',1,1); INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at) VALUES('context-old','context',1,'readable','owner',1),('context-new','context',2,'readable','owner',2); UPDATE source SET current_revision_id='context-new' WHERE id='context'");
      const result = await h.publication(mode, ["r1", "context-old"])();
      expect(result.freshness).toBe("stale"); expect(result.citations).toEqual(citations);
      expect(h.db.prepare("SELECT inputs_json FROM page_revision WHERE id=?").get(result.headRevisionId)?.inputs_json).toBe('["r1","context-old"]');
    } finally { h.db.close(); }
  });
  for (const writer of ["replace", "ocr"] as const) {
    it.each(["before", "after"])(`${writer} serializes %s publication without changing old evidence`, async (order) => {
      const h = fixture(); try {
        const publish = h.publication(mode); let atPublication: unknown;
        if (order === "before") h.control.beforeBatch = async () => { await h[writer](); };
        else h.control.afterBatch = async () => { atPublication = h.db.prepare("SELECT freshness FROM page WHERE head_revision_id IS NOT NULL").get()?.freshness; await h[writer](); };
        const result = await publish();
        expect(result.freshness).toBe("stale"); if (order === "after") expect(atPublication).toBe("current");
        expect(result.body).toBe(body); expect(result.citations).toEqual(citations);
        expect(new TextDecoder().decode(h.objects.get(`page/${result.headRevisionId}/citations.json`)?.bytes)).toBe(JSON.stringify(citations));
      } finally { h.db.close(); }
    });
  }
  it("replays the publication winner without writes or recomputing freshness", async () => {
    const h = fixture(); try {
      const publish = h.publication(mode), first = await publish();
      h.db.prepare("UPDATE page SET freshness='stale' WHERE id=?").run(first.id);
      const before = { batches: h.batches(), puts: h.bucketPut.mock.calls.length, reads: h.getStoredTurn.mock.calls.length, row: h.page(first.id) };
      const replay = await publish(); expect(replay.id).toBe(first.id); expect(replay.freshness).toBe("stale"); expect(h.page(first.id)).toEqual(before.row);
      expect(h.batches()).toBe(before.batches); expect(h.bucketPut).toHaveBeenCalledTimes(before.puts); expect(h.getStoredTurn).toHaveBeenCalledTimes(before.reads);
    } finally { h.db.close(); }
  });
  it.each(["before", "after"])("handles a failed %s-commit batch reply and explicit retry", async (where) => {
    const h = fixture(); try {
      const publish = h.publication(mode); await h.replace();
      if (where === "before") h.control.failBatch = true; else h.control.loseReply = true;
      if (where === "after" && mode === "save") expect((await publish()).freshness).toBe("stale");
      else await expect(publish()).rejects.toThrow();
      const winner = await publish(); expect(winner.freshness).toBe("stale");
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM page WHERE head_revision_id IS NOT NULL").get()?.n).toBe(1);
      const before = h.batches(); expect((await publish()).headRevisionId).toBe(winner.headRevisionId); expect(h.batches()).toBe(before);
    } finally { h.db.close(); }
  });
});

it("clears an old stale flag only for a newly accepted current head; reject, CAS loser and old acceptance replay leave the winner alone", async () => {
  const h = fixture(); try {
    const old = h.proposal(); await h.accept(old); await h.replace(); expect(h.page(old.pageId)?.freshness).toBe("stale");
    const winner = h.proposal(["r2"], old.pageId, old.id), loser = h.proposal(["r1"], old.pageId, old.id), rejected = h.proposal(["r1"], old.pageId, old.id);
    await h.accept(winner); expect(h.page(old.pageId)?.freshness).toBe("current"); const before = h.page(old.pageId);
    await expect(h.accept(loser)).rejects.toMatchObject({ code: "conflict" });
    await h.accept(rejected, "reject"); await h.accept(old);
    expect(h.page(old.pageId)).toEqual(before);
    expect(h.db.prepare("SELECT status FROM page_revision WHERE id=?").get(loser.id)?.status).toBe("proposed");
    const stale = h.proposal(["r1"], old.pageId, winner.id); await h.accept(stale); expect(h.page(old.pageId)?.freshness).toBe("stale");
  } finally { h.db.close(); }
});

it("rolls back status and freshness together on a failed head update, preserving migration ownership guards", async () => {
  const h = fixture(); try {
    const p = h.proposal(); h.db.exec("CREATE TRIGGER fail_head BEFORE UPDATE OF head_revision_id ON page BEGIN SELECT RAISE(ABORT,'head failure'); END");
    await expect(h.accept(p)).rejects.toThrow("head failure"); expect(h.page(p.pageId)?.head_revision_id).toBe(null);
    expect(h.db.prepare("SELECT status FROM page_revision WHERE id=?").get(p.id)?.status).toBe("proposed");
    h.db.exec("DROP TRIGGER fail_head"); await h.accept(p); expect(h.page(p.pageId)?.freshness).toBe("current");
    await expect(decideProposal(h.env, { type: "agent", id: "agent" } as Actor, { projectId: "project", revisionId: p.id, decision: "accept", expectedHeadRevisionId: null })).rejects.toThrow("Only the owner");
    await expect(decideProposal(h.env, owner, { projectId: "other", revisionId: p.id, decision: "accept", expectedHeadRevisionId: null })).rejects.toMatchObject({ code: "not_found" });
  } finally { h.db.close(); }
});

it("matches JSON string identities exactly, with invalid or non-array scopes fail-closed", async () => {
  const h = fixture(); try {
    h.db.exec("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('numeric','Numeric','text','owner',1,1); INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at) VALUES('1','numeric',1,'readable','owner',1); UPDATE source SET current_revision_id='1' WHERE id='numeric'");
    for (const [inputs, expected] of [['["1"]', "current"], ["[1]", "stale"], ["[null]", "stale"], ["{}", "stale"], ["null", "stale"], ["invalid", "stale"]] as const) {
      const p = h.proposal();
      // Keep immutable inputs immutable: insert a separate fixture row with the raw scope.
      const id = crypto.randomUUID(); h.db.prepare("INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,inputs_json,mutation_id,created_at) VALUES(?,?,2,'proposed','owner','owner','fixture',?,?,1)").run(id, p.pageId, inputs, id);
      expect(Object.values(h.db.prepare(PAGE_FRESHNESS_SQL).get(id) ?? {})[0]).toBe(expected);
    }
  } finally { h.db.close(); }
});
