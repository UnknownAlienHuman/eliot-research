import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@eliotr/pwa-http-client";
import { decodeResearchRunHistory } from "./research-run-api.js";
import { historyStatusText } from "./research-run-view.js";
import type { ResearchRunHistoryView } from "./research-run-api.js";

const generation = "history-generation";
const checkedAt = "2026-10-13T00:00:00.000Z";

type Visibility = NonNullable<ResearchRunHistoryView["visibility_scan"]>;
function history(protocol: ResearchRunHistoryView["protocol"], visibility?: Visibility, runs: unknown[] = []): unknown {
  return {
    trace_id: "pwa-history-v4-test",
    deployment_generation: generation,
    data: {
      protocol,
      runs,
      saved_drafts: [],
      configuration_state: "INSTALLED",
      checked_at: checkedAt,
      ...(visibility === undefined ? {} : { visibility_scan: visibility }),
    },
  };
}

describe("PWA adapter for shared v4 history", () => {
  it("claims no saved history only when both v4 sources are exhausted", () => {
    const incomplete = decodeResearchRunHistory(history("eliotr.research-runs.v4", {
      runs: "BUDGET_STOPPED",
      saved_drafts: "SOURCE_EXHAUSTED",
    }));
    expect(incomplete.runs).toEqual([]);
    expect(incomplete.saved_drafts).toEqual([]);
    expect(historyStatusText(incomplete)).toBe("No saved runs or drafts are visible in this response.");

    const complete = decodeResearchRunHistory(history("eliotr.research-runs.v4", {
      runs: "SOURCE_EXHAUSTED",
      saved_drafts: "SOURCE_EXHAUSTED",
    }));
    expect(historyStatusText(complete)).toBe("No saved research runs or drafts were found.");

    const malformed = history("eliotr.research-runs.v4", {
      runs: "BUDGET_STOPPED",
      saved_drafts: "SOURCE_EXHAUSTED",
    }, []);
    (malformed as { data: { visibility_scan: Record<string, unknown> } }).data.visibility_scan.owner = "private";
    expect(() => decodeResearchRunHistory(malformed)).toThrow(ApiRequestError);
  });

  it.each([
    "eliotr.research-runs.v1",
    "eliotr.research-runs.v2",
    "eliotr.research-runs.v3",
  ] as const)("preserves empty %s decoding without asserting absence", (protocol) => {
    const view = decodeResearchRunHistory(history(protocol));
    expect(view.protocol).toBe(protocol);
    expect(view.visibility_scan).toBeUndefined();
    expect(historyStatusText(view)).toBe("No saved runs or drafts are visible in this response.");
  });

  it("uses the existing PWA status decoder for history entries", () => {
    const view = decodeResearchRunHistory(history("eliotr.research-runs.v4", {
      runs: "SOURCE_EXHAUSTED",
      saved_drafts: "SOURCE_EXHAUSTED",
    }, [{
      created_at: checkedAt,
      status: {
        protocol: "eliotr.research-run-status.v1",
        workflow_instance_id: "run-1",
        investigation_ref: { id: "investigation-1", revision: 1 },
        execution_state: "ACTIVE",
        next_stage_index: 0,
        answer: { availability: "unavailable" },
      },
    }]));
    expect(view.runs[0]?.status.workflow_instance_id).toBe("run-1");
    expect(view.runs[0]?.status.engine_status).toBe("unknown");
  });
  it("shares strict v2 outcomes and consequences even through the legacy default decoder", () => {
    const consequence = { code: "WORKFLOW_BUDGET_STOP", phase: "STAGE", stage: "PLAN", retryable: false };
    const failure = { code: "WORKFLOW_EFFECT_UNCERTAIN", phase: "RECOVERY", stage: "RECONCILE", retryable: false,
      protocol: "eliotr.workflow-failure-outcome.v1", dispatch_state: "OUTCOME_UNKNOWN", references_intact: "UNKNOWN",
      recovery_action: "READBACK", consequence, consequences: [consequence] };
    const run = { created_at: checkedAt, status: { protocol: "eliotr.research-run-status.v2", workflow_instance_id: "run-2",
      investigation_ref: { id: "investigation-2", revision: 2 }, execution_state: "ACTIVE", engine_status: "errored",
      next_stage_index: 3, answer: { availability: "unavailable" }, failure } };
    const view = decodeResearchRunHistory(history("eliotr.research-runs.v4", {
      runs: "SOURCE_EXHAUSTED", saved_drafts: "SOURCE_EXHAUSTED",
    }, [run]));
    expect(view.runs[0]?.status.failure).toEqual(failure);
    expect(() => decodeResearchRunHistory(history("eliotr.research-runs.v4", {
      runs: "SOURCE_EXHAUSTED", saved_drafts: "SOURCE_EXHAUSTED",
    }, [{ ...run, status: { ...run.status, failure: { ...failure, dispatch_state: undefined } } }]))).toThrow(ApiRequestError);
  });
});
