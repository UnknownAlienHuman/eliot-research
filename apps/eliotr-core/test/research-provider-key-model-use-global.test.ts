import { applyD1Migrations, env as generatedEnv } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL, SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL } from "@eliotr/contracts";
import { createServiceModelProviderService, type ServiceModelProviderManagementPort } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { readConfiguredProviderKeyOperation } from "@eliotr/cloudflare-model-control/research-provider-key-configured-operation.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { createGlobalServiceProviderKeyConfiguration } from "../src/research-provider-key-model-use-composition.js";
import { createResearchProviderKeyConfigurationService } from "../src/research-provider-key-configuration-service.js";
import { createResearchProviderKeyModelUseService } from "../src/research-provider-key-model-use-service.js";
import { createResearchProviderKeyModelUseBasis } from "../src/research-provider-key-model-use-plan.js";
import { createOwnerResearchProjectConfigurationService } from "../src/research-project-configuration-composition.js";
import { createNativeUseEnvironment, freeOnlyCatalogResponse, MODEL_ID } from "./research-provider-key-model-use-fixture.js";

const DOTS = "dots-studio/dots-3-note-preview:free";
const env = generatedEnv as unknown as Env & { CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(env.CORE_DB, env.CORE_MIGRATIONS); });
afterEach(() => { vi.unstubAllGlobals(); });

async function setup(modelIds: readonly string[]) {
  const owner = `global-dots-owner-${crypto.randomUUID()}`;
  const project = `global-dots-project-${crypto.randomUUID()}`;
  const created = new Date().toISOString();
  await env.CORE_DB.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES (?1,'Global Dots test','private','retention','source','profile','depth',1,?2)",
  ).bind(project, created).run();
  await env.CORE_DB.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES (?1,?2,'global-dots',?3,?3)",
  ).bind(project, owner, created).run();
  const context: AuthenticatedRequestContext = {
    request: new Request("https://core.example/owner"), principal_ref: owner, client_class: "owner_pwa",
    credential_generation: `credential-${crypto.randomUUID()}`, trace_id: crypto.randomUUID(),
  };
  const installed = await createNativeUseEnvironment(owner, env.CORE_DB, { ...env, ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "global-dots", AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
  });
  const { ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON: _unusedPolicy, ...withoutPerModelPolicy } = installed;
  void _unusedPolicy;
  const runtimeEnv = withoutPerModelPolicy as Env;
  const global = createServiceModelProviderService({ database: env.CORE_DB, managementPort: {
    available: true,
    create: vi.fn(async (input: Parameters<ServiceModelProviderManagementPort["create"]>[0]) =>
      ({ provider_config_id: `config-${input.operation_id}`, provider_slug: "openrouter", alias: input.alias })),
    read: vi.fn(async () => null),
  } });
  const keyId = crypto.randomUUID();
  await global.create(context, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operation_id: keyId,
    provider_id: "openrouter", display_name: "OpenRouter", model_ids: [...modelIds], api_key: "synthetic-global-key-never-sent" });
  const configuration = createOwnerResearchProjectConfigurationService(runtimeEnv, context, project);
  const keys = createGlobalServiceProviderKeyConfiguration({ env: runtimeEnv, project_id: project, project_configuration: configuration,
    project_keys: createResearchProviderKeyConfigurationService({ database: env.CORE_DB }), service_models: global });
  return { owner, project, context, runtimeEnv, global, keyId, configuration, keys };
}

