import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type * as AISDK from "ai";
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
import type { Actor } from "./auth";
import { LibraryError } from "./library";
import { resolveModelTransport } from "./model-transport";
import { getOcrJob } from "./ocr";
import { OcrWorkflow } from "./workflows/ocr";

const prefix = "source/revision/ocr/job/";
type SavedObject = { bytes: Uint8Array<ArrayBuffer>; customMetadata: Record<string, string> };
function fixture({ pageCount = 2, state = "failed", calls = 1, completedPages = 0, error = "Deadline elapsed" }: {
  pageCount?: number; state?: "running" | "failed"; calls?: number; completedPages?: number; error?: string | null;
} = {}) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  db.exec(readFileSync(new URL("../migrations/0001_library.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0010_source_ocr.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES('project','OCR fixture',0,0)").run();
  db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES('source','OCR fixture','file','owner',0,0)").run();
  db.prepare("INSERT INTO source_revision(id,source_id,revision_no,original_key,original_sha256,original_size,original_mime,readable_state,created_by,created_at) "
    + "VALUES('revision','source',1,'source/revision/original','fixture',1,'application/pdf','readable','owner',0)").run();
  db.prepare("UPDATE source SET current_revision_id='revision' WHERE id='source'").run();
  db.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES('project','source','owner',0)").run();
  db.prepare("INSERT INTO source_ocr_job(id,project_id,source_id,base_revision_id,model_route,model_snapshot,page_count,state,calls,completed_pages,"
    + "token_limit,input_tokens,cached_tokens,output_tokens,error,deadline_at,created_by,created_at,updated_at) "
    + "VALUES('job','project','source','revision','fixture','{}',?,?,?,?,?,NULL,NULL,NULL,?,?,'owner',0,0)")
    .run(pageCount, state, calls, completedPages, pageCount * 4096, error, Date.now() + 60_000);
  const settled: unknown[] = [], objects = new Map<string, SavedObject>();
  let readFailureAfterPut: { key: string; error: unknown } | null = null, readFailureCount = 0;
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
    if (readFailureAfterPut?.key === key && objects.has(key)) {
      const failure = readFailureAfterPut.error;
      readFailureAfterPut = null;
      readFailureCount++;
      throw failure;
    }
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
  const failReadAfterPut = (key: string, error: unknown) => { readFailureAfterPut = { key, error }; };
  return { db, env, settled, progress, prepare, objects, get, put, save, report, failReadAfterPut, readFailureCount: () => readFailureCount };
}
beforeEach(() => { vi.mocked(generateText).mockReset().mockRejectedValue(new Error("Unexpected model generation")); });

it.each([false, true])("bounds anonymous OCR HTTP without AI while preserving page/token/preview ownership; overflow=%s", async overflow => {
  const f = fixture({ pageCount: 1, state: "running", calls: 0, completedPages: 0, error: null });
  const model = { route: "gateway:fixture/vision", id: "vision", label: "Anonymous OCR", contextTokens: 4096, maxOutputTokens: 4096,
    outputReserveTokens: 4096, supportsImages: true, enabled: true, checkedOn: "2026-11-09", routing: { provider: {
      id: "fixture", type: "openai-compatible", baseUrl: "https://api.example.com/v1", gatewaySlug: null, gatewayPath: "", enabled: true, authMode: "anonymous",
    }, gatewayId: null } };
  const image = f.save("page-1.png", "fixture image");
  f.db.prepare("UPDATE source_ocr_job SET pages_json=?,model_route=?,model_snapshot=?,token_limit=8192,input_tokens=0,cached_tokens=0,output_tokens=0,deadline_at=? WHERE id='job'")
    .run(JSON.stringify({ 1: { sha256: image.customMetadata.sha256, bytes: image.bytes.length, width: 1, height: 1 } }), model.route, JSON.stringify(model), Date.now() + 240_000);
  const sdk = await vi.importActual<typeof AISDK>("ai"), transport = await vi.importActual<typeof ModelTransport>("./model-transport");
  vi.mocked(generateText).mockImplementation(sdk.generateText); vi.mocked(resolveModelTransport).mockImplementation(transport.resolveModelTransport);
  const cancel = vi.fn(), network = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    expect(init?.signal).toBeDefined(); expect(init?.credentials).toBe("omit");
    expect(JSON.parse(String(init?.body)).max_tokens).toBe(4096);
    return overflow ? new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); }, cancel }))
      : Response.json({ id: "offline", object: "chat.completion", created: 0, model: "vision",
        choices: [{ index: 0, message: { role: "assistant", content: "Transcription fixture." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  });
  try {
    await new OcrWorkflow({} as never, f.env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: async (name: string, _options: unknown, callback: () => Promise<unknown>) => name === "begin OCR" ? 1 : callback() } as unknown as WorkflowStep);
    expect(f.progress()).toMatchObject({ state: overflow ? "failed" : "ready", calls: 1, completed_pages: overflow ? 0 : 1 });
    if (overflow) { expect(f.objects.has(prefix + "page-1.md")).toBe(false); expect(cancel).toHaveBeenCalledTimes(1); }
    else expect(f.report()).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    await getOcrJob(f.env, { type: "owner" } as Actor, { projectId: "project", sourceId: "source", jobId: "job" });
    expect(network).toHaveBeenCalledTimes(1);
  } finally { network.mockRestore(); f.db.close(); }
});

