import { describe, expect, it } from "vitest";
import { createResearchRunWire } from "../runs/wire.js";
import { createResearchRunsApi, type ResearchRunRequest } from "../runs/authority.js";
import { createRunHistoryApi } from "./history.js";
import type { LegacyErrorDetails, LegacyErrorFactory } from "../../legacy/http.js";
import type { SessionEpoch } from "../../transport/session/epoch.js";

/**
 * Targeted boundaries for the moved run history. The status decoder and wire are the real accepted
 * RR modules, so these tests prove history reuses one decoder rather than carrying its own copy.
 */

const errors: LegacyErrorFactory = (details: LegacyErrorDetails) => Object.assign(new Error(details.message), details);

const thrown = (run: () => unknown): LegacyErrorDetails & Error => {
  try {
    run();
  } catch (error) {
    return error as LegacyErrorDetails & Error;
  }
  throw new Error("expected the call to throw");
};

const status = (id: string) => ({
  protocol: "eliotr.research-run-status.v1",
  workflow_instance_id: id,
  investigation_ref: { id: "investigation-1", revision: 1 },
  execution_state: "ENGINE_COMPLETED",
  engine_status: "complete",
  next_stage_index: 18,
  answer: { availability: "unavailable" },
});

const runEntry = (id: string, createdAt: string) => ({ created_at: createdAt, status: status(id) });

const historyFor = (data: Record<string, unknown>, deploymentGeneration = "deployment-1") => ({
  data,
  trace_id: "trace-1",
  deployment_generation: deploymentGeneration,
});

const baseData = (overrides: Record<string, unknown> = {}) => ({
  protocol: "eliotr.research-runs.v3",
  runs: [runEntry("run-1", "2026-10-09T12:00:00.000Z")],
  saved_drafts: [],
  configuration_state: "INSTALLED",
  checked_at: "2026-10-09T12:00:00.000Z",
  ...overrides,
});

const wire = createResearchRunWire(errors);

/** The accepted RR status decoder, built once and reused. */
const runs = createResearchRunsApi({
  request: (async () => {
    throw new Error("unused request");
  }) as unknown as ResearchRunRequest,
  errors,
  epoch: { capture: () => ({}), isCurrent: () => true },
});

const decodeOnly = () => createRunHistoryApi(
  {
    request: (async () => { throw new Error("decode-only call must not touch the transport"); }) as unknown as ResearchRunRequest,
    errors,
    epoch: { capture: () => ({}), isCurrent: () => true },
  },
  { wire, decodeStatus: runs.decodeResearchRunStatus },
);

const liveEpoch = (): { readonly epoch: SessionEpoch; advance(): void } => {
  let stamp: object | undefined = {};
  const epoch: SessionEpoch = {
    capture: () => stamp,
    isCurrent: (capture: unknown) => capture === stamp,
    advance: () => { stamp = {}; return stamp; },
    close: () => { stamp = undefined; },
    dispose: () => { stamp = undefined; },
  };
  return { epoch, advance: () => { stamp = {}; } };
};

