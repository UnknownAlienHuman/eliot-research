import { applyD1Migrations, env as generatedEnv } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createServiceModelProviderService } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { decodeResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { handleResearchModelCatalog } from "../src/research-model-catalog-http.js";
import { createResearchCatalogModelUseComposition } from "../src/research-catalog-model-use-composition.js";
import { createOwnerResearchProjectConfigurationService } from "../src/research-project-configuration-composition.js";
import { createResearchSemanticNativeModelRuntime } from "../src/research-semantic-native-model-runtime.js";
import { createNativeUseEnvironment } from "./research-provider-key-model-use-fixture.js";
import type { Env } from "../src/env.js";

const testEnv = generatedEnv as unknown as Env & { CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const provider = `compatible-${"a".repeat(24)}`, physical = `custom-${provider}`;
const model = "vendor/catalog-model", base = "https://openrouter.ai/api/v1";
const gateway = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;
const record = '{ "id": "vendor/catalog-model", "cost": { "input": 0.1, "output": 0.2 }, "reasoning": false, "structured_output": false }';
const source = `{ "openrouter": { "id": "openrouter", "npm": "@openrouter/ai-sdk-provider", "api": "${base}", "models": { "${model}": ${record} } } }`;
beforeAll(async () => { await applyD1Migrations(testEnv.CORE_DB, testEnv.CORE_MIGRATIONS); });
afterEach(() => { vi.unstubAllGlobals(); });

async function fixture(registeredBase = base, catalogSource = source) {
  const owner = `generic-owner-${crypto.randomUUID()}`, project = `generic-project-${crypto.randomUUID()}`;
  const providerOperation = crypto.randomUUID(), operation = crypto.randomUUID(), created = new Date().toISOString();
  const context: AuthenticatedRequestContext = { request: new Request("https://owner.example/owner", { method: "POST" }),
    principal_ref: owner, client_class: "owner_pwa", credential_generation: "generic-credential-1", trace_id: crypto.randomUUID() };
  await testEnv.CORE_DB.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES (?1,'Generic','private','retention','source','profile','depth',1,?2)")
    .bind(project, created).run();
  await testEnv.CORE_DB.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES (?1,?2,'generic-test',?3,?3)")
    .bind(project, owner, created).run();
  const providers = createServiceModelProviderService({ database: testEnv.CORE_DB, managementPort: { available: true,
    create: async input => ({ provider_config_id: `generic-config-${providerOperation}`, provider_slug: physical, alias: input.alias }),
    read: async () => null } });
  const saved = await providers.create(context, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operation_id: providerOperation,
    provider_id: provider, display_name: "Existing generic OpenRouter", base_url: base, model_ids: ["legacy/model"],
    api_key: "synthetic-generic-provider-secret-for-test" });
  const installed = await createNativeUseEnvironment(owner, testEnv.CORE_DB, { ...testEnv, ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "generic-test", AI_GATEWAY_REASONING_URL: gateway, ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN: "synthetic-existing-control" });
  const requests: Array<{ url: string; alias: string | null; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init), url = request.url;
    if (url.startsWith("https://api.cloudflare.com/")) return Response.json({ success: true,
      result: [{ slug: physical, base_url: registeredBase, enable: true }], result_info: { page: 1, total_count: 1 } });
    if (url === `${base}/models`) {
      expect([...request.headers]).toEqual([["accept", "application/json"]]);
      return Response.json({ data: [{ id: model, architecture: { output_modalities: ["text"] } }] });
    }
    if (url === "https://models.dev/api.json") return new Response(catalogSource, { headers: { "content-type": "application/json" } });
    if (url !== `${gateway}/custom-${physical}/chat/completions`) throw new Error("Unapproved endpoint");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, alias: request.headers.get("cf-aig-byok-alias"), body });
    return Response.json({ id: `generic-probe-${requests.length}`, object: "chat.completion", created: 1760000000, model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ connected: true,
        qualification_purpose: "structured-output-connectivity" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }, { headers: { "cf-aig-log-id": `generic-log-${requests.length}` } });
  });
  vi.stubGlobal("fetch", fetcher);
  const api = createResearchCatalogModelUseComposition(installed, context, project);
  const start = () => api.start({ protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: operation,
    expected_selection_revision: null, provider_id: provider, provider_operation_id: providerOperation, model_id: model });
  return { owner, project, providerOperation, operation, context, saved, installed, requests, fetcher, api, start };
}

