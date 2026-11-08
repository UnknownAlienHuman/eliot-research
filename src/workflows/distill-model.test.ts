import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { scanBlocks, type Block } from "../blocks";
import type { Actor } from "../auth";
import { LibraryError } from "../library";
import { estimateModelInput } from "../model-input";
import { modelInputLimit } from "../models";
import type { ModelSpec } from "../models";
import type * as Models from "../models";
import type * as ModelTransport from "../model-transport";
import type * as AISDK from "ai";
import { z } from "zod";
import type { DistillInput } from "../shared/api";
import type { DistillReport } from "../understanding";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { Markdown } from "../web/Markdown";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(_ctx: unknown, readonly env: Env) {}
  },
}));
vi.mock("ai", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("ai");
  return { ...actual, generateText: vi.fn(), experimental_streamTextLowMemory: vi.fn(), Output: { object: vi.fn(), json: vi.fn() } };
});
vi.mock("../model-transport", async () => ({
  ...await vi.importActual<typeof ModelTransport>("../model-transport"),
  resolveModelTransport: vi.fn(),
  modelFailure: vi.fn(() => "Unexpected model failure projection"),
}));
vi.mock("../model-catalog", () => ({ discoverGatewayModels: vi.fn() }));
vi.mock("../native-model-catalog", () => ({ discoverNativeModels: vi.fn() }));
vi.mock("../models", async () => ({
  ...await vi.importActual<typeof Models>("../models"),
  requireAvailableModel: vi.fn(), requireCatalogModel: vi.fn(), availableModels: vi.fn(),
}));

import { NoObjectGeneratedError, generateText, experimental_streamTextLowMemory, Output } from "ai";
import { modelFailure, resolveModelTransport } from "../model-transport";
import { availableModels, modelTokenLimit, requireAvailableModel, requireCatalogModel } from "../models";
import { discoverGatewayModels } from "../model-catalog";
import { discoverNativeModels } from "../native-model-catalog";
import { DistillWorkflow, extractionSchema, hasAvailableUnderstanding, requestUnderstanding, scheduleDistillation } from "./distill";
import { getUnderstanding } from "../understanding";

const revisionId = "d9b7d198-0dd2-4d5f-8176-e824e25bb6d0";
const sourceId = "fb3c275a-46c0-43f6-9d49-deea18581c44";
const prefix = `source/${revisionId}/`;
// Deliberately not a catalogue entry: the Workflow consumes the admitted payload.
// Token-native snapshot: no currency fields; bounds come from context/output limits.
const snapshot: ModelSpec = Object.freeze({
  route: "gateway:command-code/fixture/admitted", id: "fixture/admitted", label: "Admitted snapshot fixture",
  contextTokens: 262144, maxOutputTokens: null, outputReserveTokens: 8192,
  responseFormat: false, structuredOutputs: false, reasoning: Object.freeze({ enabled: false as const }),
  checkedOn: "2026-10-27", enabled: true,
});

function fixture(storedRoute: string, document?: { text: string; blocks: Block[] }) {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql", "0005_model_gateway.sql", "0006_integrity.sql", "0007_manual_understanding.sql", "0008_model_providers.sql", "0012_model_admission.sql", "0013_understanding_retry.sql"])
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const text = document?.text ?? "The method uses normalization. Its source passage is retained.";
  const blocks = document?.blocks ?? [{ id: 1, type: "paragraph", start: 0, end: new TextEncoder().encode(text).byteLength, heading: null }];
  const readableSize = new TextEncoder().encode(text).byteLength;
  db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES (?,'Paper','text','owner',0,0)").run(sourceId);
  db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,readable_size,created_by,created_at,
    distill_state,distill_model,distill_started_at,distill_estimated_cost_microusd)
    VALUES (?,?,1,'readable',?,'owner',0,'running',?,?,322766)`)
    .run(revisionId, sourceId, readableSize, storedRoute, Date.now() - 100);
  db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run(revisionId, sourceId);
  const bodies = new Map([[prefix + "text.md", text], [prefix + "blocks.json", JSON.stringify(blocks)]]);
  const dispatchCAS = vi.fn(), sourceWrites = vi.fn();
  const env = { DB: {
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    prepare(sql: string) {
      const operations = (args: SQLInputValue[]) => ({
          first: async () => db.prepare(sql).get(...args) ?? null,
          all: async () => ({ results: db.prepare(sql).all(...args) }),
          run: async () => {
            if (/^UPDATE\s+source\s/i.test(sql)) sourceWrites(sql, args);
            if (/SET\s+distill_calls\s*=\s*distill_calls\s*\+\s*1/i.test(sql)) dispatchCAS(sql, args);
            return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } };
          },
        });
      return { ...operations([]), bind: (...args: SQLInputValue[]) => operations(args) };
    },
  }, BUCKET: {
    async get(key: string) {
      const body = bodies.get(key);
      if (body === undefined) return null;
      const bytes = new TextEncoder().encode(body);
      return { text: async () => body, json: async () => JSON.parse(body) as unknown,
        arrayBuffer: async () => bytes.buffer, size: bytes.byteLength, body: new Response(bytes).body };
    },
    async put(key: string, body: string) {
      if (bodies.has(key)) return null;
      bodies.set(key, body); return {};
    },
  } } as unknown as Env;
  return { db, env, bodies, dispatchCAS, sourceWrites };
}

const explicitlySelectedRevisionId = "148e1392-f987-4fc5-bc65-152c9000b4d8";
const explicitlySelectedSourceId = "e61d9a7d-0817-4a9b-b46b-3f52ab3bd47f";
const otherQueuedRevisionId = "3ba8fcb2-ddca-41b1-b901-00fdb4f76afd";
const otherQueuedSourceId = "c3fd7da4-b662-4aa5-a6fc-9c84b6299940";

function callerFixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql", "0005_model_gateway.sql", "0006_integrity.sql", "0007_manual_understanding.sql", "0008_model_providers.sql", "0012_model_admission.sql", "0013_understanding_retry.sql"])
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));

  const insertSource = (id: string, title: string, revision: string, state: "none" | "queued" | "running", createdAt: number) => {
    db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES (?,?,'text','owner',?,?)")
      .run(id, title, createdAt, createdAt);
    db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,readable_size,created_by,created_at,
      distill_state,distill_model,distill_calls,distill_estimated_cost_microusd)
      VALUES (?,?,1,'readable',40,'owner',?,?,?,0,0)`)
      .run(revision, id, createdAt, state, snapshot.route);
    db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run(revision, id);
  };
  insertSource(explicitlySelectedSourceId, "Selected", explicitlySelectedRevisionId, "queued", 2);
  insertSource(otherQueuedSourceId, "Older queued source", otherQueuedRevisionId, "queued", 1);

  const createWorkflow = vi.fn(async (_input: { id: string; params: { revisionId: string; model: ModelSpec } }) => ({ id: "stubbed-workflow" }));
  const bodies = new Map<string, string>();
  const env = { DB: {
    prepare(sql: string) {
      const operations = (args: SQLInputValue[]) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      });
      return { ...operations([]), bind: (...args: SQLInputValue[]) => operations(args) };
    },
  }, DISTILL: { create: createWorkflow }, BUCKET: {
    async get(key: string) {
      const body = bodies.get(key);
      return body === undefined ? null : { json: async () => JSON.parse(body) as unknown };
    },
  } } as unknown as Env;
  return { db, env, createWorkflow, insertSource, bodies };
}

// A and C occupy both slots while explicitly requested B waits. A's persisted
// output simulates cached Workflow steps, not a new model generation.
function queuedBehindRunning() {
  const f = callerFixture();
  f.insertSource(sourceId, "Finishing source", revisionId, "running", 0);
  f.db.prepare("UPDATE source_revision SET distill_state='running',distill_started_at=? WHERE id IN (?,?)")
    .run(Date.now(), revisionId, otherQueuedRevisionId);
  f.db.prepare("UPDATE source_revision SET distill_calls=2,guide_summary='Saved understanding' WHERE id=?").run(revisionId);
  f.bodies.set(prefix + "distill.json", JSON.stringify({ state: "done", error: null,
    usage: { calls: 2, wallMs: 100, inputTokens: 20, cachedTokens: 0, outputTokens: 10, tokenLimit: 540672 } }));
  return f;
}

async function completeSavedWorkflow(f: ReturnType<typeof callerFixture>) {
  const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
    name === "finish understanding" ? callback() : undefined);
  return new DistillWorkflow({} as ExecutionContext, f.env).run(
    { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>,
    { do: stepDo } as unknown as WorkflowStep);
}

function documentWithBlocks(parts: Array<{ type: Block["type"]; text: string }>): { text: string; blocks: Block[] } {
  const encoder = new TextEncoder();
  let offset = 0;
  const blocks = parts.map(({ type, text }, index): Block => {
    const start = offset;
    offset += encoder.encode(text).byteLength;
    return { id: index + 1, type, start, end: offset, heading: null };
  });
  return { text: parts.map(({ text }) => text).join(""), blocks };
}

const forbiddenLookups = [requireAvailableModel, requireCatalogModel, availableModels,
  discoverGatewayModels, discoverNativeModels];
beforeEach(() => {
  vi.mocked(generateText).mockReset().mockRejectedValue(new Error("Unexpected model generation"));
  vi.mocked(experimental_streamTextLowMemory).mockReset().mockImplementation(() => { throw new Error("Unexpected native generation"); });
  vi.mocked(resolveModelTransport).mockReset().mockRejectedValue(new Error("Fixture transport stopped before dispatch."));
  vi.mocked(modelFailure).mockReset().mockReturnValue("Unexpected model failure projection");
  for (const lookup of forbiddenLookups) vi.mocked(lookup).mockReset().mockRejectedValue(new Error("Unexpected catalogue lookup"));
});

async function run(f: ReturnType<typeof fixture>, serializeErrors = false, model = snapshot, producerFormat?: "compact-k3-v1" | "legacy-v4", failBeforeFinish = false) {
  const stepDo = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
    try {
      if (failBeforeFinish && _name === "finish understanding")
        throw new LibraryError("unavailable", "Simulated report publication interruption.", 503);
      return await callback();
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Simulate Workflow serialization stripping the error class and cause.
      if (serializeErrors && error instanceof Error) throw new Error(error.message);
      throw error;
    }
  });
  await new DistillWorkflow({} as ExecutionContext, f.env).run(
    { payload: { revisionId, model, ...(producerFormat === undefined ? {} : { producerFormat }) } } as WorkflowEvent<DistillInput>,
    { do: stepDo } as unknown as WorkflowStep);
  return stepDo;
}

function finished(f: ReturnType<typeof fixture>, error: string) {
  expect(f.dispatchCAS).not.toHaveBeenCalled();
  expect(generateText).not.toHaveBeenCalled();
  for (const lookup of forbiddenLookups) expect(lookup).not.toHaveBeenCalled();
  expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,distill_error AS error FROM source_revision WHERE id=?")
    .get(revisionId)).toEqual({ state: "failed", calls: 0, error });
  const body = f.bodies.get(prefix + "distill.json");
  if (!body) throw new Error("Actual failure finalization did not store its report.");
  const report = JSON.parse(body) as DistillReport & { state: string };
  expect(report).toMatchObject({ state: "failed", error, kept: 0, usage: { calls: 0 } });
  expect(f.bodies.has(prefix + "distill-call1.json")).toBe(false);
  expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
}

