import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createResearchProviderKeyConfigurationService } from "../src/research-provider-key-configuration-service.js";
import { createOwnerResearchProjectConfigurationService } from "../src/research-project-configuration-composition.js";
import { resolveResearchRunAdmissionConfiguration } from "../src/research-run-configuration-admission.js";
import { RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL, RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL } from "@eliotr/contracts";
import type { ResearchRunConfigurationAssociation } from "@eliotr/cloudflare-workflows";
import {
  createNativeUseEnvironment,
  freeOnlyCatalogResponse,
  GATEWAY_ACCOUNT_ID,
  MODEL_ID,
} from "./research-provider-key-model-use-fixture.js";
import type { ResearchProviderKeyManagementPort } from "../src/research-provider-key-configuration-service.js";
import type { ResearchProviderKeyConfigurationService } from "@eliotr/cloudflare-model-control";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ResearchProjectModelConfigurationService } from "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
import type { Env } from "../src/env.js";
import { handleResearchProviderKeyModelUseHttp } from "../src/research-provider-key-model-use-http.js";
import { createResearchProviderKeyModelUseService } from "../src/research-provider-key-model-use-service.js";
import type * as NativeAuthorityModule from "../src/research-provider-native-model-authority.js";

const nativeAuthorityDiagnostics = vi.hoisted(() => ({ lastQualifyError: undefined as unknown }));
vi.mock("../src/research-provider-native-model-authority.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NativeAuthorityModule>();
  const realFactory = actual.createResearchProviderNativeModelAuthority;
  return {
    ...actual,
    createResearchProviderNativeModelAuthority: (options: Parameters<typeof realFactory>[0]) => {
      const authority = realFactory(options);
      return {
        ...authority,
        async qualify(input: Parameters<typeof authority.qualify>[0]) {
          try {
            return await authority.qualify(input);
          } catch (error) {
            nativeAuthorityDiagnostics.lastQualifyError = error;
            throw error;
          }
        },
      };
    },
  };
});

const TEST_ENV = {
  CORE_DB: env.CORE_DB,
  ENVIRONMENT: "development",
  DEPLOYMENT_GENERATION: "provider-key-model-use-test-generation",
  AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
  AI_GATEWAY_RETRIEVAL_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-retrieval`,
} as unknown as Env;

const migrationRuntime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
beforeAll(async () => {
  await applyD1Migrations(migrationRuntime.CORE_DB, migrationRuntime.CORE_MIGRATIONS);
});

const EFFECT_TABLES = [
  "research_provider_key_configuration_operation",
  "research_provider_key_model_use_operation",
  "research_provider_key_model_use_stage_operation",
  "research_provider_key_model_price_observation",
  "research_project_model_configuration_revision",
  "research_project_model_configuration_selection",
  "provider_native_model_preparation",
  "provider_native_model_qualification_attempt",
  "provider_native_model_qualification_observation",
  "provider_native_model_candidate",
  "provider_native_model_qualification_proof",
] as const;

function context(
  principal: string,
  project: string,
  options: { readonly clientClass?: AuthenticatedRequestContext["client_class"]; readonly signal?: AbortSignal } = {},
): AuthenticatedRequestContext {
  const credentialGeneration = `credential-${crypto.randomUUID()}`;
  return {
    request: new Request(`https://core.example/api/v1/projects/${project}/model-provider-key/model-use`,
      options.signal === undefined ? {} : { signal: options.signal }),
    principal_ref: principal,
    client_class: options.clientClass ?? "owner_pwa",
    credential_generation: credentialGeneration,
    trace_id: crypto.randomUUID(),
    access: {
      principal_ref: principal,
      credential_generation: credentialGeneration,
      expires_at: "2099-01-01T00:00:00.000Z",
      authentication_method: "cloudflare_access",
    },
  };
}

