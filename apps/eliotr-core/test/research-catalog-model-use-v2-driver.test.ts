import { applyD1Migrations, env as generatedEnv } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
} from "@eliotr/contracts";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createServiceModelProviderService, type ServiceModelProviderManagementPort } from
  "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import type { ResearchCatalogAdvertisedCapabilities } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-pricing.js";
import { createResearchCatalogModelUseComposition } from "../src/research-catalog-model-use-composition.js";
import { createResearchCatalogModelTransportPolicyV2 } from "../src/research-catalog-model-use-v2-driver.js";
import { createOwnerResearchProjectConfigurationService, readOwnerProjectResearchReadiness } from
  "../src/research-project-configuration-composition.js";
import { createResearchSemanticNativeModelRuntime } from "../src/research-semantic-native-model-runtime.js";
import { createResearchSemanticConfigRevisionStore, decodeResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
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
  const model = {
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: false,
    temperature: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1_048_576, input: 900_000, output: 131_072 },
    cost: { input: 0.1, output: 0.2, cache_read: 0.002 },
  };
  return JSON.stringify({
    "opencode-go": {
      id: "opencode-go",
      models: {
        [MODEL]: {
          id: MODEL,
          ...model,
          provider: { npm: sdk, api: ADVERTISED_GO_BASE },
        },
      },
    },
    openai: { id: "openai", models: { "gpt-4.1-mini": {
      id: "gpt-4.1-mini", ...model, provider: { npm: "@ai-sdk/openai", api: "https://api.openai.com/v1" },
    } } },
  });
}

function ownerContext(owner: string): AuthenticatedRequestContext {
  return { request: new Request("https://eliot.test/owner", { method: "POST" }), principal_ref: owner,
    credential_generation: `catalog-v2-credential-${crypto.randomUUID()}`, client_class: "owner_pwa",
    trace_id: crypto.randomUUID() };
}

