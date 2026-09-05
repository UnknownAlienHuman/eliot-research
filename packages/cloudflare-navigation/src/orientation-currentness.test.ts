import { describe, expect, it, vi } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { orientationCurrentness } from "./orientation-currentness.js";
import type { ScopeService } from "./scope-service.js";

describe("request-local currentness fence", () => {
  const initial = Date.parse("2026-09-05T05:00:00Z");
  const snapshot = { expires_at: new Date(initial + 900000).toISOString(), resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
    member_source_revision_refs: [] } as unknown as ScopeSnapshot;
  function fixture() {
    const state = { time: initial, epoch: 1, boundary: initial + 1000 };
    const db = { prepare(sql: string) { return { bind() { return this; }, async first() {
      return sql.includes("orientation_authority_epoch") ? { generation: state.epoch } : {
        t0: new Date(state.boundary).toISOString(), t1: null, t2: null, t3: null, t4: null, t5: null,
      };
    } }; } } as unknown as D1Database;
    const deep = vi.fn(async (scope: ScopeSnapshot) => scope);
    const read = orientationCurrentness(db, { requireCurrent: deep } as unknown as ScopeService, "owner", () => state.time);
    return { state, deep, read };
  }
  it("reuses only the same request/epoch before the next temporal boundary", async () => {
    const f = fixture(); await f.read(snapshot); await f.read(snapshot); expect(f.deep).toHaveBeenCalledTimes(1);
    f.state.epoch += 1; await f.read(snapshot); expect(f.deep).toHaveBeenCalledTimes(2);
    f.state.time = f.state.boundary;
    await expect(f.read(snapshot)).rejects.toMatchObject({ code: "ORIENTATION_AUTHORITY_CHANGED" });
    expect(f.deep).toHaveBeenCalledTimes(3);
    const independent = fixture(); await independent.read(snapshot); expect(independent.deep).toHaveBeenCalledOnce();
  });
  it("rejects a time boundary or mutation crossed while validating", async () => {
    for (const mutation of ["clock", "epoch"] as const) {
      const f = fixture(); f.deep.mockImplementation(async (scope) => {
        if (mutation === "clock") f.state.time = f.state.boundary; else f.state.epoch += 1;
        return scope;
      });
      await expect(f.read(snapshot)).rejects.toMatchObject({ code: "ORIENTATION_AUTHORITY_CHANGED" });
    }
  });
  it("does not reuse a cached observation after the clock moves backwards", async () => {
    const f = fixture(); await f.read(snapshot); f.state.time -= 1;
    await f.read(snapshot); expect(f.deep).toHaveBeenCalledTimes(2);
  });
});