describe("generic OpenRouter catalog to exact qualified selection", () => {
  it("uses the actual HTTP catalog, v2 driver, immutable prices and native pin reader without changing connection identity", async () => {
    const f = await fixture();
    const response = await handleResearchModelCatalog(new Request(`https://owner.example/api/v1/system/research-models?provider_id=${provider}`), f.installed, f.context);
    expect(response.status).toBe(200);
    const catalog = await response.json() as { data: { provider_id: string; models: Array<{ provider_id: string; model_id: string }> } };
    expect(catalog.data).toMatchObject({ provider_id: provider, models: [{ provider_id: provider, model_id: model }] });
    const receipt = await f.start();
    expect(receipt).toMatchObject({ state: "selected", phase: "complete", provider_id: provider,
      provider_operation_id: f.providerOperation, model_id: model, failure_code: null });
    const before = f.requests.length;
    const page = await createOwnerResearchProjectConfigurationService(f.installed, f.context, f.project).readPage(f.context, f.project, { limit: 50 });
    expect(page.selected).toMatchObject({ qualification_state: "qualified", configuration_ref: receipt.selected_configuration_ref,
      configuration_sha256: receipt.selected_configuration_sha256 });
    expect(page.selected?.model_selections.find(selection => selection.stage === "SYNTHESIZE")).toMatchObject({
      provider_id: physical, model_id: model,
    });
    const savedJson = await testEnv.CORE_DB.prepare("SELECT configuration_json FROM research_project_model_configuration_revision WHERE configuration_ref=?1")
      .bind(receipt.selected_configuration_ref).first<string>("configuration_json");
    if (savedJson === null) throw new Error("Missing qualified configuration");
    const { bundle } = await decodeResearchProjectModelConfigurationBundle(JSON.parse(savedJson));
    expect(bundle.model_selections.find(selection => selection.stage === "SYNTHESIZE")).toMatchObject({
      candidate_kind: "provider-native-v2",
      transport_policy: { provider: physical, model, billing: { alias: f.saved.receipt.alias } },
    });
    const native = createResearchSemanticNativeModelRuntime({ env: f.installed, owner_ref: f.owner,
      run_configuration: { mode: "snapshot-v2", configuration_ref: receipt.selected_configuration_ref,
        configuration_sha256: receipt.selected_configuration_sha256, project_owner_ref: f.owner,
        project_id: f.project, model_selections: bundle.model_selections } });
    expect(await native.resolvePinned("SYNTHESIZE")).toMatchObject({ selection: { candidate_kind: "provider-native-v2" },
      proof: { qualification: { provider_id: provider, provider_slug: physical, model_id: model,
        provider_operation_id: f.providerOperation } } });
    expect(f.requests.length).toBe(before);
    expect(f.requests.length).toBeGreaterThan(0);
    for (const request of f.requests) {
      expect(request).toMatchObject({ url: `${gateway}/custom-${physical}/chat/completions`, alias: f.saved.receipt.alias,
        body: { model, response_format: { type: "json_object" } } });
    }
    const prices = await testEnv.CORE_DB.prepare("SELECT snapshot_json FROM research_model_pricing_snapshot WHERE approval_receipt_ref=?1")
      .bind(f.operation).all<{ snapshot_json: string }>();
    const consent = await testEnv.CORE_DB.prepare("SELECT request_sha256,configuration_metadata_sha256 FROM research_catalog_model_use_authorization WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3")
      .bind(f.owner, f.project, f.operation).first<{ request_sha256: string; configuration_metadata_sha256: string }>();
    expect(consent).not.toBeNull();
    expect(prices.results.length).toBeGreaterThan(0);
    for (const price of prices.results) expect(JSON.parse(price.snapshot_json)).toMatchObject({ catalog_metadata: {
      provider_id: provider, provider_slug: physical, provider_operation_id: f.providerOperation,
      request_sha256: consent?.request_sha256, configuration_metadata_sha256: consent?.configuration_metadata_sha256,
      consent_operation_id: f.operation, alias: f.saved.receipt.alias, source_provider_id: "openrouter",
      source_url: "https://models.dev/api.json", source_sha256: await modelGatewaySha256(source),
      model_record_sha256: await modelGatewaySha256(record), model_id: model,
      advertised_sdk: "@openrouter/ai-sdk-provider", rates_usd_per_1k_tokens: { input: "0.0001", output: "0.0002" },
    } });
    const connection = await testEnv.CORE_DB.prepare("SELECT provider_id,provider_slug,model_ids_json,base_url,alias FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2")
      .bind(f.owner, f.providerOperation).first();
    expect(connection).toMatchObject({ provider_id: provider, provider_slug: physical, base_url: base,
      model_ids_json: JSON.stringify(["legacy/model"]), alias: f.saved.receipt.alias });
    await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "selected", provider_id: provider });
    expect(f.requests.length).toBe(before);
  }, 30_000);

  it("blocks an unknown registered endpoint before catalog pricing or qualification", async () => {
    const f = await fixture("https://evil.example/api/v1");
    const receipt = await f.start();
    expect(receipt.state).toBe("blocked"); expect(receipt.selected_configuration_ref).toBeNull();
    expect(receipt.failure_code).toBe("MODEL_NOT_SUPPORTED");
    expect(f.requests).toHaveLength(0);
    expect(f.fetcher.mock.calls.some(call => String(call[0]) === "https://models.dev/api.json")).toBe(false);
  }, 30_000);

  it("does not qualify from a mismatched exact source provider record", async () => {
    const f = await fixture(base, source.replace('"id": "openrouter"', '"id": "someone-else"'));
    const receipt = await f.start();
    expect(receipt.state).toBe("blocked"); expect(receipt.selected_configuration_ref).toBeNull();
    expect(f.requests).toHaveLength(0);
  }, 30_000);

  it.each(["@ai-sdk/google", "@ai-sdk/anthropic"])("rejects incompatible OpenRouter SDK %s before qualification", async sdk => {
    const f = await fixture(base, source.replace("@openrouter/ai-sdk-provider", sdk));
    const receipt = await f.start();
    expect(receipt).toMatchObject({ state: "blocked", selected_configuration_ref: null, failure_code: "MODEL_NOT_SUPPORTED" });
    expect(f.requests).toHaveLength(0);
  }, 30_000);
});
