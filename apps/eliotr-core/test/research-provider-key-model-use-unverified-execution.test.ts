import { applyD1Migrations, env as generatedEnv, reset, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL, RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
  SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL } from "@eliotr/contracts";
import { createResearchProviderKeyModelUseUnverifiedExecutionReconciler } from
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-store.js";
import { createCatalogQualificationGatewayLogReader } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-use-store.js";
import { createResearchProviderKeyModelUseService as createPackageModelUseService } from
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-service.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { createServiceModelProviderService } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { createResearchProviderKeyConfigurationService, type ResearchProviderKeyManagementPort } from
  "../src/research-provider-key-configuration-service.js";
import { createGlobalServiceProviderKeyConfiguration } from "../src/research-provider-key-model-use-composition.js";
import { createResearchProviderNativeModelAuthority } from "../src/research-provider-native-model-authority.js";
import { createResearchProviderKeyModelUsePlanInputsFromEnv } from "../src/research-provider-key-model-use-plan.js";
import { createOwnerResearchProjectConfigurationService } from "../src/research-project-configuration-composition.js";
import { createNativeUseEnvironment, freeOnlyCatalogResponse, GATEWAY_ACCOUNT_ID, MODEL_ID } from
  "./research-provider-key-model-use-fixture.js";

const env = generatedEnv as unknown as Env & { readonly CORE_MIGRATIONS: D1Migration[] };
const database = env.CORE_DB;
const TEST_ENV = {
  CORE_DB: database,
  ENVIRONMENT: "development",
  DEPLOYMENT_GENERATION: "legacy-unverified-execution-test-generation",
  AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${GATEWAY_ACCOUNT_ID}/eliotr-reasoning`,
} as unknown as Env;

beforeAll(async () => { await reset(); await applyD1Migrations(database, env.CORE_MIGRATIONS); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function ownerContext(owner: string, project: string): AuthenticatedRequestContext {
  const generation = `credential-${crypto.randomUUID()}`;
  return {
    request: new Request(`https://core.example/api/v1/projects/${project}/model-provider-key/model-use`),
    principal_ref: owner, client_class: "owner_pwa", credential_generation: generation, trace_id: crypto.randomUUID(),
    access: { principal_ref: owner, credential_generation: generation, expires_at: "2099-01-01T00:00:00.000Z",
      authentication_method: "cloudflare_access" },
  };
}

