import { applyD1Migrations } from "cloudflare:test";
import { env as generatedEnv } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenRouterProviderKeyRestError } from "@eliotr/cloudflare-ai";
import { RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { handleResearchProviderKeyConfiguration } from "../src/research-provider-key-configuration-http.js";
import { createResearchProviderKeyConfigurationService } from "../src/research-provider-key-configuration-service.js";

const ACCOUNT_ID = "a".repeat(32);
const GATEWAY_ID = "eliotr-reasoning";
const runtime = generatedEnv as unknown as Env & {
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const env = runtime;
const TEST_ENV = runtime;

beforeAll(async () => {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
});

function context(principal: string, options: { readonly serviceToken?: boolean } = {}): AuthenticatedRequestContext {
  const credentialGeneration = `credential-${crypto.randomUUID()}`;
  return {
    request: new Request("https://core.example/api/v1/projects/project/model-provider-key"),
    principal_ref: principal,
    client_class: "owner_pwa",
    credential_generation: credentialGeneration,
    trace_id: crypto.randomUUID(),
    access: {
      principal_ref: principal,
      credential_generation: credentialGeneration,
      expires_at: "2099-01-01T00:00:00.000Z",
      authentication_method: options.serviceToken ? "service_token" : "cloudflare_access",
    },
  };
}

async function insertOwnerProject(database: D1Database, owner: string): Promise<string> {
  const project = `provider-key-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  await database.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES (?1,'Provider key test','private','retention-test','source-policy-test','model-profile-test','depth-test',1,?2)",
  ).bind(project, timestamp).run();
  await database.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
    "VALUES (?1,?2,'provider-key-test-generation',?3,?3)",
  ).bind(project, owner, timestamp).run();
  return project;
}

function createPort(onCreate?: (input: { readonly alias: string; readonly secret: string }) => Promise<void>) {
  const calls = vi.fn(async (
    input: { readonly alias: string; readonly secret: string },
    _execution?: { readonly signal?: AbortSignal; readonly deadline_ms?: number },
  ) => {
    await onCreate?.(input);
    return {
      protocol: "eliotr.openrouter-provider-key-configured.v1",
      disposition: "configured_not_qualified",
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      provider_config_id: `pcfg-${crypto.randomUUID()}`,
      provider_slug: "openrouter",
      alias: input.alias,
      default_config: false,
      secret_id: `secret-${crypto.randomUUID()}`,
      observed_modified_at: new Date().toISOString(),
    };
  });
  return {
    calls,
    port: { account_id: ACCOUNT_ID, gateway_id: GATEWAY_ID, create: calls },
  };
}

function requestBody(operationId: string, providerKey: string) {
  return {
    protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
    operation_id: operationId,
    provider_id: "openrouter",
    provider_key: providerKey,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("owner OpenRouter provider-key configuration", () => {
  it("creates one non-default alias, records safe readback and rejects changed-key replay", async () => {
    const owner = `provider-key-owner-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const key = "sk-or-v1-test-secret-do-not-persist-1234567890";
    const operationId = crypto.randomUUID();
    const { port, calls } = createPort();
    const service = createResearchProviderKeyConfigurationService({ database: env.CORE_DB, managementPort: port });
    const first = await service.create(context(owner), project, requestBody(operationId, key));
    const replay = await service.create(context(owner), project, requestBody(operationId, key));
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(first.receipt.alias).toMatch(/^eliotr-[0-9a-f]{48}$/u);
    expect(first.receipt.status).toBe("configured_not_qualified");
    expect(calls).toHaveBeenCalledTimes(1);
    const execution = calls.mock.calls[0]?.[1];
    expect(execution?.signal).toBeInstanceOf(AbortSignal);
    expect(execution?.deadline_ms).toBeGreaterThan(Date.now());
    expect(execution?.deadline_ms).toBeLessThanOrEqual(Date.now() + 30_000);

    await expect(service.create(context(owner), project,
      requestBody(operationId, `${key}-changed`))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_CONFLICT", status: 409,
    });
    const status = await service.read(context(owner), project);
    expect(status.configurations).toHaveLength(1);
    expect(status.configurations[0]).toMatchObject({
      operation_id: operationId, alias: first.receipt.alias,
      provider_config_id: first.receipt.provider_config_id, status: "configured_not_qualified",
    });
    const internal = await service.readConfiguredOperation(context(owner), project, operationId);
    expect(internal).toMatchObject({
      owner_id: owner, project_id: project, operation_id: operationId,
      provider_id: "openrouter", account_id: ACCOUNT_ID, gateway_id: GATEWAY_ID,
      alias: first.receipt.alias, provider_config_id: first.receipt.provider_config_id,
      status: "configured_not_qualified",
    });
    expect(internal).not.toHaveProperty("secret_id");
    const stored = await env.CORE_DB.prepare(
      "SELECT * FROM research_provider_key_configuration_operation WHERE project_id=?1",
    ).bind(project).all();
    expect(JSON.stringify({ first, replay, status, stored })).not.toContain(key);
    expect(JSON.stringify(stored)).not.toContain("secret_id");

    const url = `https://core.example/api/v1/projects/${project}/model-provider-key`;
    const read = (path: string) => handleResearchProviderKeyConfiguration(
      new Request(path), TEST_ENV, context(owner), project, 8_192, service,
    );
    const exact = await read(`${url}?operation_id=${operationId}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ data: {
      configurations: [{ operation_id: operationId, provider_config_id: first.receipt.provider_config_id }],
      truncated: false,
    } });
    const absent = await read(`${url}?operation_id=${crypto.randomUUID()}`);
    expect(await absent.json()).toMatchObject({ data: { configurations: [], truncated: false } });
    await expect(read(`${url}?operation_id=${operationId}&operation_id=${operationId}`)).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", status: 400,
    });
    await expect(read(`${url}?unexpected=1`)).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", status: 400,
    });
  });

  it("saves a replacement as a new operation and preserves safe replay readback", async () => {
    const owner = `provider-key-replacement-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const firstOperation = crypto.randomUUID();
    const replacementOperation = crypto.randomUUID();
    const firstKey = "sk-or-v1-fixture-original-key-1234567890";
    const replacementKey = "sk-or-v1-fixture-replacement-key-1234567890";
    const { port, calls } = createPort();
    const service = createResearchProviderKeyConfigurationService({ database: env.CORE_DB, managementPort: port });

    const first = await service.create(context(owner), project, requestBody(firstOperation, firstKey));
    const replacement = await service.create(context(owner), project, requestBody(replacementOperation, replacementKey));
    const replay = await service.create(context(owner), project, requestBody(replacementOperation, replacementKey));

    expect(first.replayed).toBe(false);
    expect(replacement.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replacement.receipt.alias).not.toBe(first.receipt.alias);
    expect(replacement.receipt.provider_config_id).not.toBe(first.receipt.provider_config_id);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls.map(([input]) => input.secret)).toEqual([firstKey, replacementKey]);

    const configurations = await service.read(context(owner), project);
    expect(configurations.configurations).toHaveLength(2);
    expect(configurations.configurations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation_id: firstOperation, alias: first.receipt.alias,
        provider_config_id: first.receipt.provider_config_id, status: "configured_not_qualified" }),
      expect.objectContaining({ operation_id: replacementOperation, alias: replacement.receipt.alias,
        provider_config_id: replacement.receipt.provider_config_id, status: "configured_not_qualified" }),
    ]));
    const configured = await service.readConfiguredOperation(context(owner), project, replacementOperation);
    expect(configured).toMatchObject({ operation_id: replacementOperation, alias: replacement.receipt.alias,
      provider_config_id: replacement.receipt.provider_config_id, status: "configured_not_qualified" });
    expect(configured).not.toHaveProperty("secret_id");

    await expect(service.create(context(owner), project,
      requestBody(replacementOperation, `${replacementKey}-changed`))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_OPERATION_CONFLICT", status: 409,
    });
    expect(calls).toHaveBeenCalledTimes(2);
    const stored = await env.CORE_DB.prepare(
      "SELECT operation_id,alias,provider_config_id,state FROM research_provider_key_configuration_operation " +
      "WHERE project_id=?1 ORDER BY operation_id",
    ).bind(project).all<{ operation_id: string; alias: string; provider_config_id: string | null; state: string }>();
    expect(stored.results).toHaveLength(2);
    expect(stored.results?.every((row) => row.state === "CONFIGURED")).toBe(true);
    expect(JSON.stringify({ first, replacement, replay, configurations, configured, stored })).not.toContain(firstKey);
    expect(JSON.stringify({ first, replacement, replay, configurations, configured, stored })).not.toContain(replacementKey);
  });

  it("fails closed for service-token principals and when server management authority is absent", async () => {
    const owner = `provider-key-denied-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const { port, calls } = createPort();
    const service = createResearchProviderKeyConfigurationService({ database: env.CORE_DB, managementPort: port });
    await expect(service.create(context(owner, { serviceToken: true }), project,
      requestBody(crypto.randomUUID(), "sk-or-v1-test-secret-do-not-persist-1234567890"))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_OWNER_REQUIRED", status: 403,
    });
    const unavailable = createResearchProviderKeyConfigurationService({ database: env.CORE_DB });
    await expect(unavailable.create(context(owner), project,
      requestBody(crypto.randomUUID(), "sk-or-v1-test-secret-do-not-persist-1234567890"))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_MANAGEMENT_UNAVAILABLE", status: 503,
    });
    expect(calls).not.toHaveBeenCalled();
    const count = await env.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM research_provider_key_configuration_operation WHERE project_id=?1",
    ).bind(project).first<{ readonly count: number }>();
    expect(count?.count).toBe(0);
  });

  it("records a terminal no-write provider rejection and preserves only its safe code/status", async () => {
    const owner = `provider-key-no-effect-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const calls = vi.fn(async () => {
      throw new OpenRouterProviderKeyRestError("OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
        "This message must not be persisted", { effect: "NONE", http_status: 429 });
    });
    const service = createResearchProviderKeyConfigurationService({ database: env.CORE_DB, managementPort: {
      account_id: ACCOUNT_ID, gateway_id: GATEWAY_ID, create: calls,
    } });
    const operationId = crypto.randomUUID();
    const input = requestBody(operationId, "sk-or-v1-test-secret-do-not-persist-1234567890");
    await expect(service.create(context(owner), project, input)).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_PROVIDER_REJECTED", status: 502, retryable: false,
    });
    await expect(service.create(context(owner), project, input)).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_PROVIDER_REJECTED", status: 502,
    });
    expect(calls).toHaveBeenCalledTimes(1);
    const status = await service.read(context(owner), project, operationId);
    expect(status.configurations).toHaveLength(1);
    expect(status.configurations[0]).toMatchObject({
      operation_id: operationId,
      status: "not_configured",
      failure_code: "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      provider_http_status: 429,
      provider_config_id: null,
    });
    const stored = await env.CORE_DB.prepare(
      "SELECT * FROM research_provider_key_configuration_operation WHERE project_id=?1",
    ).bind(project).first<Record<string, unknown>>();
    expect(stored).toMatchObject({ state: "FAILED_NO_EFFECT", failure_code: "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      provider_http_status: 429, provider_config_id: null, metadata_sha256: null });
    expect(JSON.stringify(stored)).not.toContain("This message must not be persisted");
  });

  it("persists an acknowledged provider effect but refuses a response after project generation changes", async () => {
    const owner = `provider-key-generation-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const { port } = createPort(async () => {
      await env.CORE_DB.prepare("UPDATE project SET generation=2 WHERE project_id=?1").bind(project).run();
    });
    const service = createResearchProviderKeyConfigurationService({ database: env.CORE_DB, managementPort: port });
    await expect(service.create(context(owner), project,
      requestBody(crypto.randomUUID(), "sk-or-v1-test-secret-do-not-persist-1234567890"))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_AUTHORITY_CHANGED", status: 409,
    });
    const status = await service.read(context(owner), project);
    expect(status.configurations).toHaveLength(1);
    expect(status.configurations[0]?.status).toBe("configured_not_qualified");
  });

  it("rejects cross-origin and missing-CSRF POSTs before any provider write", async () => {
    const owner = `provider-key-csrf-${crypto.randomUUID()}`;
    const project = await insertOwnerProject(env.CORE_DB, owner);
    const { port, calls } = createPort();
    const service = createResearchProviderKeyConfigurationService({ database: env.CORE_DB, managementPort: port });
    const url = `https://core.example/api/v1/projects/${project}/model-provider-key`;
    const json = JSON.stringify(requestBody(crypto.randomUUID(), "sk-or-v1-test-secret-do-not-persist-1234567890"));
    const makeRequest = (origin: string, csrf?: string) => new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json", Origin: origin,
        ...(csrf === undefined ? {} : { "x-eliotr-csrf": csrf }),
      },
      body: json,
    });
    const call = (request: Request) => handleResearchProviderKeyConfiguration(
      request, TEST_ENV, context(owner), project, 8_192, service,
    );
    await expect(call(makeRequest("https://attacker.example", "1"))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_CSRF_DENIED", status: 403,
    });
    await expect(call(makeRequest("https://core.example"))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_CSRF_DENIED", status: 403,
    });
    await expect(call(new Request(`${url}?operation_id=${crypto.randomUUID()}`, {
      method: "POST", headers: {
        "content-type": "application/json", Origin: "https://core.example", "x-eliotr-csrf": "1",
      }, body: json,
    }))).rejects.toMatchObject({
      code: "RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", status: 400,
    });
    expect(calls).not.toHaveBeenCalled();
  });
});