describe("DistillWorkflow admitted model snapshot", () => {
  it.each(["valid", "malformed final JSON", "invalid final schema", "nested output bound", "no final text", "reported usage then failure", "missing finish", "length with valid output", "SDK placeholder zeros", "response budget"] as const)(
    "stores only final native onEnd output and preserves usage/guards: %s", async mode => {
      const realParser = ["valid", "malformed final JSON", "invalid final schema", "nested output bound", "no final text", "missing finish"].includes(mode);
      const id = realParser ? "@cf/zai-org/glm-5.3-flash" : "fixture";
      const model: ModelSpec = { ...snapshot, route: "workers-ai:" + id, id, nativeReasoningEffort: "high" };
      delete model.responseFormat;
      const f = fixture(model.route);
      let admitted = model;
      f.db.prepare("UPDATE source_revision SET distill_token_limit_kind='unknown',distill_token_limit=NULL WHERE id=?").run(revisionId);
      const first = { claims: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The method uses normalization.",
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }],
        guide: ["The method uses normalization.", "The source retains its passage.", "The source describes a method."]
          .map(assertion => ({ labels: ["[S1:1]"], scope: [], assertion })), glossary: [], questions: ["Which method?", "Which evidence?", "Which passage?"] };
      const second = { supportedClaims: ["C0"], additionalClaims: [], supportedGuide: ["H0", "H1", "H2"], supportedGlossary: [], digestPlan: { C0: "methods" } };
      const unknown = mode === "SDK placeholder zeros";
      const usage = { inputTokens: unknown ? 0 : 71, outputTokens: unknown ? 0 : 19, inputTokenDetails: { cacheReadTokens: 0 },
        ...(unknown ? {} : { raw: { prompt_tokens: 71, completion_tokens: 19, prompt_tokens_details: { cached_tokens: 0 } } }) };
      const privateText = "Private provider details must not escape";
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
      let ordinal = 0, acceptedChunks = 0, finalParses = 0, bindingCalls = 0;
      const bindingEfforts: unknown[] = [];
      vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
      vi.mocked(modelFailure).mockReturnValue("Model stream failed (HTTP 408).");
      vi.mocked(experimental_streamTextLowMemory).mockImplementation(options => {
        const output = ordinal++ === 0 ? first : second;
        return { consumeStream: async ({ onError }: { onError: (error: unknown) => void }) => {
          if (mode === "response budget") {
            const transform = options.experimental_transform;
            if (typeof transform !== "function") throw new Error("Native response guard was not supplied.");
            let chunks = 0;
            const source = new ReadableStream({ pull(controller) {
              if (chunks++ === 200) controller.close(); else controller.enqueue({ type: "text-delta", id: "offline", text: "x".repeat(8192) });
            } });
            try { await source.pipeThrough(transform({ tools: {}, stopStream: () => {} })).pipeTo(new WritableStream({ write() { acceptedChunks++; } })); }
            catch (error) { onError(error); }
            return;
          }
          await options.onChunk?.({ chunk: { type: "finish-step", finishReason: mode === "missing finish" ? "other" : mode === "length with valid output" ? "length" : "stop",
            ...(mode === "missing finish" ? {} : { rawFinishReason: mode === "length with valid output" ? "length" : "stop" }), usage } } as never);
          if (mode === "reported usage then failure") onError(new Error(privateText));
          if (typeof options.onEnd !== "function") throw new Error("Final validated output callback was not supplied.");
          await options.onEnd({ output: mode === "invalid final schema" ? undefined : output, totalUsage: usage } as never);
        } } as never;
      });
      if (realParser) {
        const sdk = await vi.importActual<typeof AISDK>("ai");
        const transport = await vi.importActual<typeof ModelTransport>("../model-transport");
        vi.mocked(experimental_streamTextLowMemory).mockImplementation(sdk.experimental_streamTextLowMemory);
        vi.mocked(resolveModelTransport).mockImplementation(transport.resolveModelTransport);
        vi.mocked(Output.object).mockImplementation(options => {
          const spec = sdk.Output.object(options);
          return { ...spec, parseCompleteOutput: (...args: Parameters<typeof spec.parseCompleteOutput>) => { finalParses++; return spec.parseCompleteOutput(...args); } };
        });
        Object.assign(f.env, { AI: { run: async (_modelId: string, options: Record<string, unknown>) => {
          bindingCalls++;
          bindingEfforts.push(options.reasoning_effort);
          const output = bindingCalls === 1 ? first : second;
          const content = mode === "malformed final JSON" ? '{"claims":' + privateText : mode === "no final text" ? ""
            : JSON.stringify(mode === "invalid final schema" ? { ...first, questions: privateText, [privateText]: privateText }
              : mode === "nested output bound" ? { ...first, claims: [{ ...first.claims[0], statement: "x".repeat(1201) }] } : output);
          const frame = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
          let body = frame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
            + frame({ choices: [], usage: usage.raw });
          if (mode !== "missing finish") body += frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        } } });
      }
      try {
        if (mode === "valid") {
          const catalogHigh = Object.freeze({ ...model });
          vi.mocked(requireAvailableModel).mockResolvedValue(catalogHigh);
          f.db.prepare("UPDATE source_revision SET distill_state='queued',distill_started_at=NULL,distill_request_json=? WHERE id=?")
            .run(JSON.stringify({ sourceId, revisionId, model: model.route, nativeReasoningEffort: "low" }), revisionId);
          const create = vi.fn(async ({ params }: { params: DistillInput }) => {
            expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls FROM source_revision WHERE id=?").get(revisionId)).toEqual({ state: "running", calls: 0 });
            admitted = params.model;
            expect(admitted).toEqual({ ...catalogHigh, nativeReasoningEffort: "low" }); expect(admitted).not.toBe(catalogHigh);
          });
          Object.assign(f.env, { DISTILL: { create } });
          await scheduleDistillation(f.env, revisionId);
          expect(create).toHaveBeenCalledTimes(1); expect(catalogHigh.nativeReasoningEffort).toBe("high");
        }
        await run(f, true, admitted);
        const succeeds = mode === "valid" || mode === "SDK placeholder zeros";
        expect(experimental_streamTextLowMemory).toHaveBeenCalledTimes(succeeds ? 2 : 1); expect(generateText).not.toHaveBeenCalled();
        expect(f.dispatchCAS).toHaveBeenCalledTimes(succeeds ? 2 : 1);
        const request = vi.mocked(experimental_streamTextLowMemory).mock.calls[0]?.[0];
        expect(request).toMatchObject({ maxRetries: 0, streamRetries: 0 }); expect(request).not.toHaveProperty("maxOutputTokens");
        expect(request?.instructions).toContain("Return one JSON object conforming to this schema: " + JSON.stringify(z.toJSONSchema(extractionSchema(["[S1:1]"]))));
        const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
        expect(report.state).toBe(succeeds ? "done" : "failed");
        if (mode === "response budget") {
          expect(acceptedChunks).toBeGreaterThan(1); expect(acceptedChunks).toBeLessThan(200);
          expect(modelFailure).not.toHaveBeenCalled();
          expect(report.error).toBe("Local response materialization budget exceeded. No retry was started.");
          expect(f.bodies.has(prefix + "distill-call1.json")).toBe(false);
        } else {
          const rawBody = f.bodies.get(prefix + "distill-call1.json") ?? "null";
          const raw = JSON.parse(rawBody);
          expect(raw.output).toEqual(succeeds ? first : null);
          if (mode === "nested output bound") expect(rawBody).not.toContain("x".repeat(1201));
          expect(raw.usage).toMatchObject({ inputTokens: unknown ? null : 71, outputTokens: unknown ? null : 19, cachedTokens: unknown ? null : 0 });
          if (succeeds) {
            expect(raw.format).toBe("claim-plan-guide-v4"); expect(f.bodies.get(prefix + "guide.md")).toContain("The method uses normalization.");
            expect(JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null").output.digestPlan).toEqual({ C0: "methods" });
          }
        }
        if (mode === "reported usage then failure") expect(report.error).toBe("Model stream failed (HTTP 408).");
        if (mode === "length with valid output") expect(report.error).toBe("model reached output bound before complete output");
        if (mode === "invalid final schema") expect(report.error).toBe("Native final JSON did not match the required schema. Schema issue: path=questions; code=invalid_type; expected=array.");
        if (mode === "nested output bound") expect(report.error).toBe("Native final JSON did not match the required schema. Schema issue: path=claims.0.statement; code=too_big; type=string; maximum=1200.");
        if (realParser) {
          expect(bindingCalls).toBe(mode === "valid" ? 2 : 1); expect(finalParses).toBe(mode === "valid" ? 2 : 1); expect(modelFailure).not.toHaveBeenCalled();
          expect(bindingEfforts).toEqual(mode === "valid" ? ["low", "low"] : ["high"]);
          expect(requireAvailableModel).toHaveBeenCalledTimes(mode === "valid" ? 1 : 0);
          expect(network).not.toHaveBeenCalled();
          if (mode === "valid") {
            expect(report).toMatchObject({ state: "done", error: null, kept: 1, usage: { calls: 2, inputTokens: 142, outputTokens: 38, cachedTokens: 0 } });
            expect(JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null")).toMatchObject({ format: "claim-plan-guide-v4", output: second,
              usage: { inputTokens: 71, outputTokens: 19, cachedTokens: 0 } });
            expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,claim_count AS kept,distill_input_tokens AS inputTokens,distill_output_tokens AS outputTokens,distill_cached_tokens AS cachedTokens FROM source_revision WHERE id=?").get(revisionId))
              .toEqual({ state: "done", calls: 2, kept: 1, inputTokens: 142, outputTokens: 38, cachedTokens: 0 });
          } else {
            const expected = mode === "malformed final JSON" ? "Native final output could not be parsed as JSON."
              : mode === "invalid final schema" ? "Native final JSON did not match the required schema. Schema issue: path=questions; code=invalid_type; expected=array."
              : mode === "nested output bound" ? "Native final JSON did not match the required schema. Schema issue: path=claims.0.statement; code=too_big; type=string; maximum=1200."
              : mode === "no final text" ? "Native final output contained no text." : "Native output ended with a non-normal finish (stream-truncated).";
            expect(report.error).toBe(expected);
            expect(f.db.prepare("SELECT distill_error AS error FROM source_revision WHERE id=?").get(revisionId)).toEqual({ error: expected });
          }
        }
        for (const body of f.bodies.values()) expect(body).not.toContain(privateText);
      } finally { if (realParser) vi.mocked(Output.object).mockReset(); network.mockRestore(); f.db.close(); }
    });

  it.each(["scanner >400k", "legacy >4096-byte block"])("completes both synthetic producers and actual verify/store for %s", async (shape) => {
    const lead = "The method preserves source evidence and its conditions. The source retains canonical text. The source describes its method. ";
    const paragraph = "Canonical evidence preserves the source conditions and terminology. ".repeat(120);
    const text = shape === "scanner >400k" ? lead + Array(160).fill(paragraph).join("\n\n") : lead + "Ordinary retained content. ".repeat(400);
    const blocks = shape === "scanner >400k" ? scanBlocks(text) : [{ id: 1, type: "paragraph" as const, start: 0, end: text.length, heading: null }];
    const first = blocks[0];
    if (!first) throw new Error("Missing canonical first block.");
    const f = fixture(snapshot.route, { text, blocks });
    const model = { ...snapshot, contextTokens: 1000000, contextWindowTokens: 1000000 };
    f.db.prepare("UPDATE source_revision SET distill_token_limit=NULL,distill_token_limit_kind='unknown' WHERE id=?").run(revisionId);
    const guide = ["The method preserves source evidence and its conditions.", "The source retains canonical text.", "The source describes its method."]
      .map(text => ({ labels: ["[S1:1]"], scope: [], assertion: text }));
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(generateText)
      .mockResolvedValueOnce({ output: { guide, glossary: [], questions: ["Which method?", "Which evidence?", "Which conditions?"],
        claims: [{ quoteBlock: "[S1:1]", kind: "method", statement: guide[0]?.assertion,
          task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }] },
        totalUsage: { inputTokens: 17, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 0 } } } as never)
      .mockResolvedValueOnce({ output: { supportedClaims: ["C0"], additionalClaims: [], supportedGuide: ["H0", "H1", "H2"], digestPlan: { C0: "methods" }, supportedGlossary: [] },
        totalUsage: { inputTokens: 19, outputTokens: 9, inputTokenDetails: { cacheReadTokens: 0 } } } as never);
    const original = new Map(f.bodies);
    try {
      const steps = await run(f, false, model);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source", "verify source excerpts", "review and synthesize", "store understanding", "finish understanding"]);
      expect(generateText).toHaveBeenCalledTimes(2);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(2);
      if (shape === "scanner >400k") expect(text.length / 3).toBeGreaterThan(400000);
      else expect(first.end - first.start).toBeGreaterThan(4096);
      const quote = text.slice(first.start, first.end);
      expect(f.db.prepare("SELECT block_index AS block,start_byte AS start,end_byte AS end,quote FROM claim WHERE source_revision_id=?").get(revisionId))
        .toEqual({ block: first.id, start: first.start, end: first.end, quote });
      expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,distill_token_limit AS bound,distill_token_limit_kind AS kind FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "done", calls: 2, bound: null, kind: "unknown" });
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
      expect(report).toMatchObject({ state: "done", usage: { calls: 2, inputTokens: 36, outputTokens: 17, tokenLimit: null, tokenLimitKind: "unknown" } });
      expect(f.bodies.get(prefix + "guide.md")).toContain(`[R${revisionId}:1]`);
      expect(f.bodies.get(prefix + "digest.md")).toContain("Methods");
      expect(f.bodies.get(prefix + "digest.md")).toContain(guide[0]?.assertion);
      expect(f.bodies.get(prefix + "digest.md")).toContain("[R" + revisionId + ":1]");
      const call2 = JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null") as { format: string };
      expect(call2.format).toBe("claim-plan-guide-v4");
      expect(f.bodies.get(prefix + "glossary.json")).toBe("[]");
      for (const [key, body] of original) expect(f.bodies.get(key)).toBe(body);
    } finally { f.db.close(); }
  });

  it.each(["overlapping", "invalid end", "mid-byte"])("bounds %s legacy verification after a retained first call without a second dispatch", async (shape) => {
    const text = shape === "mid-byte" ? "\u00e9 retained text" : "Retained source evidence. " + "x".repeat(1000000);
    const size = new TextEncoder().encode(text).length;
    const blocks: Block[] = shape === "overlapping" ? Array.from({ length: 12 }, (_, i) => ({ id: i + 1, type: "paragraph", start: 0, end: size, heading: null }))
      : [{ id: 1, type: "paragraph", start: shape === "mid-byte" ? 1 : 0, end: shape === "invalid end" ? size + 1 : size, heading: null }];
    const f = fixture(snapshot.route, { text, blocks });
    const raw = JSON.stringify({ output: { claims: [{ quoteBlock: "[S1:1]", kind: "method", statement: "Retained source evidence.",
      task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }],
      guide: [], questions: [] }, usage: { inputTokens: 17, cachedTokens: 0, outputTokens: 8, tokenLimit: null, tokenLimitKind: "unknown" } });
    f.bodies.set(prefix + "distill-call1.json", raw);
    f.db.prepare("UPDATE source_revision SET distill_calls=1 WHERE id=?").run(revisionId);
    try {
      const steps = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => name === "extract source" ? undefined : callback());
      await new DistillWorkflow({} as ExecutionContext, f.env).run({ payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>, { do: steps } as unknown as WorkflowStep);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source", "verify source excerpts"]);
      expect(generateText).not.toHaveBeenCalled(); expect(f.dispatchCAS).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls FROM source_revision WHERE id=?").get(revisionId)).toEqual({ state: "failed", calls: 1 });
      expect(f.bodies.get(prefix + "distill-call1.json")).toBe(raw);
      expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
      expect(f.bodies.has(prefix + "distill-verified.json")).toBe(false);
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
      expect(report.usage).toMatchObject({ calls: 1, inputTokens: 17, outputTokens: 8 });
      if (shape === "overlapping") expect(report.error).toBe("Narrow the source selection so the answer fits.");
    } finally { f.db.close(); }
  });

  it.each([
    { paragraphs: 12, capacity: 40000, formerCap: 24000 },
    { paragraphs: 164, capacity: 1000000, formerCap: 360000 },
    { paragraphs: 190, capacity: 1000000, formerCap: 400000 },
  ])("dispatches $paragraphs canonical paragraphs above the former $formerCap estimate", async ({ paragraphs, capacity, formerCap }) => {
    const paragraph = "The method preserves source evidence and its conditions. ".repeat(120);
    const text = Array(paragraphs).fill(paragraph).join("\n\n"), blocks = scanBlocks(text);
    const model = { ...snapshot, contextTokens: capacity, contextWindowTokens: capacity + 2048, outputReserveTokens: 2048 };
    const f = fixture(model.route, { text, blocks });
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    try {
      await run(f, false, model);
      expect(text.length / 3).toBeGreaterThan(formerCap);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(1);
      const options = vi.mocked(generateText).mock.calls[0]?.[0];
      const instructions = options?.instructions;
      if (!options || typeof instructions !== "string") throw new Error("Missing extraction instructions.");
      const schema = JSON.parse(instructions.slice(instructions.lastIndexOf("Return one JSON object conforming to this schema: ") + "Return one JSON object conforming to this schema: ".length));
      expect(estimateModelInput({ instructions, messages: options.messages as { role: string; content: string }[], schema })).toBeLessThanOrEqual(modelInputLimit(model));
      const content = options?.messages?.[0]?.content;
      if (typeof content !== "string") throw new Error("Missing extraction context.");
      expect(content.split("\n").map(line => JSON.parse(line).text).join(""))
        .toBe(blocks.map(block => text.slice(block.start, block.end)).join(""));
    } finally { f.db.close(); }
  });

  it("rejects cumulative extraction allocations at the existing memory allowance before dispatch", async () => {
    const paragraph = "The method preserves source evidence and its conditions. ".repeat(120);
    const text = Array(400).fill(paragraph).join("\n\n");
    const model = { ...snapshot, contextTokens: 3000000 };
    const f = fixture(model.route, { text, blocks: scanBlocks(text) });
    try {
      await run(f, false, model);
      finished(f, "Narrow the source selection so the answer fits.");
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it.each(["text.md", "blocks.json"])("cancels an understated oversized %s stream without dispatch", async (name) => {
    const f = fixture(snapshot.route), originalGet = f.env.BUCKET.get.bind(f.env.BUCKET);
    let pulls = 0;
    const cancel = vi.fn();
    f.env.BUCKET.get = vi.fn(async (key: string) => {
      if (key !== prefix + name) return originalGet(key);
      return { size: 1, body: new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel }) };
    }) as unknown as R2Bucket["get"];
    try {
      await run(f, false, { ...snapshot, contextTokens: 100000000 });
      finished(f, "Narrow the source selection so the answer fits.");
      expect(pulls).toBeLessThanOrEqual(17);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("validates extraction statement references before numeric support without losing candidate order", async () => {
    const document = documentWithBlocks([{ type: "paragraph", text: "The method uses normalization for 9 layers." }]);
    const f = fixture(snapshot.route, document);
    const statements = ["Unknown reference [S9:9].", "The method uses normalization. [S1:1]", "Ordinary method.",
      "The method uses 8 layers. [S1:1]", "The method uses 9 layers.", "[S1:1]",
      `Persistent reference. [R${revisionId}:1]`, "Block reference. [block 1]", "Literal `[S9:9]` example.",
      "Unknown reference [S8:8].", "Final method."];
    const raw = JSON.stringify({ output: {
      guide: ["The source describes a method.", "The method uses normalization.", "The source retains its text."].map(text => ({ labels: ["[S1:1]"], text })),
      questions: ["Which method?", "What normalization?", "What evidence?"],
      claims: statements.map(statement => ({ quoteBlock: "[S1:1]", kind: "method", statement,
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null })),
    }, usage: { inputTokens: 17, cachedTokens: 0, outputTokens: 8, tokenLimit: 100 } });
    f.bodies.set(prefix + "distill-call1.json", raw);
    f.db.prepare("UPDATE source_revision SET distill_calls=1,distill_token_limit=123456 WHERE id=?").run(revisionId);
    try {
      const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
        if (name === "extract source") return;
        if (name === "verify source excerpts") return callback();
        throw new Error("Fixture stops before the next paid step.");
      });
      await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<{ revisionId: string; model: ModelSpec }>, { do: stepDo } as unknown as WorkflowStep);
      const verified = JSON.parse(f.bodies.get(prefix + "distill-verified.json") ?? "null");
      expect(verified.claims.map((claim: { statement: string }) => claim.statement)).toEqual([
        "The method uses normalization. ", "Ordinary method.", "The method uses 9 layers.",
        "Persistent reference. ", "Block reference. ", "Literal `[S9:9]` example.", "Final method.",
      ]);
      expect(verified.dropped).toEqual(expect.arrayContaining([
        { index: 0, reason: "claim-invalid-reference" }, { index: 3, reason: "unsupported-statement-numbers" },
        { index: 5, reason: "empty-claim-statement" },
        { index: 9, reason: "unsupported-statement-numbers" },
      ]));
      expect(verified.claims.every((claim: { quote: string }) => claim.quote === document.text)).toBe(true);
      expect(f.bodies.get(prefix + "distill-call1.json")).toBe(raw);
      expect(f.db.prepare("SELECT distill_token_limit FROM source_revision WHERE id=?").get(revisionId)).toEqual({ distill_token_limit: 123456 });
      expect(generateText).not.toHaveBeenCalled(); expect(resolveModelTransport).not.toHaveBeenCalled(); expect(f.dispatchCAS).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it.each([
    { name: "bibliography", passage: "References\nAda Example. Related research. 2021.", authors: "Ada Example", published: "2021" },
    { name: "body attribution", passage: "We compare the 2024 method described by Ann Example.", authors: "Ann Example", published: "2024" },
    { name: "Unicode bibliography", passage: "Литература\nМария Ёлкина. Чужая статья. 2023 г.", authors: "Мария Ёлкина", published: "2023" },
    { name: "Unicode byline text", passage: "Автор: Zoë Łukasz\nОпубликовано: 2024-02-29", authors: "Zoë Łukasz", published: "2024-02-29" },
    { name: "front matter is canonical text", passage: "---\nauthors: Ada Example\npublished: 2020-03\n---", authors: "Ada Example", published: "2020-03" },
    { name: "partial occurrences", passage: "Annabelle Example's run has identifier 2024-02-29.", authors: "Ann", published: "2024" },
    { name: "unavailable", passage: "No bibliographic information is supplied.", authors: "", published: null },
    { name: "legacy null fields", passage: "The literal null is content, not metadata.", authors: null, published: null },
  ])("does not promote $name from retained model output into source metadata", async ({ passage, authors, published }) => {
    const document = documentWithBlocks([{ type: "paragraph", text: passage + "\n\nThe method uses normalization." }]);
    const f = fixture(snapshot.route, document);
    const raw = JSON.stringify({ output: {
      guide: ["The source describes a method.", "The method uses normalization.", "The source retains its text."].map(text => ({ labels: ["[S1:1]"], text })),
      questions: ["Which method?", "What normalization?", "What evidence?"],
      claims: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The method uses normalization.",
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }], authors, published,
    }, usage: { inputTokens: 17, cachedTokens: 0, outputTokens: 8, tokenLimit: 100 } });
    f.bodies.set(prefix + "distill-call1.json", raw);
    f.db.prepare("UPDATE source_revision SET distill_calls=1 WHERE id=?").run(revisionId);
    const originalBodies = new Map(f.bodies);
    try {
      for (let replay = 0; replay < 2; replay++) {
        const metadata = replay === 0 ? { authors: "", published: null } : { authors: "Историческая Zoë Ёлкина", published: "2021-03" };
        if (replay) {
          f.db.prepare("INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at) VALUES(?,?,2,'readable','owner',1)")
            .run(explicitlySelectedRevisionId, sourceId);
          f.db.prepare("UPDATE source SET authors=?,published=?,current_revision_id=? WHERE id=?")
            .run(metadata.authors, metadata.published, explicitlySelectedRevisionId, sourceId);
        }
        const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
          if (name === "extract source") return; // Simulate cached extraction; the paid function is not invoked.
          if (name === "verify source excerpts") return callback(); // Actual production verifier/storage callback.
          throw new Error("Fixture stops before the next paid step.");
        });
        await new DistillWorkflow({} as ExecutionContext, f.env).run(
          { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>, { do: stepDo } as unknown as WorkflowStep);
        expect(stepDo.mock.calls.map(([name]) => name)).toEqual(replay ? ["extract source", "verify source excerpts"] : ["extract source", "verify source excerpts", "review and synthesize"]);
        expect(f.db.prepare("SELECT authors,published FROM source WHERE id=?").get(sourceId)).toEqual(metadata);
        expect(f.db.prepare("SELECT current_revision_id AS head FROM source WHERE id=?").get(sourceId))
          .toEqual({ head: replay ? explicitlySelectedRevisionId : revisionId });
        expect(f.db.prepare("SELECT distill_calls AS calls,distill_input_tokens AS input,distill_cached_tokens AS cached,distill_output_tokens AS output FROM source_revision WHERE id=?")
          .get(revisionId)).toEqual({ calls: 1, input: 17, cached: 0, output: 8 });
        const verified = JSON.parse(f.bodies.get(prefix + "distill-verified.json") ?? "null");
        expect(verified.claims).toHaveLength(1);
        expect(verified.claims[0].quote).toBe(document.text);
        for (const [key, body] of originalBodies) expect(f.bodies.get(key)).toBe(body);
      }
      expect(generateText).not.toHaveBeenCalled(); expect(resolveModelTransport).not.toHaveBeenCalled();
      expect(f.dispatchCAS).not.toHaveBeenCalled();
      expect(f.sourceWrites).not.toHaveBeenCalled();
      for (const lookup of forbiddenLookups) expect(lookup).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("cron drains an explicitly requested queue after a concurrency slot is freed", async () => {
    const f = queuedBehindRunning();
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    try {
      await requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId: explicitlySelectedSourceId });
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId))
        .toEqual({ distill_state: "queued" });
      f.db.prepare("UPDATE source_revision SET distill_state='done' WHERE id=?").run(revisionId);
      await scheduleDistillation(f.env);
      expect(f.createWorkflow).toHaveBeenCalledExactlyOnceWith({ id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: snapshot } });
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("Workflow completion drains a waiting explicitly requested revision without replaying paid steps", async () => {
    const f = queuedBehindRunning();
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    try {
      await completeSavedWorkflow(f);
      expect(f.db.prepare("SELECT distill_state,distill_calls FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ distill_state: "done", distill_calls: 2 });
      expect(f.createWorkflow).toHaveBeenCalledExactlyOnceWith({ id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: snapshot } });
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it.each(["deleted source", "deleted revision", "unreadable revision", "changed model"])("admission rechecks %s after async catalogue lookup", async (change) => {
    const f = callerFixture();
    vi.mocked(requireAvailableModel).mockImplementation(async () => {
      if (change === "deleted source") f.db.prepare("UPDATE source SET state='deleted' WHERE id=?").run(explicitlySelectedSourceId);
      if (change === "deleted revision") f.db.prepare("UPDATE source_revision SET deleted_at=1 WHERE id=?").run(explicitlySelectedRevisionId);
      if (change === "unreadable revision") f.db.prepare("UPDATE source_revision SET readable_state='failed' WHERE id=?").run(explicitlySelectedRevisionId);
      if (change === "changed model") f.db.prepare("UPDATE source_revision SET distill_model='gateway:command-code/fixture/new' WHERE id=?").run(explicitlySelectedRevisionId);
      return snapshot;
    });
    try {
      await scheduleDistillation(f.env, explicitlySelectedRevisionId);
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state,distill_token_limit FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId))
        .toEqual({ distill_state: "queued", distill_token_limit: null });
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("concurrent cron, explicit request and repeated completion create each waiting Workflow once", async () => {
    const f = queuedBehindRunning();
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    try {
      await Promise.all([
        completeSavedWorkflow(f), completeSavedWorkflow(f), scheduleDistillation(f.env),
        requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId: explicitlySelectedSourceId }),
      ]);
      await completeSavedWorkflow(f);
      await scheduleDistillation(f.env);
      expect(f.createWorkflow).toHaveBeenCalledExactlyOnceWith({ id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: snapshot } });
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM source_revision WHERE distill_state='running'").get()).toEqual({ n: 2 });
      expect(f.db.prepare("SELECT distill_state,distill_calls FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ distill_state: "done", distill_calls: 2 });
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("cron leaves a full concurrency window queued", async () => {
    const f = queuedBehindRunning();
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    try {
      await Promise.all([scheduleDistillation(f.env), scheduleDistillation(f.env)]);
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId))
        .toEqual({ distill_state: "queued" });
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it.each(["none", "paused", "failed", "done", "partial", "running", "paid queued", "deleted source", "deleted revision", "unreadable"])("cron skips %s without catalogue or dispatch", async (state) => {
    const f = callerFixture();
    f.db.prepare("UPDATE source_revision SET distill_state='none' WHERE id=?").run(otherQueuedRevisionId);
    if (["none", "paused", "failed", "done", "partial", "running"].includes(state))
      f.db.prepare("UPDATE source_revision SET distill_state=?,distill_started_at=? WHERE id=?").run(state, Date.now(), explicitlySelectedRevisionId);
    if (state === "paid queued") f.db.prepare("UPDATE source_revision SET distill_calls=1 WHERE id=?").run(explicitlySelectedRevisionId);
    if (state === "deleted source") f.db.prepare("UPDATE source SET state='deleted' WHERE id=?").run(explicitlySelectedSourceId);
    if (state === "deleted revision") f.db.prepare("UPDATE source_revision SET deleted_at=1 WHERE id=?").run(explicitlySelectedRevisionId);
    if (state === "unreadable") f.db.prepare("UPDATE source_revision SET readable_state='needs_conversion' WHERE id=?").run(explicitlySelectedRevisionId);
    const before = f.db.prepare("SELECT * FROM source_revision ORDER BY id").all();
    try {
      await scheduleDistillation(f.env);
      expect(f.db.prepare("SELECT * FROM source_revision ORDER BY id").all()).toEqual(before);
      expect(requireAvailableModel).not.toHaveBeenCalled();
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("cron uses the frozen route and pauses unavailable models until an explicit request", async () => {
    const f = callerFixture();
    f.db.prepare("UPDATE settings SET distill_model='gateway:command-code/fixture/new-default' WHERE id=1").run();
    vi.mocked(requireAvailableModel).mockRejectedValue(new LibraryError("unavailable", "The selected model is unavailable.", 503));
    try {
      await scheduleDistillation(f.env);
      expect(vi.mocked(requireAvailableModel).mock.calls.map(([, route]) => route)).toEqual([snapshot.route, snapshot.route]);
      expect(f.db.prepare("SELECT distill_state,distill_model,distill_calls FROM source_revision").all())
        .toEqual(Array.from({ length: 2 }, () => ({ distill_state: "paused", distill_model: snapshot.route, distill_calls: 0 })));
      vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
      await scheduleDistillation(f.env);
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("does not replace a missing frozen model with the current setting", async () => {
    const f = callerFixture();
    f.db.prepare("UPDATE source_revision SET distill_model=NULL").run();
    try {
      await scheduleDistillation(f.env);
      expect(f.db.prepare("SELECT distill_state FROM source_revision").all()).toEqual([{ distill_state: "paused" }, { distill_state: "paused" }]);
      expect(requireAvailableModel).not.toHaveBeenCalled();
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("a drain failure cannot change or replay the already finalized revision", async () => {
    const f = queuedBehindRunning();
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = ((sql: string) => {
      if (sql.includes("SELECT r.id,r.distill_model AS model")) throw new Error("Queue read unavailable");
      return prepare(sql);
    }) as D1Database["prepare"];
    try {
      await expect(completeSavedWorkflow(f)).resolves.toEqual({ revisionId });
      expect(f.db.prepare("SELECT distill_state,distill_calls FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ distill_state: "done", distill_calls: 2 });
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it.each(["allow", "deny"])("a stale %s model lookup cannot overwrite a route explicitly resumed after pause", async (outcome) => {
    const f = queuedBehindRunning();
    const replacement: ModelSpec = { ...snapshot, route: "gateway:command-code/fixture/replacement", id: "fixture/replacement" };
    vi.mocked(requireAvailableModel).mockImplementation(async (_env, route) => route === replacement.route ? replacement : snapshot);
    let release!: () => void, deny!: (error: Error) => void, enter!: () => void;
    const pending = new Promise<void>((resolve, reject) => { release = resolve; deny = reject; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    vi.mocked(requireAvailableModel)
      .mockImplementationOnce(async () => { enter(); await pending; return snapshot; })
      .mockRejectedValueOnce(new LibraryError("unavailable", "The selected model is unavailable.", 503));
    try {
      const staleAdmission = scheduleDistillation(f.env, explicitlySelectedRevisionId);
      await entered;
      await scheduleDistillation(f.env, explicitlySelectedRevisionId);
      expect(f.db.prepare("SELECT distill_state FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId)).toEqual({ distill_state: "paused" });
      await requestUnderstanding(f.env, { type: "owner" } as Actor,
        { sourceId: explicitlySelectedSourceId, model: replacement.route });
      // Both slots were still full, so the owner's new frozen choice is queued.
      f.db.prepare("UPDATE source_revision SET distill_state='done' WHERE id=?").run(revisionId);
      if (outcome === "allow") release();
      else deny(new LibraryError("unavailable", "The old selected model is unavailable.", 503));
      await staleAdmission;
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state,distill_model FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId))
        .toEqual({ distill_state: "queued", distill_model: replacement.route });
      await scheduleDistillation(f.env);
      expect(f.createWorkflow).toHaveBeenCalledExactlyOnceWith({ id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: replacement } });
      expect(generateText).not.toHaveBeenCalled();
    } finally { release(); f.db.close(); }
  });

  it.each(["native", "openrouter"] as const)("fences held %s Low lookups when the same original route is paused and resumed as High", async provider => {
    const f = queuedBehindRunning();
    const field = provider === "native" ? "nativeReasoningEffort" : "openRouterReasoningEffort";
    const native: ModelSpec = Object.freeze(provider === "native"
      ? { ...snapshot, route: "workers-ai:fixture/native", id: "fixture/native", nativeReasoningEffort: "high" }
      : { ...snapshot, route: "gateway:router-alias/fixture", id: "fixture", openRouterReasoningEfforts: ["low", "high"],
        routing: { gatewayId: "fixture", provider: { id: "router-alias", type: "openai-compatible", gatewaySlug: "custom-router", gatewayPath: "",
          baseUrl: "https://openrouter.ai/api/v1", enabled: true } } } satisfies ModelSpec);
    const lowRequest = JSON.stringify({ sourceId: explicitlySelectedSourceId, revisionId: explicitlySelectedRevisionId, model: native.route, [field]: "low" });
    f.db.prepare("UPDATE source_revision SET distill_model=?,distill_request_json=? WHERE id=?")
      .run(native.route, lowRequest, explicitlySelectedRevisionId);
    // Exercise stale admission, scheduler error-pause and cost metadata error-pause against the same replacement intent.
    const results: Array<ModelSpec | LibraryError> = [native, new LibraryError("unavailable", "Old lookup failed.", 503), { ...native, contextTokens: 0 }];
    const held = results.map(result => {
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      return { result, wait, release };
    });
    let enters = 0, allEntered!: () => void;
    const entered = new Promise<void>(resolve => { allEntered = resolve; });
    vi.mocked(requireAvailableModel).mockResolvedValue(native);
    for (const lookup of held) vi.mocked(requireAvailableModel).mockImplementationOnce(async () => {
      if (++enters === held.length) allEntered();
      await lookup.wait;
      if (lookup.result instanceof LibraryError) throw lookup.result;
      return lookup.result;
    });
    vi.mocked(requireAvailableModel).mockRejectedValueOnce(new LibraryError("unavailable", "Pause the old intent.", 503));
    const staleAdmissions = held.map(() => scheduleDistillation(f.env, explicitlySelectedRevisionId));
    try {
      await entered;
      await scheduleDistillation(f.env, explicitlySelectedRevisionId);
      expect(f.db.prepare("SELECT distill_state FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId)).toEqual({ distill_state: "paused" });
      await requestUnderstanding(f.env, { type: "owner" } as Actor,
        { sourceId: explicitlySelectedSourceId, model: native.route, [field]: "high" });
      const replacement = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId);
      expect(replacement).toMatchObject({ distill_state: "queued", distill_attempt_id: null, distill_calls: 0,
        distill_token_limit: null, distill_token_limit_kind: null, distill_estimated_cost_microusd: 0,
        distill_request_json: JSON.stringify({ sourceId: explicitlySelectedSourceId, revisionId: explicitlySelectedRevisionId, model: native.route, [field]: "high" }) });
      f.db.prepare("UPDATE source_revision SET distill_state='done' WHERE id=?").run(revisionId);
      for (const lookup of held) lookup.release();
      await Promise.all(staleAdmissions);
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId)).toEqual(replacement);
      await scheduleDistillation(f.env, explicitlySelectedRevisionId);
      expect(f.createWorkflow).toHaveBeenCalledExactlyOnceWith({ id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: { ...native, [field]: "high" } } });
      if (provider === "native") expect(native.nativeReasoningEffort).toBe("high");
      else expect(native).not.toHaveProperty("openRouterReasoningEffort");
      expect(generateText).not.toHaveBeenCalled(); expect(experimental_streamTextLowMemory).not.toHaveBeenCalled();
    } finally {
      for (const lookup of held) lookup.release();
      await Promise.allSettled(staleAdmissions); f.db.close();
    }
  });

  it.each([0, 1])("cron never recreates an ambiguous Workflow after %i model dispatches", async (calls) => {
    const f = callerFixture();
    f.db.prepare("UPDATE source_revision SET distill_state='none' WHERE id=?").run(otherQueuedRevisionId);
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    f.createWorkflow.mockImplementation(async () => {
      f.db.prepare("UPDATE source_revision SET distill_calls=? WHERE id=?").run(calls, explicitlySelectedRevisionId);
      throw new Error("Workflow acknowledgement lost");
    });
    const get = vi.fn().mockRejectedValue(new Error("Workflow status unavailable"));
    f.env.DISTILL.get = get;
    try {
      await scheduleDistillation(f.env);
      f.db.prepare("UPDATE source_revision SET distill_started_at=? WHERE id=?").run(Date.now() - 360_000, explicitlySelectedRevisionId);
      await scheduleDistillation(f.env);
      await scheduleDistillation(f.env);
      expect(f.createWorkflow).toHaveBeenCalledTimes(1);
      expect(f.db.prepare("SELECT distill_state,distill_calls FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId))
        .toEqual({ distill_state: calls === 0 ? "failed" : "running", distill_calls: calls });
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("a next-Workflow dispatch failure leaves the previous terminal result intact", async () => {
    const f = queuedBehindRunning();
    const savedReport = f.bodies.get(prefix + "distill.json");
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    f.createWorkflow.mockRejectedValue(new Error("Dispatch unavailable"));
    try {
      await expect(completeSavedWorkflow(f)).resolves.toEqual({ revisionId });
      await completeSavedWorkflow(f);
      expect(f.db.prepare("SELECT distill_state,distill_calls FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ distill_state: "done", distill_calls: 2 });
      expect(f.bodies.get(prefix + "distill.json")).toBe(savedReport);
      expect(f.db.prepare("SELECT distill_state,distill_calls,distill_token_limit FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId))
        .toEqual({ distill_state: "failed", distill_calls: 0, distill_token_limit: 0 });
      expect(f.createWorkflow).toHaveBeenCalledTimes(1);
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("explicit Understand dispatches only its revision; cron can then drain other requested work", async () => {
    const f = callerFixture();
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    try {
      await requestUnderstanding(f.env, { type: "owner" } as Actor, {
        sourceId: explicitlySelectedSourceId,
        revisionId: explicitlySelectedRevisionId,
        model: snapshot.route,
      });

      expect(f.createWorkflow).toHaveBeenCalledExactlyOnceWith({
        id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: snapshot },
      });
      expect(f.db.prepare("SELECT id,distill_state AS state FROM source_revision ORDER BY created_at").all())
        .toEqual([
          { id: otherQueuedRevisionId, state: "queued" },
          { id: explicitlySelectedRevisionId, state: "running" },
        ]);
      expect(generateText).not.toHaveBeenCalled();

      // Discarding the first receipt does not authorise another Workflow for this revision.
      await requestUnderstanding(f.env, { type: "owner" } as Actor, {
        sourceId: explicitlySelectedSourceId, revisionId: explicitlySelectedRevisionId, model: snapshot.route,
      });
      expect(f.createWorkflow).toHaveBeenCalledTimes(1);
      expect(generateText).not.toHaveBeenCalled();

      // The later background drain may admit the already requested older row.
      await scheduleDistillation(f.env);
      expect(f.createWorkflow).toHaveBeenCalledTimes(2);
      expect(f.db.prepare("SELECT id,distill_state AS state FROM source_revision ORDER BY created_at").all())
        .toEqual([
          { id: otherQueuedRevisionId, state: "running" },
          { id: explicitlySelectedRevisionId, state: "running" },
        ]);
      expect(generateText).not.toHaveBeenCalled();

      // Explicit target admits only its own queued row, no other revision.
      await scheduleDistillation(f.env, otherQueuedRevisionId);
      expect(f.createWorkflow.mock.calls.map(([input]) => input.id)).toEqual([
        `distill-${explicitlySelectedRevisionId}`,
        `distill-${otherQueuedRevisionId}`,
      ]);
      expect(f.db.prepare("SELECT COUNT(*) AS count FROM source_revision WHERE distill_state='running'").get())
        .toEqual({ count: 2 });
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("rejects explicit different model on already-queued revision without dispatch", async () => {
    const f = callerFixture();
    const different: ModelSpec = { ...snapshot, route: "gateway:command-code/fixture/different-model", id: "different-model" };
    vi.mocked(requireAvailableModel).mockImplementation(async (_env, route: string) => {
      if (route === snapshot.route) return snapshot;
      if (route === different.route) return different;
      throw new LibraryError("unavailable", "This model is absent from the current provider catalogue.", 503);
    });
    f.db.prepare("UPDATE settings SET distill_model=? WHERE id=1").run(different.route);
    try {
      await expect(
        requestUnderstanding(f.env, { type: "owner" } as Actor, {
          sourceId: explicitlySelectedSourceId,
          revisionId: explicitlySelectedRevisionId,
          model: different.route,
        }),
      ).rejects.toMatchObject({ code: "conflict", status: 409 });
      expect(
        f.db.prepare("SELECT distill_model AS model, distill_state AS state FROM source_revision WHERE id=?").get(explicitlySelectedRevisionId),
      ).toEqual({ model: snapshot.route, state: "queued" });
      expect(f.createWorkflow).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
      await expect(
        requestUnderstanding(f.env, { type: "owner" } as Actor, {
          sourceId: explicitlySelectedSourceId,
          revisionId: explicitlySelectedRevisionId,
        }),
      ).resolves.toEqual({ revisionId: explicitlySelectedRevisionId });
      expect(f.createWorkflow).toHaveBeenCalledTimes(1);
      expect(f.createWorkflow.mock.calls[0]?.[0]).toEqual({
        id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: snapshot },
      });
      expect(generateText).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });

  it("uses generic source guidance and exposes only citable block labels to a new first pass", async () => {
    const document = documentWithBlocks([
      { type: "heading", text: "### Page 1\n" },
      { type: "heading", text: "### \n" },
      { type: "heading", text: "### Страница 2\n" },
      { type: "paragraph", text: "The source describes a method and its assumptions.\n" },
      { type: "paragraph", text: "The reported finding holds under a stated condition and limitation.\n" },
    ]);
    const f = fixture(snapshot.route, document);
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(generateText).mockRejectedValue(new Error("Mocked first-call stop."));
    try {
      const steps = await run(f);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      const firstCall = vi.mocked(generateText).mock.calls[0]?.[0];
      if (!firstCall) throw new Error("The first extraction request was not captured.");
      const instructions = firstCall.instructions;
      if (typeof instructions !== "string") throw new Error("The extraction instructions were not a string.");
      expect(instructions).toContain("contribution");
      expect(instructions).toContain("methods");
      expect(instructions).toContain("assumptions");
      expect(instructions).toContain("findings");
      expect(instructions).toContain("conditions");
      expect(instructions).toContain("limitations");
      for (const tailored of ["optimizer defaults", "training schedules/formulas", "representational choices", "paper's"]) {
        expect(instructions.toLowerCase()).not.toContain(tailored);
      }
      const messages = firstCall.messages;
      if (!messages || messages.length === 0) throw new Error("The extraction request has no user message.");
      const firstMessage = messages[0];
      if (!firstMessage || typeof firstMessage.content !== "string") throw new Error("The extraction input was not a text message.");
      const content = firstMessage.content;
      expect(content).toContain("[S1:4]");
      expect(content).toContain("[S1:5]");
      expect(content).not.toContain("[S1:1]");
      expect(content).not.toContain("[S1:2]");
      expect(content).not.toContain("[S1:3]");
      expect(content).not.toContain("Page 1");
      expect(content).not.toContain("Страница 2");
      expect(f.bodies.get(prefix + "text.md")).toBe(document.text);
      expect(f.bodies.get(prefix + "blocks.json")).toBe(JSON.stringify(document.blocks));
      expect(f.bodies.has(prefix + "distill-call1.json")).toBe(false);
    } finally { f.db.close(); }
  });

  it("rejects payload/stored route mismatch before transport, generation or dispatch CAS", async () => {
    const storedRoute = "gateway:command-code/fixture/different-admitted-route";
    const f = fixture(storedRoute);
    try {
      const steps = await run(f);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      expect(resolveModelTransport).not.toHaveBeenCalled();
      finished(f, "The admitted model snapshot no longer matches the stored model route.");
      expect(f.db.prepare("SELECT distill_model AS model FROM source_revision WHERE id=?").get(revisionId)).toEqual({ model: storedRoute });
    } finally { f.db.close(); }
  });

  it("binds call-two candidates to exact quotes and preserves nullable and historical metadata", async () => {
    const withBatch = (target: ReturnType<typeof fixture>) => {
      const db = target.env.DB as unknown as {
        batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>): Promise<{ meta: { changes: number } }[]>;
      };
      db.batch = async (statements) => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      };
      return target;
    };
    const document = documentWithBlocks([
      { type: "paragraph", text: "Method Alpha uses a low-rank update.\n" },
      { type: "paragraph", text: "The source reports 3 and 5 examples. On Set 2021 Variant Alpha, the model scores 9.4 QScore, improving over the baseline by 1.7 QScore.\n" },
      { type: "paragraph", text: "The source notes one limitation.\n" },
      { type: "paragraph", text: "The source describes a related condition.\n" },
      { type: "paragraph", text: "The update starts from a random matrix and a zero matrix: A ~ N(0, σ²); B = 0; scale ΔWx by α/r.\n" },
      { type: "paragraph", text: "The method reduces trainable parameters by 10,000 times and GPU memory by 3 times.\n" },
    ]);
    const malformedMeasurements = [
      { quoteBlock: "[S1:5]", kind: "method", task: null, metric: null, dataset: null,
        valueText: "A ~ N(0, σ²); B = 0; scale ΔWx by α/r", unit: null, conditions: null,
        statement: "The update starts from a random matrix and a zero matrix." },
      { quoteBlock: "[S1:6]", kind: "result", task: "adaptation", metric: "trainable parameters", dataset: null,
        valueText: "10,000", unit: "times reduction (trainable parameters); 3 times reduction (GPU memory)", conditions: null,
        statement: "The method reduces trainable parameters by 10,000 times." },
    ];
    const f = withBatch(fixture(snapshot.route, document));
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(Output.object).mockClear();
    const extraction = {
      guide: [
        { labels: ["[S1:1]"], scope: [], assertion: "The source describes method Alpha." },
        { labels: ["[S1:3]"], scope: [], assertion: "The source notes a limitation." },
        { labels: ["[S1:4]"], scope: [], assertion: "The source describes a related condition." },
      ],
      glossary: [],
      claims: [
        { quoteBlock: "[S1:3]", kind: "result", task: "outcomes", metric: "count", dataset: null,
          valueText: "9", unit: null, conditions: null, statement: "The source reports 9 outcomes." },
        { quoteBlock: "[S1:2]", kind: "result", task: "measured examples", metric: "count", dataset: null,
          valueText: "3 and 5", unit: null, conditions: null, statement: "The method yields exactly 3 and 5 measured examples." },
        { quoteBlock: "[S1:1]", kind: "method", task: null, metric: null, dataset: null,
          valueText: null, unit: null, conditions: null, statement: "Method Alpha uses a low-rank update." },
        { quoteBlock: "[S1:2]", kind: "result", task: "synthetic scoring task", metric: "QScore",
          dataset: "Set 2021", valueText: "9.4", unit: "QScore", conditions: "Variant Alpha",
          statement: "On Set 2021 Variant Alpha, the model scores 9.4 QScore, improving over the baseline by 1.7 QScore." },
        { quoteBlock: "[S1:4]", kind: "other", task: null, metric: null, dataset: null,
          valueText: null, unit: null, conditions: null, statement: "The source describes a related condition." },
        ...malformedMeasurements,
      ],
      questions: ["What method is described?", "What result is reported?", "What limitation is noted?"],
      authors: "", published: null,
    };
    vi.mocked(generateText)
      .mockImplementationOnce(async () => ({
        output: extraction,
        totalUsage: { inputTokens: 12, inputTokenDetails: { cacheReadTokens: 0 }, outputTokens: 24, raw: null },
      } as never))
      .mockRejectedValueOnce(new Error("Stop after capturing call-two schema."));
    try {
      await run(f);
      expect(generateText).toHaveBeenCalledTimes(2);
      const callInstructions = vi.mocked(generateText).mock.calls.map(([options]) => options.instructions);
      const call2Options = vi.mocked(generateText).mock.calls[1]?.[0];
      const call2Messages = call2Options?.messages;
      const call2SourceContext = call2Messages?.[0]?.content;
      if (typeof call2SourceContext !== "string") throw new Error("Call two source context was not captured.");
      const capturedContext = JSON.parse(call2SourceContext) as {
        candidates: Array<{ id: string; statement: string; quote: string; quoteBlock: string; [key: string]: unknown }>;
        evidence: Array<{ label: string; quote: string }>;
      };
      expect(capturedContext.candidates).toEqual([
        { id: "C0", statement: "Method Alpha uses a low-rank update.", quote: "Method Alpha uses a low-rank update.\n",
          quoteBlock: "[S1:1]", kind: "method", task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null },
        { id: "C1", statement: "The source describes a related condition.", quote: "The source describes a related condition.\n",
          quoteBlock: "[S1:4]", kind: "other", task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null },
      ]);
      expect(capturedContext.evidence).toContainEqual({ label: "[S1:2]", block: 2,
        quote: "The source reports 3 and 5 examples. On Set 2021 Variant Alpha, the model scores 9.4 QScore, improving over the baseline by 1.7 QScore.\n" });
      const verifiedBody = f.bodies.get(prefix + "distill-verified.json");
      if (!verifiedBody) throw new Error("Fresh verified stage was not retained before call two.");
      const verified = JSON.parse(verifiedBody);
      expect(verified.claims.map(({ block, quote }: { block: number; quote: string }) => [block, quote])).toEqual([
        [1, "Method Alpha uses a low-rank update.\n"], [4, "The source describes a related condition.\n"],
      ]);
      expect(verified.dropped).toContainEqual({ index: 0, reason: "unsupported-statement-numbers" });
      expect(verified.dropped).toContainEqual({ index: 1, reason: "pre-synthesis-missing-or-unsupported-primary-result" });
      expect(verified.dropped).toContainEqual({ index: 3, reason: "pre-synthesis-missing-or-unsupported-primary-result" });
      expect(verified.dropped).toContainEqual({ index: 5, reason: "non-result-measurement-fields" });
      expect(verified.dropped).toContainEqual({ index: 6, reason: "compound-primary-measurement" });
      expect(capturedContext.evidence).toContainEqual({ label: "[S1:5]", block: 5,
        quote: "The update starts from a random matrix and a zero matrix: A ~ N(0, σ²); B = 0; scale ΔWx by α/r.\n" });
      expect(capturedContext.evidence).toContainEqual({ label: "[S1:6]", block: 6,
        quote: "The method reduces trainable parameters by 10,000 times and GPU memory by 3 times.\n" });
      const marker = "Return one JSON object conforming to this schema: ";
      type JsonSchemaNode = {
        $defs?: Record<string, JsonSchemaNode>;
        definitions?: Record<string, JsonSchemaNode>;
        properties?: Record<string, JsonSchemaNode>;
        items?: JsonSchemaNode;
        required?: string[];
        $ref?: string;
        type?: string | string[];
        anyOf?: JsonSchemaNode[];
        oneOf?: JsonSchemaNode[];
        allOf?: JsonSchemaNode[];
        enum?: string[];
        maxItems?: number;
        minItems?: number;
        maxLength?: number;
        maxProperties?: number;
        propertyNames?: JsonSchemaNode;
        additionalProperties?: JsonSchemaNode;
      };
      const generatedSchema = (instructions: unknown): JsonSchemaNode => {
        if (typeof instructions !== "string") throw new Error("Structured request instructions were not captured.");
        const at = instructions.lastIndexOf(marker);
        if (at < 0) throw new Error("Generated JSON schema was not included in the captured model request.");
        return JSON.parse(instructions.slice(at + marker.length)) as JsonSchemaNode;
      };
      const firstSchema = generatedSchema(callInstructions[0]);
      expect(firstSchema.properties).not.toHaveProperty("authors");
      expect(firstSchema.properties).not.toHaveProperty("published");
      const extractionFields = Object.keys(firstSchema.properties ?? {});
      expect(extractionFields.indexOf("claims")).toBeLessThan(extractionFields.indexOf("guide"));
      const secondSchema = generatedSchema(callInstructions[1]);
      const firstClaim = firstSchema.properties?.claims?.items;
      const additionalClaim = secondSchema.properties?.additionalClaims?.items;
      if (!firstClaim || !additionalClaim) throw new Error("Generated call schemas are missing their claim item definitions.");
      const fields = ["task", "metric", "dataset", "valueText", "unit", "conditions"];
      expect(firstClaim.required).toEqual(expect.arrayContaining(fields));
      expect(additionalClaim.required).toEqual(expect.arrayContaining(fields));
      const acceptsNull = (node: JsonSchemaNode | undefined, rootSchema: JsonSchemaNode, seen = new Set<string>()): boolean => {
        if (!node) return false;
        if (node.$ref) {
          const name = decodeURIComponent(node.$ref.split("/").at(-1) || "");
          if (seen.has(name)) return false;
          const next = new Set(seen); next.add(name);
          return acceptsNull(rootSchema.$defs?.[name] ?? rootSchema.definitions?.[name], rootSchema, next);
        }
        if (node.type === "null" || (Array.isArray(node.type) && node.type.includes("null"))) return true;
        return [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]
          .some((child) => acceptsNull(child, rootSchema, seen));
      };
      for (const field of fields) {
        expect(acceptsNull(firstClaim.properties?.[field], firstSchema), "call-one " + field + " must be nullable").toBe(true);
        expect(acceptsNull(additionalClaim.properties?.[field], secondSchema), "call-two " + field + " must be nullable").toBe(true);
      }
      const resolve = (node: JsonSchemaNode | undefined, rootSchema: JsonSchemaNode, seen = new Set<string>()): JsonSchemaNode | undefined => {
        if (!node?.$ref) return node;
        const name = decodeURIComponent(node.$ref.split("/").at(-1) || "");
        if (seen.has(name)) return undefined;
        const next = new Set(seen); next.add(name);
        return resolve(rootSchema.$defs?.[name] ?? rootSchema.definitions?.[name], rootSchema, next);
      };
      const guideItem = resolve(firstSchema.properties?.guide?.items, firstSchema);
      const digestPlan = resolve(secondSchema.properties?.digestPlan, secondSchema);
      const partialDigestItem = resolve(secondSchema.properties?.partialDigest?.items, secondSchema);
      const glossaryItem = resolve(firstSchema.properties?.glossary?.items, firstSchema);
      expect(Object.keys(guideItem?.properties ?? {})).toEqual(["labels", "scope", "assertion"]);
      expect(guideItem?.properties?.assertion?.maxLength).toBe(800);
      const scope = guideItem?.properties?.scope;
      expect(scope).toMatchObject({ type: "array", minItems: 0, maxItems: 1, items: { type: "object" } });
      expect(scope?.items?.properties?.text?.maxLength).toBe(300);
      expect(guideItem?.required).toContain("scope");
      const sdk = await vi.importActual<typeof AISDK>("ai");
      const labels = document.blocks.map((block) => "[S1:" + block.id + "]") as [string, ...string[]];
      const oldFormat = await sdk.Output.object({ schema: extractionSchema(labels, "claim-plan-guide-v2") }).responseFormat;
      const newFormat = await sdk.Output.object({ schema: extractionSchema(labels) }).responseFormat;
      if (oldFormat?.type !== "json" || newFormat?.type !== "json" || !oldFormat.schema || !newFormat.schema)
        throw new Error("The pinned SDK did not produce its actual JSON response schemas.");
      const oldSDK = structuredClone(oldFormat.schema) as JsonSchemaNode, newSDK = structuredClone(newFormat.schema) as JsonSchemaNode;
      const oldGuide = resolve(oldSDK.properties?.guide?.items, oldSDK), newGuide = resolve(newSDK.properties?.guide?.items, newSDK);
      const oldScope = oldGuide?.properties?.scope, newScope = newGuide?.properties?.scope;
      expect(oldScope?.anyOf?.map((node) => node.type)).toEqual(["object", "null"]);
      expect(newScope).toMatchObject({ type: "array", minItems: 0, maxItems: 1 });
      expect(newScope).not.toHaveProperty("anyOf");
      expect(newScope?.items).toEqual(oldScope?.anyOf?.find((node) => node.type === "object"));
      if (!oldGuide?.properties || !newGuide?.properties) throw new Error("SDK guide schemas are missing.");
      delete oldGuide.properties.scope;
      delete newGuide.properties.scope;
      expect(newSDK).toEqual(oldSDK); // Every other wire field and primitive-nullable remains identical.
      for (const field of fields) expect(acceptsNull(newSDK.properties?.claims?.items?.properties?.[field], newSDK)).toBe(true);
      const v2Extraction = { ...extraction, guide: extraction.guide.map((item) => ({ ...item, scope: null })) };
      expect(extractionSchema(labels).safeParse(extraction).success).toBe(true);
      expect(extractionSchema(labels).safeParse(v2Extraction).success).toBe(false);
      expect(extractionSchema(labels, "claim-plan-guide-v2").safeParse(v2Extraction).success).toBe(true);
      expect(extractionSchema(labels, "claim-plan-guide-v2").safeParse(extraction).success).toBe(false);
      expect(secondSchema.properties).not.toHaveProperty("guide");
      expect(secondSchema.required).toContain("supportedGuide");
      const localSchema = vi.mocked(Output.object).mock.calls[1]?.[0].schema as z.ZodType;
      const actualPlan = await sdk.Output.object({ schema: localSchema }).responseFormat;
      if (actualPlan?.type !== "json" || !actualPlan.schema) throw new Error("The pinned SDK did not produce the digest selection schema.");
      const sdkPlan = (actualPlan.schema as JsonSchemaNode).properties?.digestPlan;
      expect(sdkPlan).toEqual(digestPlan);
      expect(digestPlan).toMatchObject({ type: "object", maxProperties: 8,
        propertyNames: { enum: ["C0", "C1", "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7"] },
        additionalProperties: { enum: ["methods", "findings", "limits"] } });
      const selection = { supportedClaims: ["C0"], additionalClaims: [], supportedGuide: ["H0"], supportedGlossary: [],
        digestPlan: { C1: "methods", C0: "methods", A0: "findings", A1: "findings", A2: "findings", A3: "findings", A4: "limits", A5: "limits" } };
      expect(Object.keys((localSchema.parse(selection) as typeof selection).digestPlan)).toEqual(Object.keys(selection.digestPlan));
      expect(localSchema.safeParse({ ...selection, digestPlan: { C99: "findings" } }).success).toBe(false);
      expect(localSchema.safeParse({ ...selection, digestPlan: { ...selection.digestPlan, A6: "limits" } }).success).toBe(false);
      expect(localSchema.safeParse({ ...selection, digestPlan: [{ id: "C0", group: "methods" }] }).success).toBe(false);
      expect(Object.keys(partialDigestItem?.properties ?? {})).toEqual(["labels", "text"]);
      expect(Object.keys(glossaryItem?.properties ?? {})).toEqual(["labels", "en", "ru", "definition"]);
      expect(guideItem?.required).toContain("labels");
      expect(digestPlan?.propertyNames?.enum).not.toContain("A8");
      expect(glossaryItem?.required).toContain("labels");
    } finally { f.db.close(); }

    const cached = withBatch(fixture(snapshot.route, document));
    const encoder = new TextEncoder();
    const bytes = encoder.encode(document.text);
    const quote = (block: Block) => new TextDecoder().decode(bytes.subarray(block.start, block.end));
    const block1 = document.blocks[0], block2 = document.blocks[1], block3 = document.blocks[2];
    if (!block1 || !block2 || !block3) throw new Error("Historical fixture requires three source blocks.");
    cached.bodies.set(prefix + "distill-verified.json", JSON.stringify({
      claims: [{
        kind: "method", statement: "Method Alpha uses a low-rank update.", quote: quote(block1), block: block1.id,
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null,
        start: block1.start, end: block1.end, ambiguous: false, valueNumber: null,
      }, ...malformedMeasurements.map(({ quoteBlock, ...item }) => {
        const block = document.blocks.find((block) => quoteBlock === "[S1:" + block.id + "]");
        if (!block) throw new Error("The retained malformed measurement needs its own canonical block.");
        return { ...item, quote: quote(block), block: block.id, start: block.start, end: block.end,
          ambiguous: false, valueNumber: null };
      })],
      guide: [
        { labels: ["[S1:1]"], text: "The source describes method Alpha." },
        { labels: ["[S1:2]"], text: "The source reports a result." },
        { labels: ["[S1:3]"], text: "The source notes a limitation." },
      ],
      evidence: document.blocks.map((block) => ({ label: "[S1:" + block.id + "]", block: block.id, quote: quote(block) })),
      questions: ["What method is described?", "What result is reported?", "What limitation is noted?"],
      dropped: [], clearedNumbers: 0,
    }));
    cached.bodies.set(prefix + "distill-call2.json", JSON.stringify({
      output: {
        supportedClaims: ["C0", "C1", "C2"],
        additionalClaims: [
          { quoteBlock: "[S1:2]", kind: "result", statement: "The source reports a result of 3 times." },
          { quoteBlock: "[S1:1]", kind: "method", statement: "[S1:1]" },
          { quoteBlock: "[S1:1]", kind: "method", statement: " \n\t" },
          { quoteBlock: "[S1:1]", kind: "method", statement: "The method uses a low-rank update." },
          { quoteBlock: "[S1:1]", kind: "method", statement: "The method uses 9999 layers." },
          { quoteBlock: "[S1:1]", kind: "result", statement: "The source reports a result." },
          ...malformedMeasurements,
        ],
        guide: [
          { labels: ["[S1:1]"], text: "The source describes method Alpha." },
          { labels: ["[S1:2]"], text: "The source reports a result." },
          { labels: ["[S1:3]"], text: "The source notes a limitation." },
        ],
        digest: [{ labels: ["[S1:1]"], text: "The source describes method Alpha." }],
        glossary: [],
      },
      usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 24, tokenLimit: 1000, providerUsage: null },
    }));
    cached.bodies.set(prefix + "distill.json", JSON.stringify({
      state: "failed", questions: [], usage: { calls: 2, inputTokens: 24, cachedTokens: 0, outputTokens: 48, tokenLimit: 1000, wallMs: 30, providerUsage: [] },
      kept: 0, dropped: [], clearedNumbers: 0, raw: { first: prefix + "distill-call1.json", second: prefix + "distill-call2.json" }, error: "historical call-two output",
    }));
    cached.db.prepare("UPDATE source_revision SET distill_state='failed',distill_calls=2,distill_error=? WHERE id=?")
      .run("historical call-two output", revisionId);
    cached.db.prepare("UPDATE source SET authors=?,published=? WHERE id=?").run("Историческая Zoë Ёлкина", "2021-03", sourceId);
    const originalCachedBodies = new Map(cached.bodies);
    try {
      expect(await hasAvailableUnderstanding(cached.env, revisionId)).toBe(true);
      expect(cached.bodies.has(prefix + "distill-call1.json")).toBe(false);
      vi.mocked(generateText).mockClear();
      vi.mocked(resolveModelTransport).mockClear();
      await expect(requestUnderstanding(cached.env, { type: "owner" } as Actor, {
        sourceId, revisionId, saveAvailable: true,
      })).resolves.toEqual({ revisionId });
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
      const savedBody = cached.bodies.get(prefix + "checked/distill.json");
      if (!savedBody) throw new Error("Historical call-two output was not saved.");
      const saved = JSON.parse(savedBody) as DistillReport & { state: string };
      expect(saved.state).toBe("partial"); // Cards survive; original claim markup cannot be recovered.
      expect(saved.kept).toBe(2);
      expect(saved.usage.calls).toBe(2);
      expect(cached.db.prepare("SELECT authors,published FROM source WHERE id=?").get(sourceId))
        .toEqual({ authors: "Историческая Zoë Ёлкина", published: "2021-03" });
      for (const [key, body] of originalCachedBodies) expect(cached.bodies.get(key)).toBe(body);
      expect(saved.dropped).toContainEqual({ index: 0, reason: "additional-missing-or-unsupported-primary-result" });
      expect(saved.dropped).toContainEqual({ index: 1, reason: "additional-empty-statement" });
      expect(saved.dropped).toContainEqual({ index: 2, reason: "additional-empty-statement" });
      expect(saved.dropped).toContainEqual({ index: 4, reason: "additional-unsupported-statement-numbers" });
      expect(saved.dropped).toContainEqual({ index: 5, reason: "additional-missing-or-unsupported-primary-result" });
      expect(saved.dropped).toContainEqual({ index: 1, reason: "retained-non-result-measurement-fields" });
      expect(saved.dropped).toContainEqual({ index: 2, reason: "retained-compound-primary-measurement" });
      expect(saved.dropped).toContainEqual({ index: 6, reason: "additional-non-result-measurement-fields" });
      expect(saved.dropped).toContainEqual({ index: 7, reason: "additional-compound-primary-measurement" });
      expect(cached.db.prepare("SELECT statement FROM claim WHERE source_revision_id=? ORDER BY ordinal").all(revisionId))
        .toEqual([{ statement: "Method Alpha uses a low-rank update." }, { statement: "The method uses a low-rank update." }]);
    } finally { cached.db.close(); }
  });

  it("rejects an unknown or dropped claim-plan ID and malformed fresh plan without legacy fallback", async () => {
    const document = documentWithBlocks([
      { type: "paragraph", text: "Method Alpha uses a low-rank update.\n" },
      { type: "paragraph", text: "The source reports a result.\n" },
      { type: "paragraph", text: "The source notes a limitation.\n" },
    ]);
    const oldGuideText = "Method Alpha uses a low-rank update. The source reports a result. The source notes a limitation.";
    const prepareCached = (output: unknown, format: string | undefined, claimCount = 1) => {
      const f = fixture(snapshot.route, document);
      const encoder = new TextEncoder();
      const bytes = encoder.encode(document.text);
      const quote = (block: Block) => new TextDecoder().decode(bytes.subarray(block.start, block.end));
      const [block1, block2, block3] = document.blocks;
      if (!block1 || !block2 || !block3) throw new Error("Fixture requires three blocks.");
      f.bodies.set(prefix + "distill-verified.json", JSON.stringify({
        claims: Array.from({ length: claimCount }, () => ({
          kind: "method", statement: "Method Alpha uses a low-rank update.", quote: quote(block1), block: block1.id,
          task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null,
          start: block1.start, end: block1.end, ambiguous: false, valueNumber: null,
        })),
        ...(format === "claim-plan-guide-v1" || format === "claim-plan-guide-v3" ? { glossaryCandidates: [], guideCandidates: [{
          id: "H4", labels: ["[S1:1]", "[S1:2]", "[S1:3]"], qualifiers: [], text: oldGuideText,
        }] } : {}),
        ...(format === "claim-plan-guide-v3" ? { format } : {}),
        guide: [
          { labels: ["[S1:1]"], text: "The source describes method Alpha." },
          { labels: ["[S1:2]"], text: "The source reports a result." },
          { labels: ["[S1:3]"], text: "The source notes a limitation." },
        ],
        evidence: [block1, block2, block3].map((block) => ({ label: "[S1:" + block.id + "]", block: block.id, quote: quote(block) })),
        questions: ["Q?"], dropped: [], clearedNumbers: 0,
      }));
      f.bodies.set(prefix + "distill-call2.json", JSON.stringify({
        output, usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 24, tokenLimit: 1000, providerUsage: null },
        ...(format ? { format } : {}),
      }));
      const flow = async () => {
        const steps = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
          ["extract source", "verify source excerpts", "review and synthesize"].includes(name) ? undefined : callback());
        await new DistillWorkflow({} as ExecutionContext, f.env).run(
          { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>, { do: steps } as unknown as WorkflowStep);
        return steps;
      };
      return { f, flow };
    };
    const guide = [
      { labels: ["[S1:1]"], text: "The source describes method Alpha." },
      { labels: ["[S1:2]"], text: "The source reports a result." },
      { labels: ["[S1:3]"], text: "The source notes a limitation." },
    ];
    const good = { supportedClaims: ["C0"], additionalClaims: [], guide, digestPlan: { methods: ["C0"], findings: [], limits: [] }, glossary: [] };
    for (const overflow of [false, true]) {
      const output = { supportedClaims: Array.from({ length: overflow ? 12 : 1 }, (_, i) => "C" + i),
        additionalClaims: overflow ? Array.from({ length: 8 }, () => ({ quoteBlock: "[S1:1]", kind: "method",
          statement: "Method Alpha uses a low-rank update.", task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null })) : [],
        supportedGuide: ["H4"], supportedGlossary: [], digestPlan: overflow ? {
          methods: ["C0", "C2", "C3", "C4", "A2", "A3"],
          findings: ["C1", "C5", "C6", "C7", "C8", "C9", "A1", "A0"], limits: ["C10", "C11", "A7"],
        } : good.digestPlan };
      const { f, flow } = prepareCached(output, "claim-plan-guide-v1", overflow ? 12 : 1);
      const before = new Map(f.bodies);
      try {
        expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(!overflow);
        await flow();
        const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
        expect(report.state).toBe(overflow ? "failed" : "partial");
        if (overflow) expect(f.bodies.has(prefix + "digest.md")).toBe(false);
        else expect(f.bodies.get(prefix + "guide.md")).toBe(oldGuideText + "\n\n" + [1, 2, 3].map((block) => "[R" + revisionId + ":" + block + "]").join(" "));
        for (const [key, body] of before) expect(f.bodies.get(key)).toBe(body);
        expect(generateText).not.toHaveBeenCalled();
      } finally { f.db.close(); }
    }
    {
      const { f, flow } = prepareCached({ supportedClaims: ["C0"], additionalClaims: [], supportedGuide: ["H4"], supportedGlossary: [],
        digestPlan: [{ id: "C0", group: "findings" }, { id: "C0", group: "findings" }] }, "claim-plan-guide-v3");
      const before = new Map(f.bodies);
      try {
        expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
        const steps = await flow();
        expect(steps.mock.calls.at(-1)?.[0]).toBe("store understanding");
        await expect(steps.mock.results.at(-1)?.value).rejects.toThrow("The curated digest plan is not a bounded, unique selection.");
        expect(JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null")).toMatchObject({ state: "failed",
          error: "Source understanding failed." });
        expect(f.bodies.has(prefix + "digest.md")).toBe(false);
        for (const [key, body] of before) expect(f.bodies.get(key)).toBe(body);
        expect(generateText).not.toHaveBeenCalled();
      } finally { f.db.close(); }
    }
    {
      const { f, flow } = prepareCached(good, "claim-plan-v1");
      try {
        expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(true);
        await flow();
        const r = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null") as { state: string; error: string | null };
        if (!["done", "partial"].includes(r.state)) throw new Error("flow report: " + JSON.stringify(r));
        expect(f.bodies.get(prefix + "digest.md")).toContain("Method Alpha uses a low-rank update.");
        expect(f.bodies.get(prefix + "digest.md")).toContain("[R" + revisionId + ":1]");
        expect(generateText).not.toHaveBeenCalled();
      } finally { f.db.close(); }
    }
    for (const [output, format] of [
      [{ ...good, digestPlan: { methods: ["C99"], findings: [], limits: [] } }, "claim-plan-v1"],
      [{ ...good, digestPlan: { methods: ["C1"], findings: [], limits: [] } }, "claim-plan-v1"],
      [{ supportedClaims: ["C0"], additionalClaims: [], guide, glossary: [] }, "claim-plan-v1"],
      [{ ...good, digestPlan: { methods: [] } }, "claim-plan-v1"],
      [{ ...good, digestPlan: { methods: ["C0"], findings: ["C0"], limits: [] } }, "claim-plan-v1"],
      [{ ...good, additionalClaims: Array.from({ length: 8 }, () => ({
        quoteBlock: "[S1:1]", kind: "method", statement: "Method Alpha uses a low-rank update.",
      })), digestPlan: { methods: ["C0", "A0", "A1", "A2", "A3", "A4", "A5", "A6"], findings: ["A7"], limits: [] } }, "claim-plan-v1"],
    ] as const) {
      const { f, flow } = prepareCached(output, format);
      try {
        expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
        await flow();
        const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null") as { state: string; error: string };
        expect(report.state).toBe("failed");
        expect(f.bodies.get(prefix + "digest.md")).toBeUndefined();
      } finally { f.db.close(); }
    }
  });

  it.each(["complete comparison", "missing comparison", "rejected ID"] as const)(
    "copies eight unique fresh assignments only from fully checked facts: %s", async (mode) => {
      const statements = ["The method retains evidence.", "The method preserves labels.", "The method shares weights.",
        "The method computes attention.", "The method trains in parallel.", "The method limits padding."];
      const result = "On English-German translation, the model reports 28.4 BLEU, improving over the previous best by 2.0 BLEU after 3.5 days on eight P100 GPUs.";
      const document = documentWithBlocks([
        { type: "paragraph", text: "The method uses normalization. " + statements.join(" ") + "\n" },
        { type: "paragraph", text: result + "\n" },
      ]);
      const f = fixture(snapshot.route, document);
      const fields = { task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null };
      const comparison = mode === "missing comparison" ? "after 3.5 days on eight P100 GPUs"
        : "improving over the previous best by 2.0 BLEU after 3.5 days on eight P100 GPUs";
      const digestPlan = { A7: "limits", C0: "methods", A0: "findings", A6: "methods", A2: "methods", A3: "methods", A4: "methods", A5: "methods" };
      if (mode === "rejected ID") { delete (digestPlan as Partial<typeof digestPlan>).A7; Object.assign(digestPlan, { A1: "limits" }); }
      vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
      vi.mocked(generateText)
        .mockResolvedValueOnce({ output: { claims: [{ quoteBlock: "[S1:1]", kind: "method", ...fields, statement: "The method uses normalization." }],
          guide: [{ labels: ["[S1:1]"], scope: [], assertion: "The method uses normalization." },
            { labels: ["[S1:1]"], scope: [], assertion: "The method retains evidence." },
            { labels: ["[S1:2]"], scope: [], assertion: "The source reports a translation result." }],
          glossary: [], questions: ["Which method?", "Which result?", "Which conditions?"] },
          totalUsage: { inputTokens: 17, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 0 } } } as never)
        .mockResolvedValueOnce({ output: { supportedClaims: ["C0"], supportedGuide: ["H0", "H1", "H2"], supportedGlossary: [], digestPlan,
          additionalClaims: [
            { quoteBlock: "[S1:2]", kind: "result", task: "English-German translation", metric: "BLEU", dataset: null,
              valueText: "28.4", unit: "BLEU", conditions: comparison, statement: result },
            { quoteBlock: "[S1:1]", kind: "method", ...fields, statement: "The method uses 99 layers." },
            ...statements.map((statement) => ({ quoteBlock: "[S1:1]", kind: "method", ...fields, statement })),
          ] }, totalUsage: { inputTokens: 19, outputTokens: 9, inputTokenDetails: { cacheReadTokens: 0 } } } as never);
      try {
        const steps = await run(f);
        expect(generateText).toHaveBeenCalledTimes(2);
        expect(f.dispatchCAS).toHaveBeenCalledTimes(2);
        const raw2 = f.bodies.get(prefix + "distill-call2.json");
        expect(JSON.parse(raw2 ?? "null")).toMatchObject({ format: "claim-plan-guide-v4", output: { digestPlan } });
        const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
        if (mode !== "complete comparison") {
          expect(steps.mock.calls.at(-1)?.[0]).toBe("store understanding");
          await expect(steps.mock.results.at(-1)?.value).rejects.toThrow("The curated digest references an unknown or rejected claim.");
          expect(report).toMatchObject({ state: "failed", error: "Source understanding failed." });
          expect(f.bodies.has(prefix + "digest.md")).toBe(false);
        } else {
          expect(report).toMatchObject({ state: "done", kept: 8 });
          expect(report.dropped).toContainEqual({ index: 1, reason: "additional-unsupported-statement-numbers" });
          const digest = f.bodies.get(prefix + "digest.md") ?? "";
          const expectedOrder = ["## Methods", "The method uses normalization.", statements[4], ...statements.slice(0, 4),
            "## Findings", result, comparison, "## Limitations", statements[5]] as string[];
          let position = -1;
          for (const text of expectedOrder) { const next = digest.indexOf(text, position + 1); expect(next, text).toBeGreaterThan(position); position = next; }
          expect(f.db.prepare("SELECT statement,conditions FROM claim WHERE source_revision_id=? AND kind='result'").get(revisionId))
            .toEqual({ statement: result, conditions: comparison });
        }
        expect(f.bodies.get(prefix + "distill-call2.json")).toBe(raw2);
        expect(f.bodies.get(prefix + "text.md")).toBe(document.text);
      } finally { f.db.close(); }
    });

  it.each([
    { name: "task", field: "task", value: "99 experiments" },
    { name: "metric", field: "metric", value: "Scope 99" },
    { name: "dataset", field: "dataset", value: "ValidationSet 99" },
    { name: "unit", field: "unit", value: "99 units" },
    { name: "valid qualified fact", field: null, value: "" },
  ] as const)("checks every rendered digest field against its own quote: $name", async ({ field, value }) => {
    const document = documentWithBlocks([
      { type: "paragraph", text: "On ValidationSet 4, Method Alpha uses normalization for 4 layers in 4 short-sequence experiments and reports Scope 4. This applies only with short sequences.\n" },
      { type: "paragraph", text: "An unrelated method reports 99 experiments, Scope 99, ValidationSet 99, and 99 units.\n" },
      { type: "paragraph", text: "The source notes a limitation.\n" },
    ]);
    const f = fixture(snapshot.route, document);
    const bytes = new TextEncoder().encode(document.text);
    const quote = (block: Block) => new TextDecoder().decode(bytes.subarray(block.start, block.end));
    const block1 = document.blocks[0];
    if (!block1) throw new Error("The digest regression requires its own canonical block.");
    const kind = field === "unit" ? "result" : "method";
    const statement = kind === "result" ? "Method Alpha uses 4 layers with short sequences." : "Method Alpha uses normalization.";
    const metadata = { task: "4 short-sequence experiments", metric: "Scope 4", dataset: "ValidationSet 4 [S1:1]",
      valueText: kind === "result" ? "4" : null, unit: kind === "result" ? "layers" : null, conditions: "only on ValidationSet 4 with short sequences" };
    if (field !== null) metadata[field] = value;
    const guide = [
      { labels: ["[S1:1]"], text: "The source describes Method Alpha." },
      { labels: ["[S1:2]"], text: "The source includes an unrelated method." },
      { labels: ["[S1:3]"], text: "The source notes a limitation." },
    ];
    const questions = ["What method?", "Which scope?", "What limitation?"];
    const usage = { inputTokens: 12, cachedTokens: 0, outputTokens: 24, tokenLimit: 1000, providerUsage: null };
    f.db.prepare("UPDATE source_revision SET distill_calls=2 WHERE id=?").run(revisionId);
    f.bodies.set(prefix + "distill-call1.json", JSON.stringify({
      output: { claims: [{ quoteBlock: "[S1:1]", kind, statement, ...metadata }], guide, questions }, usage,
    }));
    f.bodies.set(prefix + "distill-verified.json", JSON.stringify({
      claims: [{ kind, statement, ...metadata, quote: quote(block1), block: block1.id,
        start: block1.start, end: block1.end, ambiguous: false, valueNumber: kind === "result" ? 4 : null }],
      guide, questions, evidence: document.blocks.map((block) => ({ label: "[S1:" + block.id + "]", block: block.id, quote: quote(block) })),
      dropped: [], clearedNumbers: 0,
    }));
    const rawCall2 = JSON.stringify({ format: "claim-plan-v1",
      output: { supportedClaims: ["C0"], additionalClaims: [], guide,
        digestPlan: { methods: ["C0"], findings: [], limits: [] }, glossary: [] }, usage });
    f.bodies.set(prefix + "distill-call2.json", rawCall2);
    let storeError: unknown;
    try {
      const steps = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
        if (["extract source", "verify source excerpts", "review and synthesize"].includes(name)) return;
        try { return await callback(); }
        catch (error) { if (name === "store understanding") storeError = error; throw error; }
      });
      await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>, { do: steps } as unknown as WorkflowStep);
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
      if (field !== null) {
        expect(storeError).toHaveProperty("message", field === "unit"
          ? "The curated digest references claims that did not survive verification."
          : "The curated digest fact contains unsupported rendered fields.");
        expect(report.state).toBe("failed");
        expect(f.bodies.has(prefix + "digest.md")).toBe(false);
        expect(f.db.prepare("SELECT COUNT(*) AS count FROM claim WHERE source_revision_id=?").get(revisionId)).toEqual({ count: 0 });
      } else {
        expect(report).toMatchObject({ state: "done", kept: 1 });
        const digest = f.bodies.get(prefix + "digest.md") ?? "";
        for (const scope of [statement, ...Object.values(metadata)].filter((value) => value !== null)) expect(digest).toContain(scope);
        expect(digest).toContain("[R" + revisionId + ":1]");
        expect(f.db.prepare("SELECT task,metric,dataset,value_text AS valueText,unit,conditions FROM claim WHERE source_revision_id=?").get(revisionId))
          .toEqual(metadata);
      }
      expect(f.bodies.get(prefix + "distill-call2.json")).toBe(rawCall2);
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("stores a zero-claim claim-plan result as partial only with validated partial digest", async () => {
    const document = documentWithBlocks([
      { type: "paragraph", text: "Method Alpha uses a low-rank update.\n" },
      { type: "paragraph", text: "The source reports a result.\n" },
      { type: "paragraph", text: "The source notes a limitation.\n" },
    ]);
    const f = fixture(snapshot.route, document);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(document.text);
    const quote = (block: Block) => new TextDecoder().decode(bytes.subarray(block.start, block.end));
    const [block1, block2, block3] = document.blocks;
    if (!block1 || !block2 || !block3) throw new Error("Fixture requires three blocks.");
    f.bodies.set(prefix + "distill-verified.json", JSON.stringify({
      claims: [],
      guide: [
        { labels: ["[S1:1]"], text: "The source describes method Alpha." },
        { labels: ["[S1:2]"], text: "The source reports a result." },
        { labels: ["[S1:3]"], text: "The source notes a limitation." },
      ],
      evidence: [block1, block2, block3].map((block) => ({ label: "[S1:" + block.id + "]", block: block.id, quote: quote(block) })),
      questions: ["Q?"], dropped: [], clearedNumbers: 0,
    }));
    f.bodies.set(prefix + "distill-call2.json", JSON.stringify({
      output: { supportedClaims: [], additionalClaims: [],
        guide: [
          { labels: ["[S1:1]"], text: "The source describes method Alpha." },
          { labels: ["[S1:2]"], text: "The source reports a result." },
          { labels: ["[S1:3]"], text: "The source notes a limitation." },
        ],
        digestPlan: { methods: [], findings: [], limits: [] },
        partialDigest: [{ labels: ["[S1:1]"], text: "The source describes method Alpha." }],
        glossary: [] },
      format: "claim-plan-v1",
      usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 24, tokenLimit: 1000, providerUsage: null },
    }));
    try {
      const steps = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
        ["extract source", "verify source excerpts", "review and synthesize"].includes(name) ? undefined : callback());
      await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>, { do: steps } as unknown as WorkflowStep);
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null") as { state: string; kept: number };
      expect(report.state).toBe("partial");
      expect(report.kept).toBe(0);
      expect(f.bodies.get(prefix + "digest.md")).toContain("The source describes method Alpha.");
    } finally { f.db.close(); }
  });

  it.each(["complete", "questions", "over-five", "insufficient", "zero-claim", "unknown", "duplicate", "missing", "malformed"] as const)(
    "assembles complete source-bound scope before whole-guide review: %s", async (mode) => {
      const document = documentWithBlocks([
        { type: "paragraph", text: "Compared to GPT-3 175B fine-tuned with Adam, the method reduces GPU memory. (Version 2)"
          + (mode === "questions" ? " The source asks whether r=1 always suffices?" : "") + "\n" },
        { type: "paragraph", text: "Adaptation proceeds while keeping the pre-trained weights frozen.\n" },
        { type: "paragraph", text: "The model reduces deployment storage if r is smaller than dmodel. This bound is conditional. The condition concerns rank. The base weights remain shared.\n" },
      ]);
      const f = fixture(snapshot.route, document);
      const caseScope = { labels: ["[S1:1]"], text: "Compared to GPT-3 175B fine-tuned with Adam; (Version 2)" };
      const paraphrasedScope = { labels: ["[S1:2]"], text: "while keeping the pre-trained weights frozen" };
      const omittedScope = { labels: ["[S1:3]"], text: "if r is smaller than dmodel" };
      const guide = [
        { labels: ["[S1:1]"], scope: mode === "questions" ? [] : [paraphrasedScope],
          assertion: mode === "questions" ? "r=1 always suffices?" : "The method reduces GPU memory" },
        { labels: ["[S1:1]"], scope: [caseScope],
          assertion: "The method reduces GPU memory compared to GPT-3 175B fine-tuned with Adam in Version 2" },
        { labels: ["[S1:1]", "[S1:2]"], scope: mode === "questions" ? [] : [{ labels: ["[S1:2]"], text: "using 175B parameters" }],
          assertion: mode === "questions" ? "r=1 always suffices？！" : "The pre-trained weights remain fixed during adaptation" },
        { labels: ["[S1:2]"], scope: [paraphrasedScope],
          assertion: "The pre-trained weights remain fixed during adaptation" + (mode === "questions" ? "." : "") },
        { labels: ["[S1:3]"], scope: [omittedScope], assertion: "The model reduces deployment storage"
          + (mode === "over-five" ? ". This bound is conditional. The condition concerns rank. The base weights remain shared" : "") },
      ];
      const frozen = [
        { id: "H1", labels: ["[S1:1]"], qualifiers: [caseScope],
          text: "(Compared to GPT-3 175B fine-tuned with Adam; (Version 2)) The method reduces GPU memory compared to GPT-3 175B fine-tuned with Adam in Version 2." },
        { id: "H3", labels: ["[S1:2]"], qualifiers: [paraphrasedScope],
          text: "(while keeping the pre-trained weights frozen) The pre-trained weights remain fixed during adaptation." },
        { id: "H4", labels: ["[S1:3]"], qualifiers: [omittedScope], text: mode === "over-five"
          ? "(if r is smaller than dmodel) The model reduces deployment storage. This bound is conditional. The condition concerns rank. The base weights remain shared."
          : "(if r is smaller than dmodel) The model reduces deployment storage." },
      ];
      for (const i of [1, 3, 4]) expect(guide[i]?.assertion).not.toContain(guide[i]?.scope[0]?.text);
      const ids = mode === "unknown" ? ["H0"] : mode === "duplicate" ? ["H1", "H1", "H3"]
        : mode === "insufficient" ? ["H1"] : ["H1", "H3", "H4"];
      const zero = mode === "zero-claim", invalid = ["unknown", "duplicate", "missing", "malformed"].includes(mode);
      vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
      vi.mocked(generateText)
        .mockResolvedValueOnce({ output: { guide, glossary: [], questions: ["Which scope?", "What method?", "What evidence?"],
          claims: [{ quoteBlock: "[S1:2]", kind: "method", statement: "The pre-trained weights remain fixed during adaptation.",
            task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }] },
          totalUsage: { inputTokens: 17, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 0 } } } as never)
        .mockResolvedValueOnce({ output: { supportedClaims: zero ? [] : ["C0"], additionalClaims: [], supportedGlossary: [],
          ...(mode === "missing" ? { guide: frozen } : { supportedGuide: mode === "malformed" ? "H1" : ids }),
          digestPlan: zero ? {} : { C0: "methods" },
          ...(zero ? { partialDigest: [{ labels: ["[S1:2]"], text: "Adaptation keeps the pre-trained weights frozen." }] } : {}) },
          totalUsage: { inputTokens: 19, outputTokens: 9, inputTokenDetails: { cacheReadTokens: 0 } } } as never);
      try {
        await run(f);
        expect(generateText).toHaveBeenCalledTimes(2);
        expect(f.dispatchCAS).toHaveBeenCalledTimes(2);
        const verified = JSON.parse(f.bodies.get(prefix + "distill-verified.json") ?? "null");
        expect(verified.format).toBe("claim-plan-guide-v4");
        expect(verified.guideCandidates).toEqual(frozen);
        expect(verified.dropped).toContainEqual({ index: 0, reason: mode === "questions"
          ? "guide-candidate-question-assertion" : "guide-candidate-qualifier-outside-scope" });
        expect(verified.dropped).toContainEqual({ index: 2, reason: mode === "questions"
          ? "guide-candidate-question-assertion" : "guide-candidate-unsupported-qualifier" });
        const request = vi.mocked(generateText).mock.calls[1]?.[0].messages?.[0]?.content;
        if (typeof request !== "string") throw new Error("The assembled guide context was not captured.");
        const context = JSON.parse(request);
        expect(context.guideCandidates).toEqual(frozen.map((item) => ({ ...item,
          evidence: item.labels.map((label) => verified.evidence.find((e: { label: string }) => e.label === label)) })));
        if (mode === "questions") expect(context.guideCandidates.map((item: { text: string }) => item.text).join("\n"))
          .not.toContain("r=1 always suffices");
        expect(JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null").format).toBe("claim-plan-guide-v4");
        const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
        expect(report.state).toBe(invalid ? "failed" : mode === "complete" || mode === "questions" ? "done" : "partial");
        expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(!invalid);
        if (invalid) expect(f.bodies.has(prefix + "guide.md")).toBe(false);
        else {
          const expected = ids.map((id) => {
            const item = frozen.find((item) => item.id === id);
            if (!item) throw new Error("The expected guide must select a frozen unit.");
            return item.text + "\n\n" + item.labels.map((label) => label.replace("S1:", "R" + revisionId + ":")).join(" ");
          }).join("\n\n");
          expect(f.bodies.get(prefix + "guide.md")).toBe(expected);
          expect(expected).not.toContain("Scope:");
          expect(report.kept).toBe(zero ? 0 : 1);
          if (!zero) expect(f.bodies.get(prefix + "digest.md")).toContain("## Methods\n\nStatement:\n> The pre-trained weights remain fixed during adaptation.");
          if (zero) {
            const beforeSave = new Map(f.bodies);
            await requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId, saveAvailable: true });
            expect(f.bodies.get(prefix + "checked/guide.md")).toBe(expected);
            expect(JSON.parse(f.bodies.get(prefix + "checked/distill.json") ?? "null")).toMatchObject({ state: "partial", kept: 0 });
            for (const [key, body] of beforeSave) expect(f.bodies.get(key)).toBe(body);
            expect(generateText).toHaveBeenCalledTimes(2);
          }
        }
        expect(f.bodies.get(prefix + "text.md")).toBe(document.text);
      } finally { f.db.close(); }
    });

  it.each([
    { name: "missing", scope: undefined },
    { name: "legacy null", scope: null },
    { name: "legacy object", scope: { labels: ["[S1:1]"], text: "uses normalization" } },
    { name: "two clauses", scope: [{ labels: ["[S1:1]"], text: "uses normalization" }, { labels: ["[S1:1]"], text: "retains evidence" }] },
    { name: "malformed clause", scope: [{ labels: ["[S1:1]"], text: 17 }] },
  ])("rejects $name fresh scope without a legacy downgrade or second call", async ({ scope }) => {
    const f = fixture(snapshot.route);
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(generateText).mockResolvedValueOnce({ output: {
      guide: [{ labels: ["[S1:1]"], scope, assertion: "The method uses normalization." },
        { labels: ["[S1:1]"], scope: [], assertion: "The source retains its passage." },
        { labels: ["[S1:1]"], scope: [], assertion: "The source describes a method." }],
      claims: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The method uses normalization.",
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }],
      questions: ["Which method?", "Which evidence?", "What normalization?"], glossary: [],
    }, totalUsage: { inputTokens: 17, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 0 } } } as never);
    try {
      await run(f);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(1);
      expect(JSON.parse(f.bodies.get(prefix + "distill-call1.json") ?? "null").format).toBe("claim-plan-guide-v4");
      expect(f.bodies.has(prefix + "distill-verified.json")).toBe(false);
      expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
      expect(JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null")).toMatchObject({ state: "failed", kept: 0, usage: { calls: 1 } });
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
    } finally { f.db.close(); }
  });

  it.each(["claim-plan-guide-v2", "claim-plan-guide-v3", "claim-plan-guide-v4"] as const)("keeps identical complete text, symbols and cached Save with exact version matching: %s", async (format) => {
    const document = documentWithBlocks([{ type: "paragraph", text:
      "For distinct items, the number of permutations is n!. The estimate remains open... During adaptation, the method keeps the pre-trained weights fixed.\n" }]);
    const f = fixture(snapshot.route, document);
    const scope = { labels: ["[S1:1]"], text: "for distinct items" }, context = { labels: ["[S1:1]"], text: "during adaptation" };
    const guide = [
      { labels: ["[S1:1]"], scope: [scope], assertion: "  The number of permutations is n!  " },
      { labels: ["[S1:1]"], scope: [], assertion: " The estimate remains open... " },
      { labels: ["[S1:1]"], scope: [context], assertion: "The method keeps the pre-trained weights fixed." },
    ];
    const frozen = [
      { id: "H0", labels: ["[S1:1]"], qualifiers: [scope], text: "(for distinct items) The number of permutations is n!" },
      { id: "H1", labels: ["[S1:1]"], qualifiers: [], text: "The estimate remains open..." },
      { id: "H2", labels: ["[S1:1]"], qualifiers: [context], text: "(during adaptation) The method keeps the pre-trained weights fixed." },
    ];
    const totalUsage = { inputTokens: 17, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 0 } };
    const firstOutput = { guide: format === "claim-plan-guide-v2" ? guide.map((item) => ({ ...item, scope: item.scope[0] ?? null })) : guide,
      glossary: [], questions: ["Which items?", "What estimate?", "Which method?"],
      claims: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The method keeps the pre-trained weights fixed during adaptation.",
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }] };
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    if (format !== "claim-plan-guide-v4") {
      f.bodies.set(prefix + "distill-call1.json", JSON.stringify({ format, output: firstOutput,
        usage: { inputTokens: 17, cachedTokens: 0, outputTokens: 8, tokenLimit: null, tokenLimitKind: "legacy" } }));
      f.db.prepare("UPDATE source_revision SET distill_calls=1 WHERE id=?").run(revisionId);
    } else vi.mocked(generateText).mockResolvedValueOnce({ output: firstOutput, totalUsage } as never);
    vi.mocked(generateText).mockResolvedValueOnce({ output: { supportedClaims: ["C0"], additionalClaims: [], supportedGlossary: [],
        supportedGuide: ["H0", "H1", "H2"], digestPlan: format === "claim-plan-guide-v4" ? { C0: "methods" } : [{ id: "C0", group: "methods" }] }, totalUsage } as never);
    try {
      if (format !== "claim-plan-guide-v4") await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>,
        { do: async (name: string, _options: unknown, callback: () => Promise<unknown>) => name === "extract source" ? undefined : callback() } as unknown as WorkflowStep);
      else await run(f);
      expect(JSON.parse(f.bodies.get(prefix + "distill-verified.json") ?? "null").format).toBe(format);
      expect(JSON.parse(f.bodies.get(prefix + "distill-verified.json") ?? "null").guideCandidates).toEqual(frozen);
      const content = vi.mocked(generateText).mock.calls.at(-1)?.[0].messages?.[0]?.content;
      if (typeof content !== "string") throw new Error("The guide review request was not captured.");
      expect(JSON.parse(content).guideCandidates).toEqual(frozen.map((item) => ({ ...item,
        evidence: [{ label: "[S1:1]", block: 1, quote: document.text }] })));
      const expectedGuide = frozen.map((item) => item.text + "\n\n[R" + revisionId + ":1]").join("\n\n");
      expect(f.bodies.get(prefix + "guide.md")).toBe(expectedGuide);
      expect(JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null")).toMatchObject({ state: "done", kept: 1 });
      const raw2 = f.bodies.get(prefix + "distill-call2.json");
      if (!raw2) throw new Error("The selected guide output was not retained.");
      expect(JSON.parse(raw2).format).toBe(format);
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(true);
      f.bodies.set(prefix + "distill-call2.json", JSON.stringify({ ...JSON.parse(raw2),
        format: format === "claim-plan-guide-v2" ? "claim-plan-guide-v3" : "claim-plan-guide-v2" }));
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
      await expect(requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId, saveAvailable: true }))
        .rejects.toThrow("No complete compatible model output is available");
      f.bodies.set(prefix + "distill-call2.json", raw2);
      const beforeSave = new Map(f.bodies);
      await requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId, saveAvailable: true });
      expect(f.bodies.get(prefix + "checked/guide.md")).toBe(expectedGuide);
      for (const [key, value] of beforeSave) expect(f.bodies.get(key)).toBe(value);
      expect(generateText).toHaveBeenCalledTimes(format === "claim-plan-guide-v4" ? 2 : 1);
    } finally { f.db.close(); }
  });

  it.each([
    { name: "whole G1 unit after an earlier drop", empty: false },
    { name: "fresh empty candidate set", empty: true },
  ])("freezes and selects glossary candidates: $name", async ({ empty }) => {
    const document = documentWithBlocks([
      { type: "paragraph", text: "The source describes Method Alpha, which uses normalization.\n" },
      { type: "paragraph", text: "The compact adapter uses 4 layers only for short sequences.\n" },
      { type: "paragraph", text: "The comparison concerns one request at a time, not large-batch throughput.\n" },
    ]);
    const f = fixture(snapshot.route, document);
    const guide = [
      { labels: ["[S1:1]"], scope: [], assertion: "The source describes Method Alpha." },
      { labels: ["[S1:1]"], scope: [], assertion: "Method Alpha uses normalization." },
      { labels: ["[S1:1]"], scope: [], assertion: "The method is named Alpha." },
    ];
    const questions = ["What method?", "Which condition?", "What comparison?"];
    const unit = { labels: ["[S1:2]", "[S1:3]"], en: "Compact adapter", ru: "Компактный адаптер",
      definition: "Компактный адаптер использует 4 слоя только для коротких последовательностей; сравнение касается обработки по одному запросу. Этот вывод не относится к большому пакетному режиму." };
    const invalid = { labels: ["[S1:1]"], en: "Layered adapter", ru: "Многослойный адаптер", definition: "Адаптер использует 99 слоёв." };
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(generateText)
      .mockResolvedValueOnce({ output: { claims: [{ quoteBlock: "[S1:1]", kind: "method", statement: "Method Alpha uses normalization.",
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }],
        guide, questions, glossary: empty ? [] : [invalid, unit] },
        totalUsage: { inputTokens: 17, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 0 } } } as never)
      .mockResolvedValueOnce({ output: { supportedClaims: ["C0"], additionalClaims: [], supportedGuide: ["H0", "H1", "H2"],
        digestPlan: { C0: "methods" }, supportedGlossary: empty ? [] : ["G1"] },
        totalUsage: { inputTokens: 19, outputTokens: 9, inputTokenDetails: { cacheReadTokens: 0 } } } as never);
    try {
      await run(f);
      expect(generateText).toHaveBeenCalledTimes(2);
      const verified = JSON.parse(f.bodies.get(prefix + "distill-verified.json") ?? "null");
      expect(verified.glossaryCandidates).toEqual(empty ? [] : [{ id: "G1", ...unit }]);
      expect(verified.evidence.map(({ label }: { label: string }) => label))
        .toEqual(empty ? ["[S1:1]"] : ["[S1:1]", "[S1:2]", "[S1:3]"]);
      if (!empty) expect(verified.dropped).toContainEqual({ index: 0, reason: "glossary-candidate-unsupported-output" });
      const call2 = vi.mocked(generateText).mock.calls[1]?.[0];
      const content = call2?.messages?.[0]?.content;
      if (!call2 || typeof content !== "string" || typeof call2.instructions !== "string") throw new Error("Fresh glossary request was not captured.");
      const context = JSON.parse(content);
      expect(context.glossaryCandidates).toEqual(empty ? [] : [{ id: "G1", ...unit, evidence: [
        { label: "[S1:2]", block: 2, quote: "The compact adapter uses 4 layers only for short sequences.\n" },
        { label: "[S1:3]", block: 3, quote: "The comparison concerns one request at a time, not large-batch throughput.\n" },
      ] }]);
      const marker = "Return one JSON object conforming to this schema: ";
      const schema = JSON.parse(call2.instructions.slice(call2.instructions.lastIndexOf(marker) + marker.length));
      expect(schema.required).toContain("supportedGlossary");
      expect(schema.properties).not.toHaveProperty("glossary");
      expect(schema.properties.supportedGlossary.maxItems).toBe(empty ? 0 : 1);
      const rawCall2 = JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null");
      expect(rawCall2.format).toBe("claim-plan-guide-v4");
      expect(JSON.parse(f.bodies.get(prefix + "glossary.json") ?? "null")).toEqual(empty ? [] : [{
        ...unit, labels: ["[R" + revisionId + ":2]", "[R" + revisionId + ":3]"],
      }]);
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
      expect(report).toMatchObject({ state: "done", kept: 1, questions });
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(true);
      expect(f.bodies.get(prefix + "text.md")).toBe(document.text);
    } finally { f.db.close(); }
  });

  it.each([
    { name: "missing", ids: undefined },
    { name: "unknown dropped G0", ids: ["G0"] },
    { name: "duplicate", ids: ["G1", "G1"] },
  ])("rejects $name fresh glossary selection without prose fallback", async ({ ids }) => {
    const document = documentWithBlocks([
      { type: "paragraph", text: "Method Alpha uses normalization.\n" },
      { type: "paragraph", text: "The method applies only to short sequences.\n" },
      { type: "paragraph", text: "The source notes a limitation.\n" },
    ]);
    const f = fixture(snapshot.route, document);
    const bytes = new TextEncoder().encode(document.text);
    const quote = (block: Block) => new TextDecoder().decode(bytes.subarray(block.start, block.end));
    const block1 = document.blocks[0];
    if (!block1) throw new Error("The glossary fixture requires a canonical first block.");
    const guide = [
      { labels: ["[S1:1]"], text: "The source describes Method Alpha." },
      { labels: ["[S1:2]"], text: "The method applies to short sequences." },
      { labels: ["[S1:3]"], text: "The source notes a limitation." },
    ];
    const unit = { labels: ["[S1:1]"], en: "Normalization", ru: "Нормализация", definition: "Метод Alpha использует нормализацию." };
    f.db.prepare("UPDATE source_revision SET distill_calls=2 WHERE id=?").run(revisionId);
    f.bodies.set(prefix + "distill-verified.json", JSON.stringify({
      claims: [{ kind: "method", statement: "Method Alpha uses normalization.", quote: quote(block1), block: block1.id,
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null,
        start: block1.start, end: block1.end, ambiguous: false, valueNumber: null }],
      guide, evidence: document.blocks.map((block) => ({ label: "[S1:" + block.id + "]", block: block.id, quote: quote(block) })),
      questions: ["What method?", "Which scope?", "What limitation?"], dropped: [], clearedNumbers: 0,
      glossaryCandidates: [{ id: "G1", ...unit }, { id: "G2", labels: ["[S1:2]"], en: "Short sequence", ru: "Короткая последовательность",
        definition: "Условие относится только к коротким последовательностям." }],
    }));
    const rawCall2 = JSON.stringify({ format: "claim-plan-glossary-v1",
      output: { supportedClaims: ["C0"], additionalClaims: [], guide, digestPlan: { methods: ["C0"], findings: [], limits: [] },
        ...(ids === undefined ? { glossary: [unit] } : { supportedGlossary: ids }) },
      usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 24, tokenLimit: 1000, providerUsage: null } });
    f.bodies.set(prefix + "distill-call2.json", rawCall2);
    try {
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
      const steps = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
        ["extract source", "verify source excerpts", "review and synthesize"].includes(name) ? undefined : callback());
      await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>, { do: steps } as unknown as WorkflowStep);
      expect(JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null").state).toBe("failed");
      expect(f.bodies.has(prefix + "glossary.json")).toBe(false);
      expect(f.bodies.has(prefix + "digest.md")).toBe(false);
      expect(f.bodies.get(prefix + "distill-call2.json")).toBe(rawCall2);
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it.each([
    { name: "plain", marker: "", closed: true },
    { name: "closed backtick", marker: String.fromCharCode(96).repeat(3), closed: true },
    { name: "open backtick", marker: String.fromCharCode(96).repeat(3), closed: false },
    { name: "closed tilde", marker: "~~~", closed: true },
    { name: "open tilde", marker: "~~~", closed: false },
  ])("preserves full curated digest scope and outside citation for $name", async ({ marker, closed }) => {
    const statementText = "WikiSQL validation accuracy is 73.4 at rank 4.";
    const conditionsText = "rank 4 on the validation split only";
    const authored = (text: string) => marker ? marker + "\n" + text + (closed ? "\n" + marker : "") : text;
    const statement = authored(statementText), conditions = authored(conditionsText);
    const document = documentWithBlocks([
      { type: "paragraph", text: statementText + " The scope is " + conditionsText + ".\n" },
      { type: "paragraph", text: "The source reports a result.\n" },
      { type: "paragraph", text: "The source notes a limitation.\n" },
    ]);
    const f = fixture(snapshot.route, document);
    const bytes = new TextEncoder().encode(document.text);
    const quote = (block: Block) => new TextDecoder().decode(bytes.subarray(block.start, block.end));
    const [block1, block2, block3] = document.blocks;
    if (!block1 || !block2 || !block3) throw new Error("Fixture requires three blocks.");
    const guide = [
      { labels: ["[S1:1]"], text: "The source reports WikiSQL validation accuracy." },
      { labels: ["[S1:2]"], text: "The source reports a result." },
      { labels: ["[S1:3]"], text: "The source notes a limitation." },
    ];
    const metadata = { task: "Validation accuracy", metric: "Accuracy", dataset: "WikiSQL", valueText: "73.4", unit: "%", conditions };
    const usage = { inputTokens: 12, cachedTokens: 0, outputTokens: 24, tokenLimit: 1000, providerUsage: null };
    f.db.prepare("UPDATE source_revision SET distill_calls=2 WHERE id=?").run(revisionId);
    f.bodies.set(prefix + "distill-call1.json", JSON.stringify({
      output: { claims: [{ quoteBlock: "[S1:1]", kind: "result", statement, ...metadata }], guide,
        questions: ["What result?", "What dataset?", "What scope?"] }, usage,
    }));
    f.bodies.set(prefix + "distill-verified.json", JSON.stringify({
      claims: [{ kind: "result", statement, quote: quote(block1), block: block1.id, ...metadata,
        start: block1.start, end: block1.end, ambiguous: false, valueNumber: 73.4 }],
      guide,
      evidence: [block1, block2, block3].map((block) => ({ label: "[S1:" + block.id + "]", block: block.id, quote: quote(block) })),
      questions: ["What result?", "What dataset?", "What scope?"], dropped: [], clearedNumbers: 0,
    }));
    f.bodies.set(prefix + "distill-call2.json", JSON.stringify({
      output: { supportedClaims: ["C0"], additionalClaims: [], guide,
        digestPlan: { methods: [], findings: ["C0"], limits: [] }, glossary: [] },
      format: "claim-plan-v1", usage,
    }));
    try {
      const steps = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
        ["extract source", "verify source excerpts", "review and synthesize"].includes(name) ? undefined : callback());
      await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>, { do: steps } as unknown as WorkflowStep);
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null") as { state: string; kept: number };
      expect(report).toMatchObject({ state: "done", kept: 1 });
      const digest = f.bodies.get(prefix + "digest.md") ?? "";
      expect(f.db.prepare("SELECT statement,conditions FROM claim WHERE source_revision_id=?").get(revisionId))
        .toEqual({ statement, conditions });
      const href = "/p/project/source/" + sourceId + "?revisionId=" + revisionId + "&start=" + block1.start + "&end=" + block1.end;
      const html = renderToStaticMarkup(createElement(MemoryRouter, null,
        createElement(Markdown, { text: digest, references: [{ text: "[R" + revisionId + ":1]", href, label: "Paper · 1" }] })));
      const dom = new JSDOM(html);
      try {
        const rendered = dom.window.document;
        expect(rendered.body.textContent).toContain(statementText);
        expect(rendered.body.textContent).toContain(conditionsText);
        expect(rendered.body.textContent).toContain("Dataset:");
        expect(rendered.body.textContent).toContain("WikiSQL");
        expect(rendered.body.textContent).toContain("73.4 %");
        expect(rendered.querySelectorAll("blockquote pre code")).toHaveLength(marker ? 2 : 0);
        const citations = rendered.querySelectorAll("a.er-citation");
        expect(citations).toHaveLength(1);
        expect(citations.item(0).getAttribute("href")).toBe(href);
        expect(citations.item(0).closest("pre,code,blockquote")).toBeNull();
      } finally { dom.window.close(); }
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });

  it("charges repeated call-two quote escaping before dispatch at the materialization boundary", async () => {
    const model = { ...snapshot, contextTokens: 10000000 };
    const prepare = (quote: string) => {
      const document = documentWithBlocks([{ type: "paragraph", text: quote }]);
      const f = fixture(model.route, document);
      f.db.prepare("UPDATE source_revision SET distill_calls=1 WHERE id=?").run(revisionId);
      f.bodies.set(prefix + "distill-verified.json", JSON.stringify({
        claims: Array.from({ length: 3 }, () => ({
          kind: "method", statement: "The method is retained.", quote, block: 1,
          task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null,
          start: 0, end: quote.length, ambiguous: false, valueNumber: null,
        })),
        guide: [], evidence: [{ label: "[S1:1]", block: 1, quote }], questions: [], dropped: [], clearedNumbers: 0,
      }));
      return f;
    };
    const synthesizeCached = async (f: ReturnType<typeof fixture>) => {
      const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
        name === "extract source" || name === "verify source excerpts" ? undefined : callback());
      await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { payload: { revisionId, model } } as WorkflowEvent<DistillInput>, { do: stepDo } as unknown as WorkflowStep);
    };

    const oversized = prepare("[]".repeat(50000));
    try {
      await synthesizeCached(oversized);
      expect(resolveModelTransport).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
      expect(oversized.dispatchCAS).not.toHaveBeenCalled();
      expect(oversized.db.prepare("SELECT distill_calls AS calls FROM source_revision WHERE id=?").get(revisionId)).toEqual({ calls: 1 });
    } finally { oversized.db.close(); }

    const fitting = prepare("[]".repeat(40000));
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(generateText).mockRejectedValueOnce(new Error("Stop after capturing the bounded request."));
    try {
      await synthesizeCached(fitting);
      expect(resolveModelTransport).toHaveBeenCalledTimes(1);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(fitting.dispatchCAS).toHaveBeenCalledTimes(1);
      const content = vi.mocked(generateText).mock.calls[0]?.[0].messages?.[0]?.content;
      if (typeof content !== "string") throw new Error("The fitting call-two context was not captured.");
      expect((JSON.parse(content) as { candidates: Array<{ quote: string }> }).candidates.map(({ quote }) => quote))
        .toEqual(Array(3).fill("[]".repeat(40000)));
    } finally { fitting.db.close(); }
  });

  it("passes the exact admitted context, reserve and checked date to transport without rediscovery", async () => {
    const f = fixture(snapshot.route);
    const original = structuredClone(snapshot);
    vi.mocked(resolveModelTransport).mockImplementation(async (env, model, affinity) => {
      expect(env).toBe(f.env); expect(model).toBe(snapshot); expect(affinity).toBe(`distill-${revisionId}`);
      expect(model).toEqual(original);
      expect(model).toMatchObject({ contextTokens: 262144, maxOutputTokens: null, outputReserveTokens: 8192,
        checkedOn: "2026-10-27" });
      expect(model).not.toHaveProperty("inputMicrousdPerMillion");
      expect(model).not.toHaveProperty("cachedMicrousdPerMillion");
      expect(model).not.toHaveProperty("outputMicrousdPerMillion");
      expect(f.dispatchCAS).not.toHaveBeenCalled();
      throw new Error("Fixture transport stopped before dispatch.");
    });
    try {
      const steps = await run(f);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      expect(resolveModelTransport).toHaveBeenCalledExactlyOnceWith(f.env, snapshot, `distill-${revisionId}`, { structuredOutput: true });
      expect(snapshot).toEqual(original);
      finished(f, "Source understanding failed.");
    } finally { f.db.close(); }
  });

  it("redacts synthetic status and dispatch details while preserving LibraryError text", async () => {
    const secret = "sk-live-distill-secret prompt=private source Authorization: Bearer secret-body";
    const statusFixture = callerFixture();
    const statusError = Object.assign(new Error(secret), { statusCode: 503, responseBody: secret, data: { message: secret } });
    statusFixture.db.prepare("UPDATE source_revision SET distill_state='running',distill_started_at=?,distill_calls=0 WHERE id=?")
      .run(Date.now() - 301_000, explicitlySelectedRevisionId);
    const statusEnv = { ...statusFixture.env, DISTILL: {
      get: vi.fn(async () => ({ status: async () => { throw statusError; } })),
      create: vi.fn(),
    } } as unknown as Env;
    try {
      await scheduleDistillation(statusEnv, explicitlySelectedRevisionId);
      const error = statusFixture.db.prepare("SELECT distill_error AS error FROM source_revision WHERE id=?")
        .get(explicitlySelectedRevisionId) as { error: string };
      expect(error.error).toContain("HTTP 503");
      expect(error.error).not.toContain("sk-live-distill-secret");
      expect(error.error).not.toContain("private source");
      expect(generateText).not.toHaveBeenCalled();
    } finally { statusFixture.db.close(); }

    const reportFixture = fixture(snapshot.route);
    const reportError = Object.assign(new Error(secret), { statusCode: 503, responseBody: secret });
    const failedStep = vi.fn(async () => { throw reportError; });
    try {
      await new DistillWorkflow({} as ExecutionContext, reportFixture.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>,
        { do: failedStep } as unknown as WorkflowStep);
      const reportBody = reportFixture.bodies.get(prefix + "distill.json");
      if (!reportBody) throw new Error("The workflow failure did not store its report.");
      const report = JSON.parse(reportBody) as DistillReport & { state: string };
      expect(report.error).toContain("HTTP 503");
      expect(JSON.stringify(report)).not.toContain("sk-live-distill-secret");
      const reportErrorRow = reportFixture.db.prepare("SELECT distill_error AS error FROM source_revision WHERE id=?")
        .get(revisionId) as { error: string };
      expect(reportErrorRow.error).toBe(report.error);
      expect(generateText).not.toHaveBeenCalled();
    } finally { reportFixture.db.close(); }

    const dispatchFixture = callerFixture();
    vi.mocked(requireAvailableModel).mockResolvedValue(snapshot);
    const dispatchError = Object.assign(new Error(secret), { statusCode: 502, responseBody: secret, data: { message: secret } });
    const dispatchEnv = { ...dispatchFixture.env, DISTILL: {
      get: vi.fn(), create: vi.fn().mockRejectedValue(dispatchError),
    } } as unknown as Env;
    try {
      await scheduleDistillation(dispatchEnv, explicitlySelectedRevisionId);
      const error = dispatchFixture.db.prepare("SELECT distill_error AS error FROM source_revision WHERE id=?")
        .get(explicitlySelectedRevisionId) as { error: string };
      expect(error.error).toContain("HTTP 502");
      expect(error.error).not.toContain("sk-live-distill-secret");
      expect(error.error).not.toContain("private source");
      expect(generateText).not.toHaveBeenCalled();
    } finally { dispatchFixture.db.close(); }

    const productFixture = fixture(snapshot.route);
    const productError = new LibraryError("unavailable", "The source has no citable content blocks.", 503);
    const failedProductStep = vi.fn(async () => { throw productError; });
    try {
      await new DistillWorkflow({} as ExecutionContext, productFixture.env).run(
        { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>,
        { do: failedProductStep } as unknown as WorkflowStep);
      const reportBody = productFixture.bodies.get(prefix + "distill.json");
      if (!reportBody) throw new Error("The product failure did not store its report.");
      expect((JSON.parse(reportBody) as DistillReport).error).toBe("The source has no citable content blocks.");
    } finally { productFixture.db.close(); }

    expect(generateText).not.toHaveBeenCalled();
    expect(resolveModelTransport).not.toHaveBeenCalled();
  });

  it.each([32768, 4096, null])("uses published %s for understanding generation independently of its reserve", async (capacity) => {
    const model = { ...snapshot, maxOutputTokens: capacity };
    const f = fixture(model.route);
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    const bound = modelTokenLimit(model);
    f.db.prepare("UPDATE source_revision SET distill_token_limit=?,distill_token_limit_kind=? WHERE id=?")
      .run(bound === null ? null : 2 * bound, bound === null ? "unknown" : "published", revisionId);
    try {
      await run(f, false, model);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(vi.mocked(generateText).mock.calls[0]?.[0].maxOutputTokens).toBe(capacity ?? undefined);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(1);
      expect(f.db.prepare("SELECT distill_calls FROM source_revision WHERE id=?").get(revisionId)).toEqual({ distill_calls: 1 });
    } finally { f.db.close(); }
  });

  it("retains a legacy admitted bound and per-call cap during replay with a larger published output capacity", async () => {
    const model = { ...snapshot, maxOutputTokens: 32768 };
    const f = fixture(model.route);
    const oldBound = 2 * (snapshot.contextTokens + 8192);
    f.db.prepare("UPDATE source_revision SET distill_token_limit=? WHERE id=?").run(oldBound, revisionId);
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    try {
      await run(f, false, model);
      expect(vi.mocked(generateText).mock.calls[0]?.[0].maxOutputTokens).toBe(8192);
      expect(f.db.prepare("SELECT distill_token_limit,distill_token_limit_kind FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ distill_token_limit: oldBound, distill_token_limit_kind: null });
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null") as DistillReport;
      expect(report.usage.tokenLimit).toBe(oldBound);
      expect(report.usage.tokenLimitKind).toBe("legacy");
      await run(f, false, model);
      expect(generateText).toHaveBeenCalledTimes(1);
    } finally { f.db.close(); }
  });

  it.each([
    { name: "fresh six-minute call", expired: true, remainingMs: 15 * 60_000, effectiveMs: 360_000 },
    { name: "only 60 seconds left in the absolute ceiling", expired: true, remainingMs: 60_000, effectiveMs: 60_000 },
    { name: "provider failure before its deadline", expired: false, remainingMs: 15 * 60_000, effectiveMs: 360_000 },
  ].flatMap(item => [false, true].map(native => ({ ...item, native }))))("classifies owned deadline expiry without changing history: $name native=$native", async ({ expired, remainingMs, effectiveMs, native }) => {
    vi.useFakeTimers();
    // Native Node AbortSignal.timeout does not use Vitest's fake clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Fixture local deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    const deliveryModel = native ? { ...snapshot, route: "workers-ai:fixture", id: "fixture" } : snapshot;
    const f = fixture(deliveryModel.route);
    const startedAt = Date.now() - 15 * 60_000 + remainingMs;
    f.db.prepare("UPDATE source_revision SET distill_started_at=? WHERE id=?").run(startedAt, revisionId);
    const historicalId = explicitlySelectedRevisionId;
    const historicalReportKey = prefix + "understanding/" + historicalId + "/distill.json";
    const historicalSnapshotKey = prefix + "understanding/" + historicalId + "/history/" + revisionId + ".json";
    const owningRow = f.db.prepare("SELECT * FROM source_revision WHERE id=?").get(revisionId);
    if (!owningRow) throw new Error("The owning revision fixture is missing.");
    const historicalSnapshot = JSON.stringify({ revision: { ...owningRow, distill_attempt_id: historicalId,
      distill_state: "failed", distill_calls: 1, distill_started_at: startedAt - 60_000 - 180091,
      distill_ms: 180091, distill_error: "Model stream failed.", distill_report_key: historicalReportKey,
      distill_token_limit: null, distill_token_limit_kind: "unknown", distill_estimated_cost_microusd: null,
      distill_pricing_checked_on: null }, claims: [] });
    const historicalReport = JSON.stringify({ state: "failed", error: "Model stream failed.", questions: [],
      kept: 0, dropped: [], clearedNumbers: 0, raw: { first: null, second: null },
      usage: { calls: 1, inputTokens: null, cachedTokens: null, outputTokens: null, wallMs: 180091,
        tokenLimit: null, tokenLimitKind: "unknown", providerUsage: [] } });
    f.bodies.set(historicalSnapshotKey, historicalSnapshot);
    f.bodies.set(historicalReportKey, historicalReport);
    f.db.prepare("INSERT INTO distill_history(attempt_id,source_revision_id,request_json,snapshot_key,archived_at) VALUES (?,?,NULL,?,?)")
      .run(historicalId, revisionId, historicalSnapshotKey, startedAt - 60_000);
    const historicalRow = f.db.prepare("SELECT * FROM distill_history WHERE attempt_id=?").get(historicalId);
    const privateText = "private-provider-response-and-request-marker";
    const wrapped = new Error("Wrapped stream failure " + privateText, {
      cause: Object.assign(new Error(privateText), { name: "TimeoutError" }),
    });
    let enter: () => void = () => undefined;
    const dispatched = new Promise<void>((resolve) => { enter = resolve; });
    let observedSignal: AbortSignal | undefined;
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(modelFailure).mockReturnValue("Model stream failed.");
    const reportedBeforeAbort = native && remainingMs === 60_000;
    const reportedUsage = { inputTokens: 71, outputTokens: 19, inputTokenDetails: { cacheReadTokens: 0 }, raw: { prompt_tokens: 71, completion_tokens: 19 } };
    if (native) vi.mocked(experimental_streamTextLowMemory).mockImplementationOnce(({ abortSignal, onChunk }) => ({
      consumeStream: async ({ onError }: { onError: (error: unknown) => void }) => {
        observedSignal = abortSignal; enter();
        if (!abortSignal) throw new Error("Native consumption must own its deadline signal.");
        if (reportedBeforeAbort) await onChunk?.({ chunk: { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: reportedUsage } } as never);
        await new Promise<void>(resolve => {
          const fail = () => { onError(wrapped); resolve(); };
          if (expired) abortSignal.addEventListener("abort", fail, { once: true }); else fail();
        });
      },
    } as never));
    else vi.mocked(generateText).mockImplementationOnce(({ abortSignal }) => {
      observedSignal = abortSignal;
      enter();
      if (!abortSignal) throw new Error("The actual call must own a deadline signal.");
      return new Promise<never>((_resolve, reject) => {
        if (expired) abortSignal.addEventListener("abort", () => reject(wrapped), { once: true });
        else reject(wrapped);
      });
    });
    try {
      const pending = run(f, true, deliveryModel);
      await dispatched;
      expect(timeout).toHaveBeenCalledExactlyOnceWith(effectiveMs);
      expect(observedSignal?.aborted).toBe(false);
      const callStartedAt = Date.now();
      if (expired) {
        await vi.advanceTimersByTimeAsync(effectiveMs - 1);
        expect(observedSignal?.aborted).toBe(false);
        expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls FROM source_revision WHERE id=?").get(revisionId))
          .toEqual({ state: "running", calls: 1 });
        await vi.advanceTimersByTimeAsync(1);
      }
      const steps = await pending;
      const failure = expired ? "Local model-call deadline expiry observed. No retry was started." : "Model stream failed.";
      expect(observedSignal?.aborted).toBe(expired);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      expect(steps.mock.calls[0]?.[1]).toMatchObject({ retries: { limit: 0 }, timeout: "7 minutes" });
      expect(native ? experimental_streamTextLowMemory : generateText).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ abortSignal: observedSignal, maxRetries: 0 }));
      expect(native ? generateText : experimental_streamTextLowMemory).not.toHaveBeenCalled();
      expect(f.dispatchCAS).toHaveBeenCalledTimes(1);
      expect(Date.now() - callStartedAt).toBe(expired ? effectiveMs : 0);
      if (expired) expect(modelFailure).not.toHaveBeenCalled();
      else expect(modelFailure).toHaveBeenCalledExactlyOnceWith(wrapped, deliveryModel);
      expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,distill_error AS error FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "failed", calls: 1, error: failure });
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
      expect(report).toMatchObject({ state: "failed", error: failure,
        usage: { calls: 1, inputTokens: reportedBeforeAbort ? 71 : null, cachedTokens: reportedBeforeAbort ? 0 : null, outputTokens: reportedBeforeAbort ? 19 : null, providerUsage: reportedBeforeAbort ? [reportedUsage.raw] : [],
          wallMs: 15 * 60_000 - remainingMs + (expired ? effectiveMs : 0) },
        raw: { first: reportedBeforeAbort ? prefix + "distill-call1.json" : null, second: null } });
      if (reportedBeforeAbort) expect(JSON.parse(f.bodies.get(prefix + "distill-call1.json") ?? "null"))
        .toMatchObject({ output: null, usage: { inputTokens: 71, outputTokens: 19 } });
      expect(f.db.prepare("SELECT distill_started_at FROM source_revision WHERE id=?").get(revisionId)).toEqual({ distill_started_at: startedAt });
      expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
      expect(f.bodies.get(historicalSnapshotKey)).toBe(historicalSnapshot);
      expect(f.bodies.get(historicalReportKey)).toBe(historicalReport);
      expect(f.db.prepare("SELECT * FROM distill_history WHERE attempt_id=?").get(historicalId)).toEqual(historicalRow);
      for (const body of f.bodies.values()) expect(body).not.toContain(privateText);
    } finally { f.db.close(); vi.clearAllTimers(); timeout.mockRestore(); vi.useRealTimers(); }
  });

  it("retains typed structured-output failure telemetry and cause across serialized steps", async () => {
    // Does not reproduce eval/out/openrouter-20261028/resnet-trace (generic External failure, distill-call2.json 404, unrecoverable).
    // It covers the proven pinned ai@7.0.152 shape in isolation: NoObjectGeneratedError carries usage/finishReason.
    const f = fixture(snapshot.route);
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    const rawProviderUsage = { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 };
    const sdkUsage = { inputTokens: 1200, inputTokenDetails: { noCacheTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: undefined }, outputTokens: 34, outputTokenDetails: { textTokens: 34, reasoningTokens: undefined }, totalTokens: 1234, raw: rawProviderUsage };
    const sdkError = new NoObjectGeneratedError({ message: "No object generated: response did not match schema.", text: '{"guide":', response: { id: "resp-typed-1", timestamp: new Date(), modelId: "fixture/admitted" }, usage: sdkUsage, finishReason: "length" });
    vi.mocked(generateText).mockRejectedValueOnce(sdkError);
    try {
      const steps = await run(f, true);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(1);
      const rawBody = f.bodies.get(prefix + "distill-call1.json");
      if (!rawBody) throw new Error("Typed failure did not retain its per-call artifact.");
      const stored = JSON.parse(rawBody) as { output: null; usage: { inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; tokenLimit: number | null; providerUsage: unknown } };
      expect(stored.output).toBeNull();
      expect(stored).not.toHaveProperty("error");
      expect(JSON.stringify(stored)).not.toContain('{"guide":');
      expect(stored.usage.inputTokens).toBe(1200);
      expect(stored.usage.cachedTokens).toBe(0);
      expect(stored.usage.outputTokens).toBe(34);
      expect(stored.usage.providerUsage).toMatchObject(rawProviderUsage);
      expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
      const reportBody = f.bodies.get(prefix + "distill.json");
      if (!reportBody) throw new Error("Missing distill.json for typed failure.");
      const report = JSON.parse(reportBody) as DistillReport & { state: string };
      expect(report.state).toBe("failed");
      expect(report.error).toBe("model reached output bound before complete output");
      expect(report.usage.calls).toBe(1);
      expect(report.usage.inputTokens).toBe(1200);
      expect(report.usage.outputTokens).toBe(34);
      expect(report.usage.providerUsage).toHaveLength(1);
      expect(report.kept).toBe(0);
      expect(JSON.stringify(report)).not.toContain('{"guide":');
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
      const row = f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,distill_error AS error FROM source_revision WHERE id=?").get(revisionId);
      expect(row).toEqual({ state: "failed", calls: 1, error: report.error });
    } finally { f.db.close(); }
  });

  it("preserves only the safe provider failure across a serialized step with unknown usage", async () => {
    const f = fixture(snapshot.route);
    const markers = ["sk-fixture-private-key", "private-header-marker", "private-request-body", "private-response-body"];
    const providerError = Object.assign(new Error(markers.join(" ")), {
      statusCode: 401, requestHeaders: { Authorization: `Bearer ${markers[0]}`, "x-private": markers[1] },
      requestBody: markers[2], responseBody: markers[3],
    });
    const failure = "External model request failed (HTTP 401). Check the Gateway connection and provider status; no retry was started.";
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(generateText).mockRejectedValueOnce(providerError);
    vi.mocked(modelFailure).mockReturnValueOnce(failure);
    try {
      const steps = await run(f, true);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      expect(steps.mock.calls[0]?.[1]).toMatchObject({ retries: { limit: 0 } });
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
      expect(f.dispatchCAS).toHaveBeenCalledTimes(1);
      expect(modelFailure).toHaveBeenCalledExactlyOnceWith(providerError, snapshot);
      const row = f.db.prepare(`SELECT distill_state AS state,distill_calls AS calls,distill_error AS error,
        distill_input_tokens AS inputTokens,distill_cached_tokens AS cachedTokens,distill_output_tokens AS outputTokens
        FROM source_revision WHERE id=?`).get(revisionId);
      expect(row).toEqual({ state: "failed", calls: 1, error: failure, inputTokens: null, cachedTokens: null, outputTokens: null });
      const reportBody = f.bodies.get(prefix + "distill.json");
      if (!reportBody) throw new Error("Missing distill.json for provider failure.");
      const report = JSON.parse(reportBody) as DistillReport & { state: string };
      expect(report).toMatchObject({ state: "failed", error: failure, kept: 0,
        usage: { calls: 1, inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: null, providerUsage: [] },
        raw: { first: null, second: null } });
      for (const marker of markers) {
        expect(JSON.stringify(row)).not.toContain(marker);
        for (const body of f.bodies.values()) expect(body).not.toContain(marker);
      }
      expect(f.bodies.has(prefix + "distill-call1.json")).toBe(false);
      expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
    } finally { f.db.close(); }
  });

  it("keeps known-zero token counts and historical cost for zero-call failure", async () => {
    const f = fixture(snapshot.route);
    vi.mocked(resolveModelTransport).mockRejectedValueOnce(new Error("Fixture transport stopped before dispatch."));
    try {
      const steps = await run(f);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      const body = f.bodies.get(prefix + "distill.json");
      if (!body) throw new Error("Missing distill.json for zero-call failure.");
      const report = JSON.parse(body) as DistillReport & { state: string };
      expect(report.usage.calls).toBe(0);
      expect(report.usage.inputTokens).toBe(0);
      expect(report.usage.cachedTokens).toBe(0);
      expect(report.usage.outputTokens).toBe(0);
      expect(report.usage.tokenLimit).toBeNull();
      expect(report.usage).not.toHaveProperty("estimatedCostMicrousd");
      const row = f.db.prepare("SELECT distill_input_tokens AS inputTokens, distill_cached_tokens AS cachedTokens, distill_output_tokens AS outputTokens, distill_token_limit AS tokenLimit, distill_estimated_cost_microusd AS cost FROM source_revision WHERE id=?").get(revisionId) as { inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; tokenLimit: number | null; cost: number | null };
      expect(row.inputTokens).toBe(0);
      expect(row.cachedTokens).toBe(0);
      expect(row.outputTokens).toBe(0);
      expect(row.tokenLimit).toBeNull();
      expect(row.cost).toBe(322766);
      expect(generateText).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
});

describe("compact K3 producer", () => {
  it.each(["valid", "absent", "object", "over-five", "empty", "unselected-guide", "unknown-id", "extra-decision-field", "duplicate", "missing-kind"] as const)(
    "uses closed generation schemas and existing decoding through both real Gateway SDK calls: %s", async mode => {
      const model: ModelSpec = Object.freeze({ route: "gateway:openrouter/stealth/crouton-alpha", id: "stealth/crouton-alpha", label: "Frozen OpenRouter fixture",
        contextTokens: 1048576, contextWindowTokens: 1048576, maxOutputTokens: 943718, outputReserveTokens: 8192,
        responseFormat: true, structuredOutputs: true, structuredReasoningEffort: "minimal", checkedOn: "2026-11-08", enabled: true,
        routing: { provider: { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1",
          baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny", enabled: true }, gatewayId: "offline-compact" } } satisfies ModelSpec);
      const document = documentWithBlocks([
        { type: "paragraph", text: "A projection update preserves the residual path.\n" },
        { type: "paragraph", text: "The update uses 4 layers.\n" },
        { type: "paragraph", text: "The method assumes the sampled corpus remains stable.\n" },
      ]);
      const extraction = { candidates: [
        { quoteBlock: "[S1:1]", ...(mode === "missing-kind" ? {} : { kind: "method" }), statement: "A projection update preserves the residual path." },
        { quoteBlock: "[S1:2]", kind: "method", statement: "The update uses 4 layers." },
        { quoteBlock: "[S1:3]", kind: "limitation", statement: "The method assumes the sampled corpus remains stable." },
      ] };
      const review = { metadata: "UNTRUSTED_REVIEW_METADATA", selected: [
        { candidateId: mode === "unknown-id" ? "C999" : "C0", reason: "The bound quote states this mechanism.",
          ...(mode === "extra-decision-field" ? { extra: "UNTRUSTED_DECISION_FIELD" } : {}) },
        { candidateId: "C2", reason: "The bound quote states this assumption." },
      ], rejected: [{ candidateId: mode === "duplicate" ? "C0" : "C1", reason: "Not selected for this core." }],
      ...(mode === "absent" ? {} : { guide: mode === "object" ? { candidateIds: ["C0"] }
        : mode === "over-five" ? ["C0", "C2", "C0", "C2", "C0", "C2"] : mode === "empty" ? []
          : mode === "unselected-guide" ? ["C1"] : ["C0", "C2"] }) };
      const f = fixture(model.route, document);
      f.db.prepare("UPDATE source_revision SET distill_request_json=?,distill_token_limit_kind='published',distill_token_limit=? WHERE id=?")
        .run(JSON.stringify({ sourceId, revisionId, model: model.route, producerFormat: "compact-k3-v1" }), 2 * 1048576, revisionId);
      const sdk = await vi.importActual<typeof AISDK>("ai");
      const transport = await vi.importActual<typeof ModelTransport>("../model-transport");
      const failures: unknown[] = [];
      vi.mocked(generateText).mockImplementation(async options => {
        try { return await sdk.generateText(options); } catch (error) { failures.push(error); throw error; }
      });
      vi.mocked(resolveModelTransport).mockImplementation(transport.resolveModelTransport);
      vi.mocked(Output.object).mockReset().mockImplementation(options => sdk.Output.object(options));
      type SchemaNode = { type?: string; properties?: Record<string, SchemaNode>; required?: string[];
        additionalProperties?: boolean; items?: SchemaNode; enum?: string[]; minItems?: number; maxItems?: number };
      const bodies: { model: string; max_tokens: number; reasoning: unknown; reasoning_effort?: unknown;
        provider: unknown; response_format: { type: string; json_schema: { strict: boolean; schema: SchemaNode } } }[] = [];
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        const output = bodies.length === 1 ? extraction : review;
        return Response.json({ id: "chatcmpl-offline-compact", object: "chat.completion", created: 0, model: model.id,
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 101, completion_tokens: 17, total_tokens: 118 } });
      });
      Object.assign(f.env, { AI: { fetch } });
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
      try {
        await run(f, false, model, "compact-k3-v1");
        expect(fetch).toHaveBeenCalledTimes(2); expect(f.dispatchCAS).toHaveBeenCalledTimes(2);
        expect(bodies.map(body => body.model)).toEqual([model.id, model.id]);
        expect(bodies.map(body => body.max_tokens)).toEqual([8192, 4096]);
        for (const body of bodies) {
          expect(body.reasoning).toEqual({ effort: "minimal" }); expect(body).not.toHaveProperty("reasoning_effort");
          expect(body.provider).toMatchObject({ allow_fallbacks: false, require_parameters: true, data_collection: "deny" });
          expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
          const root = body.response_format.json_schema.schema;
          expect(root.additionalProperties).toBe(false);
          expect(root.required).toEqual(Object.keys(root.properties ?? {}));
        }
        const first = bodies[0]?.response_format.json_schema.schema;
        expect(first?.required).toEqual(["candidates"]);
        expect(first?.properties?.candidates?.maxItems).toBe(32);
        const candidate = first?.properties?.candidates?.items;
        expect(candidate?.required).toEqual(["quoteBlock", "kind", "statement"]);
        expect(candidate?.additionalProperties).toBe(false);
        expect(candidate?.properties?.kind?.enum).toEqual(["method", "result", "limitation", "dataset", "definition", "other"]);
        const second = bodies[1]?.response_format.json_schema.schema;
        expect(second?.required).toEqual(["selected", "rejected", "guide"]);
        expect(second?.properties?.guide).toMatchObject({ type: "array", minItems: 0, maxItems: 5,
          items: { type: "string", enum: ["C0", "C1", "C2"] } });
        for (const field of ["selected", "rejected"]) {
          const decision = second?.properties?.[field]?.items;
          expect(decision?.required).toEqual(["candidateId", "reason"]); expect(decision?.additionalProperties).toBe(false);
          expect(decision?.properties?.candidateId?.enum).toEqual(["C0", "C1", "C2"]);
        }
        const invalidDecision = ["unknown-id", "extra-decision-field", "duplicate"].includes(mode);
        const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
        expect(report).toMatchObject({ state: invalidDecision ? "failed" : ["valid", "missing-kind"].includes(mode) ? "done" : "partial",
          kept: invalidDecision ? 0 : 2, usage: { calls: 2, outputBudgets: [
            { requestedTokens: 8192, appliedTokens: 8192 }, { requestedTokens: 4096, appliedTokens: 4096 },
          ] } });
        if (mode === "unknown-id" || mode === "extra-decision-field") {
          const error = failures[0];
          if (!sdk.NoObjectGeneratedError.isInstance(error) || !sdk.TypeValidationError.isInstance(error.cause))
            throw new Error("The actual SDK did not preserve its schema-validation cause.");
          expect(error.cause.cause).toBeInstanceOf(z.ZodError);
          expect(JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null").output).toBeNull();
        } else expect(failures).toEqual([]);
        const rawFirst = f.bodies.get(prefix + "distill-call1.json"), rawSecond = f.bodies.get(prefix + "distill-call2.json");
        expect(JSON.parse(rawFirst ?? "null").output).toEqual(extraction);
        const view = await getUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId });
        expect(view.claims).toHaveLength(invalidDecision ? 0 : 2);
        if (!invalidDecision) {
          expect(view.claims.map(claim => claim.statement)).toEqual([extraction.candidates[0]?.statement, extraction.candidates[2]?.statement]);
          expect(view.digest).toContain(extraction.candidates[0]?.statement);
          if (!["valid", "missing-kind"].includes(mode)) expect(view.guide).toBe("");
          expect(JSON.stringify(view)).not.toContain("UNTRUSTED_REVIEW_METADATA");
          if (mode === "missing-kind") {
            expect(JSON.parse(rawFirst ?? "null").output.candidates[0]).not.toHaveProperty("kind");
            expect(view.claims[0]?.kind).toBe("other");
            await requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId, saveAvailable: true });
            expect(f.bodies.get(prefix + "distill-call1.json")).toBe(rawFirst);
            expect(f.bodies.get(prefix + "distill-call2.json")).toBe(rawSecond);
            expect(fetch).toHaveBeenCalledTimes(2);
          }
        }
        for (const lookup of forbiddenLookups) expect(lookup).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
      } finally { vi.mocked(Output.object).mockReset(); network.mockRestore(); f.db.close(); }
    });

  it("retains all 61 native candidates, strips outer metadata and keeps prefix output partial after Recheck", async () => {
    const metadata = "OUTER_METADATA_MUST_NOT_REACH_OWNER_OUTPUT";
    const longReason = "The bound source block states this complete configuration with its original condition, and selection keeps the frozen statement unchanged. ".repeat(2).trim();
    const document = documentWithBlocks(Array.from({ length: 61 }, (_, index) => ({ type: "paragraph" as const,
      text: `Configuration ${index + 1} preserves the residual path through ${index + 1} projection layers.\n` })));
    const extraction = { $schema: "https://schema.invalid/" + metadata, extraMetadata: { note: metadata },
      candidates: document.blocks.map((block, index) => ({ quoteBlock: `[S1:${block.id}]`,
      kind: "method" as const, statement: `Configuration ${index + 1} preserves the residual path through ${index + 1} projection layers.` })) };
    const review = { $schema: "https://schema.invalid/" + metadata, extraMetadata: { note: metadata },
      selected: extraction.candidates.slice(0, 32).map((_, index) => ({ candidateId: `C${index}`,
      reason: index === 0 ? longReason : "The bound source block states this complete configuration." })), rejected: [], guide: ["C0", "C1", "C2"] };
    const tailDrops = Array.from({ length: 29 }, (_, index) => ({ index: index + 32, reason: "unreviewed-work-limit" }));
    const model: ModelSpec = { ...snapshot, route: "workers-ai:@cf/zai-org/glm-5.3-flash",
      id: "@cf/zai-org/glm-5.3-flash", nativeReasoningEffort: "low" };
    const f = fixture(model.route, document);
    f.db.prepare("UPDATE source_revision SET distill_request_json=?,distill_token_limit_kind='unknown',distill_token_limit=NULL WHERE id=?")
      .run(JSON.stringify({ sourceId, revisionId, model: model.route, producerFormat: "compact-k3-v1" }), revisionId);
    const sdk = await vi.importActual<typeof AISDK>("ai");
    const transport = await vi.importActual<typeof ModelTransport>("../model-transport");
    vi.mocked(experimental_streamTextLowMemory).mockImplementation(sdk.experimental_streamTextLowMemory);
    vi.mocked(resolveModelTransport).mockImplementation(transport.resolveModelTransport);
    vi.mocked(Output.json).mockReset(); vi.mocked(Output.object).mockReset();
    let jsonParses = 0, objectParses = 0, bindingCalls = 0;
    const caps: unknown[] = [];
    vi.mocked(Output.json).mockImplementation(options => {
      const spec = sdk.Output.json(options);
      return { ...spec, parseCompleteOutput: (...args: Parameters<typeof spec.parseCompleteOutput>) => {
        jsonParses++; return spec.parseCompleteOutput(...args);
      } };
    });
    vi.mocked(Output.object).mockImplementation(options => {
      const spec = sdk.Output.object(options);
      return { ...spec, parseCompleteOutput: (...args: Parameters<typeof spec.parseCompleteOutput>) => {
        objectParses++; return spec.parseCompleteOutput(...args);
      } };
    });
    Object.assign(f.env, { AI: { run: async (modelId: string, inputs: Record<string, unknown>) => {
      expect(modelId).toBe(model.id); expect(inputs.stream).toBe(true);
      expect(inputs).not.toHaveProperty("response_format"); caps.push(inputs.max_tokens);
      const output = bindingCalls++ === 0 ? extraction : review;
      const frame = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
      return new Response(frame({ choices: [{ index: 0, delta: { content: JSON.stringify(output) }, finish_reason: null }] })
        + frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        + frame({ choices: [], usage: { prompt_tokens: 101, completion_tokens: 17, total_tokens: 118 } })
        + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } } });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
    try {
      await run(f, false, model, "compact-k3-v1");
      expect(bindingCalls).toBe(2); expect(caps).toEqual([8192, 4096]);
      expect(jsonParses).toBe(1); expect(objectParses).toBe(1);
      expect(Output.json).toHaveBeenCalledTimes(1); expect(Output.object).toHaveBeenCalledTimes(1);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(2); expect(generateText).not.toHaveBeenCalled();
      for (const [request] of vi.mocked(experimental_streamTextLowMemory).mock.calls)
        expect(request).toMatchObject({ maxRetries: 0, streamRetries: 0 });
      const firstRequest = vi.mocked(experimental_streamTextLowMemory).mock.calls[0]?.[0];
      const marker = "Return one JSON object conforming to this schema: ";
      const instructions = String(firstRequest?.instructions);
      const promptSchema = JSON.parse(instructions.slice(instructions.lastIndexOf(marker) + marker.length));
      expect(promptSchema.properties.candidates.maxItems).toBe(32);
      const messages = vi.mocked(experimental_streamTextLowMemory).mock.calls[1]?.[0].messages;
      const payload = JSON.parse(String((messages?.[0] as { content: string }).content)) as {
        evidence: { candidates: { id: string }[] }[];
      };
      const groupedIds = payload.evidence.flatMap(({ candidates }) => candidates.map((c) => c.id));
      expect(groupedIds).toEqual(Array.from({ length: 32 }, (_, index) => `C${index}`));
      expect(JSON.stringify(messages)).not.toContain(metadata);
      const reviewSchema = vi.mocked(Output.object).mock.calls[0]?.[0].schema as z.ZodType;
      expect(reviewSchema.safeParse({ selected: [{ candidateId: "C32", reason: "Not offered for review." }], rejected: [], guide: [] }).success).toBe(false);
      const rawFirst = f.bodies.get(prefix + "distill-call1.json");
      const rawSecond = f.bodies.get(prefix + "distill-call2.json");
      expect(JSON.parse(rawFirst ?? "null").output).toEqual(extraction);
      expect(JSON.parse(rawSecond ?? "null").output).toEqual({ selected: review.selected, rejected: review.rejected, guide: review.guide });
      expect(longReason.length).toBeGreaterThan(160);
      expect(JSON.parse(rawSecond ?? "null").output.selected[0].reason).toBe(longReason);
      const verified = JSON.parse(f.bodies.get(prefix + "distill-verified.json") ?? "null");
      expect(verified).toMatchObject({ dropped: tailDrops });
      expect(verified.candidates).toHaveLength(32);
      const report = f.bodies.get(prefix + "distill.json");
      expect(JSON.parse(report ?? "null")).toMatchObject({ state: "partial", kept: 32,
        dropped: expect.arrayContaining(tailDrops), usage: { calls: 2 } });
      const view = await getUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId });
      expect(view.state).toBe("partial");
      expect(view.claims.map(claim => claim.statement)).toEqual(extraction.candidates.slice(0, 32).map(candidate => candidate.statement));
      expect(view.guide).toContain(extraction.candidates[0]?.statement);
      expect(view.digest).toContain(extraction.candidates[31]?.statement);
      expect(view.digest).not.toContain(extraction.candidates[32]?.statement);
      expect(JSON.stringify({ guide: view.guide, digest: view.digest, claims: view.claims })).not.toContain(longReason);
      expect(JSON.stringify({ guide: view.guide, digest: view.digest, claims: view.claims, report: view.report })).not.toContain(metadata);
      await requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId, saveAvailable: true });
      const rechecked = await getUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId });
      expect(rechecked.state).toBe("partial"); expect(rechecked.claims).toHaveLength(32);
      expect(JSON.parse(f.bodies.get(prefix + "checked/distill.json") ?? "null")).toMatchObject({ state: "partial", kept: 32 });
      expect(rechecked.claims.map(claim => claim.statement)).toEqual(view.claims.map(claim => claim.statement));
      expect(rechecked.guide).toBe(view.guide); expect(rechecked.digest).toBe(view.digest);
      expect(rechecked.report?.dropped).toEqual(expect.arrayContaining(tailDrops));
      expect(f.bodies.get(prefix + "distill-call1.json")).toBe(rawFirst);
      expect(f.bodies.get(prefix + "distill-call2.json")).toBe(rawSecond);
      expect(f.bodies.get(prefix + "distill.json")).toBe(report);
      expect(bindingCalls).toBe(2); expect(network).not.toHaveBeenCalled();
    } finally { vi.mocked(Output.json).mockReset(); vi.mocked(Output.object).mockReset(); network.mockRestore(); f.db.close(); }
  });

  it("retains the safe compact verification reason when Workflow reconstruction replaces the error prototype", async () => {
    const model: ModelSpec = { ...snapshot, route: "workers-ai:fixture", id: "fixture" };
    const f = fixture(model.route);
    f.db.prepare("UPDATE source_revision SET distill_request_json=? WHERE id=?")
      .run(JSON.stringify({ sourceId, revisionId, model: model.route, producerFormat: "compact-k3-v1" }), revisionId);
    const privatePayload = "PRIVATE_INVALID_CANDIDATES_VALUE";
    const privateRawError = "PRIVATE_RECONSTRUCTED_ERROR_TEXT";
    const extraction = { $schema: "https://schema.invalid/fixture", candidates: privatePayload };
    const usage = { inputTokens: 41, inputTokenDetails: { cacheReadTokens: 0 }, outputTokens: 9,
      raw: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 } };
    const safeReason = "The retained compact extraction candidates are not an array.";
    let reconstructions = 0;
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(experimental_streamTextLowMemory).mockImplementation(options => ({ consumeStream: async () => {
      await options.onChunk?.({ chunk: { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage } } as never);
      await options.onEnd?.({ output: extraction, totalUsage: usage } as never);
    } } as never));
    const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
      try { return await callback(); }
      catch (error) {
        if (name !== "verify source excerpts") throw error;
        expect(error).toBeInstanceOf(LibraryError);
        expect(f.db.prepare("SELECT distill_error AS error,distill_calls AS calls,distill_state AS state FROM source_revision WHERE id=?").get(revisionId))
          .toEqual({ error: safeReason, calls: 1, state: "running" });
        const reconstructed = new Error(privateRawError);
        expect(reconstructed).not.toBeInstanceOf(LibraryError);
        reconstructions++;
        throw reconstructed;
      }
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
    try {
      await new DistillWorkflow({} as ExecutionContext, f.env).run(
        { timestamp: new Date(), instanceId: `distill-${revisionId}`, workflowName: "DistillWorkflow",
          payload: { revisionId, model, producerFormat: "compact-k3-v1" } },
        { do: stepDo } as unknown as WorkflowStep);
      expect(reconstructions).toBe(1);
      expect(stepDo.mock.calls.map(([name]) => name)).toEqual(["extract source", "verify source excerpts"]);
      expect(experimental_streamTextLowMemory).toHaveBeenCalledTimes(1); expect(generateText).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,claim_count AS count,distill_error AS error FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "failed", calls: 1, count: 0, error: safeReason });
      const raw = JSON.parse(f.bodies.get(prefix + "distill-call1.json") ?? "null");
      expect(raw.output).toEqual(extraction);
      expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
      expect(f.bodies.has(prefix + "digest.md")).toBe(false);
      const report = f.bodies.get(prefix + "distill.json") ?? "null";
      expect(JSON.parse(report)).toMatchObject({ state: "failed", error: safeReason, kept: 0, usage: { calls: 1 } });
      expect(report).not.toContain(privatePayload); expect(report).not.toContain(privateRawError);
      const view = await getUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId });
      expect(view.state).toBe("failed"); expect(view.error).toBe(safeReason); expect(view.claims).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); f.db.close(); }
  });

  it("sends a unique evidence dictionary, keeps reviewed claims and digest when guide IDs include rejected or unreported candidates", async () => {
    const document = documentWithBlocks([
      { type: "paragraph", text: "A low-rank update changes the projection weights in each layer.\n" },
      { type: "paragraph", text: "The report records 92.5% accuracy on the held-out corpus.\n" },
      { type: "paragraph", text: "The method assumes the sampled corpus remains stable.\n" },
    ]);
    const model: ModelSpec = { ...snapshot, route: "workers-ai:fixture", id: "fixture", maxOutputTokens: null };
    const f = fixture(model.route, document);
    f.db.prepare("UPDATE source_revision SET distill_request_json=? WHERE id=?")
      .run(JSON.stringify({ sourceId, revisionId, model: model.route, producerFormat: "compact-k3-v1" }), revisionId);
    const extraction = { candidates: [
      { quoteBlock: "[S1:1]", kind: "method", statement: "The low-rank update changes projection weights." },
      { quoteBlock: "[S1:2]", kind: "result", statement: "Accuracy on the held-out corpus is reported at 92.5%." },
      { quoteBlock: "[S1:1]", kind: "method", statement: "The update changes weights in every layer." },
      { quoteBlock: "[S1:3]", kind: "limitation", statement: "The method assumes a stable sampled corpus." },
    ] };
    const review = { selected: [
      { candidateId: "C0", reason: "The linked block states the update mechanism." },
      { candidateId: "C1", reason: "The linked block gives the same accuracy value and condition." },
    ], rejected: [{ candidateId: "C2", reason: "This repeats the first candidate." }], guide: ["C0", "C2", "C3"] };
    const usage = { inputTokens: 101, inputTokenDetails: { cacheReadTokens: 0 }, outputTokens: 17,
      outputTokenDetails: { textTokens: 17 }, totalTokens: 118,
      raw: { prompt_tokens: 101, completion_tokens: 17, total_tokens: 118 } };
    let ordinal = 0;
    const requests: { maxOutputTokens?: number; instructions?: string; messages?: unknown }[] = [];
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(experimental_streamTextLowMemory).mockImplementation((options) => {
      const output = ordinal++ === 0 ? extraction : review;
      const captured = options as unknown as { maxOutputTokens?: number; instructions?: string; messages?: unknown;
        onChunk?: (event: never) => Promise<void> | void; onEnd?: (event: never) => Promise<void> | void };
      requests.push(captured);
      return { consumeStream: async () => {
        await captured.onChunk?.({ chunk: { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage } } as never);
        await captured.onEnd?.({ output, totalUsage: usage } as never);
      } } as never;
    });
    try {
      const steps = await run(f, false, model, "compact-k3-v1");
      expect(steps.mock.calls.map(([name]) => name)).toEqual([
        "extract source", "verify source excerpts", "review and synthesize", "store understanding", "finish understanding",
      ]);
      expect(requests.map((request) => request.maxOutputTokens)).toEqual([8192, 4096]);

      const first = requests[0];
      if (!first || typeof first.instructions !== "string") throw new Error("The compact extraction request was not captured.");
      const schemaMarker = "Return one JSON object conforming to this schema: ";
      const schemaAt = first.instructions.lastIndexOf(schemaMarker);
      const firstSchema = JSON.parse(first.instructions.slice(schemaAt + schemaMarker.length)) as {
        properties?: { candidates?: { items?: { properties?: Record<string, unknown> } } };
      };
      expect(Object.keys(firstSchema.properties ?? {})).toEqual(["candidates"]);
      expect(Object.keys(firstSchema.properties?.candidates?.items?.properties ?? {})).toEqual(["quoteBlock", "kind", "statement"]);
      const firstMessages = first.messages as { role: string; content: unknown }[];
      expect(firstMessages[1]?.content).not.toContain("The glossary must");
      expect(firstMessages[1]?.content).not.toContain("Write the guide, questions");

      const second = requests[1];
      if (!second) throw new Error("The compact review request was not captured.");
      const secondMessages = second.messages as { role: string; content: unknown }[];
      if (typeof secondMessages[0]?.content !== "string") throw new Error("The compact review context was not JSON text.");
      const payload = JSON.parse(secondMessages[0].content) as {
        evidence: { id: string; label: string; quote: string;
          candidates: { id: string; kind: string; statement: string }[] }[];
      };
      expect(payload.evidence).toHaveLength(3);
      // Each unique evidence appears exactly once, with its nested candidates.
      // Surviving flat order is C0(E0), C1(E1), C2(E0), C3(E2): interleaved
      // same-evidence candidates (C0 and C2 share E0) and a stable E0/E1/E2 gap.
      const quotes = payload.evidence.map(({ quote }) => quote);
      expect(new Set(quotes).size).toBe(3);
      expect(payload.evidence.map(({ id }) => id)).toEqual(["E0", "E1", "E2"]);
      expect(payload.evidence[0]?.candidates.map(({ id }) => id)).toEqual(["C0", "C2"]);
      expect(payload.evidence[1]?.candidates.map(({ id }) => id)).toEqual(["C1"]);
      expect(payload.evidence[2]?.candidates.map(({ id }) => id)).toEqual(["C3"]);
      // Nested candidate IDs/statements/kinds match call-one order within group,
      // while final publication preserves original candidate order (verified below).
      expect(payload.evidence[0]?.candidates).toEqual([
        { id: "C0", kind: "method", statement: "The low-rank update changes projection weights." },
        { id: "C2", kind: "method", statement: "The update changes weights in every layer." },
      ]);
      expect(payload.evidence[1]?.candidates).toEqual([
        { id: "C1", kind: "result", statement: "Accuracy on the held-out corpus is reported at 92.5%." },
      ]);
      expect(payload.evidence[2]?.candidates).toEqual([
        { id: "C3", kind: "limitation", statement: "The method assumes a stable sampled corpus." },
      ]);
      // No top-level candidates array / dangling joins, no duplicated quotes.
      expect((payload as Record<string, unknown>).candidates).toBeUndefined();
      expect(payload.evidence.flatMap(({ candidates }) => candidates.map(({ id }) => id)))
        .toEqual(["C0", "C2", "C1", "C3"]);
      const sourceBytes = new TextEncoder().encode(document.text);
      expect(quotes).toEqual(document.blocks.map((block) =>
        new TextDecoder().decode(sourceBytes.slice(block.start, block.end))));

      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null") as DistillReport & { state: string; producerFormat?: string };
      expect(report.state).toBe("partial");
      expect(report.producerFormat).toBe("compact-k3-v1");
      expect(report.questions).toEqual([]);
      expect(report.usage.outputBudgets).toEqual([
        { requestedTokens: 8192, appliedTokens: 8192 }, { requestedTokens: 4096, appliedTokens: 4096 },
      ]);
      expect(report.dropped).toEqual(expect.arrayContaining([
        { index: 2, reason: "review-rejected: This repeats the first candidate." },
        { index: 3, reason: "review-reason-unknown" },
        { index: 4, reason: "guide-invalid-selection" },
      ]));
      expect(f.db.prepare("SELECT claim_count AS count,guide_summary AS summary FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ count: 2, summary: null });
      expect(f.bodies.get(prefix + "guide.md")).toBe("");
      expect(f.bodies.get(prefix + "digest.md")).toContain("92.5%");
      expect(JSON.parse(f.bodies.get(prefix + "glossary.json") ?? "null")).toEqual([]);

      const view = await getUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId });
      expect(view.state).toBe("partial");
      expect(view.canRecover).toBe(true);
      expect(view.guide).toBe("");
      expect(view.digest).toContain("92.5%");
      expect(view.claims).toHaveLength(2);
      expect(view.report?.producerFormat).toBe("compact-k3-v1");
      await requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId, saveAvailable: true });
      expect(experimental_streamTextLowMemory).toHaveBeenCalledTimes(2);
      expect(f.db.prepare("SELECT distill_state AS state,claim_count AS count FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "partial", count: 2 });
    } finally { f.db.close(); }
  });

  it("does not promote call-one drafts when call-two JSON is invalid", async () => {
    const document = documentWithBlocks([{ type: "paragraph", text: "A projection update preserves the residual path.\n" }]);
    const f = fixture(snapshot.route, document);
    f.db.prepare("UPDATE source_revision SET distill_request_json=? WHERE id=?")
      .run(JSON.stringify({ sourceId, revisionId, model: snapshot.route, producerFormat: "compact-k3-v1" }), revisionId);
    const extraction = { candidates: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The projection update preserves a residual path." }] };
    const usage = { inputTokens: 41, inputTokenDetails: { noCacheTokens: 41, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokens: 9,
      outputTokenDetails: { textTokens: 9, reasoningTokens: undefined }, totalTokens: 50,
      raw: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 } };
    const invalidText = '{"selected":[{"candidateId":"C0","reason":"private malformed result"}';
    const invalid = new NoObjectGeneratedError({ message: "Invalid JSON from provider.", text: invalidText,
      response: { id: "fixture-invalid-json", timestamp: new Date(), modelId: "fixture/admitted" }, usage, finishReason: "stop" });
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(generateText)
      .mockResolvedValueOnce({ output: extraction, totalUsage: usage } as never)
      .mockRejectedValueOnce(invalid);
    try {
      const steps = await run(f, false, snapshot, "compact-k3-v1");
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source", "verify source excerpts", "review and synthesize"]);
      expect(f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,claim_count AS count FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "failed", calls: 2, count: 0 });
      expect(f.bodies.has(prefix + "guide.md")).toBe(false);
      expect(f.bodies.has(prefix + "digest.md")).toBe(false);
      const rawFirst = JSON.parse(f.bodies.get(prefix + "distill-call1.json") ?? "null");
      const rawSecond = JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null");
      expect(rawFirst).toMatchObject({ format: "compact-k3-v1", output: extraction });
      expect(rawSecond).toMatchObject({ format: "compact-k3-v1", output: null,
        usage: { outputBudget: { requestedTokens: 4096, appliedTokens: 4096 } } });
      expect(JSON.stringify(rawSecond)).not.toContain(invalidText);
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
      const rowClaims = f.db.prepare("SELECT COUNT(*) AS count FROM claim WHERE source_revision_id=?").get(revisionId) as { count: number };
      expect(rowClaims.count).toBe(0);
    } finally { f.db.close(); }
  });

  it("retains whole unknown-ID native compact review only as untrusted Raw2 and rejects publication", async () => {
    const document = documentWithBlocks([{ type: "paragraph", text: "A projection update preserves the residual path.\n" }]);
    const model: ModelSpec = { ...snapshot, route: "workers-ai:@cf/zai-org/glm-5.3-flash",
      id: "@cf/zai-org/glm-5.3-flash", nativeReasoningEffort: "low" };
    const f = fixture(model.route, document);
    f.db.prepare("UPDATE source_revision SET distill_request_json=?,distill_token_limit_kind='unknown',distill_token_limit=NULL WHERE id=?")
      .run(JSON.stringify({ sourceId, revisionId, model: model.route, producerFormat: "compact-k3-v1" }), revisionId);
    const extraction = { candidates: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The projection update preserves a residual path." }] };
    const unknownReview = { selected: [{ candidateId: "C999", reason: "Fixture unknown ID." }], rejected: [] };
    const sdk = await vi.importActual<typeof AISDK>("ai");
    const transport = await vi.importActual<typeof ModelTransport>("../model-transport");
    vi.mocked(experimental_streamTextLowMemory).mockImplementation(sdk.experimental_streamTextLowMemory);
    vi.mocked(resolveModelTransport).mockImplementation(transport.resolveModelTransport);
    vi.mocked(Output.json).mockReset(); vi.mocked(Output.object).mockReset();
    let bindingCalls = 0;
    vi.mocked(Output.json).mockImplementation(options => sdk.Output.json(options));
    vi.mocked(Output.object).mockImplementation(options => sdk.Output.object(options));
    Object.assign(f.env, { AI: { run: async () => {
      const output = bindingCalls++ === 0 ? extraction : unknownReview;
      const frame = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
      return new Response(frame({ choices: [{ index: 0, delta: { content: JSON.stringify(output) }, finish_reason: null }] })
        + frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        + frame({ choices: [], usage: { prompt_tokens: 201, completion_tokens: 17, total_tokens: 218 } })
        + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } } });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
    try {
      const steps = await run(f, false, model, "compact-k3-v1");
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source", "verify source excerpts", "review and synthesize"]);
      expect(experimental_streamTextLowMemory).toHaveBeenCalledTimes(2);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(2);
      expect(bindingCalls).toBe(2);
      const row = f.db.prepare("SELECT distill_state AS state,distill_calls AS calls,claim_count AS count,distill_error AS error FROM source_revision WHERE id=?").get(revisionId);
      expect(row).toMatchObject({ state: "failed", calls: 2, count: 0 });
      expect(String((row as { error?: unknown }).error)).toContain("Native final JSON did not match the required schema");
      const rawSecond = JSON.parse(f.bodies.get(prefix + "distill-call2.json") ?? "null");
      expect(rawSecond).toMatchObject({ format: "compact-k3-v1", output: unknownReview });
      expect(JSON.stringify(rawSecond.output)).toContain("C999");
      expect(f.bodies.has(prefix + "guide.md")).toBe(false);
      expect(f.bodies.has(prefix + "digest.md")).toBe(false);
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
      await expect(requestUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId, saveAvailable: true }))
        .rejects.toMatchObject({ status: 409 });
      expect(f.bodies.has(prefix + "checked/distill.json")).toBe(false);
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null");
      expect(report).toMatchObject({ state: "failed", kept: 0, usage: { calls: 2 } });
      expect(JSON.stringify(report)).not.toContain("C999");
      expect(JSON.stringify(report)).not.toContain("Fixture unknown ID.");
      const claims = f.db.prepare("SELECT COUNT(*) AS count FROM claim WHERE source_revision_id=?").get(revisionId) as { count: number };
      expect(claims.count).toBe(0);
      expect(network).not.toHaveBeenCalled();
    } finally { vi.mocked(Output.json).mockReset(); vi.mocked(Output.object).mockReset(); network.mockRestore(); f.db.close(); }
  });

  it("recovers committed compact claims and digest as partial when finish-report publication is interrupted", async () => {
    const document = documentWithBlocks([{ type: "paragraph", text: "The projection update preserves the residual path.\n" }]);
    const model: ModelSpec = { ...snapshot, route: "workers-ai:fixture", id: "fixture", maxOutputTokens: null };
    const f = fixture(model.route, document);
    f.db.prepare("UPDATE source_revision SET distill_request_json=? WHERE id=?")
      .run(JSON.stringify({ sourceId, revisionId, model: model.route, producerFormat: "compact-k3-v1" }), revisionId);
    const extraction = { candidates: [{ quoteBlock: "[S1:1]", kind: "method", statement: "The projection update preserves a residual path." }] };
    const review = { selected: [{ candidateId: "C0", reason: "The linked block states the method." }], rejected: [] };
    const usage = { inputTokens: 41, inputTokenDetails: { cacheReadTokens: 0 }, outputTokens: 9,
      outputTokenDetails: { textTokens: 9 }, totalTokens: 50, raw: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 } };
    let ordinal = 0;
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(experimental_streamTextLowMemory).mockImplementation((options) => {
      const output = ordinal++ === 0 ? extraction : review;
      const captured = options as unknown as { onChunk?: (event: never) => Promise<void> | void; onEnd?: (event: never) => Promise<void> | void };
      return { consumeStream: async () => {
        await captured.onChunk?.({ chunk: { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage } } as never);
        await captured.onEnd?.({ output, totalUsage: usage } as never);
      } } as never;
    });
    try {
      const steps = await run(f, false, model, "compact-k3-v1", true);
      expect(steps.mock.calls.map(([name]) => name)).toEqual([
        "extract source", "verify source excerpts", "review and synthesize", "store understanding", "finish understanding",
      ]);
      expect(experimental_streamTextLowMemory).toHaveBeenCalledTimes(2);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(2);
      expect(f.db.prepare("SELECT distill_state AS state,claim_count AS count,guide_summary AS summary FROM source_revision WHERE id=?").get(revisionId))
        .toEqual({ state: "partial", count: 1, summary: null });
      expect(f.bodies.get(prefix + "guide.md")).toBe("");
      expect(f.bodies.get(prefix + "digest.md")).toContain("The projection update preserves a residual path.");
      const report = JSON.parse(f.bodies.get(prefix + "distill.json") ?? "null") as DistillReport & { state: string };
      expect(report.state).toBe("partial");
      expect(report.error).toBe("Simulated report publication interruption.");
      expect(report.kept).toBe(1);
      const view = await getUnderstanding(f.env, { type: "owner" } as Actor, { sourceId, revisionId });
      expect(view.state).toBe("partial");
      expect(view.error).toBe(report.error);
      expect(view.guide).toBe("");
      expect(view.digest).toContain("The projection update preserves a residual path.");
      expect(view.claims).toHaveLength(1);
    } finally { f.db.close(); }
  });
});

