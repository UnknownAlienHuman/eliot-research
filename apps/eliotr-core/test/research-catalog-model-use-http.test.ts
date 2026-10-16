import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { handleResearchCatalogModelUseHttp } from "../src/research-catalog-model-use-http.js";
import type { ResearchCatalogModelUseService } from "../src/research-catalog-model-use-service.js";

const project = "catalog-project";
const operation = "11111111-1111-4111-8111-111111111111";
const current = {
  protocol: "eliotr.research.catalog-model-use-receipt.v1" as const,
  project_id: project, operation_id: operation, provider_id: "opencode-go",
  provider_operation_id: "22222222-2222-4222-8222-222222222222",
  model_id: "muse-spark-1.3-contributor", state: "uncertain" as const,
  phase: "qualification" as const, selected_configuration_ref: null,
  selected_configuration_sha256: null, selection_revision: null,
  failure_code: "QUALIFICATION_OUTCOME_UNCERTAIN" as const,
  created_at: "2026-10-16T20:00:00.000Z", updated_at: "2026-10-16T20:00:00.000Z",
};

describe("catalog operation discovery HTTP", () => {
  it.each([null, current])("reads the current operation without starting or probing a model", async receipt => {
    const service = { start: vi.fn(), read: vi.fn(), readCurrent: vi.fn(async () => receipt) } satisfies ResearchCatalogModelUseService;
    const request = new Request(`https://research.example/api/v1/research/projects/${project}/catalog-model-use`);
    const response = await handleResearchCatalogModelUseHttp(request, env as unknown as Env,
      {} as AuthenticatedRequestContext, project, null, 4096, service);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: receipt });
    expect(service.readCurrent).toHaveBeenCalledTimes(1);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.read).not.toHaveBeenCalled();
  });

  it("rejects a body declaration before calling the read service", async () => {
    const service = { start: vi.fn(), read: vi.fn(), readCurrent: vi.fn() } satisfies ResearchCatalogModelUseService;
    const request = new Request(`https://research.example/api/v1/research/projects/${project}/catalog-model-use`,
      { headers: { "content-length": "3" } });
    await expect(handleResearchCatalogModelUseHttp(request, env as unknown as Env,
      {} as AuthenticatedRequestContext, project, null, 4096, service))
      .rejects.toMatchObject({ code: "RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID" });
    expect(service.readCurrent).not.toHaveBeenCalled();
  });
});
