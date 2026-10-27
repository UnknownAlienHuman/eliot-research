import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ModelSpec } from "../models";
import type * as Models from "../models";
import type { DistillInput } from "../shared/api";
import type { DistillReport } from "../understanding";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(_ctx: unknown, readonly env: Env) {}
  },
}));
vi.mock("ai", () => ({ generateText: vi.fn(), Output: { object: vi.fn() } }));
vi.mock("../model-transport", () => ({
  resolveModelTransport: vi.fn(),
  modelFailure: () => "Unexpected model failure projection",
}));
vi.mock("../model-catalog", () => ({ discoverGatewayModels: vi.fn(), enrichSelectedModel: vi.fn() }));
vi.mock("../native-model-catalog", () => ({ discoverNativeModels: vi.fn() }));
vi.mock("../models", async () => ({
  ...await vi.importActual<typeof Models>("../models"),
  requireAvailableModel: vi.fn(), requireCatalogModel: vi.fn(), availableModels: vi.fn(),
}));

import { generateText } from "ai";
import { resolveModelTransport } from "../model-transport";
import { availableModels, requireAvailableModel, requireCatalogModel } from "../models";
import { discoverGatewayModels, enrichSelectedModel } from "../model-catalog";
import { discoverNativeModels } from "../native-model-catalog";
import { DistillWorkflow } from "./distill";

const revisionId = "d9b7d198-0dd2-4d5f-8176-e824e25bb6d0";
const sourceId = "fb3c275a-46c0-43f6-9d49-deea18581c44";
const prefix = `source/${revisionId}/`;
// Deliberately not a catalogue entry: the Workflow consumes the admitted payload.
const snapshot: ModelSpec = Object.freeze({
  route: "gateway:command-code/fixture/admitted", id: "fixture/admitted", label: "Admitted snapshot fixture",
  contextTokens: 262144, maxOutputTokens: null, outputReserveTokens: 8192,
  inputMicrousdPerMillion: 123456, cachedMicrousdPerMillion: 2345, outputMicrousdPerMillion: 654321,
  responseFormat: false, structuredOutputs: false, reasoning: Object.freeze({ enabled: false as const }),
  checkedOn: "2026-10-27", enabled: true,
});

function fixture(storedRoute: string) {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001_library.sql", "0002_ask.sql", "0003_distill.sql"])
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const text = "The method uses normalization. Its source passage is retained.";
  const block = { id: 1, type: "paragraph", start: 0, end: new TextEncoder().encode(text).byteLength, heading: null };
  db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES (?,'Paper','text','owner',0,0)").run(sourceId);
  db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,readable_size,created_by,created_at,
    distill_state,distill_model,distill_started_at,distill_estimated_cost_microusd)
    VALUES (?,?,1,'readable',?,'owner',0,'running',?,?,322766)`)
    .run(revisionId, sourceId, block.end, storedRoute, Date.now() - 100);
  db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run(revisionId, sourceId);
  const bodies = new Map([[prefix + "text.md", text], [prefix + "blocks.json", JSON.stringify([block])]]);
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

const forbiddenLookups = [requireAvailableModel, requireCatalogModel, availableModels,
  discoverGatewayModels, enrichSelectedModel, discoverNativeModels];
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

  it("passes the exact admitted context, prices, reserve and pricing date to transport without rediscovery", async () => {
    const f = fixture(snapshot.route);
    const original = structuredClone(snapshot);
    vi.mocked(resolveModelTransport).mockImplementation(async (env, model, affinity) => {
      expect(env).toBe(f.env); expect(model).toBe(snapshot); expect(affinity).toBe(`distill-${revisionId}`);
      expect(model).toEqual(original);
      expect(model).toMatchObject({ contextTokens: 262144, maxOutputTokens: null, outputReserveTokens: 8192,
        inputMicrousdPerMillion: 123456, cachedMicrousdPerMillion: 2345, outputMicrousdPerMillion: 654321,
        checkedOn: "2026-10-27" });
      expect(f.dispatchCAS).not.toHaveBeenCalled();
      throw new Error("Fixture transport stopped before dispatch.");
    });
    try {
      const steps = await run(f);
      expect(steps.mock.calls.map(([name]) => name)).toEqual(["extract source"]);
      expect(resolveModelTransport).toHaveBeenCalledExactlyOnceWith(f.env, snapshot, `distill-${revisionId}`);
      expect(snapshot).toEqual(original);
      finished(f, "Fixture transport stopped before dispatch.");
    } finally { f.db.close(); }
  });
});
