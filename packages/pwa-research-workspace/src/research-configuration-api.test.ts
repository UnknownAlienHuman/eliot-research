import { afterEach, describe, expect, it, vi } from "vitest";
import { readResearchConfiguration } from "./research-configuration-api.js";

const deploymentGeneration = "deploy-1";

function apiResponse(): Response {
  return new Response(JSON.stringify({
    data: {
      protocol: "eliotr.research-configuration-readiness.v1",
      configuration: "present",
      model_transport: "available",
      qualification_state: "current",
      run_readiness: "ready",
      readiness_reason: "QUALIFICATION_PROOFS_CURRENT",
      model_route: "route/research",
      qualification_expires_at: "2026-10-04T12:00:00.000Z",
      missing_fields: [],
      invalid_fields: [],
      checked_at: "2026-10-03T12:00:00.000Z",
    },
    trace_id: "trace-1",
    deployment_generation: deploymentGeneration,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("project-scoped research readiness API", () => {
  it("passes the selected project ID as a query parameter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return apiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = await readResearchConfiguration(deploymentGeneration, { projectId: "project/one", signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as string;
    expect(request).toBe("/api/v1/system/research-configuration?project_id=project%2Fone");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
    expect(result.run_readiness).toBe("ready");
  });

  it("rejects malformed project IDs before sending a request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return apiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(readResearchConfiguration(deploymentGeneration, { projectId: "../other" }))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_ID_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