describe("registered global model check-and-use", () => {
  it("uses real price/qualification/selection services with mocked I/O for exact global Dots pins", async () => {
    const fixture = await setup([DOTS]);
    const pricing = vi.fn(async (_resource: RequestInfo | URL) => freeOnlyCatalogResponse(DOTS));
    vi.stubGlobal("fetch", pricing);
    const requests: Array<{ model: string; provider: unknown }> = [];
    const aliases: Array<string | null> = [];
    const modelFetch: typeof fetch = async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      requests.push(JSON.parse(String(init?.body)) as { model: string; provider: unknown });
      aliases.push(new Headers(init?.headers).get("cf-aig-byok-alias"));
      return new Response(JSON.stringify({ id: `mock-dots-${requests.length}`, object: "chat.completion", created: 1_759_000_000,
        model: DOTS, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
          content: JSON.stringify({ connected: true, qualification_purpose: "structured-output-connectivity" }) } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }), { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": `mock-dots-log-${requests.length}` } });
    };
    const service = createResearchProviderKeyModelUseService({ env: fixture.runtimeEnv, context: fixture.context, project_id: fixture.project,
      key_configuration: fixture.keys, project_configuration: fixture.configuration, fetcher: modelFetch });
    const request = { protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL, operation_id: crypto.randomUUID(), expected_selection_revision: null };
    await service.start(fixture.keyId, request);
    const selectedReceipt = await service.start(fixture.keyId, request);
    expect(selectedReceipt.state).toBe("selected");
    expect(requests).toHaveLength(2);
    expect(requests.every((body) => body.model === DOTS)).toBe(true);
    expect(requests[0]?.provider).toEqual({ max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, allow_fallbacks: false });
    const key = await fixture.keys.readConfiguredOperation(fixture.context, fixture.project, fixture.keyId);
    expect(aliases).toEqual([key.alias, key.alias]);
    expect(pricing.mock.calls).toHaveLength(2);
    expect(pricing.mock.calls.every((call) => String(call[0]) ===
      "https://openrouter.ai/api/v1/models/dots-studio/dots-3-note-preview%3Afree/endpoints")).toBe(true);
    const selected = await fixture.configuration.readSelected(fixture.context, fixture.project);
    expect(selected?.configuration.model_selections.every((entry) => entry.transport_policy.model === DOTS)).toBe(true);
    expect(await readConfiguredProviderKeyOperation(env.CORE_DB, fixture.owner, fixture.project, fixture.keyId))
      .toMatchObject({ status: "configured", operation: { model_registry: { operation_id: fixture.keyId, model_ids: [DOTS] } } });
    expect(await env.CORE_DB.prepare("SELECT count(*) AS n FROM research_provider_key_configuration_operation WHERE project_id=?1")
      .bind(fixture.project).first()).toEqual({ n: 0 });
    await service.start(fixture.keyId, request);
    expect(requests).toHaveLength(2);
    expect(pricing).toHaveBeenCalledTimes(2);
    const nextId = crypto.randomUUID();
    await fixture.global.create(fixture.context, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operation_id: nextId,
      provider_id: "openrouter", display_name: "Multiple models", model_ids: [DOTS, MODEL_ID], api_key: "synthetic-second-key" });
    const nextKey = await fixture.keys.readConfiguredOperation(fixture.context, fixture.project, nextId);
    const nextBasis = await createResearchProviderKeyModelUseBasis({ env: fixture.runtimeEnv, selected, key: nextKey,
      operation_id: crypto.randomUUID(), database: env.CORE_DB });
    expect(nextBasis.stages.every((stage) => stage.transport_policy.model === DOTS && stage.transport_policy.billing.mode === "byok" &&
      stage.transport_policy.billing.alias === nextKey.alias)).toBe(true);
  }, 15_000);

  it("rejects ambiguous registered models before any price read, model dispatch or use intent", async () => {
    const fixture = await setup([DOTS, MODEL_ID]);
    const pricing = vi.fn(); const model = vi.fn(); vi.stubGlobal("fetch", pricing);
    const service = createResearchProviderKeyModelUseService({ env: fixture.runtimeEnv, context: fixture.context, project_id: fixture.project,
      key_configuration: fixture.keys, project_configuration: fixture.configuration, fetcher: model });
    await expect(service.start(fixture.keyId, { protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL, operation_id: crypto.randomUUID(),
      expected_selection_revision: null })).rejects.toMatchObject({ code: "PROVIDER_KEY_MODEL_USE_SERVER_POLICY_UNAVAILABLE" });
    expect(pricing).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
    expect(await env.CORE_DB.prepare("SELECT count(*) AS n FROM research_provider_key_model_use_operation WHERE project_id=?1")
      .bind(fixture.project).first()).toEqual({ n: 0 });
  });
});