async function insertOwnerProject(database: D1Database, owner: string): Promise<string> {
  const project = `model-use-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  await database.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES (?1,'Model use status test','private','retention-test','source-policy-test','model-profile-test','depth-test',1,?2)",
  ).bind(project, timestamp).run();
  await database.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
    "VALUES (?1,?2,'provider-key-model-use-test-generation',?3,?3)",
  ).bind(project, owner, timestamp).run();
  return project;
}

async function countsForProject(database: D1Database, project: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const table of EFFECT_TABLES) {
    const row = await database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id=?1`)
      .bind(project).first<{ readonly count: number }>();
    counts[table] = row?.count ?? -1;
  }
  return Object.freeze(counts);
}

function serviceFor(requestContext: AuthenticatedRequestContext, project: string) {
  const effects = {
    keyRead: vi.fn(async () => { throw new Error("Unexpected provider-key read from status GET"); }),
    keyCreate: vi.fn(async () => { throw new Error("Unexpected provider-key write from status GET"); }),
    selectionRead: vi.fn(async () => { throw new Error("Unexpected selection read from status GET"); }),
    selectionWrite: vi.fn(async () => { throw new Error("Unexpected selection write from status GET"); }),
    transportFetch: vi.fn(async () => { throw new Error("Unexpected native model request from status GET"); }),
  };
  const keyConfiguration = {
    read: vi.fn(),
    readConfiguredOperation: effects.keyRead,
    create: effects.keyCreate,
  } as unknown as ResearchProviderKeyConfigurationService;
  const projectConfiguration = {
    readPage: vi.fn(),
    readSelected: effects.selectionRead,
    selectExisting: effects.selectionWrite,
    importQualifiedConfiguration: effects.selectionWrite,
  } as unknown as ResearchProjectModelConfigurationService;
  const service = createResearchProviderKeyModelUseService({
    env: TEST_ENV,
    context: requestContext,
    project_id: project,
    key_configuration: keyConfiguration,
    project_configuration: projectConfiguration,
    fetcher: effects.transportFetch as typeof fetch,
  });
  return { service, effects };
}

function statusGet(
  project: string,
  operationId: string,
  requestContext: AuthenticatedRequestContext,
  service: ReturnType<typeof serviceFor>["service"],
): Promise<Response> {
  return handleResearchProviderKeyModelUseHttp(
    new Request(`https://core.example/api/v1/projects/${project}/model-provider-key/model-use/${operationId}`),
    TEST_ENV,
    requestContext,
    project,
    crypto.randomUUID(),
    operationId,
    2_048,
    service,
  );
}

function expectNoPortEffects(effects: ReturnType<typeof serviceFor>["effects"]): void {
  expect(effects.keyRead).not.toHaveBeenCalled();
  expect(effects.keyCreate).not.toHaveBeenCalled();
  expect(effects.selectionRead).not.toHaveBeenCalled();
  expect(effects.selectionWrite).not.toHaveBeenCalled();
  expect(effects.transportFetch).not.toHaveBeenCalled();
}

function safeDiagnosticError(error: unknown, secrets: readonly string[], depth = 0): string {
  if (!(error instanceof Error)) return typeof error;
  if (depth >= 3) return "[cause depth limit]";
  const redact = (value: string) => secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), value);
  const code = "code" in error && typeof error.code === "string" ? ` code=${redact(error.code)}` : "";
  const cause = "cause" in error ? error.cause : undefined;
  return `${redact(error.name)}${code}: ${redact(error.message).slice(0, 240)}` +
    (cause === undefined ? "" : ` <- ${safeDiagnosticError(cause, secrets, depth + 1)}`);
}

