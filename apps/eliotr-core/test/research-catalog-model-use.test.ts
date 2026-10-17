import { applyD1Migrations, env as generatedEnv } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeResearchProjectModelConfigurationBundle, type ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL } from "@eliotr/contracts";
import { createServiceModelProviderService, type ServiceModelProviderManagementPort } from
  "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { createD1ResearchCatalogModelUseStore, type ResearchCatalogModelUseIntent } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-use-store.js";
import { createResearchProviderKeyModelUseStore, type ResearchProviderKeyModelUseIntent } from
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-store.js";
import type { ResearchProjectModelConfigurationService } from "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
import { createResearchCatalogModelUseService } from "../src/research-catalog-model-use-service.js";
import { ResearchProviderKeyModelUseServiceError, type ResearchProviderKeyModelUseService } from
  "../src/research-provider-key-model-use-service.js";
import { createResearchProviderKeyModelUseComposition } from "../src/research-provider-key-model-use-composition.js";
import { createOwnerResearchProjectConfigurationService } from "../src/research-project-configuration-composition.js";
import type { Env } from "../src/env.js";
import type { InstalledNativeResearchConfiguration } from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import { createNativeUseEnvironment, freeOnlyCatalogResponse, MODEL_ID } from "./research-provider-key-model-use-fixture.js";

