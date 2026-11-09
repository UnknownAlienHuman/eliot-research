import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "./auth";
import type { ModelSpec } from "./models";
import type * as Models from "./models";
import type * as AI from "ai";
import type * as ModelTransport from "./model-transport";
import type { DistillInput } from "./shared/api";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class { constructor(_ctx: unknown, readonly env: Env) {} } }));
vi.mock("./models", async (original) => ({ ...await original<typeof Models>(), requireAvailableModel: vi.fn() }));
vi.mock("ai", async (original) => ({ ...await original<typeof AI>(), generateText: vi.fn(), experimental_streamTextLowMemory: vi.fn() }));
vi.mock("./model-transport", async (original) => ({ ...await original<typeof ModelTransport>(), resolveModelTransport: vi.fn() }));
import { requireAvailableModel } from "./models";
import { requestUnderstanding, DistillWorkflow, scheduleDistillation } from "./workflows/distill";
import { getUnderstanding, getUnderstandingHistory } from "./understanding";
import { failUndispatchedDistill, admitDistill } from "./cost";
import { resolveModelTransport } from "./model-transport";
import { generateText, experimental_streamTextLowMemory } from "ai";
import { buildContext } from "./context";
import { LibraryError } from "./library";

const sourceId = "058fd2a9-6b6b-4a59-ab28-94792ebf05cf", revisionId = "82f80504-2527-4b03-a3bb-e9092d14d117";
const retryId = "05a6d34f-354f-4278-b882-2475c0c70030", otherId = "0acb1c5b-0b9c-442e-b846-26cef71c718f";
const actor: Actor = { type: "owner", id: "owner", authentication: "local" };
const model: ModelSpec = { route: "workers-ai:fixture", id: "fixture", label: "Fixture", enabled: true, contextTokens: 262144, maxOutputTokens: 1024, checkedOn: "2026-11-04" };
const openRouterModel: ModelSpec = { ...model, route: "gateway:router-alias/fixture", id: "fixture", maxOutputTokens: null, outputReserveTokens: 8192,
  responseFormat: true, structuredOutputs: true, structuredReasoningEffort: "minimal", openRouterReasoningEfforts: ["minimal", "low", "high", "max"],
  routing: { gatewayId: "fixture", provider: { id: "router-alias", type: "openai-compatible", gatewaySlug: "custom-router", gatewayPath: "",
    baseUrl: "https://openrouter.ai/api/v1", enabled: true } } };
const input = { sourceId, revisionId, retry: { attemptId: retryId, previousAttemptId: revisionId }, model: model.route };