afterEach(() => {
  nativeAuthorityDiagnostics.lastQualifyError = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("owner OpenRouter model-key use status", () => {
  it("reads an absent authorized operation without pricing, provider, key, or selection effects", async () => {
    const owner = `model-use-owner-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const before = await countsForProject(env.CORE_DB, project);
    const externalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Status GET must not access the pricing catalog or provider");
    });
    const requestContext = context(owner, project);
    const { service, effects } = serviceFor(requestContext, project);

    await expect(statusGet(project, crypto.randomUUID(), requestContext, service)).rejects.toMatchObject({
      code: "PROVIDER_KEY_MODEL_USE_NOT_FOUND",
      status: 404,
    });

    expect(externalFetch).not.toHaveBeenCalled();
    expectNoPortEffects(effects);
    expect(await countsForProject(env.CORE_DB, project)).toEqual(before);
  });

  it("rejects malformed, aborted, and non-owner GETs before any model-use effects", async () => {
    const owner = `model-use-owner-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const before = await countsForProject(env.CORE_DB, project);
    const externalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Rejected status GET must not access the pricing catalog or provider");
    });
    const operationId = crypto.randomUUID();

    const ownerContext = context(owner, project);
    const ownerService = serviceFor(ownerContext, project);
    await expect(statusGet(project, "not-an-operation-id", ownerContext, ownerService.service)).rejects.toMatchObject({
      code: "PROVIDER_KEY_MODEL_USE_INPUT_INVALID",
      status: 400,
    });

    const controller = new AbortController();
    controller.abort();
    const abortedContext = context(owner, project, { signal: controller.signal });
    const abortedService = serviceFor(abortedContext, project);
    await expect(statusGet(project, operationId, abortedContext, abortedService.service)).rejects.toMatchObject({
      code: "PROVIDER_KEY_MODEL_USE_OWNER_REQUIRED",
      status: 403,
    });

    const nonOwnerContext = context(owner, project, { clientClass: "trusted_agent" });
    const nonOwnerService = serviceFor(nonOwnerContext, project);
    await expect(statusGet(project, operationId, nonOwnerContext, nonOwnerService.service)).rejects.toMatchObject({
      code: "PROVIDER_KEY_MODEL_USE_OWNER_REQUIRED",
      status: 403,
    });

    expect(externalFetch).not.toHaveBeenCalled();
    expectNoPortEffects(ownerService.effects);
    expectNoPortEffects(abortedService.effects);
    expectNoPortEffects(nonOwnerService.effects);
    expect(await countsForProject(env.CORE_DB, project)).toEqual(before);
  });
});