const testEnv = generatedEnv as unknown as Env & { CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
beforeAll(async () => { await applyD1Migrations(testEnv.CORE_DB, testEnv.CORE_MIGRATIONS); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const OWNER = "catalog-builtin-owner";
const PROJECT = "catalog-builtin-project";
const MODEL = "@cf/zai-org/glm-5.3-flash";
const DOTS = "dots-studio/dots-3-note-preview:free";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-16T20:00:00.000Z";

const POLICY = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "workers-ai",
  model: MODEL,
  billing: { mode: "unified" },
  capabilities: { max_output_tokens_field: "max_completion_tokens", reasoning_efforts: [] },
});

const VARS: ResearchProjectModelConfigurationBundle["vars"] = Object.freeze({
  ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: "{}",
  ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "{}",
  ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "catalog-profile-ref",
  ELIOTR_MODEL_SPEND_POLICY_JSON: "{}",
  ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "catalog-spend-ref",
  ELIOTR_RESEARCH_REPORT_CONFIG_JSON: "{}",
  ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "catalog-report-ref",
});

function installed(modelId = MODEL): InstalledNativeResearchConfiguration {
  return Object.freeze({ vars: VARS, model_selections: Object.freeze([
    { stage: "SYNTHESIZE", route_ref: "dynamic/eliotr-balanced", route_version: "catalog-native-synthesis",
      candidate_ref: "catalog-native-candidate-synthesis", candidate_sha256: "a".repeat(64),
      qualification_ref: "catalog-native-qualification-synthesis", qualification_sha256: "b".repeat(64),
      transport_policy: { ...POLICY, model: modelId } },
    { stage: "AUDIT_CLAIMS", route_ref: "dynamic/eliotr-audit-verifier", route_version: "catalog-native-audit",
      candidate_ref: "catalog-native-candidate-audit", candidate_sha256: "c".repeat(64),
      qualification_ref: "catalog-native-qualification-audit", qualification_sha256: "d".repeat(64),
      transport_policy: { ...POLICY, model: modelId } },
  ]) });
}

function fakeDatabase(): D1Database {
  let row: Record<string, unknown> | null = null;
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (sql.startsWith("SELECT generation FROM project")) return { generation: 7 } as T;
              if (sql.includes("FROM research_catalog_model_use_authorization")) return row as T | null;
              throw new Error(`Unexpected D1 read: ${sql}`);
            },
            async run() {
              if (sql.startsWith("INSERT INTO research_catalog_model_use_authorization")) {
                row = {
                  owner_id: args[0], project_id: args[1], operation_id: args[2], provider_id: args[3],
                  provider_operation_id: args[4], route_provider_id: args[5], model_id: args[6], account_id: args[7],
                  gateway_id: args[8], alias: args[9], provider_config_id: args[10],
                  configuration_metadata_sha256: args[11], request_sha256: args[12], owner_credential_generation: args[13],
                  project_generation: args[14], deployment_generation: args[15], expected_selection_revision: args[16],
                  source_configuration_ref: args[17], source_configuration_sha256: args[18], state: "ACCEPTED", phase: "INTENT",
                  selected_configuration_ref: null, selected_configuration_sha256: null, selection_revision: null,
                  failure_code: null, created_at: args[19], updated_at: args[19],
                };
              } else if (sql.startsWith("UPDATE research_catalog_model_use_authorization")) {
                if (row === null) return { meta: { changes: 0 } };
                row = { ...row, state: args[0], phase: args[1], failure_code: args[2],
                  selected_configuration_ref: args[3] ?? row.selected_configuration_ref,
                  selected_configuration_sha256: args[4] ?? row.selected_configuration_sha256,
                  selection_revision: args[5] ?? row.selection_revision, updated_at: args[6] };
              } else throw new Error(`Unexpected D1 write: ${sql}`);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeProjectConfiguration() {
  let selected: Awaited<ReturnType<ResearchProjectModelConfigurationService["readSelected"]>> = null;
  let pageSelection: Record<string, unknown> | null = null;
  const service = {
    async readSelected() { return selected; },
    async readPage() { return { selection_revision: selected?.selection_revision ?? null, selected: pageSelection }; },
    async importQualifiedConfiguration(_context: AuthenticatedRequestContext, _projectId: string, input: {
      readonly expected_revision: number | null; readonly configuration: unknown;
    }) {
      expect(input.expected_revision).toBeNull();
      const decoded = await decodeResearchProjectModelConfigurationBundle(input.configuration);
      selected = Object.freeze({ protocol: "eliotr.research-project-model-configuration.v1",
        owner_id: OWNER, project_id: PROJECT, selection_revision: 1,
        configuration_ref: decoded.configuration_ref, configuration_sha256: decoded.configuration_sha256,
        configuration_json: decoded.json, configuration: decoded.bundle });
      pageSelection = { configuration_ref: decoded.configuration_ref,
        configuration_sha256: decoded.configuration_sha256, qualification_state: "qualified" };
      return { protocol: "eliotr.research-project-model-configuration.v1", project_id: PROJECT,
        selection_revision: 1, selected: pageSelection };
    },
  };
  return { service: service as unknown as ResearchProjectModelConfigurationService,
    getSelected: () => selected };
}

function context(): AuthenticatedRequestContext {
  return { principal_ref: OWNER, credential_generation: "catalog-owner-generation", client_class: "owner_pwa",
    request: new Request("https://eliot.test/api/v1/research", { method: "POST" }) } as AuthenticatedRequestContext;
}

function request(modelId = MODEL) {
  return { protocol: "eliotr.research.catalog-model-use-request.v1" as const, operation_id: OPERATION,
    expected_selection_revision: null, provider_id: "cloudflare-workers-ai", provider_operation_id: null,
    model_id: modelId };
}

function service(inputModelId = MODEL) {
  const projectConfiguration = makeProjectConfiguration();
  const externalUse = vi.fn(() => { throw new Error("Workers AI must not use an external provider key"); });
  const env = { CORE_DB: fakeDatabase(), DEPLOYMENT_GENERATION: "catalog-test-deployment" } as unknown as Env;
  const api = createResearchCatalogModelUseService({ env, context: context(), project_id: PROJECT,
    project_configuration: projectConfiguration.service, model_use: externalUse,
    now: () => NOW, read_installed_native_configuration: async () => installed(inputModelId) });
  return { api, projectConfiguration, externalUse };
}

async function staleIntentFixture(input: {
  readonly credential_matches?: boolean;
  readonly deployment_matches?: boolean;
} = {}) {
  const owner = `catalog-recovery-owner-${crypto.randomUUID()}`;
  const project = `catalog-recovery-project-${crypto.randomUUID()}`;
  const operationId = crypto.randomUUID();
  const providerOperationId = crypto.randomUUID();
  const currentCredential = `credential-current-${crypto.randomUUID()}`;
  const currentDeployment = `deployment-current-${crypto.randomUUID()}`;
  const accountId = "a".repeat(32);
  const parentCredential = input.credential_matches === true ? currentCredential : `credential-old-${crypto.randomUUID()}`;
  const parentDeployment = input.deployment_matches === true ? currentDeployment : `deployment-old-${crypto.randomUUID()}`;
  const signalController = new AbortController();
  const ownerContext: AuthenticatedRequestContext = { request: new Request("https://eliot.test/owner", { signal: signalController.signal }),
    principal_ref: owner, credential_generation: currentCredential, client_class: "owner_pwa" };
  const createdAt = new Date().toISOString();
  await testEnv.CORE_DB.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES (?1,'Catalog recovery test','private','retention','source','profile','depth',1,?2)",
  ).bind(project, createdAt).run();
  await testEnv.CORE_DB.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
  ).bind(project, owner, currentDeployment, createdAt).run();

  const providerService = createServiceModelProviderService({ database: testEnv.CORE_DB, now: () => Date.parse(createdAt),
    managementPort: {
      available: true,
      create: vi.fn(async (request: Parameters<ServiceModelProviderManagementPort["create"]>[0]) => ({
        provider_config_id: `catalog-config-${request.operation_id}`, provider_slug: "openrouter", alias: request.alias,
      })),
      read: vi.fn(async () => null),
    } });
  await providerService.create(ownerContext, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
    operation_id: providerOperationId, provider_id: "openrouter", display_name: "OpenRouter",
    model_ids: [DOTS], api_key: "synthetic-recovery-test-key" });
  const binding = await providerService.resolveConfiguredProvider(ownerContext, "openrouter", { operation_id: providerOperationId });
  if (binding === null) throw new Error("missing configured OpenRouter test binding");
  const requestSha = await modelGatewaySha256(canonicalModelGatewayJson({
    protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: operationId,
    expected_selection_revision: null, provider_id: "openrouter", provider_operation_id: providerOperationId,
    route_provider_id: binding.provider_slug, model_id: DOTS,
  }));
  const store = createD1ResearchCatalogModelUseStore(testEnv.CORE_DB);
  const intent: ResearchCatalogModelUseIntent = {
    owner_id: owner, project_id: project, operation_id: operationId, provider_id: "openrouter",
    provider_operation_id: providerOperationId, route_provider_id: binding.provider_slug, model_id: DOTS,
    account_id: accountId, gateway_id: "eliotr-reasoning", alias: binding.alias,
    provider_config_id: binding.provider_config_id, configuration_metadata_sha256: binding.metadata_sha256,
    request_sha256: requestSha, owner_credential_generation: parentCredential, project_generation: 1,
    deployment_generation: parentDeployment, expected_selection_revision: null,
    source_configuration_ref: null, source_configuration_sha256: null, created_at: createdAt,
  };
  await store.insertIntent(intent);

  const runtimeEnv = { ...testEnv, DEPLOYMENT_GENERATION: currentDeployment,
    AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/eliotr-reasoning` } as Env;
  const modelUse = vi.fn((): ResearchProviderKeyModelUseService => {
    throw new Error("stale read must not dispatch model use");
  });
  const api = createResearchCatalogModelUseService({ env: runtimeEnv, context: ownerContext, project_id: project,
    project_configuration: makeProjectConfiguration().service, model_use: modelUse, now: () => createdAt });
  return { api, store, owner, project, operationId, providerOperationId, binding, intent, createdAt, currentCredential,
    currentDeployment, parentCredential, parentDeployment, accountId, signalController, modelUse };
}

async function insertLegacyModelUseChild(f: Awaited<ReturnType<typeof staleIntentFixture>>): Promise<void> {
  const stage = (sequence_number: number, stageName: "SYNTHESIZE" | "AUDIT_CLAIMS") => ({
    sequence_number, stage: stageName,
    route_ref: stageName === "SYNTHESIZE" ? "dynamic/eliotr-balanced" : "dynamic/eliotr-audit-verifier",
    route_version: "catalog-recovery-test", prompt_sha256: "1".repeat(64), schema_sha256: "2".repeat(64),
    parameters_sha256: "3".repeat(64), probe_prompt_sha256: "4".repeat(64),
    probe_schema_sha256: "5".repeat(64), probe_parameters_sha256: "6".repeat(64),
  });
  const intent: ResearchProviderKeyModelUseIntent = {
    owner_id: f.owner, project_id: f.project, operation_id: f.operationId, key_operation_id: f.providerOperationId,
    account_id: f.accountId, gateway_id: "eliotr-reasoning", alias: f.binding.alias,
    provider_config_id: f.binding.provider_config_id, configuration_metadata_sha256: f.binding.metadata_sha256,
    request_sha256: "7".repeat(64), configuration_basis_json: JSON.stringify({
      protocol: "eliotr.research.provider-key-model-use-basis.v1",
      stages: ["SYNTHESIZE", "AUDIT_CLAIMS"].map(() => ({ transport_policy: {
        provider: "openrouter", model: DOTS, api: "openrouter-chat-completions",
        billing: { mode: "byok", alias: f.binding.alias, free_only: true },
      } })),
    }),
    owner_credential_generation: f.parentCredential, project_generation: 1,
    deployment_generation: f.parentDeployment, deadline_at: f.createdAt,
    expected_selection_revision: null, source_configuration_ref: null, source_configuration_sha256: null,
    planned_stage_set_sha256: "8".repeat(64), plan_sha256: "9".repeat(64),
    stages: [stage(0, "SYNTHESIZE"), stage(1, "AUDIT_CLAIMS")], created_at: f.createdAt,
  };
  await createResearchProviderKeyModelUseStore(testEnv.CORE_DB).insertIntent(intent);
}

async function insertV2Evidence(f: Awaited<ReturnType<typeof staleIntentFixture>>): Promise<void> {
  const stage = "SYNTHESIZE";
  const pricingRef = `pricing-${f.operationId}`;
  const pricingSha = "a".repeat(64);
  const preparationRef = `preparation-${f.operationId}`;
  const preparationSha = "b".repeat(64);
  const preparation = {
    protocol: "eliotr.provider-native-model-preparation.v2", owner_ref: f.owner, project_id: f.project,
    owner_operation_id: f.operationId, consent_operation_id: f.operationId, stage,
    provider_id: "openrouter", provider_slug: "openrouter", provider_operation_id: f.providerOperationId,
    model_id: DOTS, pricing_snapshot_ref: pricingRef, pricing_snapshot_sha256: pricingSha,
    request_sha256: f.intent.request_sha256, catalog_sdk: "test-sdk", sdk_base_url: "https://openrouter.ai/api/v1",
    catalog_metadata_sha256: f.binding.metadata_sha256,
    key_binding: { operation_id: f.providerOperationId, owner_ref: f.owner, project_id: f.project,
      provider_id: "openrouter", provider_slug: "openrouter", alias: f.binding.alias,
      provider_config_id: f.binding.provider_config_id, configuration_metadata_sha256: f.binding.metadata_sha256 },
    transport_policy: { api: "openrouter-chat-completions", provider: "openrouter", model: DOTS,
      billing: { mode: "byok", alias: f.binding.alias } },
    prepared_at: f.createdAt, preparation_expires_at: "2027-01-01T00:00:00.000Z",
    pricing_snapshot_expires_at: "2027-02-01T00:00:00.000Z",
  };
  await testEnv.CORE_DB.prepare(
    "INSERT INTO provider_native_model_catalog_v2_evidence (owner_ref,project_id,consent_operation_id,stage,provider_id," +
    "provider_slug,provider_operation_id,model_id,alias,provider_config_id,configuration_metadata_sha256,request_sha256," +
    "pricing_snapshot_ref,pricing_snapshot_sha256,preparation_ref,preparation_sha256,preparation_json,state,created_at,updated_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'PREPARED',?18,?18)",
  ).bind(f.owner, f.project, f.operationId, stage, "openrouter", "openrouter", f.providerOperationId, DOTS,
    f.binding.alias, f.binding.provider_config_id, f.binding.metadata_sha256, f.intent.request_sha256,
    pricingRef, pricingSha, preparationRef, preparationSha, JSON.stringify(preparation), f.createdAt).run();
}

describe("catalog model use with the installed Workers AI default", () => {
  it("imports only the already-qualified exact native model through project validation and CAS", async () => {
    const fixture = service();
    const receipt = await fixture.api.start(request());
    expect(receipt).toMatchObject({ state: "selected", phase: "complete", provider_id: "cloudflare-workers-ai",
      provider_operation_id: null, model_id: MODEL, selection_revision: 1 });
    expect(receipt.selected_configuration_ref).toBe(`rpmc-${receipt.selected_configuration_sha256}`);
    expect(fixture.projectConfiguration.getSelected()?.configuration.model_selections.every((selection) =>
      selection.transport_policy.provider === "workers-ai" && selection.transport_policy.model === MODEL)).toBe(true);
    expect(fixture.externalUse).not.toHaveBeenCalled();
  });

  it("does not import a different discovered Workers AI model without its own qualification", async () => {
    const fixture = service("@cf/other-model");
    const receipt = await fixture.api.start(request());
    expect(receipt).toMatchObject({ state: "blocked", failure_code: "MODEL_NOT_SUPPORTED" });
    expect(fixture.projectConfiguration.getSelected()).toBeNull();
    expect(fixture.externalUse).not.toHaveBeenCalled();
  });
});

describe("catalog model use with an exact saved global operation", () => {
  it("qualifies and selects one catalog model without changing the explicit connection allowlist", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const owner = `catalog-openrouter-owner-${crypto.randomUUID()}`;
    const project = `catalog-openrouter-project-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    await testEnv.CORE_DB.prepare(
      "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
      "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
      "VALUES (?1,'Catalog model test','private','retention','source','profile','depth',1,?2)",
    ).bind(project, createdAt).run();
    await testEnv.CORE_DB.prepare(
      "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
      "VALUES (?1,?2,'catalog-test',?3,?3)",
    ).bind(project, owner, createdAt).run();
    const ownerContext: AuthenticatedRequestContext = { request: new Request("https://eliot.test/owner"),
      principal_ref: owner, credential_generation: `catalog-credential-${crypto.randomUUID()}`,
      client_class: "owner_pwa", trace_id: crypto.randomUUID() };
    const installed = await createNativeUseEnvironment(owner, testEnv.CORE_DB, { ...testEnv,
      ENVIRONMENT: "development", DEPLOYMENT_GENERATION: "catalog-test",
      AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
    });
    const { ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON: _unusedPolicy, ...runtimeEnv } = installed;
    void _unusedPolicy;
    const globalProviders = createServiceModelProviderService({ database: testEnv.CORE_DB, managementPort: {
      available: true,
      create: vi.fn(async (input: Parameters<ServiceModelProviderManagementPort["create"]>[0]) => ({
        provider_config_id: `catalog-config-${input.operation_id}`, provider_slug: "openrouter", alias: input.alias,
      })),
      read: vi.fn(async () => null),
    } });
    const providerOperationId = crypto.randomUUID();
    await globalProviders.create(ownerContext, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL,
      operation_id: providerOperationId, provider_id: "openrouter", display_name: "OpenRouter",
      model_ids: [MODEL_ID], api_key: "synthetic-catalog-model-test-key" });
    const projectConfiguration = createOwnerResearchProjectConfigurationService(runtimeEnv as Env, ownerContext, project);
    const inferenceCalls: Array<{ readonly body: Record<string, unknown>; readonly alias: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/models/") && url.includes("/endpoints")) return freeOnlyCatalogResponse(DOTS);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      inferenceCalls.push({ body, alias: new Headers(init?.headers).get("cf-aig-byok-alias") });
      return new Response(JSON.stringify({ id: `catalog-probe-${inferenceCalls.length}`, object: "chat.completion",
        created: 1_759_000_000, model: DOTS, provider: "CatalogTestProvider",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
          content: JSON.stringify({ connected: true, qualification_purpose: "structured-output-connectivity" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
      }), { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": `catalog-log-${inferenceCalls.length}` } });
    };
    vi.stubGlobal("fetch", fetcher);
    const api = createResearchCatalogModelUseService({ env: runtimeEnv as Env, context: ownerContext, project_id: project,
      project_configuration: projectConfiguration,
      model_use: (selection) => createResearchProviderKeyModelUseComposition(runtimeEnv as Env, ownerContext, project, selection),
      now: () => new Date().toISOString(),
    });
    const operationId = crypto.randomUUID();
    const receipt = await api.start({ protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: operationId,
      expected_selection_revision: null, provider_id: "openrouter", model_id: DOTS,
      provider_operation_id: providerOperationId });
    expect(receipt).toMatchObject({ state: "selected", provider_id: "openrouter", model_id: DOTS,
      provider_operation_id: providerOperationId });
    expect(inferenceCalls).toHaveLength(2);
    expect(inferenceCalls.every((call) => call.body.model === DOTS && call.alias !== null)).toBe(true);
    expect(inferenceCalls.every((call) => (call.body.provider as Record<string, unknown>).allow_fallbacks === false)).toBe(true);
    const registered = await testEnv.CORE_DB.prepare(
      "SELECT model_ids_json,alias FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2",
    ).bind(owner, providerOperationId).first<{ readonly model_ids_json: string; readonly alias: string }>();
    expect(registered?.model_ids_json).toBe(JSON.stringify([MODEL_ID]));
    expect(inferenceCalls.every((call) => call.alias === registered?.alias)).toBe(true);
    expect(await testEnv.CORE_DB.prepare(
      "SELECT provider_operation_id,model_id,state FROM research_catalog_model_use_authorization " +
      "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
    ).bind(owner, project, operationId).first()).toEqual({ provider_operation_id: providerOperationId,
      model_id: DOTS, state: "SELECTED" });
  }, 20_000);
});

