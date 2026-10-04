import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchProviderKeyConfigurationService } from "@eliotr/cloudflare-model-control";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ResearchProjectModelConfigurationService } from "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
import type { Env } from "../src/env.js";
import { handleResearchProviderKeyModelUseHttp } from "../src/research-provider-key-model-use-http.js";
import { createResearchProviderKeyModelUseService } from "../src/research-provider-key-model-use-service.js";

const TEST_ENV = {
  CORE_DB: env.CORE_DB,
  ENVIRONMENT: "development",
  DEPLOYMENT_GENERATION: "provider-key-model-use-test-generation",
  AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
  AI_GATEWAY_RETRIEVAL_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-retrieval`,
} as unknown as Env;

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

afterEach(() => {
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
