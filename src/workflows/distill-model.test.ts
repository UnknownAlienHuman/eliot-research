import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Block } from "../blocks";
import type { Actor } from "../auth";
import { LibraryError } from "../library";
import type { ModelSpec } from "../models";
import type * as Models from "../models";
import type * as ModelTransport from "../model-transport";
import type { DistillInput } from "../shared/api";
import type { DistillReport } from "../understanding";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(_ctx: unknown, readonly env: Env) {}
  },
}));
vi.mock("ai", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("ai");
  return { ...actual, generateText: vi.fn(), Output: { object: vi.fn() } };
});
vi.mock("../model-transport", async () => ({
  ...await vi.importActual<typeof ModelTransport>("../model-transport"),
  resolveModelTransport: vi.fn(),
  modelFailure: () => "Unexpected model failure projection",
}));
vi.mock("../model-catalog", () => ({ discoverGatewayModels: vi.fn() }));
vi.mock("../native-model-catalog", () => ({ discoverNativeModels: vi.fn() }));
vi.mock("../models", async () => ({
  ...await vi.importActual<typeof Models>("../models"),
  requireAvailableModel: vi.fn(), requireCatalogModel: vi.fn(), availableModels: vi.fn(),
}));

import { NoObjectGeneratedError, generateText } from "ai";
import { resolveModelTransport } from "../model-transport";
import { availableModels, requireAvailableModel, requireCatalogModel } from "../models";
import { discoverGatewayModels } from "../model-catalog";
import { discoverNativeModels } from "../native-model-catalog";
import { DistillWorkflow, hasAvailableUnderstanding, requestUnderstanding, scheduleDistillation } from "./distill";

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
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql", "0009_provider_usage.sql"])
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
  const dispatchCAS = vi.fn();
  const env = { DB: {
    prepare(sql: string) {
      return { bind(...args: SQLInputValue[]) {
        return {
          first: async () => db.prepare(sql).get(...args) ?? null,
          run: async () => {
            if (/SET\s+distill_calls\s*=\s*distill_calls\s*\+\s*1/i.test(sql)) dispatchCAS(sql, args);
            return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } };
          },
        };
      } };
    },
  }, BUCKET: {
    async get(key: string) {
      const body = bodies.get(key);
      return body === undefined ? null : { text: async () => body, json: async () => JSON.parse(body) as unknown,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    },
    async put(key: string, body: string) {
      if (bodies.has(key)) return null;
      bodies.set(key, body); return {};
    },
  } } as unknown as Env;
  return { db, env, bodies, dispatchCAS };
}

const explicitlySelectedRevisionId = "148e1392-f987-4fc5-bc65-152c9000b4d8";
const explicitlySelectedSourceId = "e61d9a7d-0817-4a9b-b46b-3f52ab3bd47f";
const otherQueuedRevisionId = "3ba8fcb2-ddca-41b1-b901-00fdb4f76afd";
const otherQueuedSourceId = "c3fd7da4-b662-4aa5-a6fc-9c84b6299940";

function callerFixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql", "0009_provider_usage.sql"])
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));

  const insertSource = (id: string, title: string, revision: string, state: "none" | "queued", createdAt: number) => {
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
  const env = { DB: {
    prepare(sql: string) {
      const operations = (args: SQLInputValue[]) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      });
      return { ...operations([]), bind: (...args: SQLInputValue[]) => operations(args) };
    },
  }, DISTILL: { create: createWorkflow } } as unknown as Env;
  return { db, env, createWorkflow };
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
  vi.mocked(resolveModelTransport).mockReset().mockRejectedValue(new Error("Fixture transport stopped before dispatch."));
  for (const lookup of forbiddenLookups) vi.mocked(lookup).mockReset().mockRejectedValue(new Error("Unexpected catalogue lookup"));
});

