import { applyD1Migrations, env as generatedEnv } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createServiceModelProviderService, type ServiceModelProviderManagementPort } from
  "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import type { ResearchCatalogAdvertisedCapabilities } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-pricing.js";
import { createResearchCatalogModelUseComposition } from "../src/research-catalog-model-use-composition.js";
import { createResearchCatalogModelTransportPolicyV2 } from "../src/research-catalog-model-use-v2-driver.js";
import type { Env } from "../src/env.js";
import { createNativeUseEnvironment } from "./research-provider-key-model-use-fixture.js";

const MODEL = "muse-spark-1.3-contributor";
const DEPLOYMENT = "catalog-v2-test";
const LEGACY_GO_BASE = "https://opencode.ai/inference/go/v1";
const ADVERTISED_GO_BASE = "https://opencode.ai/inference/go/openai/v1";
const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;
const testEnv = generatedEnv as unknown as Env & { CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };

beforeAll(async () => { await applyD1Migrations(testEnv.CORE_DB, testEnv.CORE_MIGRATIONS); });
afterEach(() => { vi.unstubAllGlobals(); });

function advertised(apiMode: ResearchCatalogAdvertisedCapabilities["api_mode"]): ResearchCatalogAdvertisedCapabilities {
  return Object.freeze({ status: "advertised_unverified", api_mode: apiMode, api_mode_reason: null,
    attachment: null, reasoning: true, tool_call: null, structured_output: false, temperature: null,
    input_modalities: Object.freeze(["text"]), output_modalities: Object.freeze(["text"]),
    context_limit: null, input_limit: null, output_limit: null });
}

function providerCatalog(sdk = "@ai-sdk/openai"): string {
  return JSON.stringify({
    "opencode-go": {
      id: "opencode-go",
      models: {
        [MODEL]: {
          id: MODEL,
          attachment: true,
          reasoning: true,
          tool_call: true,
          structured_output: false,
          temperature: false,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 1_048_576, input: 900_000, output: 131_072 },
          cost: { input: 0.1, output: 0.2, cache_read: 0.002 },
          provider: { npm: sdk, api: ADVERTISED_GO_BASE },
        },
      },
    },
  });
}

function ownerContext(owner: string): AuthenticatedRequestContext {
  return { request: new Request("https://eliot.test/owner", { method: "POST" }), principal_ref: owner,
    credential_generation: `catalog-v2-credential-${crypto.randomUUID()}`, client_class: "owner_pwa",
    trace_id: crypto.randomUUID() };
}

describe("catalog v2 SDK transport mapping", () => {
  const alias = `eliotr-${"0".repeat(48)}`;
  it.each([
    ["opencode-go", "custom-opencode-go", "@ai-sdk/openai", "responses", "custom-responses"],
    ["opencode-go", "custom-opencode-go", "@ai-sdk/openai-compatible", "chat", "custom-chat-completions"],
    ["opencode-go", "custom-opencode-go", "@ai-sdk/anthropic", "messages", "custom-anthropic-messages"],
    ["openai", "openai", "@ai-sdk/openai", "responses", "openai-responses"],
    ["anthropic", "anthropic", "@ai-sdk/anthropic", "messages", "anthropic-messages"],
    ["openrouter", "openrouter", "@openrouter/ai-sdk-provider", "chat", "openrouter-chat-completions"],
  ] as const)("maps %s/%s/%s to %s", (provider, slug, sdk, mode, api) => {
    const policy = createResearchCatalogModelTransportPolicyV2({ provider_id: provider, provider_slug: slug,
      model_id: MODEL, alias, advertised_sdk: sdk, advertised_capabilities: advertised(mode) });
    expect(policy).toMatchObject({ api, provider: slug, model: MODEL, billing: { mode: "byok", alias } });
    expect(policy.billing).not.toHaveProperty("free_only");
  });

  it("rejects unsupported advertised SDK metadata without selecting a fallback", () => {
    expect(() => createResearchCatalogModelTransportPolicyV2({ provider_id: "opencode-go",
      provider_slug: "custom-opencode-go", model_id: MODEL, alias, advertised_sdk: "@ai-sdk/google",
      advertised_capabilities: advertised("unsupported") })).toThrow(/no supported exact custom transport/u);
  });
});