describe("owner OpenRouter model-key check and use", () => {
  it("qualifies, imports and captures the exact Bunny selection, then replays without another external effect", async () => {
    nativeAuthorityDiagnostics.lastQualifyError = undefined;
    const owner = `model-use-owner-${crypto.randomUUID()}`;
    const runtimeEnv = await createNativeUseEnvironment(owner, env.CORE_DB, TEST_ENV);
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const projectContext = context(owner, project);
    const localKey = "sk-or-v1-local-test-placeholder-never-sent-to-a-provider";
    const keyOperationId = crypto.randomUUID();
    const managementSecrets: string[] = [];
    const managementPort: ResearchProviderKeyManagementPort = {
      account_id: GATEWAY_ACCOUNT_ID,
      gateway_id: "eliotr-reasoning",
      create: vi.fn(async (input) => {
        managementSecrets.push(input.secret);
        return {
          protocol: "eliotr.openrouter-provider-key-configured.v1",
          disposition: "configured_not_qualified",
          account_id: GATEWAY_ACCOUNT_ID,
          gateway_id: "eliotr-reasoning",
          provider_config_id: `local-provider-config-${crypto.randomUUID()}`,
          provider_slug: "openrouter",
          alias: input.alias,
          default_config: false,
          secret_id: `local-secret-${crypto.randomUUID()}`,
          observed_modified_at: new Date().toISOString(),
        };
      }),
    };
    const keyConfiguration = createResearchProviderKeyConfigurationService({
      database: env.CORE_DB,
      managementPort,
    });
    const savedKey = await keyConfiguration.create(projectContext, project, {
      protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
      operation_id: keyOperationId,
      provider_id: "openrouter",
      provider_key: localKey,
    });
    expect(savedKey.receipt.status).toBe("configured_not_qualified");
    expect(managementSecrets).toEqual([localKey]);
    const projectConfiguration = createOwnerResearchProjectConfigurationService(runtimeEnv, projectContext, project);
    expect(await projectConfiguration.readSelected(projectContext, project)).toBeNull();

    const pricingUrls: string[] = [];
    const pricingFetch = vi.fn(async (resource: RequestInfo | URL): Promise<Response> => {
      pricingUrls.push(String(resource));
      return freeOnlyCatalogResponse();
    });
    vi.stubGlobal("fetch", pricingFetch);
    const modelRequests: Array<{ readonly url: string; readonly headers: Headers; readonly body: string }> = [];
    const modelFetcher: typeof fetch = async (resource, init) => {
      const url = resource instanceof Request ? resource.url : String(resource);
      const body = typeof init?.body === "string" ? init.body : "";
      modelRequests.push({ url, headers: new Headers(init?.headers), body });
      const callNumber = modelRequests.length;
      return new Response(JSON.stringify({
        id: `local-chat-${callNumber}`,
        object: "chat.completion",
        created: 1_759_000_000,
        model: MODEL_ID,
        choices: [{ index: 0, finish_reason: "stop", message: {
          role: "assistant",
          content: JSON.stringify({ connected: true, qualification_purpose: "structured-output-connectivity" }),
        } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "cf-aig-log-id": `local-gateway-log-${callNumber}` },
      });
    };
    const service = createResearchProviderKeyModelUseService({
      env: runtimeEnv,
      context: projectContext,
      project_id: project,
      key_configuration: keyConfiguration,
      project_configuration: projectConfiguration,
      fetcher: modelFetcher,
    });
    let lastStartError: unknown;
    const serviceStart = service.start.bind(service);
    const httpService: typeof service = {
      read: service.read.bind(service),
      async start(keyOperation, request) {
        lastStartError = undefined;
        try {
          return await serviceStart(keyOperation, request);
        } catch (error) {
          lastStartError = error;
          throw error;
        }
      },
    };
    const useOperationId = crypto.randomUUID();
    const postUse = async (
      requestedKeyOperationId: string,
      requestedUseOperationId: string,
      expectedSelectionRevision: number | null,
      diagnosticKey: string,
    ) => {
      nativeAuthorityDiagnostics.lastQualifyError = undefined;
      const useUrl = `https://core.example/api/v1/projects/${project}/model-provider-key/${requestedKeyOperationId}/check-and-use`;
      try {
        return await handleResearchProviderKeyModelUseHttp(new Request(useUrl, {
          method: "POST",
          headers: {
            Origin: "https://core.example",
            "Content-Type": "application/json",
            "x-eliotr-csrf": "1",
          },
          body: JSON.stringify({
            protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
            operation_id: requestedUseOperationId,
            expected_selection_revision: expectedSelectionRevision,
          }),
        }), runtimeEnv, projectContext, project, requestedKeyOperationId, requestedUseOperationId, 2_048, httpService);
      } catch (error) {
        if (lastStartError instanceof Error) {
          throw new Error(`HTTP handler masked service.start failure: ${safeDiagnosticError(lastStartError, [diagnosticKey, "local-test-gateway-token"])}`, { cause: error });
        }
        throw error;
      }
    };
    const selectedPayload = async (response: Response, diagnosticKey: string) => {
      const payload = await response.json() as { readonly data: Record<string, unknown> };
      if (payload.data.state !== "selected" && nativeAuthorityDiagnostics.lastQualifyError !== undefined) {
        const cause = nativeAuthorityDiagnostics.lastQualifyError;
        throw new Error(
          `Native qualification failed: ${safeDiagnosticError(cause, [diagnosticKey, "local-test-gateway-token"])}`,
          { cause },
        );
      }
      expect(response.status).toBe(200);
      return payload;
    };
    const readQualifiedStages = async (operationId: string) => {
      const rows = await env.CORE_DB.prepare(
        "SELECT stage,state,candidate_ref,candidate_sha256,qualification_ref,qualification_sha256 " +
        "FROM research_provider_key_model_use_stage_operation WHERE owner_id=?1 AND project_id=?2 " +
        "AND operation_id=?3 ORDER BY sequence_number",
      ).bind(owner, project, operationId).all<{
        readonly stage: string; readonly state: string; readonly candidate_ref: string | null;
        readonly candidate_sha256: string | null; readonly qualification_ref: string | null;
        readonly qualification_sha256: string | null;
      }>();
      expect(rows.results.map((row) => [row.stage, row.state])).toEqual([
        ["SYNTHESIZE", "QUALIFIED"], ["AUDIT_CLAIMS", "QUALIFIED"],
      ]);
      for (const row of rows.results) {
        expect(row.candidate_ref).toEqual(expect.any(String));
        expect(row.candidate_sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(row.qualification_ref).toEqual(expect.any(String));
        expect(row.qualification_sha256).toMatch(/^[a-f0-9]{64}$/u);
      }
      return rows.results;
    };

    const firstResponse = await postUse(keyOperationId, useOperationId, null, localKey);
    const firstPayload = await selectedPayload(firstResponse, localKey);
    expect(firstPayload.data).toMatchObject({
      project_id: project,
      operation_id: useOperationId,
      key_operation_id: keyOperationId,
      state: "selected",
      phase: "complete",
      failure_code: null,
      selection_revision: 1,
    });
    expect(firstPayload.data.selected_configuration_ref).toMatch(/^rpmc-[a-f0-9]{64}$/u);

    const operation = await env.CORE_DB.prepare(
      "SELECT state,phase,failure_code,selected_configuration_ref,selection_revision FROM " +
      "research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
    ).bind(owner, project, useOperationId).first<{
      readonly state: string; readonly phase: string; readonly failure_code: string | null;
      readonly selected_configuration_ref: string | null; readonly selection_revision: number | null;
    }>();
    expect(operation).toMatchObject({
      state: "SELECTED",
      phase: "COMPLETE",
      failure_code: null,
      selected_configuration_ref: firstPayload.data.selected_configuration_ref,
      selection_revision: 1,
    });
    const stageRows = await readQualifiedStages(useOperationId);
    const selected = await projectConfiguration.readSelected(projectContext, project);
    expect(selected?.configuration.model_selections).toHaveLength(2);
    expect(selected?.configuration.model_selections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidate_kind: "provider-native-v1",
        stage: "SYNTHESIZE",
        transport_policy: expect.objectContaining({
          api: "openrouter-chat-completions",
          provider: "openrouter",
          model: MODEL_ID,
          billing: expect.objectContaining({ mode: "byok", free_only: true }),
        }),
      }),
      expect.objectContaining({ candidate_kind: "provider-native-v1", stage: "AUDIT_CLAIMS" }),
    ]));

    const runActor: ResearchRunConfigurationAssociation = {
      operation_id: crypto.randomUUID(), investigation_id: `model-use-run-${crypto.randomUUID()}`,
      principal_ref: owner,
      deployment_generation: runtimeEnv.DEPLOYMENT_GENERATION,
    };
    const captureRun = (actor: ResearchRunConfigurationAssociation) => resolveResearchRunAdmissionConfiguration(runtimeEnv, {
      actor, scope_expression: { kind: "PROJECT", project_id: project }, new_run: true, context: projectContext,
      require_current_scope: async () => {
        const authority = await env.CORE_DB.prepare("SELECT 1 AS current FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
          "WHERE p.project_id=?1 AND o.principal_ref=?2 AND o.deployment_generation=?3")
          .bind(project, owner, runtimeEnv.DEPLOYMENT_GENERATION).first<{ readonly current: number }>();
        if (authority?.current !== 1) throw new Error("Local owner/project selection authority changed");
      },
    });
    const capturedRun = await captureRun(runActor);
    expect(capturedRun.mode).toBe("snapshot-v2");
    expect(capturedRun.project_id).toBe(project);
    expect(capturedRun.project_owner_ref).toBe(owner);
    expect(capturedRun.model_selections).toHaveLength(2);
    expect(capturedRun.model_selections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidate_kind: "provider-native-v1",
        stage: "SYNTHESIZE",
        transport_policy: expect.objectContaining({
          api: "openrouter-chat-completions",
          provider: "openrouter",
          model: MODEL_ID,
          billing: expect.objectContaining({ mode: "byok", alias: savedKey.receipt.alias, free_only: true }),
        }),
      }),
      expect.objectContaining({
        candidate_kind: "provider-native-v1",
        stage: "AUDIT_CLAIMS",
        transport_policy: expect.objectContaining({ model: MODEL_ID }),
      }),
    ]));

    const persistedBeforeReplay = await countsForProject(env.CORE_DB, project);
    const externalEffectsBeforeReplay = {
      keyWrites: managementSecrets.length,
      pricingReads: pricingFetch.mock.calls.length,
      modelCalls: modelRequests.length,
    };
    const replayResponse = await postUse(keyOperationId, useOperationId, null, localKey);
    expect(replayResponse.status).toBe(200);
    const replayPayload = await replayResponse.json() as { readonly data: Record<string, unknown> };
    expect(replayPayload.data).toEqual(firstPayload.data);
    expect(await countsForProject(env.CORE_DB, project)).toEqual(persistedBeforeReplay);
    expect({
      keyWrites: managementSecrets.length,
      pricingReads: pricingFetch.mock.calls.length,
      modelCalls: modelRequests.length,
    }).toEqual(externalEffectsBeforeReplay);

    const selectedBeforeReplacement = await projectConfiguration.readSelected(projectContext, project);
    if (selectedBeforeReplacement === null) throw new Error("Selected Native configuration is unavailable before key replacement");
    expect(selectedBeforeReplacement.selection_revision).toBe(1);
    const originalCapturedPins = JSON.stringify(capturedRun.model_selections);
    const replacementKey = "sk-or-v1-local-test-replacement-never-sent-to-a-provider";
    const replacementKeyOperationId = crypto.randomUUID();
    const replacementKeyReceipt = await keyConfiguration.create(projectContext, project, {
      protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
      operation_id: replacementKeyOperationId,
      provider_id: "openrouter",
      provider_key: replacementKey,
    });
    expect(replacementKeyReceipt.receipt.status).toBe("configured_not_qualified");
    expect(replacementKeyReceipt.receipt.alias).not.toBe(savedKey.receipt.alias);
    expect(managementSecrets).toEqual([localKey, replacementKey]);

    const replacementUseOperationId = crypto.randomUUID();
    const replacementResponse = await postUse(replacementKeyOperationId, replacementUseOperationId,
      selectedBeforeReplacement.selection_revision, replacementKey);
    const replacementPayload = await selectedPayload(replacementResponse, replacementKey);
    expect(replacementPayload.data).toMatchObject({
      project_id: project, operation_id: replacementUseOperationId, key_operation_id: replacementKeyOperationId,
      state: "selected", phase: "complete", failure_code: null,
      selection_revision: selectedBeforeReplacement.selection_revision + 1,
    });

    const replacementStages = await readQualifiedStages(replacementUseOperationId);
    const originalCandidateRefs = new Set(stageRows.map((row) => row.candidate_ref));
    expect(replacementStages.every((row) => row.candidate_ref !== null && !originalCandidateRefs.has(row.candidate_ref))).toBe(true);

    const replacementSelected = await projectConfiguration.readSelected(projectContext, project);
    if (replacementSelected === null) throw new Error("Replacement Native configuration was not selected");
    expect(replacementSelected.configuration_ref).toBe(replacementPayload.data.selected_configuration_ref);
    expect(replacementSelected.selection_revision).toBe(replacementPayload.data.selection_revision);
    expect(replacementSelected.configuration.model_selections).toHaveLength(2);
    expect(replacementSelected.configuration.model_selections.every((selection) =>
      selection.candidate_kind === "provider-native-v1" && selection.transport_policy.billing.mode === "byok" &&
      selection.transport_policy.billing.alias === replacementKeyReceipt.receipt.alias)).toBe(true);
    expect(JSON.stringify(capturedRun.model_selections)).toBe(originalCapturedPins);
    expect(capturedRun.model_selections.every((selection) => selection.transport_policy.billing.mode === "byok" &&
      selection.transport_policy.billing.alias === savedKey.receipt.alias)).toBe(true);

    const replacementRun = await captureRun({
      operation_id: crypto.randomUUID(), investigation_id: `model-use-run-${crypto.randomUUID()}`,
      principal_ref: owner, deployment_generation: runtimeEnv.DEPLOYMENT_GENERATION,
    });
    expect(replacementRun.model_selections).toHaveLength(2);
    expect(replacementRun.model_selections.every((selection) => selection.transport_policy.billing.mode === "byok" &&
      selection.transport_policy.billing.alias === replacementKeyReceipt.receipt.alias)).toBe(true);
    const candidateBindings = await env.CORE_DB.prepare(
      "SELECT candidate_json FROM provider_native_model_candidate WHERE owner_ref=?1 AND project_id=?2",
    ).bind(owner, project).all<{ readonly candidate_json: string }>();
    const keyBindingOperationIds = candidateBindings.results.map((row) =>
      (JSON.parse(row.candidate_json) as { readonly preparation: { readonly key_binding: { readonly operation_id: string } } })
        .preparation.key_binding.operation_id);
    expect(keyBindingOperationIds.filter((id) => id === keyOperationId)).toHaveLength(2);
    expect(keyBindingOperationIds.filter((id) => id === replacementKeyOperationId)).toHaveLength(2);

    const persistedBeforeReplacementReplay = await countsForProject(env.CORE_DB, project);
    const replacementEffectsBeforeReplay = {
      keyWrites: managementSecrets.length, pricingReads: pricingFetch.mock.calls.length, modelCalls: modelRequests.length,
    };
    const replacementReplay = await postUse(replacementKeyOperationId, replacementUseOperationId,
      selectedBeforeReplacement.selection_revision, replacementKey);
    expect(replacementReplay.status).toBe(200);
    const replacementReplayPayload = await replacementReplay.json() as { readonly data: Record<string, unknown> };
    expect(replacementReplayPayload.data).toEqual(replacementPayload.data);
    expect(await countsForProject(env.CORE_DB, project)).toEqual(persistedBeforeReplacementReplay);
    expect({ keyWrites: managementSecrets.length, pricingReads: pricingFetch.mock.calls.length, modelCalls: modelRequests.length })
      .toEqual(replacementEffectsBeforeReplay);

    expect(pricingUrls).toEqual(Array(4).fill("https://openrouter.ai/api/v1/models/stealth/space-bunny-alpha/endpoints"));
    expect(modelRequests).toHaveLength(4);
    for (const [index, request] of modelRequests.entries()) {
      expect(request.url).toBe(`${TEST_ENV.AI_GATEWAY_REASONING_URL}/openrouter/chat/completions`);
      expect(request.headers.get("cf-aig-authorization")).toBe("Bearer local-test-gateway-token");
      expect(request.headers.get("cf-aig-byok-alias")).toBe(index < 2 ? savedKey.receipt.alias : replacementKeyReceipt.receipt.alias);
      expect(JSON.parse(request.body)).toMatchObject({
        model: MODEL_ID,
        provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, allow_fallbacks: false },
      });
      expect(request.body).not.toContain(localKey);
      expect(request.body).not.toContain(replacementKey);
    }
    expect(JSON.stringify(await env.CORE_DB.prepare(
      "SELECT * FROM research_provider_key_configuration_operation WHERE project_id=?1",
    ).bind(project).all())).not.toContain(localKey);
  }, 15_000);
});