async function run(f: ReturnType<typeof fixture>) {
  const stepDo = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback());
  await new DistillWorkflow({} as ExecutionContext, f.env).run(
    { payload: { revisionId, model: snapshot } } as WorkflowEvent<DistillInput>,
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
  it("explicit Understand dispatches only its revision; cron leaves queued untouched", async () => {
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

      // Cron (no target) only reconciles stale running: it must not admit queued work.
      await scheduleDistillation(f.env);
      expect(f.createWorkflow).toHaveBeenCalledTimes(1);
      expect(f.db.prepare("SELECT id,distill_state AS state FROM source_revision ORDER BY created_at").all())
        .toEqual([
          { id: otherQueuedRevisionId, state: "queued" },
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
      expect(resolveModelTransport).toHaveBeenCalledExactlyOnceWith(f.env, snapshot, `distill-${revisionId}`);
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

  it("retains typed structured-output failure telemetry without claiming the stored second-step cause", async () => {
    // Does not reproduce eval/out/openrouter-20261028/resnet-trace (generic External failure, distill-call2.json 404, unrecoverable).
    // It covers the proven pinned ai@7.0.152 shape in isolation: NoObjectGeneratedError carries usage/text/finishReason.
    const f = fixture(snapshot.route);
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    const rawProviderUsage = { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 };
    const sdkUsage = { inputTokens: 1200, inputTokenDetails: { noCacheTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: undefined }, outputTokens: 34, outputTokenDetails: { textTokens: 34, reasoningTokens: undefined }, totalTokens: 1234, raw: rawProviderUsage };
    const sdkError = new NoObjectGeneratedError({ message: "No object generated: response did not match schema.", text: '{"guide":', response: { id: "resp-typed-1", timestamp: new Date(), modelId: "fixture/admitted" }, usage: sdkUsage, finishReason: "stop" });
    vi.mocked(generateText).mockRejectedValueOnce(sdkError);
    try {
      const steps = await run(f);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      expect(generateText).toHaveBeenCalledTimes(1);
      expect(f.dispatchCAS).toHaveBeenCalledTimes(1);
      const rawBody = f.bodies.get(prefix + "distill-call1.json");
      if (!rawBody) throw new Error("Typed failure did not retain its per-call artifact.");
      const stored = JSON.parse(rawBody) as { output: null; usage: { inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; tokenLimit: number | null; providerUsage: unknown }; error: { kind: string; finishReason: string | null; text: string | null } };
      expect(stored.output).toBeNull();
      expect(stored.error.kind).toBe("invalid-structured-output");
      expect(stored.error.finishReason).toBe("stop");
      expect(stored.error.text).toBe('{"guide":');
      expect(stored.usage.inputTokens).toBe(1200);
      expect(stored.usage.cachedTokens).toBe(0);
      expect(stored.usage.outputTokens).toBe(34);
      expect(stored.usage.providerUsage).toMatchObject(rawProviderUsage);
      expect(f.bodies.has(prefix + "distill-call2.json")).toBe(false);
      const reportBody = f.bodies.get(prefix + "distill.json");
      if (!reportBody) throw new Error("Missing distill.json for typed failure.");
      const report = JSON.parse(reportBody) as DistillReport & { state: string };
      expect(report.state).toBe("failed");
      expect(report.usage.calls).toBe(1);
      expect(report.usage.inputTokens).toBe(1200);
      expect(report.usage.outputTokens).toBe(34);
      expect(report.usage.providerUsage).toHaveLength(1);
      expect(report.kept).toBe(0);
      expect(JSON.stringify(report)).not.toContain('{"guide":');
      expect(await hasAvailableUnderstanding(f.env, revisionId)).toBe(false);
      const row = f.db.prepare("SELECT distill_state AS state,distill_calls AS calls FROM source_revision WHERE id=?").get(revisionId) as { state: string; calls: number };
      expect(row).toEqual({ state: "failed", calls: 1 });
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
      expect(report.usage.estimatedCostMicrousd).toBe(322766);
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