function fixture(calls = 1) {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) db.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES (?,'Paper','text','owner',1,1)").run(sourceId);
  db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,readable_size,created_by,created_at,distill_state,distill_calls,distill_error,distill_model,distill_token_limit,distill_estimated_cost_microusd)
    VALUES (?,?,1,'readable',30,'owner',1,'failed',?,'Stored failure',?,10000,73)`).run(revisionId, sourceId, calls, model.route);
  db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run(revisionId, sourceId);
  const original = JSON.stringify({ state: "failed", questions: [], kept: 0, dropped: [], clearedNumbers: 0, raw: { first: null, second: null }, error: "Stored failure", usage: { calls, inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: 10000, wallMs: 19 } });
  const text = "The method retains canonical evidence.";
  const bodies = new Map([[`source/${revisionId}/distill.json`, original], [`source/${revisionId}/text.md`, text],
    [`source/${revisionId}/blocks.json`, JSON.stringify([{ id: 1, type: "paragraph", start: 0, end: text.length, heading: null }])]]);
  const status = vi.fn(async () => ({ status: "complete" })), create = vi.fn(async (_input: { id: string; params: DistillInput & { producerFormat?: "compact-k3-v1" } }) => ({}));
  let failPut = false, ambiguousBatch = false, failBatch = false;
  type Statement = { sql: string; args: SQLInputValue[] };
  const statement = (sql: string, args: SQLInputValue[] = []) => ({ sql, args, bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }) });
  const env = { DB: { prepare: statement, batch: async (statements: Statement[]) => {
    db.exec("BEGIN");
    try { const results = statements.map((s, index) => { if (failBatch && index === 1) { failBatch = false; throw new Error("Batch rolled back"); } return { meta: { changes: Number(db.prepare(s.sql).run(...s.args).changes) } }; }); db.exec("COMMIT");
      if (ambiguousBatch) { ambiguousBatch = false; throw new Error("Lost committed batch reply"); } return results;
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  } }, BUCKET: { get: async (key: string) => { const body = bodies.get(key); return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => new TextEncoder().encode(body).buffer, size: new TextEncoder().encode(body).byteLength, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } }) }; },
    put: async (key: string, body: string) => { if (failPut) throw new Error("Storage unavailable"); if (bodies.has(key)) return null; bodies.set(key, body); return {}; } },
    DISTILL: { get: async () => ({ status }), create } } as unknown as Env;
  return { db, env, bodies, original, status, create, failStorage: () => { failPut = true; }, loseBatchReply: () => { ambiguousBatch = true; }, rollbackBatch: () => { failBatch = true; } };
}

function retainedOutput(f: ReturnType<typeof fixture>) {
  const prefix = `source/${revisionId}/`, text = f.bodies.get(prefix + "text.md") ?? "";
  const guide = ["The method retains evidence.", "The source describes normalization.", "The source retains canonical evidence."].map(text => ({ labels: ["[S1:1]"], text }));
  const claim = { kind: "method", statement: "The method retains canonical evidence.", task: null, metric: null, dataset: null, valueText: null, valueNumber: null, unit: null, conditions: null, quote: text, block: 1, start: 0, end: text.length, ambiguous: false };
  const usage = { inputTokens: 17, cachedTokens: 0, outputTokens: 8, tokenLimit: 10000 };
  f.bodies.set(prefix + "distill-call1.json", JSON.stringify({ output: { guide, claims: [{ ...claim, quoteBlock: "[S1:1]" }], questions: ["Which method?", "What evidence?", "What source?"] }, usage }));
  f.bodies.set(prefix + "distill-verified.json", JSON.stringify({ guide, claims: [claim], evidence: [{ label: "[S1:1]", block: 1, quote: text }], questions: [], dropped: [], clearedNumbers: 0 }));
  f.bodies.set(prefix + "distill-call2.json", JSON.stringify({ output: { supportedClaims: ["C0"], additionalClaims: [], guide, digest: [guide[0]], glossary: [] }, usage }));
}

function completedOutput(f: ReturnType<typeof fixture>) {
  retainedOutput(f);
  const prefix = `source/${revisionId}/`, text = f.bodies.get(prefix + "text.md") ?? "";
  const guide = "Completed prior guide", digest = "Completed prior digest";
  const glossary = [{ en: "method", ru: "метод", definition: "Метод источника.", labels: [`[R${revisionId}:1]`] }];
  f.db.prepare("INSERT INTO claim(id,source_revision_id,ordinal,kind,statement,quote,block_index,start_byte,end_byte,created_at) VALUES('completed-card',?,0,'method',?,?,1,0,?,1)")
    .run(revisionId, text, text, text.length);
  f.db.prepare(`UPDATE source_revision SET distill_state='done',distill_error=NULL,guide_summary=?,claim_count=1,
    distill_started_at=1,distill_ms=19,distill_input_tokens=42,distill_cached_tokens=0,distill_output_tokens=9,
    distill_pricing_checked_on='2025-01-02' WHERE id=?`).run(guide, revisionId);
  const report = JSON.parse(f.original);
  f.original = JSON.stringify({ ...report, state: "done", kept: 1, error: null,
    raw: { first: prefix + "distill-call1.json", second: prefix + "distill-call2.json" },
    usage: { ...report.usage, inputTokens: 17, cachedTokens: 0, outputTokens: 8 } });
  for (const [name, body] of [["guide.md", guide], ["digest.md", digest], ["glossary.json", JSON.stringify(glossary)], ["distill.json", f.original]] as const)
    f.bodies.set(prefix + name, body);
  return { guide, digest, glossary };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(experimental_streamTextLowMemory).mockReset(); vi.mocked(requireAvailableModel).mockResolvedValue(model); });
describe("explicit understanding retry", () => {
  it.each(["native", "openrouter"] as const)("records literal Low, freezes the %s scheduler payload and replays before fresh model resolution", async provider => {
    const field = provider === "native" ? "nativeReasoningEffort" : "openRouterReasoningEffort";
    const f = fixture(), high = Object.freeze(provider === "native" ? { ...model, nativeReasoningEffort: "high" as const } : openRouterModel);
    const lowInput = { ...input, model: high.route, [field]: "low" as const };
    vi.mocked(requireAvailableModel).mockResolvedValue(high);
    try {
      const old = await getUnderstanding(f.env, actor, { sourceId, revisionId });
      expect(old.progress).not.toHaveProperty("nativeReasoningEffort");
      expect(old.progress).not.toHaveProperty("openRouterReasoningEffort");
      await requestUnderstanding(f.env, actor, lowInput);
      expect(f.db.prepare("SELECT distill_request_json AS request FROM source_revision WHERE id=?").get(revisionId)).toEqual({
        request: JSON.stringify({ sourceId, revisionId, previousAttemptId: revisionId, model: high.route, [field]: "low", producerFormat: "compact-k3-v1" }),
      });
      expect(f.create).toHaveBeenCalledExactlyOnceWith({ id: `distill-attempt-${retryId}`, params: { revisionId, attemptId: retryId, model: { ...high, [field]: "low" }, producerFormat: "compact-k3-v1" } });
      if (provider === "native") expect(high.nativeReasoningEffort).toBe("high");
      else expect(high).not.toHaveProperty("openRouterReasoningEffort");
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId })).progress[field]).toBe("low");
      expect(await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId })).toEqual({ ...old, currentAttemptId: retryId });
      const resolved = vi.mocked(requireAvailableModel).mock.calls.length;
      vi.mocked(requireAvailableModel).mockRejectedValue(new Error("Catalogue no longer available"));
      expect(await requestUnderstanding(f.env, actor, lowInput)).toEqual({ revisionId, attemptId: retryId });
      await expect(requestUnderstanding(f.env, actor, { ...lowInput, [field]: "high" })).rejects.toMatchObject({ status: 409 });
      await expect(requestUnderstanding(f.env, actor, { ...input, model: high.route })).rejects.toMatchObject({ status: 409 });
      expect(requireAvailableModel).toHaveBeenCalledTimes(resolved); expect(f.create).toHaveBeenCalledTimes(1);
      expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it.each([model, { ...model, route: "gateway:fixture/model", nativeReasoningEffort: "high" as const }])("rejects a profile unsupported by $route before archiving or queueing", async unavailable => {
    const f = fixture(); completedOutput(f); vi.mocked(requireAvailableModel).mockResolvedValue(unavailable);
    const request = { ...input, model: unavailable.route, nativeReasoningEffort: "low" as const };
    const detail = "This model does not advertise a supported native reasoning profile.";
    try {
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId), bodies = new Map(f.bodies);
      const claims = f.db.prepare("SELECT * FROM claim WHERE source_revision_id=?").all(revisionId);
      const rejected = await requestUnderstanding(f.env, actor, request);
      expect(rejected).toEqual({ revisionId, attemptId: retryId, rejected: detail });
      expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId)).toEqual(before);
      expect(f.db.prepare("SELECT * FROM claim WHERE source_revision_id=?").all(revisionId)).toEqual(claims);
      expect(f.db.prepare("SELECT attempt_id,snapshot_key,rejection,request_json FROM distill_history").all()).toEqual([
        { attempt_id: retryId, snapshot_key: null, rejection: detail,
          request_json: JSON.stringify({ sourceId, revisionId, previousAttemptId: revisionId, model: unavailable.route, nativeReasoningEffort: "low", producerFormat: "compact-k3-v1" }) },
      ]);
      expect(f.bodies).toEqual(bodies); expect(f.create).not.toHaveBeenCalled();
      expect(await getUnderstanding(f.env, actor, { sourceId, revisionId, requestId: retryId })).toMatchObject({ knownRequestId: retryId, requestRejection: detail, attemptId: revisionId });
      const resolved = vi.mocked(requireAvailableModel).mock.calls.length;
      vi.mocked(requireAvailableModel).mockRejectedValue(new Error("Catalogue no longer available"));
      expect(await requestUnderstanding(f.env, actor, request)).toEqual(rejected);
      await expect(requestUnderstanding(f.env, actor, { ...request, nativeReasoningEffort: "high" })).rejects.toMatchObject({ status: 409 });
      expect(requireAvailableModel).toHaveBeenCalledTimes(resolved); expect(f.create).not.toHaveBeenCalled();
      vi.mocked(requireAvailableModel).mockResolvedValue({ ...model, nativeReasoningEffort: "high" });
      expect(await requestUnderstanding(f.env, actor, { ...input, nativeReasoningEffort: "high", retry: { ...input.retry, attemptId: otherId } })).toEqual({ revisionId, attemptId: otherId });
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("rejects malformed effort values before any model or Workflow lookup", async () => {
    const f = fixture();
    try {
      for (const value of [null, "", "max", "medium"]) await expect(requestUnderstanding(f.env, actor, { ...input, nativeReasoningEffort: value as never })).rejects.toThrow();
      for (const value of [null, "", "x".repeat(33), "high/private"]) await expect(requestUnderstanding(f.env, actor, { ...input, openRouterReasoningEffort: value as never })).rejects.toThrow();
      await expect(requestUnderstanding(f.env, actor, { ...input, nativeReasoningEffort: "low", openRouterReasoningEffort: "high" })).rejects.toThrow();
      expect(requireAvailableModel).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT count(*) AS n FROM distill_history").get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  });
  it.each(["missing-list", "unpublished", "other-root", "medium-missing-list", "medium-unpublished", "medium-other-root"] as const)("rejects OpenRouter %s membership without archiving, and replays its exact rejected identity", async mode => {
    const f = fixture(); completedOutput(f);
    const effort = mode.startsWith("medium-") ? "medium" : "high";
    const unavailable = { ...openRouterModel };
    if (mode.endsWith("missing-list")) delete unavailable.openRouterReasoningEfforts;
    else if (mode.endsWith("unpublished")) unavailable.openRouterReasoningEfforts = ["minimal"];
    else {
      const routing = openRouterModel.routing;
      if (!routing) throw new Error("The OpenRouter fixture has no frozen routing.");
      unavailable.routing = { ...routing, provider: { ...routing.provider, baseUrl: "https://vendor.example/api/v1" } };
      unavailable.openRouterReasoningEfforts = [effort];
    }
    vi.mocked(requireAvailableModel).mockResolvedValue(unavailable);
    const request = { ...input, model: unavailable.route, openRouterReasoningEffort: effort };
    const detail = "This model does not advertise the selected OpenRouter reasoning profile.";
    try {
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId), bodies = new Map(f.bodies);
      const rejected = await requestUnderstanding(f.env, actor, request);
      expect(rejected).toEqual({ revisionId, attemptId: retryId, rejected: detail });
      expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId)).toEqual(before);
      expect(f.bodies).toEqual(bodies); expect(f.create).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT request_json AS request,snapshot_key AS snapshot FROM distill_history WHERE attempt_id=?").get(retryId))
        .toEqual({ request: JSON.stringify({ sourceId, revisionId, previousAttemptId: revisionId, model: unavailable.route,
          openRouterReasoningEffort: effort, producerFormat: "compact-k3-v1" }), snapshot: null });
      const lookups = vi.mocked(requireAvailableModel).mock.calls.length;
      vi.mocked(requireAvailableModel).mockResolvedValue(openRouterModel);
      expect(await requestUnderstanding(f.env, actor, request)).toEqual(rejected);
      await expect(requestUnderstanding(f.env, actor, { ...request, openRouterReasoningEffort: "low" })).rejects.toMatchObject({ status: 409 });
      await expect(requestUnderstanding(f.env, actor, { ...input, model: unavailable.route })).rejects.toMatchObject({ status: 409 });
      expect(requireAvailableModel).toHaveBeenCalledTimes(lookups);
    } finally { f.db.close(); }
  });
  it("rejects OpenRouter effort on Save/recheck before mutating retained output or receipts", async () => {
    const f = fixture(); completedOutput(f);
    try {
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId), bodies = new Map(f.bodies);
      await expect(requestUnderstanding(f.env, actor, { sourceId, revisionId, saveAvailable: true, openRouterReasoningEffort: "high" }))
        .rejects.toMatchObject({ status: 400 });
      expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId)).toEqual(before);
      expect(f.bodies).toEqual(bodies); expect(requireAvailableModel).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT count(*) AS n FROM distill_history").get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  });
  it("pauses an expired queued OpenRouter choice with its exact intent and resumes only the retained choice", async () => {
    const f = fixture(0), request = JSON.stringify({ sourceId, revisionId, model: openRouterModel.route, openRouterReasoningEffort: "max" });
    f.db.prepare("UPDATE source_revision SET distill_state='queued',distill_model=?,distill_request_json=? WHERE id=?")
      .run(openRouterModel.route, request, revisionId);
    vi.mocked(requireAvailableModel).mockResolvedValue({ ...openRouterModel, openRouterReasoningEfforts: ["minimal"] });
    try {
      await scheduleDistillation(f.env, revisionId);
      expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,distill_request_json AS request,distill_error AS error FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "paused", calls: 0, request, error: "This model does not advertise the selected OpenRouter reasoning profile." });
      expect(f.create).not.toHaveBeenCalled();
      vi.mocked(requireAvailableModel).mockResolvedValue(openRouterModel);
      await requestUnderstanding(f.env, actor, { sourceId, revisionId, model: openRouterModel.route });
      expect(f.create).toHaveBeenCalledExactlyOnceWith({ id: `distill-${revisionId}`, params: { revisionId,
        model: { ...openRouterModel, openRouterReasoningEffort: "max" } } });
      expect(f.db.prepare("SELECT distill_request_json AS request FROM source_revision WHERE id=?").get(revisionId)).toEqual({ request });
    } finally { f.db.close(); }
  });
  it("clears an omitted old OpenRouter choice only when an undispatched original changes route", async () => {
    const f = fixture(0);
    const request = JSON.stringify({ sourceId, revisionId, model: openRouterModel.route, openRouterReasoningEffort: "max" });
    f.db.prepare("UPDATE source_revision SET distill_state='paused',distill_model=?,distill_request_json=? WHERE id=?")
      .run(openRouterModel.route, request, revisionId);
    try {
      await requestUnderstanding(f.env, actor, { sourceId, revisionId, model: model.route });
      expect(f.create).toHaveBeenCalledExactlyOnceWith({ id: `distill-${revisionId}`, params: { revisionId, model } });
      expect(f.db.prepare("SELECT distill_request_json AS request FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ request: JSON.stringify({ sourceId, revisionId, model: model.route }) });
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId })).progress).not.toHaveProperty("openRouterReasoningEffort");
    } finally { f.db.close(); }
  });
  it("reads current and archived owner literals without revalidating or enriching from today's catalogue", async () => {
    const f = fixture(), request = JSON.stringify({ sourceId, revisionId, model: openRouterModel.route, openRouterReasoningEffort: "max" });
    f.db.prepare("UPDATE source_revision SET distill_model=?,distill_request_json=? WHERE id=?").run(openRouterModel.route, request, revisionId);
    vi.mocked(requireAvailableModel).mockResolvedValue({ ...openRouterModel, openRouterReasoningEfforts: ["minimal", "low"] });
    try {
      await requestUnderstanding(f.env, actor, { ...input, model: openRouterModel.route, openRouterReasoningEffort: "low" });
      const lookups = vi.mocked(requireAvailableModel).mock.calls.length;
      vi.mocked(requireAvailableModel).mockRejectedValue(new Error("No live catalogue on read"));
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId })).progress.openRouterReasoningEffort).toBe("low");
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId })).progress.openRouterReasoningEffort).toBe("max");
      expect(requireAvailableModel).toHaveBeenCalledTimes(lookups);
      const archived = JSON.parse(f.bodies.get(`source/${revisionId}/history/${retryId}.json`) ?? "null");
      expect(archived.revision.distill_request_json).toBe(request);
    } finally { f.db.close(); }
  });
  it.each(["high", "medium"] as const)("passes the same owner-selected OpenRouter %s snapshot to both compact calls without mutating the automatic profile", async effort => {
    const f = fixture();
    const chosenModel = effort === "medium" ? { ...openRouterModel, openRouterReasoningEfforts: ["high", "medium", "none"], maxOutputTokens: 65536 } : openRouterModel;
    vi.mocked(requireAvailableModel).mockResolvedValue(chosenModel);
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    const totalUsage = { inputTokens: 17, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 0 } };
    vi.mocked(generateText).mockReset()
      .mockResolvedValueOnce({ output: { candidates: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The method retains canonical evidence." }] }, totalUsage, finishReason: "stop" } as never)
      .mockResolvedValueOnce({ output: { selected: [{ candidateId: "C0", reason: "The bound quote states this." }], rejected: [], guide: [] }, totalUsage, finishReason: "stop" } as never);
    try {
      const originalBodies = new Map(f.bodies);
      const request = { ...input, model: chosenModel.route, openRouterReasoningEffort: effort };
      await requestUnderstanding(f.env, actor, request);
      const params = f.create.mock.calls[0]?.[0].params;
      if (!params) throw new Error("The owner-selected Workflow snapshot was not created.");
      if (effort === "medium") expect(params).toMatchObject({ compactOutputTokens: [16384, 8192] });
      else expect(params).not.toHaveProperty("compactOutputTokens");
      vi.mocked(requireAvailableModel).mockRejectedValue(new Error("No catalogue lookup after admission."));
      expect(await requestUnderstanding(f.env, actor, request)).toEqual({ revisionId, attemptId: retryId });
      expect(f.create).toHaveBeenCalledTimes(1);
      await new DistillWorkflow({} as ExecutionContext, f.env).run({ payload: params } as never,
        { do: async (_name: string, _options: unknown, callback: () => unknown) => callback() } as never);
      expect(resolveModelTransport).toHaveBeenCalledTimes(2);
      for (const [, frozen] of vi.mocked(resolveModelTransport).mock.calls) {
        expect(frozen).toBe(params.model);
        expect(frozen).toMatchObject({ openRouterReasoningEffort: effort, structuredReasoningEffort: "minimal" });
      }
      expect(openRouterModel).not.toHaveProperty("openRouterReasoningEffort");
      expect(generateText).toHaveBeenCalledTimes(2); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
      const budgets = effort === "medium" ? [16384, 8192] : [8192, 8192];
      expect(vi.mocked(generateText).mock.calls.map(([options]) => options.maxOutputTokens)).toEqual(budgets);
      const view = await getUnderstanding(f.env, actor, { sourceId, revisionId });
      expect(view.report?.usage.outputBudgets).toEqual(budgets.map(tokens => ({ requestedTokens: tokens, appliedTokens: tokens })));
      expect(view.report?.usage).toMatchObject({ calls: 2, inputTokens: 34, outputTokens: 16 });
      for (const [key, body] of originalBodies) expect(f.bodies.get(key)).toBe(body);
    } finally { vi.mocked(generateText).mockReset(); f.db.close(); }
  });
  it.each(["native", "openrouter"] as const)("retains a queued original %s Low intent on repeat and rejects a conflicting profile", async provider => {
    const field = provider === "native" ? "nativeReasoningEffort" : "openRouterReasoningEffort";
    const f = fixture(0), high = Object.freeze(provider === "native" ? { ...model, nativeReasoningEffort: "high" as const } : openRouterModel);
    vi.mocked(requireAvailableModel).mockResolvedValue(high);
    f.db.prepare("UPDATE source_revision SET distill_state='none' WHERE id=?").run(revisionId);
    // Fill both admission slots in the existing in-memory fixture.
    for (const [index, id] of [otherId, retryId].entries())
      f.db.prepare("INSERT INTO source_revision(id,source_id,revision_no,created_by,created_at,distill_state,distill_started_at) VALUES(?,?,?,'owner',1,'running',?)")
        .run(id, sourceId, index + 2, Date.now());
    try {
      await requestUnderstanding(f.env, actor, { sourceId, revisionId, model: high.route, [field]: "low" });
      const request = f.db.prepare("SELECT distill_request_json AS request FROM source_revision WHERE id=?").get(revisionId);
      expect(request).toEqual({ request: JSON.stringify({ sourceId, revisionId, model: high.route, [field]: "low", producerFormat: "compact-k3-v1" }) });
      await expect(requestUnderstanding(f.env, actor, { sourceId, revisionId, [field]: "high" })).rejects.toMatchObject({ status: 409 });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state AS state FROM source_revision WHERE id=?").get(revisionId)).toEqual({ state: "queued" });
      f.db.prepare("UPDATE source_revision SET distill_state='paused' WHERE id=?").run(revisionId);
      f.db.prepare("UPDATE source_revision SET distill_state='none' WHERE id IN (?,?)").run(otherId, retryId);
      await requestUnderstanding(f.env, actor, { sourceId, revisionId, model: high.route });
      expect(f.create).toHaveBeenCalledExactlyOnceWith({ id: `distill-${revisionId}`, params: { revisionId, model: { ...high, [field]: "low" }, producerFormat: "compact-k3-v1" } });
      expect(f.db.prepare("SELECT distill_request_json AS request FROM source_revision WHERE id=?").get(revisionId)).toEqual(request);
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId })).progress[field]).toBe("low");
    } finally { f.db.close(); }
  });
  it("resumes an undispatched paused original on Gateway without carrying its old native Low intent", async () => {
    const f = fixture(0), gateway = Object.freeze({ ...model, route: "gateway:fixture/model", id: "fixture/model" });
    const lowRequest = JSON.stringify({ sourceId, revisionId, model: model.route, nativeReasoningEffort: "low" });
    f.db.prepare("UPDATE source_revision SET distill_state='paused',distill_request_json=? WHERE id=?").run(lowRequest, revisionId);
    vi.mocked(requireAvailableModel).mockResolvedValue(gateway);
    try {
      const bodies = new Map(f.bodies);
      expect(await requestUnderstanding(f.env, actor, { sourceId, revisionId, model: gateway.route })).toEqual({ revisionId });
      expect(f.create).toHaveBeenCalledExactlyOnceWith({ id: `distill-${revisionId}`, params: { revisionId, model: gateway } });
      expect(f.db.prepare("SELECT distill_attempt_id AS attempt,distill_model AS model,distill_calls AS calls,distill_request_json AS request FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ attempt: null, model: gateway.route, calls: 0, request: JSON.stringify({ sourceId, revisionId, model: gateway.route }) });
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId })).progress).not.toHaveProperty("nativeReasoningEffort");
      expect(gateway).not.toHaveProperty("nativeReasoningEffort");
      expect(f.bodies).toEqual(bodies); expect(f.db.prepare("SELECT count(*) AS n FROM distill_history").get()).toEqual({ n: 0 });
      expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it.each([0, 2])("reuses done output with recorded calls=%s on ordinary Understand and repeated reads without model work", async calls => {
    const f = fixture(calls); completedOutput(f);
    try {
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId), bodies = new Map(f.bodies);
      const first = await getUnderstanding(f.env, actor, { sourceId, revisionId });
      for (let index = 0; index < 2; index++) {
        expect(await requestUnderstanding(f.env, actor, { sourceId, revisionId, model: "workers-ai:other" })).toEqual({ revisionId });
        expect(await getUnderstanding(f.env, actor, { sourceId, revisionId })).toEqual(first);
      }
      expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId)).toEqual(before);
      expect(f.bodies).toEqual(bodies); expect((await getUnderstandingHistory(f.env, { sourceId, revisionId })).attempts).toEqual([]);
      expect(f.status).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
      expect(requireAvailableModel).not.toHaveBeenCalled(); expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("explicitly retries done within two calls and keeps its exact result, claims and usage in history", async () => {
    const f = fixture(2), output = completedOutput(f);
    try {
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId), bodies = new Map(f.bodies);
      const previous = await getUnderstanding(f.env, actor, { sourceId, revisionId });
      const extraction = JSON.parse(f.bodies.get(`source/${revisionId}/distill-call1.json`) ?? "null").output;
      extraction.glossary = [];
      extraction.guide = extraction.guide.map((item: { labels: string[]; text: string }) => ({ labels: item.labels, scope: [], assertion: item.text }));
      const synthesis = {
        supportedClaims: ["C0"], additionalClaims: [], supportedGuide: ["H0", "H1", "H2"],
        digestPlan: { C0: "methods" },
        supportedGlossary: [],
      };
      extraction.claims[0].statement = "The method retains evidence.";
      expect(await requestUnderstanding(f.env, actor, input)).toEqual({ revisionId, attemptId: retryId });
      expect(f.status).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1);
      const snapshot = JSON.parse(f.bodies.get(`source/${revisionId}/history/${retryId}.json`) ?? "null");
      expect(snapshot.revision).toEqual(before); expect(snapshot.claims).toEqual(previous.claims);
      vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
      const totalUsage = { inputTokens: 17, inputTokenDetails: { cacheReadTokens: 0 }, outputTokens: 8,
        raw: { prompt_tokens: 17, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } } };
      for (const output of [extraction, synthesis]) vi.mocked(experimental_streamTextLowMemory).mockImplementationOnce(options => ({
        consumeStream: async () => {
          await options.onChunk?.({ chunk: { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: totalUsage } } as never);
          if (typeof options.onEnd !== "function") throw new Error("Final output callback missing.");
          await options.onEnd({ output, totalUsage } as never);
        },
      } as never));
      await new DistillWorkflow({} as ExecutionContext, f.env).run({ payload: { revisionId, attemptId: retryId, model } } as never,
        { do: async (_name: string, _options: unknown, callback: () => unknown) => callback() } as never);
      expect(experimental_streamTextLowMemory).toHaveBeenCalledTimes(2); expect(generateText).not.toHaveBeenCalled();
      expect(vi.mocked(experimental_streamTextLowMemory).mock.calls.map(([options]) => [options.maxRetries, options.streamRetries])).toEqual([[0, 0], [0, 0]]);
      expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,distill_attempt_id AS attempt FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "done", calls: 2, attempt: retryId });
      const current = await getUnderstanding(f.env, actor, { sourceId, revisionId });
      expect(current.claims[0]?.statement).toBe("The method retains evidence.");
      const archived = await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId });
      expect(archived).toMatchObject({ state: "done", ...output, claims: previous.claims, report: previous.report, recordedUsage: previous.recordedUsage });
      expect(archived.recordedUsage).toMatchObject({ inputTokens: 42, cachedTokens: 0, outputTokens: 9, estimatedCostMicrousd: 73, pricingCheckedOn: "2025-01-02" });
      for (const [key, body] of bodies) expect(f.bodies.get(key)).toBe(body);
      expect((await getUnderstandingHistory(f.env, { sourceId, revisionId })).attempts.map(row => row.attemptId)).toEqual([revisionId]);
      const lookups = vi.mocked(requireAvailableModel).mock.calls.length;
      f.status.mockRejectedValue(new Error("Status is now unavailable")); vi.mocked(requireAvailableModel).mockRejectedValue(new Error("Model is now unavailable"));
      expect(await requestUnderstanding(f.env, actor, input)).toEqual({ revisionId, attemptId: retryId });
      expect(await requestUnderstanding(f.env, actor, { sourceId, revisionId })).toEqual({ revisionId });
      expect(requireAvailableModel).toHaveBeenCalledTimes(lookups); expect(f.status).toHaveBeenCalledTimes(1);
      expect(f.create).toHaveBeenCalledTimes(1); expect(experimental_streamTextLowMemory).toHaveBeenCalledTimes(2); expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it.each(["unknown", "running", "paused", "waiting", "queued", "waitingForPause", "rollingBack"])("blocks legacy zero-call done output with %s Workflow status regardless of age", async status => {
    const f = fixture(0); completedOutput(f); f.status.mockResolvedValue({ status });
    try {
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId);
      const rejected = await requestUnderstanding(f.env, actor, input); expect(rejected).toHaveProperty("rejected");
      expect(await requestUnderstanding(f.env, actor, input)).toEqual(rejected);
      expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId)).toEqual(before);
      expect(f.status).toHaveBeenCalledTimes(1); expect(f.create).not.toHaveBeenCalled(); expect(requireAvailableModel).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it.each(["get", "status"])("blocks zero-call done output when Workflow %s is unreadable", async phase => {
    const f = fixture(0); completedOutput(f);
    if (phase === "get") f.env.DISTILL.get = vi.fn(async () => { throw new Error("Workflow not found"); });
    else f.status.mockRejectedValue(new Error("Status unavailable"));
    try {
      expect(await requestUnderstanding(f.env, actor, input)).toHaveProperty("rejected");
      expect(f.create).not.toHaveBeenCalled(); expect(requireAvailableModel).not.toHaveBeenCalled();
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId })).state).toBe("done");
    } finally { f.db.close(); }
  });
  it.each(["complete", "errored", "terminated"])("requires confirmed %s Workflow status even for zero-call done output", async status => {
    const f = fixture(0); completedOutput(f); f.status.mockResolvedValue({ status });
    try {
      expect(await requestUnderstanding(f.env, actor, input)).not.toHaveProperty("rejected");
      expect(f.status).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1);
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId })).state).toBe("done");
    } finally { f.db.close(); }
  });
  it.each(["settled read", "snapshot write"])("rejects a done transition during %s without reusing the zero-call exception", async phase => {
    const f = fixture(0); completedOutput(f); let changed = false;
    f.db.prepare("UPDATE source_revision SET distill_state='partial' WHERE id=?").run(revisionId);
    const change = () => { changed = true; f.db.prepare("UPDATE source_revision SET distill_state='done' WHERE id=?").run(revisionId); };
    if (phase === "settled read") {
      const prepare = f.env.DB.prepare.bind(f.env.DB);
      f.env.DB.prepare = ((sql: string) => {
        if (!changed && sql.startsWith("SELECT * FROM source_revision WHERE id=? AND distill_attempt_id IS ? AND distill_state IN")) change();
        return prepare(sql);
      }) as typeof f.env.DB.prepare;
    } else {
      const put = f.env.BUCKET.put.bind(f.env.BUCKET);
      f.env.BUCKET.put = (async (key: string, body: string, options: R2PutOptions) => {
        const result = await put(key, body, options); if (!changed && key.endsWith(`history/${retryId}.json`)) change(); return result;
      }) as typeof f.env.BUCKET.put;
    }
    try {
      expect(await requestUnderstanding(f.env, actor, input)).toHaveProperty("rejected"); expect(changed).toBe(true);
      expect(f.status).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state AS state,distill_attempt_id AS attempt FROM source_revision WHERE id=?").get(revisionId)).toEqual({ state: "done", attempt: null });
      expect((await getUnderstandingHistory(f.env, { sourceId, revisionId })).attempts).toEqual([]);
      const orphan = f.bodies.get(`source/${revisionId}/history/${retryId}.json`);
      expect(await requestUnderstanding(f.env, actor, { ...input, retry: { ...input.retry, attemptId: otherId } })).not.toHaveProperty("rejected");
      expect(f.status).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.bodies.get(`source/${revisionId}/history/${retryId}.json`)).toBe(orphan);
    } finally { f.db.close(); }
  });
  it("keeps the forward switch guard dependent on an archived terminal predecessor and an unused target", () => {
    const f = fixture(0); completedOutput(f);
    const change = (attempt: string | null) => f.db.prepare("UPDATE source_revision SET distill_attempt_id=? WHERE id=?").run(attempt, revisionId);
    try {
      expect(() => change(retryId)).toThrow("distill_attempt_requires_archived_terminal");
      f.db.prepare("INSERT INTO distill_history(attempt_id,source_revision_id,rejection,archived_at) VALUES(?,?,'Rejected intent',1)").run(revisionId, revisionId);
      expect(() => change(retryId)).toThrow("distill_attempt_requires_archived_terminal");
      f.db.prepare("DELETE FROM distill_history WHERE attempt_id=?").run(revisionId);
      f.db.prepare("INSERT INTO distill_history(attempt_id,source_revision_id,snapshot_key,archived_at) VALUES(?,?,'snapshot',1)").run(revisionId, revisionId);
      f.db.prepare("UPDATE source_revision SET distill_state='running' WHERE id=?").run(revisionId);
      expect(() => change(retryId)).toThrow("distill_attempt_requires_archived_terminal");
      f.db.prepare("UPDATE source_revision SET distill_state='done' WHERE id=?").run(revisionId);
      f.db.prepare("INSERT INTO distill_history(attempt_id,source_revision_id,rejection,archived_at) VALUES(?,?,'Rejected intent',1)").run(retryId, revisionId);
      expect(() => change(retryId)).toThrow("distill_attempt_requires_archived_terminal");
      expect(() => change(otherId)).not.toThrow();
      expect(() => change(null)).toThrow("distill_attempt_requires_archived_terminal");
    } finally { f.db.close(); }
  });
  it("retries partial output while keeping its working guide and exact receipt accessible", async () => {
    const f = fixture(2); retainedOutput(f);
    try {
      f.db.prepare("UPDATE source_revision SET distill_state='partial',guide_summary='Working guide' WHERE id=?").run(revisionId);
      f.bodies.set(`source/${revisionId}/guide.md`, "Working prior guide"); f.bodies.set(`source/${revisionId}/digest.md`, "Working prior digest");
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId);
      await requestUnderstanding(f.env, actor, input);
      const old = await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId });
      expect(old.state).toBe("partial"); expect(old.guide).toBe("Working prior guide"); expect(old.digest).toBe("Working prior digest"); expect(old.canRecover).toBe(false);
      expect(JSON.parse(f.bodies.get(`source/${revisionId}/history/${retryId}.json`) ?? "null").revision).toEqual(before); expect(f.create).toHaveBeenCalledTimes(1);
    } finally { f.db.close(); }
  });
  it("preserves a Save winner without poisoning the next partial retry snapshot", async () => {
    const f = fixture(2); retainedOutput(f); let saved = false;
    try {
      f.db.prepare("UPDATE source_revision SET distill_state='partial' WHERE id=?").run(revisionId);
      const second = JSON.parse(f.bodies.get(`source/${revisionId}/distill-call2.json`) ?? "null"); second.output.supportedClaims = [];
      f.bodies.set(`source/${revisionId}/distill-call2.json`, JSON.stringify(second));
      const put = f.env.BUCKET.put.bind(f.env.BUCKET);
      f.env.BUCKET.put = (async (key: string, body: string, options: R2PutOptions) => {
        const result = await put(key, body, options);
        if (!saved && key === `source/${revisionId}/history/${retryId}.json`) { saved = true; await requestUnderstanding(f.env, actor, { sourceId, revisionId, saveAvailable: true }); }
        return result;
      }) as typeof f.env.BUCKET.put;
      expect(await requestUnderstanding(f.env, actor, input)).toHaveProperty("rejected"); expect(f.create).not.toHaveBeenCalled();
      const savedHead = f.db.prepare("SELECT distill_report_key AS report FROM source_revision WHERE id=?").get(revisionId);
      expect(savedHead).toEqual({ report: `source/${revisionId}/checked/distill.json` });
      const orphan = f.bodies.get(`source/${revisionId}/history/${retryId}.json`);
      await requestUnderstanding(f.env, actor, { ...input, retry: { ...input.retry, attemptId: otherId } }); expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.bodies.get(`source/${revisionId}/history/${retryId}.json`)).toBe(orphan);
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId })).guide).toBeTruthy();
    } finally { f.db.close(); }
  });
  it.each([false, true])("linearizes rejection against a held original with acceptance winner=%s", async acceptanceWins => {
    const f = fixture();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(requireAvailableModel).mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { release = resolve; });
      if (acceptanceWins) throw new LibraryError("unavailable", "The model became unavailable.", 503); return model; });
    try {
      const original = requestUnderstanding(f.env, actor, input); await started;
      if (!acceptanceWins) vi.mocked(requireAvailableModel).mockRejectedValueOnce(new LibraryError("unavailable", "The model became unavailable.", 503));
      const duplicate = await requestUnderstanding(f.env, actor, input); release(); const first = await original;
      if (acceptanceWins) { expect(first).not.toHaveProperty("rejected"); expect(duplicate).not.toHaveProperty("rejected"); expect(f.create).toHaveBeenCalledTimes(1); }
      else {
        expect(first).toEqual(duplicate); expect(first).toHaveProperty("rejected"); expect(f.create).not.toHaveBeenCalled();
        const read = await getUnderstanding(f.env, actor, { sourceId, revisionId, requestId: retryId }); expect(read.knownRequestId).toBe(retryId); expect(read.requestRejection).toContain("unavailable");
        const resolved = vi.mocked(requireAvailableModel).mock.calls.length; await requestUnderstanding(f.env, actor, input); expect(requireAvailableModel).toHaveBeenCalledTimes(resolved);
        await requestUnderstanding(f.env, actor, { ...input, retry: { ...input.retry, attemptId: otherId } }); expect(f.create).toHaveBeenCalledTimes(1);
      }
    } finally { f.db.close(); }
  });
  it("records an unavailable model rejection so a fresh explicit model choice can proceed", async () => {
    const f = fixture();
    try {
      vi.mocked(requireAvailableModel).mockRejectedValueOnce(new LibraryError("unavailable", "Selected model unavailable.", 503));
      expect(await requestUnderstanding(f.env, actor, input)).toHaveProperty("rejected", "Selected model unavailable.");
      expect((await getUnderstandingHistory(f.env, { sourceId, revisionId })).attempts).toEqual([]);
      const nextModel = { ...model, route: "workers-ai:new-choice", id: "new-choice" }; vi.mocked(requireAvailableModel).mockResolvedValue(nextModel);
      await requestUnderstanding(f.env, actor, { ...input, model: nextModel.route, retry: { ...input.retry, attemptId: otherId } });
      expect(f.create).toHaveBeenCalledTimes(1); expect(f.db.prepare("SELECT distill_model AS model FROM source_revision WHERE id=?").get(revisionId)).toEqual({ model: nextModel.route });
    } finally { f.db.close(); }
  });
  it("records a changed predecessor rejection without permitting that ID to start later", async () => {
    const f = fixture();
    try {
      await requestUnderstanding(f.env, actor, input);
      const wrong = { ...input, retry: { ...input.retry, attemptId: otherId } };
      expect(await requestUnderstanding(f.env, actor, wrong)).toHaveProperty("rejected");
      f.db.prepare("UPDATE source_revision SET distill_state='failed',distill_calls=0 WHERE id=?").run(revisionId);
      expect(await requestUnderstanding(f.env, actor, wrong)).toHaveProperty("rejected"); expect(f.create).toHaveBeenCalledTimes(1);
      await requestUnderstanding(f.env, actor, { ...input, retry: { attemptId: crypto.randomUUID(), previousAttemptId: retryId } }); expect(f.create).toHaveBeenCalledTimes(2);
    } finally { f.db.close(); }
  });
  it("pages archived runs at tied timestamps while excluding rejected intents", async () => {
    const f = fixture(0), now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      let previousAttemptId = revisionId;
      for (let index = 0; index < 21; index++) {
        const attemptId = crypto.randomUUID();
        await requestUnderstanding(f.env, actor, { ...input, retry: { attemptId, previousAttemptId } });
        f.db.prepare("UPDATE source_revision SET distill_state='failed' WHERE id=?").run(revisionId); previousAttemptId = attemptId;
      }
      await requestUnderstanding(f.env, actor, { ...input, retry: { attemptId: crypto.randomUUID(), previousAttemptId: revisionId } });
      const first = await getUnderstandingHistory(f.env, { sourceId, revisionId }); expect(first.attempts).toHaveLength(20); expect(first.nextCursor).toBeTruthy();
      const second = await getUnderstandingHistory(f.env, { sourceId, revisionId, cursor: first.nextCursor ?? undefined }); expect(second.attempts).toHaveLength(1); expect(second.nextCursor).toBeNull();
      expect(new Set([...first.attempts, ...second.attempts].map(row => row.attemptId)).size).toBe(21);
    } finally { now.mockRestore(); f.db.close(); }
  });
  it("archives exact failed accounting and replays one identity before any model work", async () => {
    const f = fixture();
    try {
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId);
      await requestUnderstanding(f.env, actor, input);
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.db.prepare("SELECT distill_request_json AS request FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ request: JSON.stringify({ sourceId, revisionId, previousAttemptId: revisionId, model: model.route, producerFormat: "compact-k3-v1" }) });
      expect(f.create.mock.calls[0]).toEqual([{ id: `distill-attempt-${retryId}`, params: { revisionId, attemptId: retryId, model, producerFormat: "compact-k3-v1" } }]);
      const archived = f.db.prepare("SELECT snapshot_key FROM distill_history WHERE attempt_id=?").get(revisionId) as { snapshot_key: string };
      expect(JSON.parse(f.bodies.get(archived.snapshot_key) ?? "null").revision).toEqual(before);
      expect(f.bodies.get(`source/${revisionId}/distill.json`)).toBe(f.original);
      const resolved = vi.mocked(requireAvailableModel).mock.calls.length;
      await requestUnderstanding(f.env, actor, input);
      expect(requireAvailableModel).toHaveBeenCalledTimes(resolved);
      expect(f.create).toHaveBeenCalledTimes(1);
      const old = await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId });
      expect(old.state).toBe("failed"); expect(old.report?.usage.inputTokens).toBeNull();
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId, requestId: retryId })).knownRequestId).toBe(retryId);
      expect((await getUnderstanding(f.env, actor, { sourceId, revisionId, requestId: otherId })).knownRequestId).toBeNull();
    } finally { f.db.close(); }
  });
  it.each(["unknown", "running", "paused", "waiting", "queued", "rollingBack"])("blocks a paid predecessor with %s Workflow status", async status => {
    const f = fixture(); f.status.mockResolvedValue({ status });
    try { expect(await requestUnderstanding(f.env, actor, input)).toHaveProperty("rejected"); expect(f.create).not.toHaveBeenCalled(); expect(requireAvailableModel).not.toHaveBeenCalled(); }
    finally { f.db.close(); }
  });
  it("archives final accounting settled while the predecessor status read was in flight", async () => {
    const f = fixture();
    try {
      f.status.mockImplementationOnce(async () => {
        f.db.prepare("UPDATE source_revision SET distill_input_tokens=42,distill_cached_tokens=0,distill_output_tokens=NULL,distill_pricing_checked_on='2025-01-02' WHERE id=?").run(revisionId);
        return { status: "complete" };
      });
      await requestUnderstanding(f.env, actor, input);
      const snapshot = JSON.parse(f.bodies.get(`source/${revisionId}/history/${retryId}.json`) ?? "null");
      expect(snapshot.revision).toMatchObject({ distill_input_tokens: 42, distill_cached_tokens: 0, distill_output_tokens: null, distill_estimated_cost_microusd: 73, distill_pricing_checked_on: "2025-01-02" });
      const history = await getUnderstanding(f.env, actor, { sourceId, revisionId, attemptId: revisionId });
      expect(history.recordedUsage).toMatchObject({ inputTokens: 42, cachedTokens: 0, outputTokens: null, estimatedCostMicrousd: 73, pricingCheckedOn: "2025-01-02" });
      expect(history.report?.usage.inputTokens).toBeNull();
    } finally { f.db.close(); }
  });
  it("blocks an unconfirmed paid Workflow without guessing not-found", async () => {
    const f = fixture(); f.status.mockRejectedValue(new Error("not found or network unavailable"));
    try { expect(await requestUnderstanding(f.env, actor, input)).toHaveProperty("rejected"); expect(f.create).not.toHaveBeenCalled(); }
    finally { f.db.close(); }
  });
  it("permits a failed zero-call attempt with uncertain create and fences its old release/admission", async () => {
    const f = fixture(0); f.status.mockRejectedValue(new Error("absent Workflow"));
    try {
      await requestUnderstanding(f.env, actor, input);
      expect(f.status).not.toHaveBeenCalled(); expect(f.create).toHaveBeenCalledTimes(1);
      expect(await failUndispatchedDistill(f.env, revisionId, "late legacy release")).toBe(false);
      f.db.prepare("UPDATE source_revision SET distill_state='queued' WHERE id=?").run(revisionId);
      expect(await admitDistill(f.env, revisionId, model)).toBe(false);
      expect(f.db.prepare("SELECT distill_state AS state,distill_error AS error FROM source_revision WHERE id=?").get(revisionId)).toEqual({ state: "queued", error: null });
    } finally { f.db.close(); }
  });
  it("blocks snapshot failure and retains an immutable post-put snapshot before a safe new intent", async () => {
    const f = fixture();
    try {
      f.rollbackBatch();
      const rejected = await requestUnderstanding(f.env, actor, input); expect(rejected).toHaveProperty("rejected");
      const snapshot = f.bodies.get(`source/${revisionId}/history/${retryId}.json`); expect(snapshot).toBeTruthy(); expect(f.create).not.toHaveBeenCalled();
      await requestUnderstanding(f.env, actor, input); expect(f.create).not.toHaveBeenCalled();
      await requestUnderstanding(f.env, actor, { ...input, retry: { ...input.retry, attemptId: otherId } });
      expect(f.bodies.get(`source/${revisionId}/history/${retryId}.json`)).toBe(snapshot); expect(f.create).toHaveBeenCalledTimes(1);
    } finally { f.db.close(); }
    const broken = fixture(); broken.failStorage();
    try { expect(await requestUnderstanding(broken.env, actor, input)).toHaveProperty("rejected"); expect(broken.db.prepare("SELECT count(*) AS n FROM distill_history WHERE rejection IS NULL").get()).toEqual({ n: 0 }); expect(broken.create).not.toHaveBeenCalled(); }
    finally { broken.db.close(); }
  });
  it.each([false, true].flatMap(committed => ["failed", "done"].map(state => ({ committed, state }))))("recovers a committed=$committed $state batch without duplicate dispatch", async ({ committed, state }) => {
    const f = fixture(); if (state === "done") completedOutput(f);
    try {
      if (committed) f.loseBatchReply(); else f.rollbackBatch();
      const result = await requestUnderstanding(f.env, actor, input);
      if (!committed) { expect(result).toHaveProperty("rejected"); expect(f.create).not.toHaveBeenCalled(); }
      await requestUnderstanding(f.env, actor, input);
      if (!committed) await requestUnderstanding(f.env, actor, { ...input, retry: { ...input.retry, attemptId: otherId } });
      await scheduleDistillation(f.env, revisionId);
      expect(f.create).toHaveBeenCalledTimes(1); expect(f.db.prepare("SELECT count(*) AS n FROM distill_history WHERE rejection IS NULL").get()).toEqual({ n: 1 });
    } finally { f.db.close(); }
  });
  it.each(["failed", "done"])("chooses one competing %s predecessor CAS and preserves archived identity replay", async state => {
    const f = fixture(); if (state === "done") completedOutput(f);
    try {
      const result = await Promise.allSettled([requestUnderstanding(f.env, actor, input), requestUnderstanding(f.env, actor, { ...input, retry: { ...input.retry, attemptId: otherId } })]);
      expect(result.filter(r => r.status === "fulfilled" && !("rejected" in r.value))).toHaveLength(1); expect(f.create).toHaveBeenCalledTimes(1);
      const winner = f.db.prepare("SELECT distill_attempt_id AS id FROM source_revision WHERE id=?").get(revisionId) as { id: string };
      const accepted = { ...input, retry: { ...input.retry, attemptId: winner.id } };
      f.db.prepare("UPDATE source_revision SET distill_state='failed',distill_calls=1 WHERE id=?").run(revisionId);
      const nextId = crypto.randomUUID();
      await requestUnderstanding(f.env, actor, { ...input, retry: { attemptId: nextId, previousAttemptId: winner.id } });
      const resolved = vi.mocked(requireAvailableModel).mock.calls.length;
      await requestUnderstanding(f.env, actor, accepted);
      expect(requireAvailableModel).toHaveBeenCalledTimes(resolved); expect(f.create).toHaveBeenCalledTimes(2);
      await expect(requestUnderstanding(f.env, actor, { ...accepted, model: "workers-ai:different" })).rejects.toMatchObject({ status: 409 });
      await expect(requestUnderstanding(f.env, actor, { ...accepted, retry: { attemptId: winner.id, previousAttemptId: nextId } })).rejects.toMatchObject({ status: 409 });
      expect(requireAvailableModel).toHaveBeenCalledTimes(resolved);
      const history = await getUnderstandingHistory(f.env, { sourceId, revisionId }); expect(history.attempts).toHaveLength(2);
      await expect(f.env.DB.prepare("UPDATE distill_history SET request_json='changed'").run()).rejects.toThrow("distill_history_is_immutable");
    } finally { f.db.close(); }
  });
  it("fences an old call paused between reading admission and its dispatch CAS", async () => {
    const f = fixture(0);
    let release!: () => void, entered!: () => void;
    const transportEntered = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(resolveModelTransport).mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return {} as never; });
    try {
      f.db.prepare("UPDATE source_revision SET distill_state='running',distill_started_at=? WHERE id=?").run(Date.now(), revisionId);
      const old = new DistillWorkflow({} as ExecutionContext, f.env).run({ payload: { revisionId, model } } as never, { do: async (_name: string, _options: unknown, callback: () => unknown) => callback() } as never);
      await transportEntered;
      f.db.prepare("UPDATE source_revision SET distill_state='failed' WHERE id=?").run(revisionId);
      await requestUnderstanding(f.env, actor, input);
      const before = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId);
      release(); await old;
      expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled(); expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId)).toEqual(before);
    } finally { f.db.close(); }
  });
  it("rejects a new publication between frozen context metadata and the single claims read", async () => {
    const f = fixture();
    try {
      f.db.exec("INSERT INTO project(id,title,created_at,updated_at) VALUES('p','Project',1,1)");
      f.db.prepare("INSERT INTO project_source(project_id,source_id,added_at,added_by) VALUES('p',?,1,'owner')").run(sourceId);
      f.db.prepare("UPDATE source_revision SET distill_state='done',readable_size=9000000,guide_summary='Old guide',claim_count=1 WHERE id=?").run(revisionId);
      const prepare = f.env.DB.prepare.bind(f.env.DB);
      f.env.DB.prepare = ((sql: string) => {
        if (sql.startsWith("WITH owner AS")) f.db.prepare("UPDATE source_revision SET distill_report_key=?,guide_summary='New guide' WHERE id=?").run(`source/${revisionId}/checked/distill.json`, revisionId);
        return prepare(sql);
      }) as typeof f.env.DB.prepare;
      await expect(buildContext(f.env, actor, { projectId: "p", scopeMode: "project_default", model: { contextTokens: 8000, maxOutputTokens: 1000 } })).rejects.toMatchObject({ code: "conflict", status: 409 });
      expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("keeps A's captured claim count when B publishes while A's finish waits on R2", async () => {
    const f = fixture(2); retainedOutput(f); let switched = false;
    try {
      f.bodies.delete(`source/${revisionId}/distill.json`);
      f.db.prepare("INSERT INTO claim(id,source_revision_id,ordinal,kind,statement,quote,block_index,start_byte,end_byte,created_at) VALUES('old-card',?,0,'method','Old card','Original',1,0,8,1)").run(revisionId);
      f.db.prepare("UPDATE source_revision SET distill_state='running',distill_started_at=?,guide_summary='Old guide',claim_count=1 WHERE id=?").run(Date.now(), revisionId);
      const get = f.env.BUCKET.get.bind(f.env.BUCKET);
      f.env.BUCKET.get = (async (key: string) => {
        if (!switched && key === `source/${revisionId}/distill.json`) {
          switched = true; f.db.prepare("UPDATE source_revision SET distill_state='partial' WHERE id=?").run(revisionId);
          await requestUnderstanding(f.env, actor, input);
          f.db.prepare("INSERT INTO claim(id,source_revision_id,ordinal,kind,statement,quote,block_index,start_byte,end_byte,created_at) VALUES('new-card',?,1,'method','New card','Original',1,0,8,1)").run(revisionId);
          f.db.prepare("UPDATE source_revision SET guide_summary='New guide',claim_count=2 WHERE id=?").run(revisionId);
        }
        return get(key);
      }) as typeof f.env.BUCKET.get;
      await new DistillWorkflow({} as ExecutionContext, f.env).run({ payload: { revisionId, model } } as never, {
        do: async (name: string, _options: unknown, callback: () => unknown) => name === "finish understanding" ? callback() : { kept: 1, guideSentences: 3, dropped: [], clearedNumbers: 0 },
      } as never);
      expect(switched).toBe(true); expect(JSON.parse(f.bodies.get(`source/${revisionId}/distill.json`) ?? "null").kept).toBe(1);
      expect(f.db.prepare("SELECT claim_count AS claims,guide_summary AS guide,distill_attempt_id AS attempt FROM source_revision WHERE id=?").get(revisionId)).toEqual({ claims: 2, guide: "New guide", attempt: retryId });
    } finally { f.db.close(); }
  });
  it.each(["verify", "publish", "finish", "save"])("fences the old %s callback after the current attempt switches", async mode => {
    const f = fixture(2); retainedOutput(f);
    let current: unknown, claims: unknown, switched = false;
    const switchAttempt = async () => {
      if (switched) return; switched = true;
      f.db.prepare("UPDATE source_revision SET distill_state='failed' WHERE id=?").run(revisionId);
      await requestUnderstanding(f.env, actor, input);
      current = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId);
      claims = f.db.prepare("SELECT * FROM claim WHERE source_revision_id=?").all(revisionId);
    };
    try {
      if (mode !== "save") f.db.prepare("UPDATE source_revision SET distill_state='running',distill_started_at=? WHERE id=?").run(Date.now(), revisionId);
      if (mode === "verify") f.bodies.delete(`source/${revisionId}/distill-verified.json`);
      const put = f.env.BUCKET.put.bind(f.env.BUCKET), get = f.env.BUCKET.get.bind(f.env.BUCKET);
      f.env.BUCKET.put = (async (key: string, body: string, options: R2PutOptions) => {
        const result = await put(key, body, options);
        if (key === `source/${revisionId}/${mode === "verify" ? "distill-verified.json" : mode === "publish" ? "guide.md" : "checked/distill.json"}` && mode !== "finish") await switchAttempt();
        return result;
      }) as typeof f.env.BUCKET.put;
      if (mode === "finish") f.env.BUCKET.get = (async (key: string) => {
        if (key === `source/${revisionId}/distill.json`) await switchAttempt(); return get(key);
      }) as typeof f.env.BUCKET.get;
      if (mode === "save") await expect(requestUnderstanding(f.env, actor, { sourceId, revisionId, saveAvailable: true })).rejects.toMatchObject({ status: 409 });
      else await new DistillWorkflow({} as ExecutionContext, f.env).run({ payload: { revisionId, model } } as never, {
        do: async (name: string, _options: unknown, callback: () => unknown) => {
          if ((mode === "verify" && name === "verify source excerpts") || (mode === "publish" && name === "store understanding") || name === "finish understanding") return callback();
          return { kept: 1, guideSentences: 3, dropped: [], clearedNumbers: 0 };
        },
      } as never);
      expect(switched).toBe(true); expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId)).toEqual(current);
      expect(f.db.prepare("SELECT * FROM claim WHERE source_revision_id=?").all(revisionId)).toEqual(claims);
      expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
});
