import { describe, expect, it } from "vitest";
import { createRunHistoryDecoder } from "./history.js";
import type { ResearchRunStatusDecoder } from "../runs/authority.js";

import type { LegacyErrorFactory } from "../../legacy/http.js";

const generation = "decoder-generation";
const errors: LegacyErrorFactory = details => Object.assign(new Error(details.message), details);
const decodeStatus: ResearchRunStatusDecoder = () => {
  throw new Error("empty history must not decode a run status");
};
const decodeHistory = createRunHistoryDecoder(errors, decodeStatus);
const timestamp = "2026-10-13T00:00:00.000Z";

function page(overrides: Record<string, unknown> = {}): {
  readonly data: Record<string, unknown>;
  readonly trace_id: string;
  readonly deployment_generation: string;
} {
  return {
    trace_id: "history-decoder-test",
    deployment_generation: generation,
    data: {
      protocol: "eliotr.research-runs.v4",
      runs: [],
      saved_drafts: [],
      configuration_state: "INSTALLED",
      checked_at: timestamp,
      visibility_scan: { runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED" },
      ...overrides,
    },
  };
}

describe("decoder-only research history seam", () => {
  it("decodes an incomplete empty v4 page without transport or epoch ports", () => {
    const view = decodeHistory(page(), generation);
    expect(view.visibility_scan).toEqual({ runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED" });
    expect(view.runs).toEqual([]);
    expect(view.saved_drafts).toEqual([]);
  });

  it.each([
    ["missing scan", (() => { const value = page(); delete value.data.visibility_scan; return value; })()],
    ["unknown scan field", page({ visibility_scan: {
      runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED", owner: "private",
    } })],
    ["inconsistent visible target", page({ visibility_scan: {
      runs: "TARGET_REACHED", saved_drafts: "SOURCE_EXHAUSTED",
    } })],
  ])("keeps v4 visibility strict for %s", (_label, value) => {
    expect(() => decodeHistory(value, generation)).toThrowError();
  });

  it.each([
    "eliotr.research-runs.v1",
    "eliotr.research-runs.v2",
    "eliotr.research-runs.v3",
  ])("preserves legacy %s decoding and refuses v4 metadata", protocol => {
    const legacy = page({ protocol });
    delete legacy.data.visibility_scan;
    expect(decodeHistory(legacy, generation).protocol).toBe(protocol);
    expect(() => decodeHistory(page({ protocol }), generation)).toThrowError();
  });

  it("preserves the expected deployment-generation fence", () => {
    expect(() => decodeHistory(page(), "other-generation")).toThrowError();
  });
});