describe("default generic catalog model-use composition", () => {
  it("reads the current unresolved owner/project operation without catalog or provider fetches", async () => {
    const owner = `catalog-current-owner-${crypto.randomUUID()}`;
    const project = `catalog-current-project-${crypto.randomUUID()}`;
    const operation = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const context = ownerContext(owner);
    await testEnv.CORE_DB.prepare(
      "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
      "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
      "VALUES (?1,'Catalog current test','private','retention','source','profile','depth',1,?2)",
    ).bind(project, createdAt).run();
    await testEnv.CORE_DB.prepare(
      "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
      "VALUES (?1,?2,?3,?4,?4)",
    ).bind(project, owner, DEPLOYMENT, createdAt).run();
    await testEnv.CORE_DB.prepare(
      "INSERT INTO research_catalog_model_use_authorization(" +
      "owner_id,project_id,operation_id,provider_id,provider_operation_id,route_provider_id,model_id," +
      "account_id,gateway_id,alias,provider_config_id,configuration_metadata_sha256,request_sha256," +
      "owner_credential_generation,project_generation,deployment_generation,expected_selection_revision," +
      "source_configuration_ref,source_configuration_sha256,state,phase,selected_configuration_ref," +
      "selected_configuration_sha256,selection_revision,failure_code,created_at,updated_at) " +
      "VALUES (?1,?2,?3,'cloudflare-workers-ai',NULL,'workers-ai','@cf/zai-org/glm-5.3-flash'," +
      "NULL,NULL,NULL,NULL,NULL,?4,?5,1,?6,NULL,NULL,NULL,'ACCEPTED','INTENT',NULL,NULL,NULL,NULL,?7,?7)",
    ).bind(owner, project, operation, "e".repeat(64), context.credential_generation, DEPLOYMENT, createdAt).run();

    const installedEnv = await createNativeUseEnvironment(owner, testEnv.CORE_DB, {
      ...testEnv, ENVIRONMENT: "development", DEPLOYMENT_GENERATION: DEPLOYMENT, AI_GATEWAY_REASONING_URL: GATEWAY_BASE,
    });
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => { fetchCalls += 1; throw new Error("readCurrent must not fetch"); });
    const api = createResearchCatalogModelUseComposition(installedEnv as Env, context, project);

    await expect(api.readCurrent()).resolves.toMatchObject({ state: "accepted", phase: "intent",
      operation_id: operation, provider_id: "cloudflare-workers-ai", provider_operation_id: null });
    await expect(api.read(operation)).resolves.toMatchObject({ state: "accepted", phase: "intent", operation_id: operation });
    expect(fetchCalls).toBe(0);
  }, 20_000);

  it("qualifies and imports exact Go Muse using its saved alias and preserves catalog pricing provenance", async () => {
    const owner = `catalog-v2-owner-${crypto.randomUUID()}`;
    const project = `catalog-v2-project-${crypto.randomUUID()}`;
    const providerOperation = crypto.randomUUID();
    const catalogOperation = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await testEnv.CORE_DB.prepare(
      "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
      "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
      "VALUES (?1,'Catalog v2 test','private','retention','source','profile','depth',1,?2)",
    ).bind(project, createdAt).run();
    await testEnv.CORE_DB.prepare(
      "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
      "VALUES (?1,?2,?3,?4,?4)",
    ).bind(project, owner, DEPLOYMENT, createdAt).run();

    const context = ownerContext(owner);
    const globalProviders = createServiceModelProviderService({ database: testEnv.CORE_DB,
      managementPort: {
        available: true,
        create: vi.fn(async (input: Parameters<ServiceModelProviderManagementPort["create"]>[0]) => ({
          provider_config_id: `catalog-v2-config-${input.operation_id}`,
          provider_slug: "custom-opencode-go",
          alias: input.alias,
        })),
        read: vi.fn(async () => null),
      },
    });
    const connection = await globalProviders.create(context, {
      protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
      operation_id: providerOperation,
      provider_id: "opencode-go",
      display_name: "Existing OpenCode Go",
      base_url: LEGACY_GO_BASE,
      model_ids: [MODEL],
      api_key: "synthetic-provider-secret-for-test-only",
    });

    const installedEnv = await createNativeUseEnvironment(owner, testEnv.CORE_DB, {
      ...testEnv,
      ENVIRONMENT: "development",
      DEPLOYMENT_GENERATION: DEPLOYMENT,
      AI_GATEWAY_REASONING_URL: GATEWAY_BASE,
    });
    const requests: Array<{ url: string; body: Record<string, unknown>; alias: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://models.dev/api.json") {
        return new Response(providerCatalog(), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body, alias: new Headers(init?.headers).get("cf-aig-byok-alias") });
      const ordinal = requests.length;
      return new Response(JSON.stringify({
        object: "response",
        id: `catalog-v2-response-${ordinal}`,
        created_at: 1_760_000_000,
        model: MODEL,
        status: "completed",
        output: [{ id: `catalog-v2-output-${ordinal}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify({ connected: true,
            qualification_purpose: "structured-output-connectivity" }), annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 },
      }), { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": `catalog-v2-log-${ordinal}` } });
    };
    vi.stubGlobal("fetch", fetcher);

    const api = createResearchCatalogModelUseComposition(installedEnv as Env, context, project);
    const receipt = await api.start({ protocol: "eliotr.research.catalog-model-use-request.v1",
      operation_id: catalogOperation, expected_selection_revision: null, provider_id: "opencode-go",
      model_id: MODEL, provider_operation_id: providerOperation });

    expect(receipt).toMatchObject({ state: "selected", phase: "complete", failure_code: null, provider_id: "opencode-go",
      provider_operation_id: providerOperation, model_id: MODEL });
    expect(receipt.selected_configuration_ref).toBe(`rpmc-${receipt.selected_configuration_sha256}`);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.url === `${GATEWAY_BASE}/custom-opencode-go/responses`)).toBe(true);
    expect(requests.every((request) => request.body.model === MODEL && request.alias === connection.receipt.alias)).toBe(true);
    expect(requests.every((request) => request.body.model !== "openai/gpt-4.1" && request.body.provider === undefined)).toBe(true);

    const connectionRow = await testEnv.CORE_DB.prepare(
      "SELECT base_url,model_ids_json,alias FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2",
    ).bind(owner, providerOperation).first<{ readonly base_url: string; readonly model_ids_json: string; readonly alias: string }>();
    expect(connectionRow).toEqual({ base_url: LEGACY_GO_BASE, model_ids_json: JSON.stringify([MODEL]), alias: connection.receipt.alias });

    const prices = await testEnv.CORE_DB.prepare(
      "SELECT input_rate_usd_per_1k_tokens,output_rate_usd_per_1k_tokens,snapshot_json,snapshot_sha256 " +
      "FROM research_model_pricing_snapshot WHERE approval_receipt_ref=?1",
    ).bind(catalogOperation).all<{ readonly input_rate_usd_per_1k_tokens: string; readonly output_rate_usd_per_1k_tokens: string;
      readonly snapshot_json: string; readonly snapshot_sha256: string }>();
    expect(prices.results?.length).toBeGreaterThan(0);
    for (const price of prices.results ?? []) {
      expect(price).toMatchObject({ input_rate_usd_per_1k_tokens: "0.0001", output_rate_usd_per_1k_tokens: "0.0002" });
      expect(price.snapshot_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.parse(price.snapshot_json)).toMatchObject({ catalog_metadata: {
        source_url: "https://models.dev/api.json",
        provider_id: "opencode-go",
        provider_slug: "custom-opencode-go",
        consent_operation_id: catalogOperation,
        model_id: MODEL,
        advertised_sdk: "@ai-sdk/openai",
        advertised_api_base: ADVERTISED_GO_BASE,
        rates_usd_per_1k_tokens: { input: "0.0001", output: "0.0002", cache_read: "0.000002" },
      } });
    }

    const evidence = await testEnv.CORE_DB.prepare(
      "SELECT DISTINCT provider_id,provider_slug,provider_operation_id,model_id,state FROM provider_native_model_catalog_v2_evidence " +
      "WHERE owner_ref=?1 AND project_id=?2 AND consent_operation_id=?3",
    ).bind(owner, project, catalogOperation).all<{ readonly provider_id: string; readonly provider_slug: string;
      readonly provider_operation_id: string; readonly model_id: string; readonly state: string }>();
    expect(evidence.results).toEqual([{ provider_id: "opencode-go", provider_slug: "custom-opencode-go",
      provider_operation_id: providerOperation, model_id: MODEL, state: "COMPLETED" }]);

    const sentCount = requests.length;
    await expect(api.read(catalogOperation)).resolves.toMatchObject({ state: "selected", model_id: MODEL });
    expect(requests).toHaveLength(sentCount);
  }, 30_000);
});
