import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class { constructor(_ctx: unknown, readonly env: Env) {} } }));
import { IngestWorkflow } from "./ingest";
import { commitRevision, loadRevision, recoverIngest, STATUS_UNAVAILABLE, STORAGE_FAILURE } from "../ingest-completion";
import { addSource, getSource } from "../library";
import type { Actor } from "../auth";

const owner: Actor = { type: "owner", id: "owner", authentication: "access" };
type Statement = { sql: string; args: SQLInputValue[]; bind(...args: SQLInputValue[]): Statement; run(): Promise<unknown>; first(): Promise<unknown>; all(): Promise<unknown> };
function fixture(native = false) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../../migrations/", import.meta.url)).filter((s) => /^\d+.*\.sql$/.test(s)).sort()) db.exec(readFileSync(new URL("../../migrations/" + file, import.meta.url), "utf8"));
  db.exec("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('source','Fixture','file','owner',1,1)");
  db.prepare("INSERT INTO source_revision(id,source_id,revision_no,original_key,original_size,original_mime,original_filename,created_by,created_at) VALUES('revision','source',1,'source/revision/original',16,?,?,'owner',1)")
    .run(native ? "text/plain" : "application/pdf", native ? "fixture.txt" : "fixture.pdf");
  const control = { loadFailures: 0, batchFailures: 0, lostBatchReply: false, lostClaimReply: false, failBlocks: false, beforeBatch: undefined as (() => void) | undefined };
  const objects = new Map<string, { bytes: Uint8Array; etag: string; size: number }>();
  let serial = 0, batches = 0, output: unknown;
  function put(key: string, value: string | Uint8Array | ArrayBuffer) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    const object = { bytes, etag: "etag-" + (++serial), size: bytes.byteLength }; objects.set(key, object); return object;
  }
  put("source/revision/original", "Native original.");
  const prepare = (sql: string): Statement => ({ sql, args: [], bind(...args) { return { ...this, args }; },
    async first() { if (sql.startsWith("SELECT id,source_id") && control.loadFailures-- > 0) throw new Error("Load unavailable"); return db.prepare(this.sql).get(...this.args) ?? null; },
    async all() { return { results: db.prepare(this.sql).all(...this.args) }; },
    async run() {
      const info = db.prepare(this.sql).run(...this.args);
      if (control.lostClaimReply && sql.includes("SET conversion_calls = 1")) { control.lostClaimReply = false; throw new Error("Claim committed, reply lost"); }
      return { meta: { changes: Number(info.changes) } };
    } });
  const transform = vi.fn(async () => ({ format: "markdown", data: "Converted evidence with a real paragraph.", tokens: 7 as number | undefined }));
  const bucketPut = vi.fn(async (key: string, value: Uint8Array | string | ArrayBuffer, options?: { onlyIf?: unknown }) => {
    if (control.failBlocks && key.endsWith("blocks.json")) throw new Error("R2 blocks unavailable");
    if (options?.onlyIf && objects.has(key)) return null;
    return put(key, value);
  });
  const get = vi.fn(async (key: string) => { const object = objects.get(key); return object ? { ...object, arrayBuffer: async () => object.bytes.slice().buffer } : null; });
  const head = vi.fn(async (key: string) => objects.get(key) ?? null);
  const create = vi.fn(() => { throw new Error("Recovery must not create a Workflow"); });
  const status = vi.fn(async () => ({ status: "complete", output }));
  const env = { DB: { prepare, async batch(statements: Statement[]) {
    batches++; control.beforeBatch?.(); control.beforeBatch = undefined;
    if (control.batchFailures-- > 0) throw new Error("D1 unavailable before commit");
    db.exec("BEGIN"); let results: unknown[];
    try { results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
    if (control.lostBatchReply) { control.lostBatchReply = false; throw new Error("Batch committed, reply lost"); }
    return results;
  } }, BUCKET: { get, head, put: bucketPut }, AI: { toMarkdown: () => ({ supported: async () => [{ mimeType: "application/pdf", extension: "pdf" }], transform }) },
  INGEST: { get: async () => ({ status }), create } } as unknown as Env;
  const cache = new Map<string, unknown>(), attempts = new Map<string, number>(), configs = new Map<string, number>();
  const step = { async do(name: string, config: { retries: { limit: number } }, fn: () => Promise<unknown>) {
    configs.set(name, config.retries.limit);
    if (cache.has(name)) return cache.get(name);
    for (let retry = 0; ; retry++) {
      attempts.set(name, (attempts.get(name) ?? 0) + 1);
      try { const result = await fn(); cache.set(name, structuredClone(result)); return result; }
      catch (error) { if (retry >= config.retries.limit) throw error; }
    }
  } } as unknown as WorkflowStep;
  const run = async () => { output = await new IngestWorkflow({} as ExecutionContext, env).run({ payload: { revisionId: "revision" } } as WorkflowEvent<{ revisionId: string }>, step); return output; };
  const row = () => db.prepare("SELECT * FROM source_revision WHERE id='revision'").get();
  const current = () => db.prepare("SELECT current_revision_id FROM source WHERE id='source'").get();
  return { db, env, run, row, current, control, objects, bucketPut, get, head, transform, create, status, cache, attempts, configs, put, batches: () => batches };
}
describe("Ingest storage completion", () => {
  it("retries only load/commit and preserves one converted result across cached Workflow replay", async () => {
    const h = fixture();
    try {
      h.control.batchFailures = 1; await h.run();
      expect(h.configs.get("load revision")).toBe(2); expect(h.configs.get("convert and store")).toBe(0); expect(h.configs.get("commit revision")).toBe(2);
      expect(h.attempts.get("commit revision")).toBe(2); expect(h.transform).toHaveBeenCalledTimes(1); expect(h.bucketPut).toHaveBeenCalledTimes(2);
      expect(h.row()).toMatchObject({ readable_state: "readable", conversion_calls: 1, conversion_tokens: 7 });
      expect(h.current()).toEqual({ current_revision_id: "revision" });
      h.cache.delete("commit revision"); await h.run();
      expect(h.transform).toHaveBeenCalledTimes(1); expect(h.bucketPut).toHaveBeenCalledTimes(2); expect(h.create).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("recovers exhausted commit from Workflow output on a source read without restarting conversion", async () => {
    const h = fixture();
    try {
      h.control.batchFailures = 3; await h.run();
      expect(h.row()).toMatchObject({ readable_state: "failed", error: STORAGE_FAILURE, conversion_calls: 1, conversion_tokens: 7 });
      expect(h.current()).toEqual({ current_revision_id: null }); expect(h.attempts.get("commit revision")).toBe(3);
      const result = await getSource(h.env, owner, "source");
      expect(result.source).toMatchObject({ readableState: "readable", currentRevisionId: "revision", conversionCalls: 1, conversionTokens: 7, error: null });
      await getSource(h.env, owner, "source");
      expect(h.transform).toHaveBeenCalledTimes(1); expect(h.bucketPut).toHaveBeenCalledTimes(2); expect(h.create).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("adopts a committed batch with a lost reply and repairs an older readable-but-unpublished result", async () => {
    const h = fixture(true);
    try {
      h.control.lostBatchReply = true; await h.run();
      expect(h.batches()).toBe(1); expect(h.row()).toMatchObject({ readable_state: "readable", conversion_calls: 0, conversion_tokens: 0 });
      h.db.exec("UPDATE source SET current_revision_id=NULL");
      await getSource(h.env, owner, "source");
      expect(h.current()).toEqual({ current_revision_id: "revision" }); expect(h.transform).not.toHaveBeenCalled();
      expect(h.bucketPut).toHaveBeenCalledTimes(2);
    } finally { h.db.close(); }
  });
  it("rolls back readability with the head write instead of leaving partial publication", async () => {
    const h = fixture(true);
    try {
      h.db.exec("CREATE TRIGGER fail_head BEFORE UPDATE OF current_revision_id ON source BEGIN SELECT RAISE(ABORT,'head unavailable'); END");
      await h.run();
      expect(h.row()).toMatchObject({ readable_state: "failed", error: STORAGE_FAILURE, readable_size: null, block_count: null });
      expect(h.current()).toEqual({ current_revision_id: null });
      h.db.exec("DROP TRIGGER fail_head"); await getSource(h.env, owner, "source");
      expect(h.row()).toMatchObject({ readable_state: "readable" }); expect(h.current()).toEqual({ current_revision_id: "revision" });
    } finally { h.db.close(); }
  });
  it("keeps an ambiguous durable call reservation without dispatch or resetting it to zero", async () => {
    const h = fixture();
    try {
      h.control.lostClaimReply = true; await h.run();
      expect(h.row()).toMatchObject({ readable_state: "failed", conversion_calls: 1, conversion_tokens: null });
      expect(h.transform).not.toHaveBeenCalled(); expect(h.current()).toEqual({ current_revision_id: null });
    } finally { h.db.close(); }
  });
  it("does not repeat conversion after a partial R2 store or an uncached convert callback replay", async () => {
    const h = fixture();
    try {
      h.control.failBlocks = true; await h.run();
      const text = h.objects.get("source/revision/text.md");
      expect(text).toBeDefined(); expect(h.objects.has("source/revision/blocks.json")).toBe(false);
      expect(h.row()).toMatchObject({ readable_state: "failed", conversion_calls: 1, conversion_tokens: 7 });
      h.cache.delete("convert and store"); h.cache.delete("commit revision");
      h.db.exec("UPDATE source_revision SET readable_state='pending' WHERE id='revision'");
      await h.run(); expect(h.transform).toHaveBeenCalledTimes(1); expect(h.objects.get("source/revision/text.md")).toEqual(text);
      expect(h.row()).toMatchObject({ readable_state: "failed", conversion_calls: 1, conversion_tokens: 7 });
    } finally { h.db.close(); }
  });
  it.each(["readable", "pending"])("preserves the newer-%s replacement head guard", async (state) => {
    const h = fixture(true);
    try {
      h.control.beforeBatch = () => {
        h.db.prepare("INSERT INTO source_revision(id,source_id,revision_no,original_key,readable_state,created_by,created_at) VALUES('newer','source',2,'newer/original',?,'owner',2)").run(state);
        if (state === "readable") h.db.exec("UPDATE source SET current_revision_id='newer' WHERE id='source'");
      };
      await h.run();
      expect(h.current()).toEqual({ current_revision_id: state === "readable" ? "newer" : "revision" });
      expect(h.row()).toMatchObject({ readable_state: state === "readable" ? "readable_with_warnings" : "readable", conversion_calls: 0, conversion_tokens: 0 });
      if (state === "readable") expect(h.row()).toMatchObject({ warning_summary: expect.stringContaining("newer revision") });
    } finally { h.db.close(); }
  });
  it("rejects changed artifacts and mismatched Workflow identity without overwriting or calling a converter", async () => {
    const h = fixture();
    try {
      h.control.batchFailures = 3; await h.run();
      h.put("source/revision/blocks.json", "changed");
      expect(await recoverIngest(h.env, "revision")).toBe(STORAGE_FAILURE);
      expect(h.row()).toMatchObject({ readable_state: "failed", error: STORAGE_FAILURE }); expect(h.current()).toEqual({ current_revision_id: null });
      const loaded = await loadRevision(h.env, "revision"); expect(loaded).not.toBeNull();
      h.status.mockResolvedValueOnce({ status: "complete", output: { revisionId: "another", stored: h.cache.get("convert and store") } });
      await recoverIngest(h.env, "revision"); expect(h.transform).toHaveBeenCalledTimes(1); expect(h.create).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("does not overwrite a different terminal conversion projection", async () => {
    const h = fixture(true);
    try {
      await h.run(); const loaded = await loadRevision(h.env, "revision");
      if (!loaded) throw new Error("Fixture revision missing");
      const stored = h.cache.get("convert and store") as Parameters<typeof commitRevision>[2];
      h.db.exec("UPDATE source_revision SET conversion_tokens=99 WHERE id='revision'");
      await expect(commitRevision(h.env, loaded, stored)).rejects.toThrow("differs");
      expect(h.row()).toMatchObject({ conversion_tokens: 99 }); expect(h.transform).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it.each(["queued", "running", "waiting", "paused", "errored", "terminated", "unknown", "status-error"])("reconciles %s status without recreating a Workflow", async (state) => {
    const h = fixture();
    try {
      h.db.prepare("UPDATE source_revision SET error=? WHERE id='revision'").run(STATUS_UNAVAILABLE);
      if (state === "status-error") h.status.mockRejectedValueOnce(new Error("Status unavailable"));
      else h.status.mockResolvedValueOnce({ status: state, output: undefined });
      const result = await getSource(h.env, owner, "source");
      const active = ["queued", "running", "waiting", "paused", "unknown", "status-error"].includes(state);
      expect(result.source.readableState).toBe(active ? "pending" : "failed");
      if (state === "status-error" || state === "unknown") expect(result.source.error).toBe(STATUS_UNAVAILABLE);
      else if (!active) expect(result.source.error).toBe(STORAGE_FAILURE);
      else expect(result.source.error).toBeNull();
      expect(h.transform).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("exhausts load storage retries as an actionable failure without reaching conversion", async () => {
    const h = fixture();
    try {
      h.control.loadFailures = 3; await h.run();
      expect(h.attempts.get("load revision")).toBe(3); expect(h.attempts.has("convert and store")).toBe(false);
      expect(h.row()).toMatchObject({ readable_state: "failed", error: STORAGE_FAILURE, conversion_calls: 0, conversion_tokens: null });
      await getSource(h.env, owner, "source"); expect(h.transform).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("never overwrites colliding canonical R2 keys", async () => {
    const h = fixture(true);
    try {
      const prior = h.put("source/revision/text.md", "Prior immutable bytes");
      await h.run(); expect(h.objects.get("source/revision/text.md")).toEqual(prior);
      expect(h.objects.has("source/revision/blocks.json")).toBe(false);
      expect(h.row()).toMatchObject({ readable_state: "failed", conversion_calls: 0, conversion_tokens: 0 });
      expect(h.current()).toEqual({ current_revision_id: null }); expect(h.transform).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it.each([false, true])("stales only exact accepted-head dependencies in the winning publication batch (head fault=%s)", async (headFault) => {
    const h = fixture(true);
    try {
      h.db.exec("INSERT INTO project(id,title,created_at,updated_at) VALUES('project','Fixture',1,1)");
      h.db.exec("INSERT INTO source_revision(id,source_id,revision_no,original_key,readable_state,created_by,created_at) VALUES('old','source',0,'old/original','readable','owner',0)");
      h.db.exec("UPDATE source SET current_revision_id='old'");
      for (const [page, inputs] of [["dependent", '["old"]'], ["unrelated", '["oldish"]'], ["numeric", '[0]']] as const) {
        h.db.prepare("INSERT INTO page(id,project_id,kind,title,created_at,updated_at) VALUES(?,'project','note',?,1,1)").run(page, page);
        h.db.prepare("INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,inputs_json,mutation_id,created_at) VALUES(?,?,1,'accepted','owner','owner','fixture',?,?,1)").run(page + '-head', page, inputs, page);
        h.db.prepare("UPDATE page SET head_revision_id=? WHERE id=?").run(page + '-head', page);
      }
      if (headFault) h.db.exec("CREATE TRIGGER fail_head BEFORE UPDATE OF current_revision_id ON source BEGIN SELECT RAISE(ABORT,'head unavailable'); END");
      await h.run();
      expect(h.db.prepare("SELECT id,freshness FROM page ORDER BY id").all()).toEqual([
        { id: "dependent", freshness: headFault ? "current" : "stale" }, { id: "numeric", freshness: "current" }, { id: "unrelated", freshness: "current" },
      ]);
      expect(h.current()).toEqual({ current_revision_id: headFault ? "old" : "revision" });
    } finally { h.db.close(); }
  });
  it("retains uncertain create identity and clears its warning after confirming the existing job is running", async () => {
    const h = fixture();
    try {
      h.db.exec("INSERT INTO project(id,title,created_at,updated_at)VALUES('project','Fixture',1,1)");
      h.status.mockRejectedValueOnce(new Error("Create/status reply unavailable"));
      const created = await addSource(h.env, owner, "project", { title: "New upload", kind: "text", bytes: new TextEncoder().encode("New original").buffer, filename: "new.txt", mimeType: "text/plain" });
      expect(created.state).toBe("pending"); expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.db.prepare("SELECT readable_state,error FROM source_revision WHERE id=?").get(created.revisionId)).toEqual({ readable_state: "pending", error: STATUS_UNAVAILABLE });
      h.status.mockResolvedValueOnce({ status: "running", output: undefined });
      expect((await getSource(h.env, owner, created.sourceId)).source).toMatchObject({ readableState: "pending", error: null });
      expect(h.create).toHaveBeenCalledTimes(1); expect(h.transform).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("retains a confirmed zero call count when the claim fails before dispatch", async () => {
    const h = fixture();
    try {
      h.db.exec("CREATE TRIGGER fail_claim BEFORE UPDATE OF conversion_calls ON source_revision WHEN NEW.conversion_calls=1 AND OLD.conversion_calls=0 BEGIN SELECT RAISE(ABORT,'claim failed'); END");
      await h.run(); expect(h.row()).toMatchObject({ readable_state: "failed", conversion_calls: 0 }); expect(h.transform).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("retains unavailable conversion usage as null through failed commit and reader completion", async () => {
    const h = fixture();
    try {
      h.transform.mockResolvedValueOnce({ format: "markdown", data: "Converted evidence with a real paragraph.", tokens: undefined });
      h.control.batchFailures = 3; await h.run();
      expect(h.row()).toMatchObject({ readable_state: "failed", conversion_calls: 1, conversion_tokens: null });
      await getSource(h.env, owner, "source"); expect(h.row()).toMatchObject({ readable_state: "readable", conversion_calls: 1, conversion_tokens: null });
      expect(h.transform).toHaveBeenCalledTimes(1);
    } finally { h.db.close(); }
  });
  it("recovers a requested older revision without stealing its newer readable head", async () => {
    const h = fixture();
    try {
      h.control.batchFailures = 3; await h.run();
      h.db.exec("INSERT INTO source_revision(id,source_id,revision_no,original_key,readable_state,created_by,created_at) VALUES('newer','source',2,'newer/original','readable','owner',2)");
      h.db.exec("UPDATE source SET current_revision_id='newer'");
      const result = await getSource(h.env, owner, "source", "revision");
      expect(result.source.currentRevisionId).toBe("newer");
      expect(result.revisions.find((revision) => revision.id === "revision")).toMatchObject({ readableState: "readable_with_warnings", conversionCalls: 1, conversionTokens: 7 });
      expect(h.transform).toHaveBeenCalledTimes(1);
    } finally { h.db.close(); }
  });
  it("does not publish a revision deleted between conversion and the completion transaction", async () => {
    const h = fixture(true);
    try {
      h.control.beforeBatch = () => { h.db.exec("UPDATE source_revision SET deleted_at=2 WHERE id='revision'"); };
      await h.run(); expect(h.current()).toEqual({ current_revision_id: null }); expect(h.row()).toMatchObject({ deleted_at: 2 });
      expect(h.objects.has("source/revision/original")).toBe(true); expect(h.transform).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
  it("does not advance a head when a conflicting terminal projection wins before the publication batch", async () => {
    const h = fixture(true);
    try {
      h.control.beforeBatch = () => {
        const stored = h.cache.get("convert and store") as { ms: number; readableSize: number; blockCount: number };
        h.db.prepare("UPDATE source_revision SET readable_state='readable',converter='local_text',readable_size=?,block_count=?,conversion_ms=?,conversion_tokens=99 WHERE id='revision'")
          .run(stored.readableSize, stored.blockCount, stored.ms);
      };
      await h.run(); expect(h.row()).toMatchObject({ readable_state: "readable", conversion_tokens: 99 });
      expect(h.current()).toEqual({ current_revision_id: null }); expect(h.transform).not.toHaveBeenCalled();
    } finally { h.db.close(); }
  });
});
