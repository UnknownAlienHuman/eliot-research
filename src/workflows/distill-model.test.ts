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
  modelFailure: vi.fn(() => "Unexpected model failure projection"),
}));
vi.mock("../model-catalog", () => ({ discoverGatewayModels: vi.fn() }));
vi.mock("../native-model-catalog", () => ({ discoverNativeModels: vi.fn() }));
vi.mock("../models", async () => ({
  ...await vi.importActual<typeof Models>("../models"),
  requireAvailableModel: vi.fn(), requireCatalogModel: vi.fn(), availableModels: vi.fn(),
}));

import { NoObjectGeneratedError, generateText, Output } from "ai";
import { modelFailure, resolveModelTransport } from "../model-transport";
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
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql", "0005_model_gateway.sql", "0006_integrity.sql", "0007_manual_understanding.sql", "0008_model_providers.sql"])
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
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql", "0005_model_gateway.sql", "0006_integrity.sql", "0007_manual_understanding.sql", "0008_model_providers.sql"])
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
  vi.mocked(modelFailure).mockReset().mockReturnValue("Unexpected model failure projection");
  for (const lookup of forbiddenLookups) vi.mocked(lookup).mockReset().mockRejectedValue(new Error("Unexpected catalogue lookup"));
});

async function run(f: ReturnType<typeof fixture>, serializeErrors = false) {
  const stepDo = vi.fn(async (_name: string, _options: unknown, callback: () => Promise<unknown>) => {
    try { return await callback(); } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Simulate Workflow serialization stripping the error class and cause.
      if (serializeErrors && error instanceof Error) throw new Error(error.message);
      throw error;
    }
  });
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

  it("admits a fresh native provider-default snapshot without mutating the published low-effort model", async () => {
    const f = callerFixture();
    const published: ModelSpec = Object.freeze({
      route: "workers-ai:@cf/zai-org/glm-5.3-flash", id: "@cf/zai-org/glm-5.3-flash", label: "Native published fixture",
      contextTokens: 1_048_576, maxOutputTokens: null, outputReserveTokens: 8192,
      nativeReasoningEffort: "low", checkedOn: "2026-10-30", enabled: true,
    });
    const { nativeReasoningEffort: originalEffort, ...expectedModel } = published;
    vi.mocked(requireAvailableModel).mockResolvedValue(published);
    try {
      f.db.prepare("UPDATE settings SET native_usage_mode='standard',distill_model=? WHERE id=1").run(snapshot.route);
      f.db.prepare("UPDATE source_revision SET distill_model=? WHERE id=?").run(published.route, explicitlySelectedRevisionId);
      expect(originalEffort).toBe("low");
      await requestUnderstanding(f.env, { type: "owner" } as Actor, {
        sourceId: explicitlySelectedSourceId, revisionId: explicitlySelectedRevisionId, model: published.route,
      });

      expect(requireAvailableModel).toHaveBeenCalledExactlyOnceWith(f.env, published.route);
      expect(f.createWorkflow).toHaveBeenCalledExactlyOnceWith({
        id: `distill-${explicitlySelectedRevisionId}`,
        params: { revisionId: explicitlySelectedRevisionId, model: expectedModel },
      });
      const admitted = f.createWorkflow.mock.calls[0]?.[0].params.model;
      expect(admitted).not.toBe(published);
      expect(admitted).toStrictEqual(expectedModel);
      expect(admitted).not.toHaveProperty("nativeReasoningEffort");
      expect(published.nativeReasoningEffort).toBe("low");
      expect(f.db.prepare("SELECT distill_model AS model,distill_state AS state,distill_calls AS calls,distill_token_limit AS tokenLimit FROM source_revision WHERE id=?")
        .get(explicitlySelectedRevisionId)).toEqual({ model: published.route, state: "running", calls: 0, tokenLimit: 2_113_536 });
      expect(f.db.prepare("SELECT distill_model AS model,native_usage_mode AS mode FROM settings WHERE id=1").get())
        .toEqual({ model: snapshot.route, mode: "standard" });
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveModelTransport).not.toHaveBeenCalled();
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

  it("requires nullable additional-result metadata for new call two but still saves historical optional call-two output", async () => {
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
    ]);
    const f = withBatch(fixture(snapshot.route, document));
    vi.mocked(resolveModelTransport).mockResolvedValue({} as never);
    vi.mocked(Output.object).mockClear();
    const extraction = {
      guide: [
        { labels: ["[S1:1]"], text: "The source describes method Alpha." },
        { labels: ["[S1:3]"], text: "The source notes a limitation." },
        { labels: ["[S1:4]"], text: "The source describes a related condition." },
      ],
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
        candidates: Array<{ id: string; statement: string; quote: string }>;
        evidence: Array<{ label: string; quote: string }>;
        guideCandidates: Array<{ labels: string[] }>;
      };
      expect(capturedContext.candidates).toEqual([{ id: "C0", statement: "Method Alpha uses a low-rank update.", quoteBlock: "[S1:1]", quote: "Method Alpha uses a low-rank update.\n", kind: "method",
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }]);
      expect(capturedContext.guideCandidates).toEqual([{ labels: ["[S1:1]"] }, { labels: ["[S1:3]"] }, { labels: ["[S1:4]"] }]);
      expect(capturedContext.evidence).toContainEqual({ label: "[S1:2]", block: 2,
        quote: "The source reports 3 and 5 examples. On Set 2021 Variant Alpha, the model scores 9.4 QScore, improving over the baseline by 1.7 QScore.\n" });
      const verifiedBody = f.bodies.get(prefix + "distill-verified.json");
      if (!verifiedBody) throw new Error("Fresh verified stage was not retained before call two.");
      const verified = JSON.parse(verifiedBody);
      expect(verified.claims).toHaveLength(1);
      expect(verified.claims[0].statement).toBe("Method Alpha uses a low-rank update.");
      expect(verified.dropped).toContainEqual({ index: 0, reason: "unsupported-statement-numbers" });
      expect(verified.dropped).toContainEqual({ index: 1, reason: "pre-synthesis-missing-or-unsupported-primary-result" });
      expect(verified.dropped).toContainEqual({ index: 3, reason: "pre-synthesis-missing-or-unsupported-primary-result" });
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
      };
      const generatedSchema = (instructions: unknown): JsonSchemaNode => {
        if (typeof instructions !== "string") throw new Error("Structured request instructions were not captured.");
        const at = instructions.lastIndexOf(marker);
        if (at < 0) throw new Error("Generated JSON schema was not included in the captured model request.");
        return JSON.parse(instructions.slice(at + marker.length)) as JsonSchemaNode;
      };
      const firstSchema = generatedSchema(callInstructions[0]);
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
      }],
      guide: [
        { labels: ["[S1:1]"], text: "The source describes method Alpha." },
        { labels: ["[S1:2]"], text: "The source reports a result." },
        { labels: ["[S1:3]"], text: "The source notes a limitation." },
      ],
      evidence: [block1, block2, block3].map((block) => ({ label: "[S1:" + block.id + "]", block: block.id, quote: quote(block) })),
      questions: ["What method is described?", "What result is reported?", "What limitation is noted?"],
      dropped: [], clearedNumbers: 0,
    }));
    cached.bodies.set(prefix + "distill-call2.json", JSON.stringify({
      output: {
        supportedClaims: ["C0"],
        additionalClaims: [{ quoteBlock: "[S1:2]", kind: "result", statement: "The source reports a result of 3 times." }],
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
    try {
      expect(await hasAvailableUnderstanding(cached.env, revisionId)).toBe(true);
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
      expect(saved.state).toBe("done");
      expect(saved.kept).toBe(1);
      expect(saved.usage.calls).toBe(2);
      expect(saved.dropped).toContainEqual({ index: 0, reason: "additional-missing-or-unsupported-primary-result" });
    } finally { cached.db.close(); }
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