describe("stale accepted catalog intent status reconciliation", () => {
  it.each(["credential", "deployment"] as const)("closes an unstarted intent after %s generation changes", async changed => {
    const f = await staleIntentFixture({ credential_matches: changed === "deployment", deployment_matches: changed === "credential" });
    const result = changed === "credential" ? await f.api.readCurrent() : await f.api.read(f.operationId);

    expect(result).toMatchObject({ state: "blocked", phase: "provider_resolution", failure_code: "AUTHORITY_CHANGED",
      operation_id: f.operationId, provider_id: "openrouter", model_id: DOTS });
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({
      state: "BLOCKED", phase: "PROVIDER_RESOLUTION", failure_code: "AUTHORITY_CHANGED",
      request_sha256: f.intent.request_sha256, owner_credential_generation: f.parentCredential,
      deployment_generation: f.parentDeployment, project_generation: 1,
    });
    expect(await f.api.readCurrent()).toBeNull();
    expect(f.modelUse).not.toHaveBeenCalled();
  });

  it("leaves an intent pending while its original credential and deployment remain current", async () => {
    const f = await staleIntentFixture({ credential_matches: true, deployment_matches: true });

    await expect(f.api.readCurrent()).resolves.toMatchObject({ state: "accepted", phase: "intent" });
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({ state: "ACCEPTED", phase: "INTENT" });
    expect(f.modelUse).not.toHaveBeenCalled();
  });

  it("does not close prepared or qualifying work even after its authority generation changes", async () => {
    const f = await staleIntentFixture();
    await f.store.transition({ owner_id: f.owner, project_id: f.project, operation_id: f.operationId,
      expected_state: "ACCEPTED", expected_phase: "INTENT", state: "PREPARING", phase: "PROVIDER_RESOLUTION",
      updated_at: f.createdAt });
    await f.store.transition({ owner_id: f.owner, project_id: f.project, operation_id: f.operationId,
      expected_state: "PREPARING", expected_phase: "PROVIDER_RESOLUTION", state: "QUALIFYING", phase: "QUALIFICATION",
      updated_at: f.createdAt });

    await expect(f.api.readCurrent()).resolves.toMatchObject({ state: "qualifying", phase: "qualification" });
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({ state: "QUALIFYING", phase: "QUALIFICATION" });
    expect(f.modelUse).not.toHaveBeenCalled();
  });

  it.each(["legacy-child", "v2-evidence"] as const)("does not close an intent with %s", async effect => {
    const f = await staleIntentFixture();
    if (effect === "legacy-child") await insertLegacyModelUseChild(f);
    else await insertV2Evidence(f);

    await expect(f.api.readCurrent()).resolves.toMatchObject({ state: "accepted", phase: "intent" });
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({ state: "ACCEPTED", phase: "INTENT" });
    expect(f.modelUse).not.toHaveBeenCalled();
  });

  it("SQL-fences recovery when the current project generation changes", async () => {
    const f = await staleIntentFixture();
    await testEnv.CORE_DB.prepare("UPDATE project SET generation=2 WHERE project_id=?1").bind(f.project).run();
    const row = await f.store.read(f.owner, f.project, f.operationId);
    if (row === null) throw new Error("missing recovery test intent");

    await expect(f.store.closeStaleIntentIfUnstarted({ row,
      current_owner_credential_generation: f.currentCredential,
      current_deployment_generation: f.currentDeployment, updated_at: f.createdAt,
    })).resolves.toBe(false);
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({ state: "ACCEPTED", phase: "INTENT" });
  });

  it("does not reconcile after the owner read is cancelled", async () => {
    const f = await staleIntentFixture();
    f.signalController.abort();

    await expect(f.api.readCurrent()).rejects.toMatchObject({ code: "RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED" });
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({ state: "ACCEPTED", phase: "INTENT" });
    expect(f.modelUse).not.toHaveBeenCalled();
  });
});

