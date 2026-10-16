import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type * as ResearchModule from "@eliotr/research";
import type { Env } from "../src/env.js";
import { createResearchRunService } from "../src/research-run-service.js";
import { ResearchServiceError } from "../src/research-service-error.js";

const mocks = vi.hoisted(() => ({
  assertPin: vi.fn(),
  assertBuiltin: vi.fn(),
  readByIdempotency: vi.fn(),
  prepareScope: vi.fn(),
  loadPlanningSources: vi.fn(),
  persistPayload: vi.fn(),
  persistRun: vi.fn(),
  dispatchRun: vi.fn(),
}));

vi.mock("../src/research-run-configuration-admission.js", () => ({
  assertCurrentInstalledNativeResearchModel: mocks.assertBuiltin,
  assertCurrentResearchRunConfigurationPin: mocks.assertPin,
  resolveResearchRunAdmissionConfiguration: vi.fn(),
}));

vi.mock("../src/research-run-admission.js", () => ({
  prepareResearchRunScope: mocks.prepareScope,
  loadResearchPlanningSources: mocks.loadPlanningSources,
}));

vi.mock("@eliotr/research", async (importOriginal) => {
  const actual = await importOriginal<typeof ResearchModule>();
  return { ...actual, createD1InvestigationLedgerStore: () => ({ readByIdempotency: mocks.readByIdempotency }) };
});

vi.mock("@eliotr/cloudflare-research-runtime/research-session-application.js", () => ({
  createResearchQueryApplication: vi.fn(),
  dispatchResearchSessionRunApplication: mocks.dispatchRun,
  persistResearchSessionRunPayload: mocks.persistPayload,
  persistResearchSessionRunApplication: mocks.persistRun,
}));

describe("research run v4 stale-pin admission boundary", () => {
  beforeEach(() => {
    mocks.assertPin.mockReset().mockRejectedValue(
      new ResearchServiceError("RESEARCH_AUTHORITY_STALE", "selected model changed", 409),
    );
    mocks.assertBuiltin.mockReset().mockRejectedValue(
      new ResearchServiceError("RESEARCH_AUTHORITY_STALE", "installed model changed", 409),
    );
    mocks.readByIdempotency.mockReset().mockResolvedValue(null);
    mocks.prepareScope.mockReset();
    mocks.loadPlanningSources.mockReset();
    mocks.persistPayload.mockReset();
    mocks.persistRun.mockReset();
    mocks.dispatchRun.mockReset();
  });

  it("rejects the stale selection before scope freeze, payload/snapshot persistence, or workflow dispatch", async () => {
    const database = {
      prepare: (query: string) => ({
        first: async <T,>() => query.includes("schema_state")
          ? "research-question-v2-utf8-envelopes" as T
          : null,
      }),
    } as unknown as D1Database;
    const env = { CORE_DB: database, DEPLOYMENT_GENERATION: "deployment-v4-test" } as Env;
    const context = {
      principal_ref: "owner-v4-test",
      credential_generation: "credential-v4-test",
      client_class: "owner_pwa",
      request: new Request("https://owner.example/api/v1/research/run", {
        method: "POST", headers: { "idempotency-key": "run-v4-stale-pin" },
      }),
    } as AuthenticatedRequestContext;
    const body = {
      query: "Compare the selected sources",
      product: "RESEARCH",
      scope_expression: { kind: "GLOBAL_LIBRARY" },
      literals: [],
      evidence_grade: "E0",
      budget_ref: "research-budget-v1",
      max_results: 8,
      request_version: "eliotr.research-run-request.v4",
      selection: {
        configuration_project_id: "project-v4-test",
        configuration_ref: `rpmc-${"a".repeat(64)}`,
        configuration_sha256: "a".repeat(64),
        selection_revision: 3,
      },
    };

    await expect(createResearchRunService(env).run(context, body as unknown as QueryRequest))
      .rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE", status: 409 });
    expect(mocks.assertPin).toHaveBeenCalledOnce();
    expect(mocks.prepareScope).not.toHaveBeenCalled();
    expect(mocks.persistPayload).not.toHaveBeenCalled();
    expect(mocks.persistRun).not.toHaveBeenCalled();
    expect(mocks.dispatchRun).not.toHaveBeenCalled();
  });

  it("rejects a changed builtin model without consulting project configuration or dispatching", async () => {
    const database = {
      prepare: (query: string) => ({
        first: async <T,>() => query.includes("schema_state")
          ? "research-question-v2-utf8-envelopes" as T
          : null,
      }),
    } as unknown as D1Database;
    const env = { CORE_DB: database, DEPLOYMENT_GENERATION: "deployment-v4-test" } as Env;
    const context = {
      principal_ref: "owner-v4-test",
      credential_generation: "credential-v4-test",
      client_class: "owner_pwa",
      request: new Request("https://owner.example/api/v1/research/run", {
        method: "POST", headers: { "idempotency-key": "run-v4-builtin-stale" },
      }),
    } as AuthenticatedRequestContext;
    const body = {
      query: "Compare the selected sources",
      product: "RESEARCH",
      scope_expression: { kind: "GLOBAL_LIBRARY" },
      literals: [],
      evidence_grade: "E0",
      budget_ref: "research-budget-v1",
      max_results: 8,
      request_version: "eliotr.research-run-request.v4",
      selection: { kind: "builtin", expected_model_id: "@cf/meta/llama-3.1-8b-instruct" },
    };

    await expect(createResearchRunService(env).run(context, body as unknown as QueryRequest))
      .rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE", status: 409 });
    expect(mocks.assertBuiltin).toHaveBeenCalledOnce();
    expect(mocks.assertPin).not.toHaveBeenCalled();
    expect(mocks.prepareScope).not.toHaveBeenCalled();
    expect(mocks.persistPayload).not.toHaveBeenCalled();
    expect(mocks.persistRun).not.toHaveBeenCalled();
    expect(mocks.dispatchRun).not.toHaveBeenCalled();
  });
});