async function setupUncertainOperation(options: Readonly<{ globalBinding?: boolean }> = {}) {
  const owner = `unverified-owner-${crypto.randomUUID()}`;
  const project = `unverified-project-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  await database.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES(?1,'Unverified execution test','private','retention-test','source-policy-test','profile-test','depth-test',1,?2)",
  ).bind(project, timestamp).run();
  await database.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",
  ).bind(project, owner, TEST_ENV.DEPLOYMENT_GENERATION, timestamp).run();
  const context = ownerContext(owner, project);
  const runtimeEnv = await createNativeUseEnvironment(owner, database, TEST_ENV);
  const keyOperationId = crypto.randomUUID();
  const managementPort: ResearchProviderKeyManagementPort = {
    account_id: GATEWAY_ACCOUNT_ID,
    gateway_id: "eliotr-reasoning",
    create: async (request) => ({
      protocol: "eliotr.openrouter-provider-key-configured.v1",
      disposition: "configured_not_qualified",
      account_id: GATEWAY_ACCOUNT_ID,
      gateway_id: "eliotr-reasoning",
      provider_config_id: `local-config-${crypto.randomUUID()}`,
      provider_slug: "openrouter",
      alias: request.alias,
      default_config: false,
      secret_id: `local-secret-${crypto.randomUUID()}`,
      observed_modified_at: new Date().toISOString(),
    }),
  };
  const projectKeys = createResearchProviderKeyConfigurationService({ database, managementPort });
  const projectConfiguration = createOwnerResearchProjectConfigurationService(runtimeEnv, context, project);
  let keyConfiguration = projectKeys;
  if (options.globalBinding === true) {
    const serviceModels = createServiceModelProviderService({ database, managementPort: {
      available: true,
      create: async (request) => ({ provider_config_id: `global-config-${keyOperationId}`,
        provider_slug: "openrouter", alias: request.alias }),
      read: async () => null,
    } });
    await serviceModels.create(context, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operation_id: keyOperationId,
      provider_id: "openrouter", display_name: "Global OpenRouter fixture", model_ids: [MODEL_ID],
      api_key: "global-fixture-provider-key-value" });
    keyConfiguration = createGlobalServiceProviderKeyConfiguration({ env: runtimeEnv, project_id: project,
      project_configuration: projectConfiguration, project_keys: projectKeys, service_models: serviceModels });
    const projectRows = await database.prepare(
      "SELECT count(*) AS count FROM research_provider_key_configuration_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
    ).bind(owner, project, keyOperationId).first<{ count: number }>();
    expect(projectRows?.count).toBe(0);
  } else {
    await keyConfiguration.create(context, project, {
      protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
      operation_id: keyOperationId,
      provider_id: "openrouter",
      provider_key: "test-only-placeholder",
    });
  }
  vi.stubGlobal("fetch", async () => freeOnlyCatalogResponse());
  let nativeCalls = 0;
  const modelFetcher: typeof fetch = async () => {
    nativeCalls += 1;
    if (nativeCalls === 2) throw new Error("original probe response body read failed");
    return new Response(JSON.stringify({
      id: `fixture-chat-${nativeCalls}`, object: "chat.completion", created: 1_759_000_000, model: MODEL_ID,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
        content: JSON.stringify({ connected: true, qualification_purpose: "structured-output-connectivity" }) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": `fixture-log-${nativeCalls}` } });
  };
  let logs: readonly unknown[] = [];
  let gatewayReads = 0;
  const gatewayFetch: typeof fetch = async (input, init) => {
    gatewayReads += 1;
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-server-control-token");
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/client/v4/accounts/${GATEWAY_ACCOUNT_ID}/ai-gateway/gateways/eliotr-reasoning/logs`);
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe("50");
    const filters = JSON.parse(url.searchParams.get("filters") ?? "[]") as Array<{ key: string; operator: string; value: string[] }>;
    expect(filters).toHaveLength(4);
    expect(filters[0]).toMatchObject({ key: "metadata.key", operator: "eq", value: ["operation_id"] });
    expect(filters[1]).toMatchObject({ key: "metadata.value", operator: "eq" });
    return new Response(JSON.stringify({ success: true, result: logs,
      result_info: { page: 1, per_page: 50, total_count: logs.length } }),
    { status: 200, headers: { "content-type": "application/json" } });
  };
  const readLogs = createCatalogQualificationGatewayLogReader({ account_id: GATEWAY_ACCOUNT_ID,
    gateway_id: "eliotr-reasoning", control_token: "fixture-server-control-token",
    signal: context.request?.signal ?? new AbortController().signal, fetcher: gatewayFetch });
  const reconciler = createResearchProviderKeyModelUseUnverifiedExecutionReconciler({
    database, context, deployment_generation: TEST_ENV.DEPLOYMENT_GENERATION, read_logs: readLogs,
    now: () => new Date(Math.max(...logs.map((item) => Date.parse((item as { created_at: string }).created_at))) + 1_000).toISOString(),
  });
  let reconcilerCalls = 0;
  const planInputs = createResearchProviderKeyModelUsePlanInputsFromEnv(runtimeEnv);
  const service = createPackageModelUseService({
    database,
    runtime_policy: { ...planInputs.runtime_policy, deployment_generation: TEST_ENV.DEPLOYMENT_GENERATION,
      gateway_base_url: TEST_ENV.AI_GATEWAY_REASONING_URL, gateway_token: "test-only-gateway-token" },
    semantic_source: planInputs.semantic_source,
    context,
    project_id: project,
    key_configuration: keyConfiguration,
    project_configuration: projectConfiguration,
    native_authority_factory: (authority) => createResearchProviderNativeModelAuthority({ env: runtimeEnv,
      current_scope: authority.current_scope, readConfiguredOperation: authority.readConfiguredOperation }),
    fetcher: modelFetcher,
    reconcile_unverified_execution: async (row) => { reconcilerCalls += 1; await reconciler(row); },
  });
  const operationId = crypto.randomUUID();
  const request = { protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL, operation_id: operationId,
    expected_selection_revision: null } as const;
  let uncertain = await service.start(keyOperationId, request);
  if (uncertain.state === "qualifying") uncertain = await service.start(keyOperationId, request);
  expect(uncertain.state).toBe("uncertain");
  expect(nativeCalls).toBe(2);

  const preparations = (await database.prepare(
    "SELECT p.preparation_json,p.preparation_ref,p.preparation_sha256,a.started_at FROM provider_native_model_preparation p " +
    "JOIN provider_native_model_qualification_attempt a ON a.preparation_ref=p.preparation_ref " +
    "WHERE p.owner_ref=?1 AND p.project_id=?2 AND p.owner_operation_id=?3 ORDER BY p.stage",
  ).bind(owner, project, operationId).all<Record<string, string>>()).results;
  expect(preparations).toHaveLength(2);
  logs = preparations.map((row, index) => {
    const preparation = JSON.parse(row.preparation_json) as {
      stage: string; prepared_at: string; preparation_expires_at: string;
      pricing_snapshot_ref: string; probe_parameters_sha256: string;
      probe_deployment: { prompt_generation: string; route_ref: string };
      transport_policy: { model: string };
    };
    return {
      id: crypto.randomUUID(),
      created_at: new Date(Date.parse(row.started_at) + 500 + index).toISOString(),
      provider: "openrouter", model: preparation.transport_policy.model, status_code: 200,
      success: true, cached: false,
      metadata: { operation_id: operationId, parameters_digest: preparation.probe_parameters_sha256,
        pricing_snapshot_ref: preparation.pricing_snapshot_ref,
        prompt_generation: preparation.probe_deployment.prompt_generation,
        route_ref: preparation.probe_deployment.route_ref },
    };
  });
  const before = await database.prepare(
    "SELECT state,phase,active_stage,failure_code,updated_at FROM research_provider_key_model_use_operation " +
    "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
  ).bind(owner, project, operationId).first<Record<string, unknown>>();
  const uncertainStageBefore = await database.prepare(
    "SELECT state,failure_code,preparation_ref,preparation_sha256,candidate_ref,qualification_ref,updated_at " +
    "FROM research_provider_key_model_use_stage_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 AND stage='AUDIT_CLAIMS'",
  ).bind(owner, project, operationId).first<Record<string, unknown>>();
  const attemptBefore = await database.prepare(
    "SELECT state,observation_ref,candidate_ref,qualification_ref,started_at,completed_at,preparation_ref,preparation_sha256 " +
    "FROM provider_native_model_qualification_attempt WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 AND stage='AUDIT_CLAIMS'",
  ).bind(owner, project, operationId).first<Record<string, unknown>>();
  return { owner, project, context, keyOperationId, operationId, service, getNativeCalls: () => nativeCalls,
    getGatewayReads: () => gatewayReads, getReconcilerCalls: () => reconcilerCalls,
    logs, preparations, before, uncertainStageBefore, attemptBefore };
}