describe("pre-child legacy unresolved start failure", () => {
  async function prepare(f: Awaited<ReturnType<typeof staleIntentFixture>>) {
    f.modelUse.mockReturnValue({
      start: async () => { throw new ResearchProviderKeyModelUseServiceError(
        "PROVIDER_KEY_MODEL_USE_OPERATION_UNRESOLVED", 409, "existing operation unresolved"); },
      read: async () => { throw new Error("unexpected child read"); },
    });
    return f.api.start({ protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: f.operationId,
      expected_selection_revision: null, provider_id: "openrouter", model_id: DOTS,
      provider_operation_id: f.providerOperationId });
  }

  it("returns a persisted blocked receipt only when the exact legacy child is absent", async () => {
    const f = await staleIntentFixture({ credential_matches: true, deployment_matches: true });

    await expect(prepare(f)).resolves.toMatchObject({ state: "blocked", phase: "provider_resolution",
      failure_code: "SERVER_POLICY_UNAVAILABLE", operation_id: f.operationId });
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({ state: "BLOCKED",
      phase: "PROVIDER_RESOLUTION", failure_code: "SERVER_POLICY_UNAVAILABLE",
      request_sha256: f.intent.request_sha256, owner_credential_generation: f.parentCredential,
      project_generation: 1, deployment_generation: f.parentDeployment });
  });

  it.each(["legacy-child", "v2-evidence"] as const)("preserves an intent when %s exists and returns no synthetic receipt", async effect => {
    const f = await staleIntentFixture({ credential_matches: true, deployment_matches: true });
    if (effect === "legacy-child") await insertLegacyModelUseChild(f);
    else await insertV2Evidence(f);

    await expect(prepare(f)).rejects.toMatchObject({ code: "PROVIDER_KEY_MODEL_USE_OPERATION_UNRESOLVED" });
    expect(await f.store.read(f.owner, f.project, f.operationId)).toMatchObject({ state: "ACCEPTED", phase: "INTENT" });
  });
});