it.each(["owned deadline", "HTTP 401", "HTTP 429"] as const)("persists %s through the real SDK before Workflow serialization without continuing", async mode => {
  const f = fixture({ pageCount: 3, state: "running", calls: 1, completedPages: 1, error: null });
  const model = { route: "gateway:openrouter/fixture/vision", id: "fixture/vision", label: "Fixture OCR", contextTokens: 4096,
    maxOutputTokens: 4096, outputReserveTokens: 4096, supportsImages: true, enabled: true,
    routing: { provider: { id: "openrouter", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1",
      gatewaySlug: "openrouter", gatewayPath: "v1", enabled: true }, gatewayId: "offline-ocr" } };
  const prefixPage = f.save("page-1.md", "Saved OCR page.", { finish: "stop", failure: "",
    inputTotal: "120", cachedTotal: "5", outputTotal: "30" });
  const image = f.save("page-2.png", "fixture image bytes");
  f.db.prepare("UPDATE source_ocr_job SET pages_json=?,model_route=?,model_snapshot=?,token_limit=?,input_tokens=120,cached_tokens=5,output_tokens=30,deadline_at=? WHERE id='job'")
    .run(JSON.stringify({ 2: { sha256: image.customMetadata.sha256, bytes: image.bytes.length, width: 1, height: 1 } }),
      model.route, JSON.stringify(model), 3 * (model.contextTokens + model.outputReserveTokens), Date.now() + 240_000);
  const sdk = await vi.importActual<typeof AISDK>("ai");
  const transport = await vi.importActual<typeof ModelTransport>("./model-transport");
  vi.mocked(generateText).mockImplementation(sdk.generateText);
  vi.mocked(resolveModelTransport).mockReset().mockImplementation(transport.resolveModelTransport);
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected upstream request."));
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.signal?.aborted).toBe(false);
    if (mode === "owned deadline") {
      deadline.abort(new DOMException("synthetic-secret", "TimeoutError"));
      init?.signal?.throwIfAborted();
      throw new Error("The SDK did not forward the abort signal.");
    }
    return Response.json({ error: { message: "synthetic-secret" } }, { status: mode === "HTTP 401" ? 401 : 429 });
  });
  Object.assign(f.env, { AI: { fetch } });
  const expected = {
    "owned deadline": "OCR model call reached its time limit.",
    "HTTP 401": "External model request failed (HTTP 401). Check the Gateway connection and provider status; no retry was started.",
    "HTTP 429": "External model request failed (HTTP 429). Limit exhausted, reset unknown. No retry was started.",
  }[mode];
  const atBoundary: unknown[] = [];
  const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
    if (name === "begin OCR") return 3;
    try { return await callback(); }
    catch (error) {
      expect(name).toBe("OCR page 2");
      expect(error).toBeInstanceOf(LibraryError);
      atBoundary.push(f.progress());
      // eslint-disable-next-line preserve-caught-error -- Simulate Workflow serialization losing the projected error identity and message.
      throw new Error("Workflow serialized failure");
    }
  });
  try {
    await new OcrWorkflow({} as never, f.env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: stepDo } as unknown as WorkflowStep);

    expect(atBoundary).toEqual([{ state: "running", error: expected, calls: 2, completed_pages: 1,
      input_tokens: null, cached_tokens: null, output_tokens: null }]);
    expect(f.progress()).toEqual({ state: "failed", error: expected, calls: 2, completed_pages: 1,
      input_tokens: null, cached_tokens: null, output_tokens: null });
    expect(f.report()).toMatchObject({ state: "failed", error: expected, calls: 2, completedPages: 1,
      inputTokens: null, cachedTokens: null, outputTokens: null });
    const ownerJob = await getOcrJob(f.env, { type: "owner" } as Actor, { projectId: "project", sourceId: "source", jobId: "job" });
    expect(ownerJob.error).toBe(expected);
    expect(f.objects.get(prefix + "page-1.md")).toBe(prefixPage);
    expect(prefixPage.customMetadata).toMatchObject({ inputTotal: "120", cachedTotal: "5", outputTotal: "30" });
    expect(f.put.mock.calls.map(([key]) => key)).toEqual([prefix + "report.json"]);
    expect(stepDo.mock.calls.some(([name]) => name === "OCR page 3" || name === "assemble OCR preview")).toBe(false);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledWith(90_000);
    expect(deadline.signal.aborted).toBe(mode === "owned deadline");
    expect(JSON.stringify(f.report())).not.toContain("synthetic-secret");
  } finally { timeout.mockRestore(); network.mockRestore(); f.db.close(); }
});