it("persists a guarded unverified receipt, preserves the uncertain stage, and releases only after index readback", async () => {
  const fixture = await setupUncertainOperation();
  await expect(database.prepare(
    "UPDATE research_provider_key_model_use_operation SET state='BLOCKED',failure_code='NATIVE_RECEIPT_INVALID' " +
    "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
  ).bind(fixture.owner, fixture.project, fixture.operationId).run()).rejects.toThrow();
  const auditPreparation = fixture.preparations.find((entry) =>
    (JSON.parse(entry.preparation_json) as { stage: string }).stage === "AUDIT_CLAIMS");
  const auditLog = fixture.logs.find((entry) =>
    (entry as { metadata: { pricing_snapshot_ref: string } }).metadata.pricing_snapshot_ref ===
      (JSON.parse(auditPreparation?.preparation_json ?? "{}") as { pricing_snapshot_ref: string }).pricing_snapshot_ref) as
      { created_at: string } | undefined;
  if (auditPreparation === undefined || auditLog === undefined) throw new Error("Audit fixture evidence is incomplete");
  await expect(database.prepare(
    "INSERT INTO research_provider_key_model_use_unverified_execution(owner_id,project_id,operation_id,stage,preparation_ref," +
    "preparation_sha256,account_id,gateway_id,gateway_log_id,http_status,logged_at,observed_at,receipt_json,receipt_sha256) " +
    "VALUES(?1,?2,?3,'AUDIT_CLAIMS',?4,?5,?6,'eliotr-reasoning','forged-caller-log',200,?7,?8,'{}',?9)",
  ).bind(fixture.owner, fixture.project, fixture.operationId, auditPreparation.preparation_ref,
    auditPreparation.preparation_sha256, GATEWAY_ACCOUNT_ID, auditLog.created_at, new Date().toISOString(), "a".repeat(64)).run())
    .rejects.toThrow();
  const forgedCount = await database.prepare(
    "SELECT count(*) AS count FROM research_provider_key_model_use_unverified_execution WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
  ).bind(fixture.owner, fixture.project, fixture.operationId).first<{ count: number }>();
  expect(forgedCount?.count).toBe(0);
  expect(fixture.before).toMatchObject({ state: "UNCERTAIN", phase: "NATIVE_QUALIFY", active_stage: "AUDIT_CLAIMS",
    failure_code: "QUALIFICATION_OUTCOME_UNCERTAIN" });
  expect(fixture.uncertainStageBefore).toMatchObject({ state: "UNCERTAIN", failure_code: "QUALIFICATION_OUTCOME_UNCERTAIN",
    candidate_ref: null, qualification_ref: null });
  expect(fixture.attemptBefore).toMatchObject({ state: "STARTED", observation_ref: null, candidate_ref: null,
    qualification_ref: null, completed_at: null });
  const operation = await fixture.service.read(fixture.operationId);
  expect(fixture.getReconcilerCalls()).toBe(1);
  expect(fixture.getGatewayReads()).toBe(1);
  expect(operation).toMatchObject({ state: "blocked", phase: "native_qualify", failure_code: "NATIVE_RECEIPT_INVALID" });
  expect(fixture.getNativeCalls()).toBe(2);
  const persistedOperation = await database.prepare(
    "SELECT state,phase,active_stage,failure_code FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
  ).bind(fixture.owner, fixture.project, fixture.operationId).first();
  expect(persistedOperation).toEqual({ state: "BLOCKED", phase: "NATIVE_QUALIFY", active_stage: "AUDIT_CLAIMS",
    failure_code: "NATIVE_RECEIPT_INVALID" });
  const stageAfter = await database.prepare(
    "SELECT state,failure_code,preparation_ref,preparation_sha256,candidate_ref,qualification_ref,updated_at " +
    "FROM research_provider_key_model_use_stage_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 AND stage='AUDIT_CLAIMS'",
  ).bind(fixture.owner, fixture.project, fixture.operationId).first();
  expect(stageAfter).toEqual(fixture.uncertainStageBefore);
  const attempt = await database.prepare(
    "SELECT state,observation_ref,candidate_ref,qualification_ref FROM provider_native_model_qualification_attempt " +
    "WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 AND stage='AUDIT_CLAIMS'",
  ).bind(fixture.owner, fixture.project, fixture.operationId).first();
  expect(attempt).toEqual({ state: "STARTED", observation_ref: null, candidate_ref: null, qualification_ref: null });
  const receipt = await database.prepare(
    "SELECT receipt_json,http_status,gateway_log_id FROM research_provider_key_model_use_unverified_execution " +
    "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
  ).bind(fixture.owner, fixture.project, fixture.operationId).first<{ receipt_json: string; http_status: number; gateway_log_id: string }>();
  expect(receipt?.http_status).toBe(200);
  expect(receipt?.gateway_log_id).toBe((fixture.logs[0] as { id: string }).id);
  const receiptJson = JSON.parse(receipt?.receipt_json ?? "{}") as Record<string, unknown>;
  expect(receiptJson).toMatchObject({ gateway_authenticated: true, success: true, cached: false,
    qualification: "UNVERIFIED", native_observation_retained: false, provider_effects: "UNKNOWN",
    classification: "EXECUTION_COMPLETED_QUALIFICATION_UNVERIFIED" });
  expect(receiptJson).not.toHaveProperty("response_body");
  const revocations = await database.prepare(
    "SELECT count(*) AS count FROM provider_native_model_qualification_revocation WHERE owner_ref=?1 AND project_id=?2",
  ).bind(fixture.owner, fixture.project).first<{ count: number }>();
  expect(revocations?.count).toBe(1);
  const unresolved = await database.prepare(
    "SELECT operation_id FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 " +
    "AND state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','UNCERTAIN') LIMIT 1",
  ).bind(fixture.owner, fixture.project).first();
  expect(unresolved).toBeNull();
  await expect(database.prepare("UPDATE research_provider_key_model_use_unverified_execution SET receipt_json='{}' " +
    "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3").bind(fixture.owner, fixture.project, fixture.operationId).run()).rejects.toThrow();
  await expect(database.prepare("DELETE FROM research_provider_key_model_use_unverified_execution " +
    "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3").bind(fixture.owner, fixture.project, fixture.operationId).run()).rejects.toThrow();
});