describe("modelFailure gateway 404 cause projection", () => {
  it("projects a known no-endpoint data-policy 404 body to the fixed actionable reason", async () => {
    const actual = await vi.importActual<typeof ModelTransport>("../model-transport");
    const secret = "sk-live-policy-secret user_id=policy-probe";
    const policyBody = JSON.stringify({ error: { message: "No endpoints found matching your data policy (data_collection: deny). " + secret, code: 404 } });
    const policyError = Object.assign(new Error("request failed"), { statusCode: 404, responseBody: policyBody });
    expect(actual.modelFailure(policyError, snapshot)).toBe(
      "External model request failed (HTTP 404). Provider reports no endpoint matching its data policy. Review provider privacy settings or choose another model. No retry was started.",
    );
    expect(actual.modelFailure(policyError, snapshot)).toContain("HTTP 404");
    const incidentalError = Object.assign(new Error("missing"), { statusCode: 404, responseBody: JSON.stringify({ error: { message: "Not found. Diagnostic mentions no endpoint and data policy", code: 404 } }) });
    expect(actual.modelFailure(incidentalError, snapshot)).toBe(
      "External model request failed (HTTP 404). Check the Gateway connection and provider status; no retry was started.",
    );
    const typedError = Object.assign(new Error("missing"), { statusCode: 404, responseBody: JSON.stringify({ error: { message: { text: "No endpoints found matching your data policy" }, code: 404 } }) });
    expect(actual.modelFailure(typedError, snapshot)).toBe(
      "External model request failed (HTTP 404). Check the Gateway connection and provider status; no retry was started.",
    );
    const plainError = Object.assign(new Error("missing"), { statusCode: 404, responseBody: JSON.stringify({ error: { message: "Not found", code: 404 } }) });
    expect(actual.modelFailure(plainError, snapshot)).toBe(
      "External model request failed (HTTP 404). Check the Gateway connection and provider status; no retry was started.",
    );
    const malformedError = Object.assign(new Error("missing"), { statusCode: 404, responseBody: "<html>not json" });
    expect(actual.modelFailure(malformedError, snapshot)).toBe(
      "External model request failed (HTTP 404). Check the Gateway connection and provider status; no retry was started.",
    );
    const echoError = Object.assign(new Error("missing"), { statusCode: 404, responseBody: JSON.stringify({ error: { message: "Not found", code: 404 }, request: { echo: "no endpoint data policy debug" } }) });
    expect(actual.modelFailure(echoError, snapshot)).toBe(
      "External model request failed (HTTP 404). Check the Gateway connection and provider status; no retry was started.",
    );
  });
});
