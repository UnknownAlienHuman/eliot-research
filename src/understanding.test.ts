import { afterEach, describe, expect, it, vi } from "vitest";
import { getUnderstanding } from "./understanding";
import type { DistillState } from "./understanding";
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

function makeEnv(configured: string, models: unknown[], options: {
  state?: DistillState; attempts?: number; model?: string | null; tokenLimit?: number | null; report?: typeof storedReport | null;
} = {}) {
  const { state = "done", attempts = 1, model = HIST, tokenLimit = null, report = storedReport } = options;
  let writes = 0;
  const snapshot = { updatedAt: "2026-10-28T00:00:00.000Z", warnings: [], models, providers };
  const DB = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("FROM source WHERE")) return { id: SRC, authors: "Synth Author", published: "2026", currentRevisionId: REV };
          if (sql.includes("FROM source_revision")) return { id: REV, state, error: null, attempts, reportKey: null, model, tokenLimit };
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
    ...(report === null ? {} : { ["source/" + REV + "/distill.json"]: report }),
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
  it("keeps recorded row/report bounds and legacy history despite a larger future default", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("no discovery"); });
    vi.stubGlobal("fetch", fetchSpy);
    for (const [tokenLimit, expected] of [[null, 44000], [60000, 60000], [0, 0]] as const) {
      const f = makeEnv(FUT, [entry(HIST, "synth-historic-v1", 16000, 4000), entry(FUT, "synth-future-v1", 32000, 8000)], { tokenLimit });
      const r = await getUnderstanding(f.env, owner, { sourceId: SRC, revisionId: REV });
      expect(r.progress.model).toBe(HIST);
      expect(r.progress.configuredModel).toBe(FUT);
      expect(r.progress.maximumTokens).toBe(expected);
      expect(r.guide).toBe("synth guide");
      expect(r.report).toEqual(storedReport);
      expect((r.report?.usage as unknown as { estimatedCostMicrousd: number }).estimatedCostMicrousd).toBe(322766);
      expect(f.writes()).toBe(0);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("missing or disabled default metadata cannot erase the historical report bound", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("no discovery"); });
    vi.stubGlobal("fetch", fetchSpy);
    const hist = entry(HIST, "synth-historic-v1", 16000, 4000);
    const absent = makeEnv(MISSING, [hist]);
    const off = makeEnv(FUT, [hist, entry(FUT, "synth-future-v1", 32000, 8000, false)]);
    const rm = await getUnderstanding(absent.env, owner, { sourceId: SRC, revisionId: REV });
    const rd = await getUnderstanding(off.env, owner, { sourceId: SRC, revisionId: REV });
    expect(rm.progress.maximumTokens).toBe(44000);
    expect(rd.progress.maximumTokens).toBe(44000);
    expect(rm.progress.model).toBe(HIST);
    expect(rd.progress.model).toBe(HIST);
    expect(rm.report).toEqual(storedReport);
    expect(rd.report).toEqual(storedReport);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(absent.writes()).toBe(0);
    expect(off.writes()).toBe(0);
  });

  it("forecasts only unstarted revisions from their selected route or default, retaining unknown as null", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("no discovery"); });
    vi.stubGlobal("fetch", fetchSpy);
    const hist = entry(HIST, "synth-historic-v1", 16000, 4000);
    const future = entry(FUT, "synth-future-v1", 32000, 8000);
    const none = makeEnv(FUT, [hist, future], { state: "none", attempts: 0, model: null, report: null });
    const queued = makeEnv(FUT, [hist, future], { state: "queued", attempts: 0, report: null });
    const missing = makeEnv(FUT, [future], { state: "queued", attempts: 0, report: null });
    const terminal = makeEnv(FUT, [hist, future], { state: "failed", report: null });
    for (const [f, expected] of [[none, 80000], [queued, 40000], [missing, null], [terminal, null]] as const) {
      const r = await getUnderstanding(f.env, owner, { sourceId: SRC, revisionId: REV });
      expect(r.progress.maximumTokens).toBe(expected);
      expect(r.report).toBeNull();
      expect(f.writes()).toBe(0);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