it("reconciles an existing uncertain owner row before rejecting a new intent, without creating or probing it", async () => {
  const fixture = await setupUncertainOperation({ globalBinding: true });
  const nextOperation = crypto.randomUUID();
  await expect(fixture.service.start(fixture.keyOperationId, { protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
    operation_id: nextOperation, expected_selection_revision: 7 })).rejects.toMatchObject({
    code: "PROVIDER_KEY_MODEL_USE_SELECTION_CAS_CONFLICT",
  });
  expect(fixture.getGatewayReads()).toBe(1);
  expect(fixture.getNativeCalls()).toBe(2);
  const [oldState, newParent] = await Promise.all([
    database.prepare("SELECT state,failure_code FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3")
      .bind(fixture.owner, fixture.project, fixture.operationId).first(),
    database.prepare("SELECT operation_id FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3")
      .bind(fixture.owner, fixture.project, nextOperation).first(),
  ]);
  expect(oldState).toEqual({ state: "BLOCKED", failure_code: "NATIVE_RECEIPT_INVALID" });
  expect(newParent).toBeNull();
});

it("does not fall back to a global binding when a pending project key row exists", async () => {
  const fixture = await setupUncertainOperation({ globalBinding: true });
  const global = await database.prepare(
    "SELECT alias FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2",
  ).bind(fixture.owner, fixture.keyOperationId).first<{ alias: string }>();
  expect(global).not.toBeNull();
  const now = new Date().toISOString();
  await database.prepare(
    "INSERT INTO research_provider_key_configuration_operation(owner_id,project_id,provider_id,operation_id,account_id,gateway_id," +
    "request_sha256,alias,state,provider_config_id,metadata_sha256,failure_code,provider_http_status,created_at,updated_at) " +
    "VALUES(?1,?2,'openrouter',?3,?4,'eliotr-reasoning',?5,?6,'PENDING',NULL,NULL,NULL,NULL,?7,?7)",
  ).bind(fixture.owner, fixture.project, fixture.keyOperationId, GATEWAY_ACCOUNT_ID,
    "a".repeat(64), global?.alias ?? `eliotr-${"b".repeat(48)}`, now).run();
  const authority = await database.prepare(
    "SELECT state,alias FROM research_provider_key_model_use_key_authority WHERE owner_id=?1 AND project_id=?2 " +
    "AND provider_id='openrouter' AND operation_id=?3",
  ).bind(fixture.owner, fixture.project, fixture.keyOperationId).all<{ state: string; alias: string }>();
  expect(authority.results).toEqual([{ state: "PENDING", alias: global?.alias }]);
  const newOperation = crypto.randomUUID();
  await expect(fixture.service.start(fixture.keyOperationId, { protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
    operation_id: newOperation, expected_selection_revision: 7 })).rejects.toMatchObject({
    code: "PROVIDER_KEY_MODEL_USE_OPERATION_UNRESOLVED",
  });
  expect(fixture.getGatewayReads()).toBe(0);
  expect(fixture.getNativeCalls()).toBe(2);
  const parent = await database.prepare(
    "SELECT operation_id FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
  ).bind(fixture.owner, fixture.project, newOperation).first();
  expect(parent).toBeNull();
});
