import { describe, expect, it } from "vitest";
import { createRunHistoryApi } from "./history.js";
import { createResearchRunsApi } from "../runs/authority.js";
import { createResearchRunWire } from "../runs/wire.js";
import type { LegacyErrorFactory } from "../../legacy/http.js";
const errors: LegacyErrorFactory = details => Object.assign(new Error(details.message), details);
const ports = { errors, request: async () => { throw new Error("no transport in decoder fixture"); },
  epoch: { capture: () => ({}), isCurrent: () => true } };
const runs = createResearchRunsApi(ports);
const api = createRunHistoryApi(ports, { wire: createResearchRunWire(errors), decodeStatus: runs.decodeResearchRunStatus });
const timestamp = "2026-10-13T00:00:00.000Z";
const page = (data: Record<string, unknown> = {}) => ({ trace_id: "visibility-test", deployment_generation: "visibility-generation", data: {
  protocol: "eliotr.research-runs.v4", runs: [], saved_drafts: [], configuration_state: "INSTALLED", checked_at: timestamp,
  visibility_scan: { runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED" }, ...data,
} });
describe("Recent v4 explicit bounded visibility decoder", () => {
  it("round-trips independent incomplete and exhausted states without inventing completion", () => {
    const view = api.decodeResearchRunHistory(JSON.parse(JSON.stringify(page())), "visibility-generation");
    expect(view.visibility_scan).toEqual({ runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED" });
    expect(view.runs).toEqual([]); expect(view.saved_drafts).toEqual([]);
  });
  it("accepts a satisfied eight-visible run target independently of draft exhaustion", () => {
    const visible = Array.from({ length: 8 }, (_value, n) => ({ created_at: timestamp, status: {
      protocol: "eliotr.research-run-status.v1", workflow_instance_id: `visible-${n}`,
      investigation_ref: { id: "investigation-visible", revision: 1 }, execution_state: "ACTIVE", next_stage_index: 0,
      answer: { availability: "unavailable" },
    } }));
    expect(api.decodeResearchRunHistory(page({ runs: visible,
      visibility_scan: { runs: "TARGET_REACHED", saved_drafts: "SOURCE_EXHAUSTED" } })).runs).toHaveLength(8);
  });
  it.each([
    { visibility_scan: undefined },
    { visibility_scan: { runs: "COMPLETE", saved_drafts: "SOURCE_EXHAUSTED" } },
    { visibility_scan: { runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED", denied_operation_id: "hidden" } },
    { visibility_scan: { runs: "TARGET_REACHED", saved_drafts: "SOURCE_EXHAUSTED" } },
    { protocol: "eliotr.research-runs.v3" },
  ])("rejects missing, foreign, inconsistent or legacy-carried v4 scan metadata %j", data => {
    expect(() => api.decodeResearchRunHistory(page(data))).toThrowError();
  });
});
