import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import type * as ModelTransport from "./model-transport";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(_ctx: unknown, readonly env: Env) {}
  },
}));
vi.mock("ai", async () => ({ ...await vi.importActual<Record<string, unknown>>("ai"), generateText: vi.fn() }));
vi.mock("./model-transport", async () => ({
  ...await vi.importActual<typeof ModelTransport>("./model-transport"), resolveModelTransport: vi.fn(),
}));

import { generateText } from "ai";
import { LibraryError } from "./library";
import { OcrWorkflow } from "./workflows/ocr";

const prefix = "source/revision/ocr/job/";
type SavedObject = { bytes: Uint8Array<ArrayBuffer>; customMetadata: Record<string, string> };
function fixture({ pageCount = 2, state = "failed", calls = 1, completedPages = 0, error = "Deadline elapsed" }: {
  pageCount?: number; state?: "running" | "failed"; calls?: number; completedPages?: number; error?: string | null;
} = {}) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  db.exec(readFileSync(new URL("../migrations/0010_source_ocr.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO source_ocr_job(id,project_id,source_id,base_revision_id,model_route,model_snapshot,page_count,state,calls,completed_pages,"
    + "token_limit,input_tokens,cached_tokens,output_tokens,error,deadline_at,created_by,created_at,updated_at) "
    + "VALUES('job','project','source','revision','fixture','{}',?,?,?,?,?,NULL,NULL,NULL,?,?,'owner',0,0)")
    .run(pageCount, state, calls, completedPages, pageCount * 4096, error, Date.now() + 60_000);
  const settled: unknown[] = [], objects = new Map<string, SavedObject>();
  const progress = () => db.prepare("SELECT state,error,calls,completed_pages,input_tokens,cached_tokens,output_tokens FROM source_ocr_job WHERE id='job'").get();
  const prepare = vi.fn((sql: string) => ({ bind: (...args: SQLInputValue[]) => ({
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const result = db.prepare(sql).run(...args);
      if (sql.includes("SET completed_pages=completed_pages+")) settled.push(progress());
      return { meta: { changes: Number(result.changes) } };
    },
  }) }));
  const get = vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object ? { customMetadata: object.customMetadata, size: object.bytes.length,
      arrayBuffer: async () => object.bytes.buffer,
      json: async () => JSON.parse(new TextDecoder().decode(object.bytes)) as unknown } : null;
  });
  const put = vi.fn(async (key: string, bytes: Uint8Array<ArrayBuffer>, options: { customMetadata: Record<string, string> }) => {
    if (objects.has(key)) return null;
    objects.set(key, { bytes, customMetadata: options.customMetadata });
    return {};
  });
  const env = { DB: { prepare }, BUCKET: { get, put } } as unknown as Env;
  const save = (name: string, text: string, metadata: Record<string, string> = {}) => {
    const bytes = new TextEncoder().encode(text);
    const object = { bytes, customMetadata: { ...metadata, sha256: createHash("sha256").update(bytes).digest("hex") } };
    objects.set(prefix + name, object);
    return object;
  };
  const report = () => {
    const object = objects.get(prefix + "report.json");
    if (!object) throw new Error("OCR report was not retained.");
    return JSON.parse(new TextDecoder().decode(object.bytes)) as Record<string, unknown>;
  };
  return { db, env, settled, progress, prepare, objects, get, put, save, report };
}
beforeEach(() => { vi.mocked(generateText).mockReset().mockRejectedValue(new Error("Unexpected model generation")); });

it("settles saved page usage after terminal failure without reviving the job or dispatching its next page", async () => {
  const f = fixture();
  f.save("page-1.md", "Saved OCR page.", { finish: "stop", failure: "",
    inputTotal: "120", cachedTotal: "5", outputTotal: "30" });
  const originalReport = f.save("report.json", JSON.stringify({ state: "failed", error: "Original immutable report reason",
    finishedAt: 1, previewSha256: null, previewSize: null, calls: 1, completedPages: 0,
    model: "fixture", pageCount: 2, tokenLimit: 8192, inputTokens: null, cachedTokens: null, outputTokens: null }));
  const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
    // Replay the completed begin step; page 1 was dispatched before the job failed.
    name === "begin OCR" ? 2 : callback());
  try {
    await new OcrWorkflow({} as never, f.env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: stepDo } as unknown as WorkflowStep);

    expect(f.settled).toEqual([{ state: "failed", error: "Deadline elapsed", calls: 1, completed_pages: 1,
      input_tokens: 120, cached_tokens: 5, output_tokens: 30 }]);
    expect(f.progress()).toMatchObject({ state: "failed", error: "Deadline elapsed", calls: 1, completed_pages: 1,
      input_tokens: 120, cached_tokens: 5, output_tokens: 30 });
    expect(f.objects.get(prefix + "report.json")).toBe(originalReport);
    expect(f.put).not.toHaveBeenCalled();
    expect(stepDo.mock.calls.some(([name]) => name === "OCR page 2")).toBe(true);
    expect(f.prepare.mock.calls.some(([sql]) => sql.includes("SET calls=calls+1"))).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});

