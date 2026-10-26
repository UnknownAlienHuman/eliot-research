import { describe, expect, it } from "vitest";
import { estimateCost } from "./cost.js";
import { LibraryError } from "./library.js";
import { requireModel } from "./models.js";
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
});

describe("requireModel", () => {
  it("fails unknown routes without calling any model", () => {
    // Simulates disabled/unknown only; never asserts audit state of real routes.
    for (const route of ["workers-ai:@cf/does-not-exist", ""]) {
      let err: unknown;
      try {
        requireModel(route);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).code).toBe("unavailable");
    }
  });
});
