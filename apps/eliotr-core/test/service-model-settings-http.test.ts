import { env as generatedEnv } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createServiceModelProviderService, ServiceModelProviderOperationError,
  type ServiceModelProviderService } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { handleServiceModelProviders, handleServiceModelSettings, handleServiceModelProvidersV2,
  handleServiceModelProviderCatalogPreferences } from "../src/service-model-settings-http.js";
import type { Env } from "../src/env.js";

const origin = "https://core.example";
const env = { ...generatedEnv, AI: { run: vi.fn(), models: vi.fn() } as unknown as Env["AI"] } as Env;
const operation = "6f06e11b-e2d0-4b16-8e84-44aa52d37533";
function context(request: Request, clientClass: AuthenticatedRequestContext["client_class"] = "owner_pwa"): AuthenticatedRequestContext {
  return { request, principal_ref: "owner-1", client_class: clientClass, credential_generation: "credential-1", trace_id: "trace-1",
    access: { principal_ref: "owner-1", credential_generation: "credential-1", expires_at: "2099-01-01T00:00:00.000Z" } };
}
function service(): ServiceModelProviderService {
  return { list: vi.fn(async () => { throw new ServiceModelProviderOperationError(
    "SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503, "storage unavailable", true); }),
  listV2: vi.fn(async () => ({ connections: [], truncated: false })),
  create: vi.fn(async () => { throw new Error("unexpected write"); }),
  connectCatalogManaged: vi.fn(async () => { throw new Error("unexpected write"); }),
  readOperation: vi.fn(async () => null), readOperationV2: vi.fn(async () => null),
  readCatalogPreferences: vi.fn(async (_context, provider_id) => ({
    protocol: "eliotr.service-model-provider-catalog-preferences.v1" as const, provider_id,
    visibility: { mode: "all" as const }, search: "", updated_at: null,
  })),
  updateCatalogPreferences: vi.fn(async (_context, input) => ({ ...input, updated_at: "2026-10-15T14:00:00.000Z" })),
  resolveConfiguredProvider: vi.fn(async () => null) };
}

describe("global model settings HTTP", () => {
  it("keeps built-in Cloudflare visible when external settings storage is unavailable", async () => {
    const request = new Request(`${origin}/api/v1/system/model-settings`);
    const response = await handleServiceModelSettings(request, env, context(request), service(), false);
    const body = await response.json() as { data: { cloudflare: unknown; external: unknown; project_id?: unknown } };
    expect(response.status).toBe(200);
    expect(body.data.cloudflare).toMatchObject({ connection: "builtin", binding_available: true,
      default_model_id: "@cf/zai-org/glm-5.3-flash" });
    expect(body.data.external).toMatchObject({ management_available: false, state: "unavailable" });
    expect(body.data).not.toHaveProperty("project_id");
  });

  it("denies a machine caller before reading owner-global provider metadata", async () => {
    const request = new Request(`${origin}/api/v1/system/model-settings`), port = service();
    await expect(handleServiceModelSettings(request, env, context(request, "trusted_agent"), port, false))
      .rejects.toMatchObject({ code: "SERVICE_MODEL_PROVIDER_OWNER_REQUIRED", status: 403 });
    expect(port.list).not.toHaveBeenCalled();
  });

  it("refuses unconfigured management before any project or operation storage access", async () => {
    const db = { prepare: vi.fn(() => { throw new Error("must not access storage"); }) } as unknown as D1Database;
    const request = new Request(`${origin}/api/v1/system/model-providers`, { method: "POST",
      headers: { origin, "content-type": "application/json", "x-eliotr-csrf": "1", "idempotency-key": operation },
      body: JSON.stringify({ protocol: "eliotr.service-model-provider-create.v1", operation_id: operation,
        provider_id: "opencode-go", display_name: "OpenCode Go", base_url: "https://provider.example/v1",
        model_ids: ["step-5-preview-free"], api_key: "synthetic-credential-test-only" }) });
    const port = createServiceModelProviderService({ database: db });
    await expect(handleServiceModelProviders(request, env, context(request), port, 32768))
      .rejects.toMatchObject({ code: "SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE", status: 503 });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("reads only the requested global operation without a project", async () => {
    const request = new Request(`${origin}/api/v1/system/model-providers?operation_id=${operation}`), port = service();
    const response = await handleServiceModelProviders(request, env, context(request), port, 0);
    const body = await response.json() as { data: unknown };
    expect(response.status).toBe(200);
    expect(port.readOperation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ principal_ref: "owner-1" }), operation);
    expect(body.data).toEqual({ protocol: "eliotr.service-model-settings.v1", connection: null, truncated: false });
    expect(port.create).not.toHaveBeenCalled();
  });

  it("reads v2 provider registration mode and owner catalog preferences", async () => {
    const providersRequest = new Request(`${origin}/api/v2/system/model-providers`);
    const providersResponse = await handleServiceModelProvidersV2(providersRequest, env, context(providersRequest), service(), 0);
    expect(await providersResponse.json()).toMatchObject({ data: {
      protocol: "eliotr.service-model-provider-read.v2", connections: [], truncated: false,
    } });

    const preferencesRequest = new Request(`${origin}/api/v2/system/model-provider-catalog-preferences?provider_id=openrouter`);
    const preferencesResponse = await handleServiceModelProviderCatalogPreferences(
      preferencesRequest, env, context(preferencesRequest), service(), 0);
    expect(await preferencesResponse.json()).toMatchObject({ data: {
      protocol: "eliotr.service-model-provider-catalog-preferences.v1", provider_id: "openrouter",
      visibility: { mode: "all" }, search: "", updated_at: null,
    } });
  });

  it("persists catalog filters through same-origin owner PUT without treating them as qualifications", async () => {
    const request = new Request(`${origin}/api/v2/system/model-provider-catalog-preferences`, { method: "PUT",
      headers: { origin, "content-type": "application/json", "x-eliotr-csrf": "1" },
      body: JSON.stringify({ protocol: "eliotr.service-model-provider-catalog-preferences.v1", provider_id: "openrouter",
        visibility: { mode: "include", model_ids: ["vendor/model-a"] }, search: "reasoning" }) });
    const port = service();
    const response = await handleServiceModelProviderCatalogPreferences(request, env, context(request), port, 262144);

    expect(response.status).toBe(200);
    expect(port.updateCatalogPreferences).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ principal_ref: "owner-1" }),
      expect.objectContaining({ provider_id: "openrouter", visibility: { mode: "include", model_ids: ["vendor/model-a"] } }));
    expect(await response.json()).toMatchObject({ data: { visibility: { mode: "include", model_ids: ["vendor/model-a"] } } });
  });
});