it("retains the page-14 length failure after Workflow serialization with 14 calls and 13 completed pages", async () => {
  const f = fixture({ pageCount: 15, state: "running", calls: 14, completedPages: 13, error: null });
  const reason = "OCR returned an incomplete page (length). No continuation was started.";
  const page = f.save("page-14.md", "", { finish: "length", failure: reason, input: "3210", cached: "0", output: "8192", ms: "36686",
    inputTotal: "44940", cachedTotal: "0", outputTotal: "32145" });
  const atBoundary: unknown[] = [];
  const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
    if (name === "begin OCR") return 15;
    const ordinal = Number(/^OCR page (\d+)$/.exec(name)?.[1]);
    if (ordinal > 0 && ordinal < 14) return ordinal;
    try { return await callback(); }
    catch (error) {
      expect(error).toBeInstanceOf(LibraryError);
      if (!(error instanceof LibraryError)) throw error;
      atBoundary.push(f.progress());
      // eslint-disable-next-line preserve-caught-error -- Reproduce Workflow serialization stripping LibraryError identity.
      throw new Error(error.message);
    }
  });
  try {
    await new OcrWorkflow({} as never, f.env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: stepDo } as unknown as WorkflowStep);

    const expected = { state: "failed", error: reason, calls: 14, completed_pages: 13,
      input_tokens: 44940, cached_tokens: 0, output_tokens: 32145 };
    expect(atBoundary).toEqual([expected]);
    expect(f.progress()).toEqual(expected);
    expect(f.report()).toMatchObject({ state: "failed", error: reason, calls: 14, completedPages: 13,
      inputTokens: 44940, cachedTokens: 0, outputTokens: 32145 });
    expect(page.bytes.byteLength).toBe(0);
    expect(page.customMetadata).toMatchObject({ finish: "length", failure: reason, input: "3210", cached: "0", output: "8192", ms: "36686" });
    expect(f.objects.get(prefix + "page-14.md")).toBe(page);
    expect(f.put.mock.calls.map(([key]) => key)).toEqual([prefix + "report.json"]);
    expect(stepDo.mock.calls.some(([name]) => name === "OCR page 15" || name === "assemble OCR preview")).toBe(false);
    expect(f.prepare.mock.calls.some(([sql]) => sql.includes("SET calls=calls+1"))).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});

it.each([
  { name: "safe application cause", error: new LibraryError("unavailable", "A frozen OCR page is missing.", 503),
    expected: "A frozen OCR page is missing." },
  { name: "opaque provider error", error: Object.assign(new Error("synthetic-provider-body synthetic-secret"), {
    responseBody: "synthetic-provider-body", headers: { authorization: "synthetic-secret" } }),
    expected: "OCR could not finish. Saved output is retained; no paid call is retried." },
])("persists only the $name projection before its step loses error identity", async ({ error: failure, expected }) => {
  const f = fixture({ state: "running", error: null });
  f.get.mockRejectedValueOnce(failure);
  const atBoundary: unknown[] = [];
  const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
    if (name === "begin OCR") return 2;
    try { return await callback(); }
    catch (error) {
      expect(error).toBeInstanceOf(LibraryError);
      if (!(error instanceof LibraryError)) throw error;
      expect(error.message).toBe(expected);
      expect(error).not.toHaveProperty("headers");
      expect(error).not.toHaveProperty("responseBody");
      atBoundary.push(f.progress());
      // eslint-disable-next-line preserve-caught-error -- Reproduce Workflow serialization after the safe projection is stored.
      throw new Error(error.message);
    }
  });
  try {
    await new OcrWorkflow({} as never, f.env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: stepDo } as unknown as WorkflowStep);

    expect(atBoundary).toEqual([expect.objectContaining({ error: expected, calls: 1, completed_pages: 0 })]);
    expect(f.progress()).toMatchObject({ state: "failed", error: expected, calls: 1, completed_pages: 0 });
    expect(f.report()).toMatchObject({ state: "failed", error: expected, calls: 1, completedPages: 0 });
    const retained = JSON.stringify(f.progress()) + [...f.objects.values()].map((object) => new TextDecoder().decode(object.bytes)).join("\n");
    expect(retained).not.toContain("synthetic-provider-body");
    expect(retained).not.toContain("synthetic-secret");
    expect(stepDo.mock.calls.some(([name]) => name === "OCR page 2")).toBe(false);
    expect(f.prepare.mock.calls.some(([sql]) => sql.includes("SET calls=calls+1"))).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});
