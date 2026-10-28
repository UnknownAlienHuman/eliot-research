import { afterEach, describe, expect, it, vi } from "vitest";
import { getUnderstanding } from "./understanding";
import type { Actor } from "./auth";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

afterEach(() => { vi.unstubAllGlobals(); });

const SRC = "src-synth-01";
const REV = "rev-synth-01";
const HIST = "gateway:synth-provider/synth-historic-v1";
const FUT = "gateway:synth-provider/synth-future-v1";
const MISSING = "gateway:synth-provider/synth-missing-v1";

const providers = [
  { id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true },
  { id: "synth-provider", type: "openai-compatible", gatewaySlug: "synth", gatewayPath: "v1", baseUrl: "https://example.invalid/v1", enabled: true },
];

const storedReport = {
  questions: ["synth-q1"],
  usage: { calls: 1, inputTokens: 100, cachedTokens: null, outputTokens: 50, tokenLimit: 44000, estimatedCostMicrousd: 322766, wallMs: 7, providerUsage: null, legacyCurrency: "USD-old" },
  kept: 1, dropped: [], clearedNumbers: 0,
  raw: { first: "raw1", second: null }, error: null, legacyNote: "keep-me",
};

const entry = (route: string, id: string, contextTokens: number, outputReserveTokens: number, enabled = true) => ({
  route, id, label: id, contextTokens, maxOutputTokens: null, outputReserveTokens, checkedOn: "2026-10-28", enabled,
  ...(enabled ? {} : { unavailableReason: "Provider is disabled." }),
});

function makeEnv(configured: string, models: unknown[]) {
  let writes = 0;
  const snapshot = { updatedAt: "2026-10-28T00:00:00.000Z", warnings: [], models, providers };
  const DB = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("FROM source WHERE")) return { id: SRC, authors: "Synth Author", published: "2026", currentRevisionId: REV };
          if (sql.includes("FROM source_revision")) return { id: REV, state: "done", error: null, attempts: 1, reportKey: null, model: HIST };
          if (sql.includes("distill_model AS model")) return { model: configured };
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => { writes += 1; return {}; },
      }),
      first: async () => {
        if (sql.includes("model_providers_json")) return { providers: JSON.stringify(providers) };
        if (sql.includes("model_gateway_id")) return { gatewayId: "fixture-gateway" };
        if (sql.includes("distill_model AS model")) return { model: configured };
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => { writes += 1; return {}; },
    }),
    batch: async () => { writes += 1; return []; },
  };
  const guides: Record<string, string> = { ["source/" + REV + "/guide.md"]: "synth guide", ["source/" + REV + "/digest.md"]: "synth digest" };
  const objs: Record<string, unknown> = {
    ["source/" + REV + "/distill.json"]: storedReport,
    ["source/" + REV + "/glossary.json"]: [],
    ["source/" + REV + "/blocks.json"]: [{ id: 1, start: 0, end: 5 }],
  };
  const BUCKET = {
    get: async (key: string) => {
      if (key === "catalog/models.json") { const raw = JSON.stringify(snapshot); return { size: raw.length, json: async () => JSON.parse(raw) }; }
      if (key in guides) { const t = guides[key] as string; return { text: async () => t }; }
      if (key in objs) { const v = objs[key]; return { json: async () => JSON.parse(JSON.stringify(v)) }; }
      return null;
    },
    put: async () => { writes += 1; return {}; },
  };
  return { env: { DB, BUCKET } as unknown as Env, writes: () => writes };
}

const owner = { type: "owner" } as Actor;

describe("getUnderstanding stored-catalogue regression", () => {
  it("keeps stored history while a separate future route sets 2*(ctx+reserve)", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("no discovery"); });
    vi.stubGlobal("fetch", fetchSpy);
    const f = makeEnv(FUT, [entry(HIST, "synth-historic-v1", 16000, 4000), entry(FUT, "synth-future-v1", 32000, 8000)]);
    const r = await getUnderstanding(f.env, owner, { sourceId: SRC, revisionId: REV });
    expect(r.progress.model).toBe(HIST);
    expect(r.progress.configuredModel).toBe(FUT);
    expect(r.progress.maximumTokens).toBe(80000);
    expect(r.guide).toBe("synth guide");
    expect(r.report).toEqual(storedReport);
    expect((r.report?.usage as unknown as { estimatedCostMicrousd: number }).estimatedCostMicrousd).toBe(322766);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(f.writes()).toBe(0);
  });

  it("missing/disabled configured metadata stays null, never zero, without discovery or writes", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("no discovery"); });
    vi.stubGlobal("fetch", fetchSpy);
    const hist = entry(HIST, "synth-historic-v1", 16000, 4000);
    const absent = makeEnv(MISSING, [hist]);
    const off = makeEnv(FUT, [hist, entry(FUT, "synth-future-v1", 32000, 8000, false)]);
    const rm = await getUnderstanding(absent.env, owner, { sourceId: SRC, revisionId: REV });
    const rd = await getUnderstanding(off.env, owner, { sourceId: SRC, revisionId: REV });
    expect(rm.progress.maximumTokens).toBeNull();
    expect(rd.progress.maximumTokens).toBeNull();
    expect(rd.progress.maximumTokens).not.toBe(0 as unknown as null);
    expect(rd.progress.model).toBe(HIST);
    expect(rd.report).toEqual(storedReport);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(off.writes()).toBe(0);
  });
});