it("settles saved page usage once after terminal failure without reviving the job or dispatching its next page", async () => {
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
    const run = () => new OcrWorkflow({} as never, f.env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: stepDo } as unknown as WorkflowStep);
    await run();
    await run();

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

it("retains known usage when page artifact readback fails after PUT and fails without continuing", async () => {
  const f = fixture({ state: "running", calls: 0, completedPages: 0, error: null });
  const model = { route: "gateway:fixture/vision", id: "fixture/vision", label: "Fixture OCR", contextTokens: 4096,
    maxOutputTokens: 4096, outputReserveTokens: 4096, supportsImages: true, enabled: true };
  const image = f.save("page-1.png", "fixture image bytes");
  f.db.prepare("UPDATE source_ocr_job SET pages_json=?,model_route=?,model_snapshot=?,token_limit=?,input_tokens=0,cached_tokens=0,output_tokens=0 WHERE id='job'")
    .run(JSON.stringify({ 1: { sha256: image.customMetadata.sha256, bytes: image.bytes.length, width: 1, height: 1 } }),
      model.route, JSON.stringify(model), 2 * (model.contextTokens + model.outputReserveTokens));
  vi.mocked(resolveModelTransport).mockReset().mockResolvedValue({} as never);
  vi.mocked(generateText).mockReset().mockResolvedValue({ text: "Transcribed page", finishReason: "stop",
    totalUsage: { inputTokens: 120, inputTokenDetails: { cacheReadTokens: 5 }, outputTokens: 30 } } as never);
  const reason = new LibraryError("unavailable", "Stored OCR page readback failed.", 503);
  f.failReadAfterPut(prefix + "page-1.md", reason);
  const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
    name === "begin OCR" ? 2 : callback());

  try {
    await new OcrWorkflow({} as never, f.env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: stepDo } as unknown as WorkflowStep);

    const expected = { state: "failed", error: reason.message, calls: 1, completed_pages: 0,
      input_tokens: 120, cached_tokens: 5, output_tokens: 30 };
    expect(f.readFailureCount()).toBe(1);
    expect(f.progress()).toEqual(expected);
    expect(f.report()).toMatchObject({ state: "failed", error: reason.message, calls: 1, completedPages: 0,
      inputTokens: 120, cachedTokens: 5, outputTokens: 30 });
    expect(f.objects.get(prefix + "page-1.md")?.customMetadata).toMatchObject({
      inputTotal: "120", cachedTotal: "5", outputTotal: "30", finish: "stop", failure: "",
    });
    expect(f.objects.has(prefix + "preview.md")).toBe(false);
    const ownerJob = await getOcrJob(f.env, { type: "owner" } as Actor, { projectId: "project", sourceId: "source", jobId: "job" });
    expect(ownerJob).toMatchObject({ state: "failed", calls: 1, completedPages: 0, error: reason.message,
      inputTokens: 120, cachedTokens: 5, outputTokens: 30 });
    expect(f.put.mock.calls.map(([key]) => key)).toEqual([prefix + "page-1.md", prefix + "report.json"]);
    expect(stepDo.mock.calls.some(([name]) => name === "OCR page 2" || name === "assemble OCR preview")).toBe(false);
    expect(f.prepare.mock.calls.filter(([sql]) => sql.includes("SET calls=calls+1"))).toHaveLength(1);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveModelTransport)).toHaveBeenCalledTimes(1);
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
    expect(f.progress()).toMatchObject({ state: "failed", error: expected, calls: 1, completed_pages: 0,
      input_tokens: null, cached_tokens: null, output_tokens: null });
    expect(f.report()).toMatchObject({ state: "failed", error: expected, calls: 1, completedPages: 0 });
    const retained = JSON.stringify(f.progress()) + [...f.objects.values()].map((object) => new TextDecoder().decode(object.bytes)).join("\n");
    expect(retained).not.toContain("synthetic-provider-body");
    expect(retained).not.toContain("synthetic-secret");
    expect(stepDo.mock.calls.some(([name]) => name === "OCR page 2")).toBe(false);
    expect(f.prepare.mock.calls.some(([sql]) => sql.includes("SET calls=calls+1"))).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});
