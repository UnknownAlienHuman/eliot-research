import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { estimateCost, failUndispatchedDistill } from "./cost.js";
import type { ModelSpec } from "./models.js";

// Local price fixture: estimateCost is pure arithmetic over the spec it is
// given, so tests pin their own rates instead of depending on registry audit state.
const SPEC: ModelSpec = {
  route: "test:local-fixture",
  id: "@cf/zai-org/glm-5.3-flash",
  label: "Local price fixture",
  contextTokens: 1_048_576,
  maxOutputTokens: 8192,
  inputMicrousdPerMillion: 150000,
  cachedMicrousdPerMillion: 30000,
  outputMicrousdPerMillion: 500000,
  checkedOn: "2026-10-26",
  enabled: true,
};

describe("estimateCost", () => {
  it("prices input, cached and output tokens at their own rates", () => {
    // (500000 * 150000 + 500000 * 30000 + 100000 * 500000) / 1e6 = 140000.
    expect(estimateCost(SPEC, 1_000_000, 500_000, 100_000)).toBe(140000);
  });

  it("ceils fractional micro-USD up to a whole integer", () => {
    // One input token costs 0.15 micro-USD; the reservation must still cover it.
    const cost = estimateCost(SPEC, 1, 0, 0);
    expect(cost).toBe(1);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it("rejects negative usage", () => {
    expect(() => estimateCost(SPEC, -1, 0, 0)).toThrow(RangeError);
    expect(() => estimateCost(SPEC, 0, 0, -5)).toThrow(RangeError);
  });

  it("rejects fractional token counts", () => {
    expect(() => estimateCost(SPEC, 1.5, 0, 0)).toThrow(RangeError);
    expect(() => estimateCost(SPEC, 10, 0.5, 0)).toThrow(RangeError);
  });

  it("rejects a cached prefix larger than the input", () => {
    expect(() => estimateCost(SPEC, 100, 101, 0)).toThrow(RangeError);
  });

  it("reserves full input price when the provider omits its cached-input rate", () => {
    expect(estimateCost({ ...SPEC, cachedMicrousdPerMillion: null }, 1_000_000, 500_000, 0)).toBe(150000);
  });
});
describe("failUndispatchedDistill", () => {
  const DDL = `CREATE TABLE source_revision (
    id TEXT PRIMARY KEY,
    distill_state TEXT NOT NULL DEFAULT 'none' CHECK (distill_state IN ('none','queued','running','paused','done','partial','failed')),
    distill_error TEXT,
    distill_calls INTEGER NOT NULL DEFAULT 0 CHECK (distill_calls BETWEEN 0 AND 2),
    distill_started_at INTEGER,
    distill_input_tokens INTEGER,
    distill_cached_tokens INTEGER,
    distill_output_tokens INTEGER,
    distill_estimated_cost_microusd INTEGER CHECK (distill_estimated_cost_microusd IS NULL OR distill_estimated_cost_microusd >= 0),
    distill_ms INTEGER
  )`;
  // Minimal D1-shaped shim over real SQLite: the helper under test only
  // uses prepare/bind/run with meta.changes. The env deliberately exposes
  // no BUCKET, so any R2 report write before the CAS would throw here.
  // The helper is a single UPDATE (no SELECT round trip), so concurrent
  // paid dispatch cannot interleave between a read and the write: either
  // the WHERE clause matches an undispatched running row, or it releases
  // nothing and preserves the winner.
  function testEnv(db: DatabaseSync) {
    const shim = {
      prepare(sql: string) {
        return {
          bind(...params: Array<string | number | null>) {
            return {
              run() {
                return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
              },
            };
          },
        };
      },
    };
    return { DB: shim } as unknown as Env;
  }
  function rowOf(db: DatabaseSync, id: string) {
    return db.prepare("SELECT distill_state AS state, distill_error AS error, distill_calls AS calls, distill_estimated_cost_microusd AS cost, distill_input_tokens AS inputTokens, distill_cached_tokens AS cachedTokens, distill_output_tokens AS outputTokens, distill_ms AS ms FROM source_revision WHERE id=?").get(id) as Record<string, unknown>;
  }
  it("releases a stuck undispatched slot with zeroed usage in one atomic CAS", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(DDL);
    const started = Date.now() - 5000;
    db.prepare("INSERT INTO source_revision (id, distill_state, distill_error, distill_calls, distill_started_at, distill_input_tokens, distill_cached_tokens, distill_output_tokens, distill_estimated_cost_microusd, distill_ms) VALUES (?, 'running', NULL, 0, ?, 100, 0, 8000, 322766, NULL)").run("r1", started);
    const env = testEnv(db);
    await expect(failUndispatchedDistill(env, "r1", "create failed")).resolves.toBe(true);
    const row = rowOf(db, "r1");
    expect(row.state).toBe("failed");
    expect(row.error).toBe("create failed");
    expect(row.calls).toBe(0);
    expect(row.cost).toBe(0);
    expect(row.inputTokens).toBe(0);
    expect(row.cachedTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
    expect(row.ms).toBeGreaterThanOrEqual(0);
    expect(row.ms).toBeLessThanOrEqual(Date.now() - started);
  });
  it("returns false and preserves the row when paid dispatch already won", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(DDL);
    const started = Date.now() - 9000;
    db.prepare("INSERT INTO source_revision (id, distill_state, distill_error, distill_calls, distill_started_at, distill_input_tokens, distill_cached_tokens, distill_output_tokens, distill_estimated_cost_microusd, distill_ms) VALUES (?, 'running', 'queued note', 1, ?, 100, 0, 8000, 322766, 123)").run("r1", started);
    const env = testEnv(db);
    await expect(failUndispatchedDistill(env, "r1", "create failed")).resolves.toBe(false);
    const row = rowOf(db, "r1");
    expect(row.state).toBe("running");
    expect(row.error).toBe("queued note");
    expect(row.calls).toBe(1);
    expect(row.cost).toBe(322766);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(8000);
    expect(row.ms).toBe(123);
  });
  it("returns false for terminal or missing rows without touching them", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(DDL);
    db.prepare("INSERT INTO source_revision (id, distill_state, distill_calls, distill_estimated_cost_microusd) VALUES (?, 'done', 2, 4444)").run("r9");
    const env = testEnv(db);
    await expect(failUndispatchedDistill(env, "r9", "create failed")).resolves.toBe(false);
    await expect(failUndispatchedDistill(env, "no-such-row", "create failed")).resolves.toBe(false);
    const row = rowOf(db, "r9");
    expect(row.state).toBe("done");
    expect(row.calls).toBe(2);
    expect(row.cost).toBe(4444);
  });
});