function modelProfileWithoutStageIdentity(raw: string): unknown {
  const profile = JSON.parse(raw) as Record<string, unknown>;
  const { deployment: _deployment, definition_ref: _definitionRef, definition_sha256: _definitionSha,
    ...stableProfile } = profile;
  return stableProfile;
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
          provider_slug: input.provider_id === "opencode-go" ? "custom-opencode-go" : input.provider_id,
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
      ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN: "synthetic-control",
    });
    const requests: Array<{ url: string; body: Record<string, unknown>; alias: string | null;
      client: string | null; session: string | null }> = [];
    let requestConstructionFailure: string | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      // Exercise native Workers request-option validation before the controlled
      // transport boundary, as the real global fetch does.
      let request: Request;
      try { request = new Request(input, init); }
      catch (error) {
        requestConstructionFailure = error instanceof Error ? error.message : String(error);
        throw error;
      }
      const url = request.url;
      if (url.startsWith("https://api.cloudflare.com/")) {
        return Response.json({ success: true, result: [{ slug: "custom-opencode-go", enable: true, base_url: ADVERTISED_GO_BASE }],
          result_info: { page: 1, total_count: 1 } });
      }
      if (url === "https://models.dev/api.json") {
        return new Response(providerCatalog(), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body, alias: request.headers.get("cf-aig-byok-alias"),
        client: request.headers.get("user-agent"), session: request.headers.get("x-opencode-session") });
      const ordinal = requests.length;
      return new Response(JSON.stringify({
        object: "response",
        id: `catalog-v2-response-${ordinal}`,
        created_at: 1_760_000_000,
        model: String(body.model),
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

    expect(requestConstructionFailure, "native Workers request initialization").toBeUndefined();
    expect(receipt).toMatchObject({ state: "selected", phase: "complete", failure_code: null, provider_id: "opencode-go",
      provider_operation_id: providerOperation, model_id: MODEL });
    expect(receipt.selected_configuration_ref).toBe(`rpmc-${receipt.selected_configuration_sha256}`);
    const beforeReadbackCalls = requests.length;
    const readbackService = createOwnerResearchProjectConfigurationService(installedEnv, context, project);
    const page = await readbackService.readPage(context, project, { limit: 50 });
    expect(page.selected?.qualification_state).toBe("qualified");
    expect((await readOwnerProjectResearchReadiness(installedEnv, context, project)).run_readiness).toBe("ready");
    const savedConfiguration = await testEnv.CORE_DB.prepare(
      "SELECT configuration_json FROM research_project_model_configuration_revision WHERE configuration_ref=?1",
    ).bind(receipt.selected_configuration_ref).first<string>("configuration_json");
    if (savedConfiguration === null) throw new Error("selected configuration missing");
    const { bundle } = await decodeResearchProjectModelConfigurationBundle(JSON.parse(savedConfiguration) as unknown);
    const nativeRuntime = createResearchSemanticNativeModelRuntime({ env: installedEnv, owner_ref: owner,
      run_configuration: { mode: "snapshot-v2", configuration_ref: receipt.selected_configuration_ref,
        configuration_sha256: receipt.selected_configuration_sha256, project_owner_ref: owner,
        project_id: project, model_selections: bundle.model_selections } });
    expect(nativeRuntime.selections.size).toBe(2);
    expect((await nativeRuntime.resolvePinned("SYNTHESIZE"))?.selection.candidate_kind).toBe("provider-native-v2");
    expect(requests.length).toBe(beforeReadbackCalls);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.url === `${GATEWAY_BASE}/custom-custom-opencode-go/responses`)).toBe(true);
    expect(requests.every((request) => request.body.model === MODEL && request.alias === connection.receipt.alias)).toBe(true);
    expect(requests.every((request) => request.client === "EliotResearch/1.0" &&
      /^eliotr_[a-f0-9]{32}$/u.test(request.session ?? ""))).toBe(true);
    expect(new Set(requests.map(request => request.session)).size).toBe(1);
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

    const baselineSemantic = JSON.parse(bundle.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON) as Record<string, unknown>;
    const auditSemantic = baselineSemantic.audit as Record<string, unknown>;
    const auditParameters = auditSemantic.trusted_parameters as Record<string, unknown>;
    baselineSemantic.roles = Object.freeze({
      trusted_parameters: Object.freeze({ ...auditParameters }),
      request_timeout_ms: auditSemantic.request_timeout_ms,
    });
    const targetSemantic = canonicalModelGatewayJson(baselineSemantic);
    const targetSemanticRevision = await createResearchSemanticConfigRevisionStore(testEnv.CORE_DB).putImmutable({
      config_json: targetSemantic, created_by_principal_ref: owner,
    });
    const selectedSpend = JSON.parse(bundle.vars.ELIOTR_MODEL_SPEND_POLICY_JSON) as {
      rules: Array<Record<string, unknown>>;
    };
    const synthesisRule = selectedSpend.rules.find((rule) => rule.stage === "SYNTHESIZE");
    if (synthesisRule === undefined) throw new Error("selected synthesis spend rule missing");
    const branchRules = ["ANALYZE_BRANCHES", "COUNTER_SEARCH"].map((stage) => ({ ...synthesisRule, stage }));
    const budgetProfile = canonicalModelGatewayJson({
      protocol: "eliotr.research.branch-query-budget-profile.v1",
      profile_id: "owner-research-existing-bounds-v1",
      profile_generation: 1,
      budgets: { candidate_limit: 200, scan_limit: 100, evidence_limit: 16,
        max_evidence_bytes: 65_536, max_query_legs: 1 },
    });
    const providerIdentity = await testEnv.CORE_DB.prepare(
      "SELECT provider_config_id,metadata_sha256 FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2",
    ).bind(owner, providerOperation).first<{ readonly provider_config_id: string; readonly metadata_sha256: string }>();
    if (providerIdentity === null) throw new Error("saved provider binding missing");
    const templateWithoutDigest = {
      protocol: "eliotr.research.provider-key-model-use-qualification-template.v1",
      project_id: project,
      provider_id: "opencode-go",
      provider_operation_id: providerOperation,
      route_provider_id: "custom-opencode-go",
      model_id: MODEL,
      alias: connection.receipt.alias,
      provider_config_id: providerIdentity.provider_config_id,
      binding_metadata_sha256: providerIdentity.metadata_sha256,
      baseline: { configuration_ref: receipt.selected_configuration_ref,
        configuration_sha256: receipt.selected_configuration_sha256, selection_revision: receipt.selection_revision,
        semantic_revision_ref: bundle.semantic_revision.revision_ref,
        semantic_config_sha256: bundle.semantic_revision.config_sha256 },
      semantic_revision_ref: targetSemanticRevision.revision_ref,
      semantic_config_sha256: targetSemanticRevision.config_sha256,
      branch_spend_rules: branchRules,
      branch_query_budget_profile_json: budgetProfile,
    };
    const template = canonicalModelGatewayJson({ ...templateWithoutDigest,
      template_sha256: await modelGatewaySha256(canonicalModelGatewayJson(templateWithoutDigest)) });
    expect(new TextEncoder().encode(template).byteLength).toBeLessThanOrEqual(5_000);
    const staleBaseline = { ...templateWithoutDigest,
      baseline: { ...templateWithoutDigest.baseline, selection_revision: 99 } };
    const badBudget = JSON.parse(budgetProfile) as Record<string, unknown>;
    badBudget.budgets = { ...(badBudget.budgets as Record<string, unknown>), candidate_limit: 201 };
    const badVariants = [
      canonicalModelGatewayJson({ ...staleBaseline,
        template_sha256: await modelGatewaySha256(canonicalModelGatewayJson(staleBaseline)) }),
      canonicalModelGatewayJson({ ...templateWithoutDigest, branch_spend_rules: [],
        template_sha256: await modelGatewaySha256(canonicalModelGatewayJson({ ...templateWithoutDigest,
          branch_spend_rules: [] })) }),
      canonicalModelGatewayJson({ ...templateWithoutDigest, branch_query_budget_profile_json: canonicalModelGatewayJson(badBudget),
        template_sha256: await modelGatewaySha256(canonicalModelGatewayJson({ ...templateWithoutDigest,
          branch_query_budget_profile_json: canonicalModelGatewayJson(badBudget) })) }),
      "{malformed",
    ];
    for (const invalidTemplate of badVariants) {
      const rejectedOperation = crypto.randomUUID();
      const badTemplateEnv = { ...installedEnv,
        ELIOTR_RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_JSON: invalidTemplate,
      } as Env;
      const badApi = createResearchCatalogModelUseComposition(badTemplateEnv, context, project);
      await expect(badApi.start({ protocol: "eliotr.research.catalog-model-use-request.v1",
        operation_id: rejectedOperation, expected_selection_revision: receipt.selection_revision,
        provider_id: "opencode-go", model_id: MODEL, provider_operation_id: providerOperation })).rejects.toThrow();
      const rejectedRow = await testEnv.CORE_DB.prepare(
        "SELECT operation_id FROM research_catalog_model_use_authorization WHERE operation_id=?1 LIMIT 1",
      ).bind(rejectedOperation).first();
      expect(rejectedRow).toBeNull();
    }

    const fourStageOperation = crypto.randomUUID();
    const templateEnv = { ...installedEnv,
      ELIOTR_RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_JSON: template,
    } as Env;
    const fourStageApi = createResearchCatalogModelUseComposition(templateEnv, context, project);
    const fourStageReceipt = await fourStageApi.start({ protocol: "eliotr.research.catalog-model-use-request.v1",
      operation_id: fourStageOperation, expected_selection_revision: receipt.selection_revision,
      provider_id: "opencode-go", model_id: MODEL, provider_operation_id: providerOperation });
    expect(fourStageReceipt).toMatchObject({ state: "selected", phase: "complete", failure_code: null,
      selected_configuration_ref: `rpmc-${fourStageReceipt.selected_configuration_sha256}` });
    const fourStageRow = await testEnv.CORE_DB.prepare(
      "SELECT configuration_json FROM research_project_model_configuration_revision WHERE configuration_ref=?1 LIMIT 1",
    ).bind(fourStageReceipt.selected_configuration_ref).first<{ readonly configuration_json: string }>();
    if (fourStageRow === null) throw new Error("four-stage configuration revision missing");
    const { bundle: fourStageBundle } = await decodeResearchProjectModelConfigurationBundle(
      JSON.parse(fourStageRow.configuration_json) as unknown);
    expect(fourStageBundle.model_selections.map((selection) => selection.stage).sort()).toEqual([
      "ANALYZE_BRANCHES", "AUDIT_CLAIMS", "COUNTER_SEARCH", "SYNTHESIZE",
    ]);
    expect(fourStageBundle.semantic_revision).toEqual({ revision_ref: targetSemanticRevision.revision_ref,
      config_sha256: targetSemanticRevision.config_sha256 });
    expect(fourStageBundle.vars.ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON).toBe(budgetProfile);
    expect(fourStageBundle.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON).toBe(bundle.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON);
    expect(fourStageBundle.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF).toBe(bundle.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF);
    expect(requests.slice(2).map((request) => request.body.model)).toEqual([MODEL, MODEL, MODEL, MODEL]);
    expect(requests.slice(2).every((request) => request.alias === connection.receipt.alias)).toBe(true);
    const selectedAfterUpgrade = await createOwnerResearchProjectConfigurationService(templateEnv, context, project)
      .readSelected(context, project);
    expect(selectedAfterUpgrade?.selection_revision).toBe((receipt.selection_revision ?? 0) + 1);

    const repeatOperation = crypto.randomUUID();
    const repeatReceipt = await fourStageApi.start({ protocol: "eliotr.research.catalog-model-use-request.v1",
      operation_id: repeatOperation, expected_selection_revision: selectedAfterUpgrade?.selection_revision ?? null,
      provider_id: "opencode-go", model_id: MODEL, provider_operation_id: providerOperation });
    expect(repeatReceipt).toMatchObject({ state: "selected", phase: "complete", failure_code: null });
    const repeatedSelection = await createOwnerResearchProjectConfigurationService(templateEnv, context, project)
      .readSelected(context, project);
    if (repeatedSelection === null) throw new Error("repeated Go qualification did not retain a selected configuration");
    const repeatedBundle = repeatedSelection.configuration;
    expect(repeatedBundle.model_selections).toHaveLength(4);
    expect(repeatedBundle.semantic_revision).toEqual(fourStageBundle.semantic_revision);
    expect(repeatedBundle.vars).toMatchObject({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: fourStageBundle.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON,
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: fourStageBundle.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: fourStageBundle.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON: budgetProfile,
    });
    expect(modelProfileWithoutStageIdentity(repeatedBundle.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON)).toEqual(
      modelProfileWithoutStageIdentity(fourStageBundle.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON));
    expect(requests.slice(6, 10).map((request) => request.body.model)).toEqual([MODEL, MODEL, MODEL, MODEL]);

    const malformedTarget = { ...templateWithoutDigest,
      branch_query_budget_profile_json: canonicalModelGatewayJson(badBudget) };
    const malformedGoTemplate = canonicalModelGatewayJson({ ...malformedTarget,
      template_sha256: await modelGatewaySha256(canonicalModelGatewayJson(malformedTarget)) });
    const malformedTemplateEnv = { ...installedEnv,
      ELIOTR_RESEARCH_PROVIDER_KEY_MODEL_USE_QUALIFICATION_TEMPLATE_JSON: malformedGoTemplate,
    } as Env;
    const matchingRejectedOperation = crypto.randomUUID();
    const matchingRejectedApi = createResearchCatalogModelUseComposition(malformedTemplateEnv, context, project);
    await expect(matchingRejectedApi.start({ protocol: "eliotr.research.catalog-model-use-request.v1",
      operation_id: matchingRejectedOperation, expected_selection_revision: repeatedSelection.selection_revision,
      provider_id: "opencode-go", model_id: MODEL, provider_operation_id: providerOperation })).rejects.toThrow();
    const matchingRejectedRow = await testEnv.CORE_DB.prepare(
      "SELECT operation_id FROM research_catalog_model_use_authorization WHERE operation_id=?1 LIMIT 1",
    ).bind(matchingRejectedOperation).first();
    expect(matchingRejectedRow).toBeNull();

    const otherProviderOperation = crypto.randomUUID();
    const otherModel = "gpt-4.1-mini";
    const otherConnection = await globalProviders.create(context, {
      protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
      operation_id: otherProviderOperation,
      provider_id: "openai",
      display_name: "Existing OpenAI connection",
      model_ids: [otherModel],
      api_key: "synthetic-openai-secret-for-test-only",
    });
    const otherOperation = crypto.randomUUID();
    const otherApi = createResearchCatalogModelUseComposition(malformedTemplateEnv, context, project);
    const otherReceipt = await otherApi.start({ protocol: "eliotr.research.catalog-model-use-request.v1",
      operation_id: otherOperation, expected_selection_revision: repeatedSelection.selection_revision,
      provider_id: "openai", model_id: otherModel, provider_operation_id: otherProviderOperation });
    expect(otherReceipt).toMatchObject({ state: "selected", phase: "complete", failure_code: null,
      provider_id: "openai", provider_operation_id: otherProviderOperation, model_id: otherModel });
    const otherSelected = await createOwnerResearchProjectConfigurationService(templateEnv, context, project)
      .readSelected(context, project);
    if (otherSelected === null) throw new Error("different-provider qualification did not retain a selected configuration");
    expect(otherSelected.configuration.model_selections).toHaveLength(4);
    expect(otherSelected.configuration.model_selections.every((selection) =>
      selection.transport_policy.provider === "openai" && selection.transport_policy.model === otherModel &&
      selection.transport_policy.billing.alias === otherConnection.receipt.alias)).toBe(true);
    expect(otherSelected.configuration.semantic_revision).toEqual(fourStageBundle.semantic_revision);
    expect(otherSelected.configuration.vars).toMatchObject({
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: fourStageBundle.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON,
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: fourStageBundle.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: fourStageBundle.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON: budgetProfile,
    });
    expect(modelProfileWithoutStageIdentity(otherSelected.configuration.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON)).toEqual(
      modelProfileWithoutStageIdentity(fourStageBundle.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON));
    expect(requests.slice(10, 14).map((request) => request.body.model)).toEqual([otherModel, otherModel, otherModel, otherModel]);

    const sentCount = requests.length;
    await expect(api.read(catalogOperation)).resolves.toMatchObject({ state: "selected", model_id: MODEL });
    expect(requests).toHaveLength(sentCount);
  }, 30_000);
});