describe("history decoder boundaries", () => {
  it("accepts a v3 page carrying saved drafts", () => {
    expect(decodeOnly().decodeResearchRunHistory(historyFor(baseData()), "deployment-1"))
      .toMatchObject({ protocol: "eliotr.research-runs.v3", configuration_state: "INSTALLED" });
  });

  it("keeps v5 run rows when a historical ledger query is absent and preserves present questions", () => {
    const visibility_scan = { runs: "BUDGET_STOPPED", saved_drafts: "SOURCE_EXHAUSTED" };
    const query = "How did the saved source revisions change this evidence?";
    const withQuestion = historyFor(baseData({ protocol: "eliotr.research-runs.v5", visibility_scan,
      runs: [{ ...runEntry("run-question", "2026-10-09T12:00:00.000Z"), query }] }));
    expect(decodeOnly().decodeResearchRunHistory(withQuestion, "deployment-1").runs[0]?.query).toBe(query);

    const withoutLedger = historyFor(baseData({ protocol: "eliotr.research-runs.v5", visibility_scan,
      runs: [runEntry("run-without-ledger", "2026-10-09T12:00:00.000Z")] }));
    const decoded = decodeOnly().decodeResearchRunHistory(withoutLedger, "deployment-1");
    expect(decoded.runs).toHaveLength(1);
    expect(decoded.runs[0]).not.toHaveProperty("query");
  });

  it("decodes v6 saved-draft questions only with a verified workflow binding", () => {
    const api = decodeOnly();
    const visibility_scan = { runs: "SOURCE_EXHAUSTED", saved_drafts: "SOURCE_EXHAUSTED" };
    const query = "Why did the saved source revisions change?";
    const valid = historyFor(baseData({ protocol: "eliotr.research-runs.v6", visibility_scan,
      saved_drafts: [{ created_at: "2026-10-09T12:00:00.000Z", artifact_ref: { id: "draft-1", revision: 1 },
        workflow_instance_id: "run-1", query }] }));
    expect(api.decodeResearchRunHistory(valid).saved_drafts[0]?.query).toBe(query);

    const noWorkflowBinding = historyFor(baseData({ protocol: "eliotr.research-runs.v6", visibility_scan,
      saved_drafts: [{ created_at: "2026-10-09T12:00:00.000Z", artifact_ref: { id: "draft-1", revision: 1 }, query }] }));
    expect(thrown(() => api.decodeResearchRunHistory(noWorkflowBinding)))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });

    const invalidQuery = historyFor(baseData({ protocol: "eliotr.research-runs.v6", visibility_scan,
      saved_drafts: [{ created_at: "2026-10-09T12:00:00.000Z", artifact_ref: { id: "draft-1", revision: 1 },
        workflow_instance_id: "run-1", query: "" }] }));
    expect(thrown(() => api.decodeResearchRunHistory(invalidQuery)))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });

    const v5WithNewField = historyFor(baseData({ protocol: "eliotr.research-runs.v5", visibility_scan,
      saved_drafts: [{ created_at: "2026-10-09T12:00:00.000Z", artifact_ref: { id: "draft-1", revision: 1 },
        workflow_instance_id: "run-1", query }] }));
    expect(thrown(() => api.decodeResearchRunHistory(v5WithNewField)))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
  });

  it("caps runs and rejects a duplicate run id", () => {
    const api = decodeOnly();
    const many = historyFor(baseData({ runs: Array.from({ length: 9 }, (_unused, index) =>
      runEntry(`run-${index}`, "2026-10-09T12:00:00.000Z")) }));
    expect(thrown(() => api.decodeResearchRunHistory(many, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID", status: 502, retryable: false });
    const duplicate = historyFor(baseData({ runs: [
      runEntry("run-1", "2026-10-09T12:00:00.000Z"),
      runEntry("run-1", "2026-10-09T13:00:00.000Z"),
    ] }));
    expect(thrown(() => api.decodeResearchRunHistory(duplicate, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
  });

  it("requires saved drafts from v2 and caps them", () => {
    const api = decodeOnly();
    const { saved_drafts: _omitted, ...withoutDrafts } = baseData();
    const missing = historyFor({ ...withoutDrafts, protocol: "eliotr.research-runs.v2" });
    expect(thrown(() => api.decodeResearchRunHistory(missing, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
    const oversize = historyFor(baseData({ saved_drafts: Array.from({ length: 9 }, (_unused, index) => ({
      created_at: "2026-10-09T12:00:00.000Z", artifact_ref: { id: `artifact-${index}`, revision: 1 },
    })) }));
    expect(thrown(() => api.decodeResearchRunHistory(oversize, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
  });

  it("accepts current-authorized history from a newer backend generation", () => {
    const api = decodeOnly();
    expect(api.decodeResearchRunHistory(historyFor(baseData(), "deployment-2"), "deployment-1"))
      .toMatchObject({ protocol: "eliotr.research-runs.v3", deployment_generation: "deployment-2" });
  });

  it("rejects an invalid draft artifact reference", () => {
    const api = decodeOnly();
    const foreign = historyFor(baseData({ saved_drafts: [{
      created_at: "2026-10-09T12:00:00.000Z", artifact_ref: { id: "artifact-1", revision: 0 },
    }] }));
    expect(thrown(() => api.decodeResearchRunHistory(foreign, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
  });

  it("rejects a malformed run status through the shared decoder", () => {
    const api = decodeOnly();
    const broken = historyFor(baseData({
      runs: [{ created_at: "2026-10-09T12:00:00.000Z", status: { ...status("run-1"), execution_state: "BOGUS" } }],
    }));
    expect(thrown(() => api.decodeResearchRunHistory(broken, "deployment-1")))
      .toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID", status: 502 });
  });
});

describe("history transport fence across a deferred request", () => {
  it("never dispatches when the epoch is already closed or missing", async () => {
    let calls = 0;
    const request = (async () => {
      calls += 1;
      return historyFor(baseData());
    }) as unknown as ResearchRunRequest;
    const closedEpoch: SessionEpoch = {
      capture: () => undefined,
      isCurrent: () => false,
      advance: () => ({}),
      close: () => undefined,
      dispose: () => undefined,
    };
    const api = createRunHistoryApi({ request, errors, epoch: closedEpoch },
      { wire, decodeStatus: runs.decodeResearchRunStatus });
    await expect(api.readResearchRunHistory("deployment-1"))
      .rejects.toMatchObject({ code: "API_SESSION_CLOSED", status: 503, retryable: false, traceId: null });
    expect(calls).toBe(0);
  });

  it("rejects a decoded but stale page when the epoch closed during the request", async () => {
    let release: (value: unknown) => void = () => undefined;
    const inFlight = new Promise<unknown>((resolve) => { release = resolve; });
    const { epoch, advance } = liveEpoch();
    const api = createRunHistoryApi(
      { request: () => inFlight, errors, epoch },
      { wire, decodeStatus: runs.decodeResearchRunStatus },
    );
    const pending = api.readResearchRunHistory("deployment-1");
    advance();
    release(historyFor(baseData()));
    await expect(pending).rejects.toMatchObject({
      code: "API_SESSION_CLOSED",
      status: 503,
      retryable: false,
      traceId: null,
    });
  });

  it("returns the decoded page while the epoch stays current", async () => {
    const { epoch } = liveEpoch();
    let seenPath = "";
    let seenInit: RequestInit | undefined;
    const api = createRunHistoryApi(
      {
        request: ((path: string, init: RequestInit | undefined) => {
          seenPath = path;
          seenInit = init;
          return Promise.resolve(historyFor(baseData()));
        }) as unknown as ResearchRunRequest,
        errors,
        epoch,
      },
      { wire, decodeStatus: runs.decodeResearchRunStatus },
    );
    await expect(api.readResearchRunHistory("deployment-1"))
      .resolves.toMatchObject({ protocol: "eliotr.research-runs.v3" });
    expect(seenPath).toBe("/api/v1/research/runs?format=v6");
    expect(Object.keys(seenInit as object)).not.toContain("method");
  });

  it("does not reject a current-authorized history response when the UI bundle generation is older", async () => {
    const { epoch } = liveEpoch();
    const api = createRunHistoryApi({
      request: (() => Promise.resolve(historyFor(baseData(), "deployment-2"))) as unknown as ResearchRunRequest,
      errors,
      epoch,
    }, { wire, decodeStatus: runs.decodeResearchRunStatus });

    await expect(api.readResearchRunHistory("deployment-1"))
      .resolves.toMatchObject({ deployment_generation: "deployment-2", runs: [{ status: { workflow_instance_id: "run-1" } }] });
  });
});
