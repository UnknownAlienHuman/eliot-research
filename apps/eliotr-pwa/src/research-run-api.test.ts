import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api.js";
import { decodeResearchRunStatus, researchRunBody, readResearchRunStatus, startResearchRun } from "./research-run-api.js";

const generation = "deployment-1";
const workflow = `run-${"a".repeat(48)}`;

function envelope(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ data, trace_id: "trace-1", deployment_generation: generation }), { status: 200, headers: { "content-type": "application/json" } });
}

function status(state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED" = "ENGINE_COMPLETED"): Record<string, unknown> {
  return { protocol: "eliotr.research-run-status.v1", workflow_instance_id: workflow, investigation_ref: { id: `research-${"b".repeat(48)}`, revision: 1 }, execution_state: state, next_stage_index: state === "ENGINE_COMPLETED" ? 18 : 3, answer: { availability: "unavailable" } };
}

afterEach(() => vi.unstubAllGlobals());

describe("research run transport", () => {
  it("builds the server-owned run DTO and reads status through the owner route", async () => {
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => path === "/api/v1/research/run" ? envelope({ investigation_ref: { id: `research-${"b".repeat(48)}`, revision: 1 }, workflow_instance_id: workflow }) : envelope(status()));
    vi.stubGlobal("fetch", fetch);
    const body = JSON.parse(researchRunBody("What changed?", ["source-1"]));
    expect(body).toMatchObject({ product: "RESEARCH", budget_ref: "research-budget-v1", max_results: 16, scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] } });
    await expect(startResearchRun(JSON.stringify(body), "run-key", generation)).resolves.toMatchObject({ workflow_instance_id: workflow });
    await expect(readResearchRunStatus(workflow, generation)).resolves.toMatchObject({ execution_state: "ENGINE_COMPLETED", answer: { availability: "unavailable" } });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/v1/research/run", expect.objectContaining({ method: "POST" }));
    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify(body), headers: expect.objectContaining({ "content-type": "application/json", "idempotency-key": "run-key" }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/v1/research/run/${workflow}`, expect.anything());
  });

  it("rejects answer claims, foreign generation, and malformed workflow IDs", async () => {
    const bad = status(); bad.answer = { availability: "available" };
    expect(() => decodeResearchRunStatus({ data: bad, trace_id: "trace-1", deployment_generation: generation })).toThrow(ApiRequestError);
    expect(() => decodeResearchRunStatus({ data: status(), trace_id: "trace-1", deployment_generation: "deployment-2" }, generation)).toThrowError(/Application changed/);
    await expect(readResearchRunStatus("../foreign", generation)).rejects.toMatchObject({ code: "RESEARCH_RUN_RESPONSE_INVALID" });
  });
});
