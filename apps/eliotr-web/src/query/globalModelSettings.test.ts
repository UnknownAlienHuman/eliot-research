import { describe, expect, it, vi } from "vitest";
import { WorkspaceRequestError } from "../app/runtime";
import { configureGlobalModelProviderOnce, GlobalModelProviderRefusedError,
  GlobalModelSettingsClosedError } from "./globalModelSettings";
import { configureCatalogManagedProviderOnce, updateGlobalModelCatalogPreferencesOnce,
  serviceModelCatalogQueryOptions, type ServiceModelCatalogConnectRequest } from "./globalModelSettings";

const request = { protocol: "eliotr.service-model-provider-create.v1" as const,
  operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533", provider_id: "openrouter", display_name: "OpenRouter",
  model_ids: ["model:free"], api_key: "synthetic-credential-test-only" };
const connection = { operation_id: request.operation_id, provider_id: request.provider_id, display_name: request.display_name,
  model_ids: request.model_ids, base_url: null, status: "configured" as const, alias: "eliotr-test",
  provider_config_id: "config-1", failure_code: null, provider_http_status: null,
  created_at: "2026-10-15T14:00:00.000Z", updated_at: "2026-10-15T14:00:00.000Z" };
function fixture() {
  const api = { readServiceModelSettings: vi.fn(), createServiceModelProvider: vi.fn(),
    readServiceModelProviderOperation: vi.fn(async () => ({ protocol: "eliotr.service-model-settings.v1" as const,
      connection, truncated: false })) };
  const input = { api, request, generation: "deployment-1", signal: new AbortController().signal, isCurrent: () => true };
  return { api, input };
}
describe("global key operation lifecycle", () => {
  it("reconciles a lost write acknowledgement with the same opaque operation and no replacement POST", async () => {
    const f = fixture(); f.api.createServiceModelProvider.mockRejectedValueOnce(new Error("lost acknowledgement"));
    const result = await configureGlobalModelProviderOnce(f.input);
    expect(result).toEqual(connection);
    expect(f.api.createServiceModelProvider).toHaveBeenCalledExactlyOnceWith(request, "deployment-1", f.input.signal);
    expect(f.api.readServiceModelProviderOperation).toHaveBeenCalledExactlyOnceWith(request.operation_id, "deployment-1", f.input.signal);
    expect(result).not.toHaveProperty("api_key");
    expect(result).not.toHaveProperty("project_id");
  });
  it("allows a new manual attempt after only the exact pre-effect management denial", async () => {
    const f = fixture(); f.api.createServiceModelProvider.mockRejectedValueOnce(new WorkspaceRequestError({
      code: "SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE", status: 503, message: "unavailable", traceId: null, retryable: true }));
    const result = configureGlobalModelProviderOnce(f.input);
    await expect(result).rejects.toBeInstanceOf(GlobalModelProviderRefusedError);
    await expect(result).rejects.toMatchObject({ reason: "unavailable" });
    expect(f.api.readServiceModelProviderOperation).not.toHaveBeenCalled();
  });
  it("does not accept another provider's metadata as the held operation outcome", async () => {
    const f = fixture();
    f.api.readServiceModelProviderOperation.mockResolvedValueOnce({ protocol: "eliotr.service-model-settings.v1",
      connection: { ...connection, provider_id: "another-provider" }, truncated: false });
    expect(await configureGlobalModelProviderOnce(f.input)).toBeUndefined();
    expect(f.api.createServiceModelProvider).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch a key after owner authority closes", async () => {
    const f = fixture();
    await expect(configureGlobalModelProviderOnce({ ...f.input, isCurrent: () => false }))
      .rejects.toBeInstanceOf(GlobalModelSettingsClosedError);
    expect(f.api.createServiceModelProvider).not.toHaveBeenCalled();
    expect(f.api.readServiceModelProviderOperation).not.toHaveBeenCalled();
  });
});

describe("catalog-managed provider and visibility preferences", () => {
  const catalogRequest: ServiceModelCatalogConnectRequest = {
    protocol: "eliotr.service-model-provider-catalog-connect.v2", operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533",
    provider_id: "opencode-go", display_name: "OpenCode Go", base_url: "https://opencode.ai/inference/go/openai/v1",
    model_registration_mode: "catalog_managed", api_key: "synthetic-credential-test-only",
  };
  const connection = { operation_id: catalogRequest.operation_id, provider_id: catalogRequest.provider_id,
    display_name: catalogRequest.display_name, base_url: catalogRequest.base_url, status: "configured" as const,
    provider_config_id: "provider-config-1", alias: "eliotr-test", failure_code: null, provider_http_status: null,
    created_at: "2026-10-16T14:00:00.000Z", updated_at: "2026-10-16T14:00:00.000Z",
    model_registration_mode: "catalog_managed" as const };

  it("reconciles one lost catalog-connect acknowledgement with the same operation and no model IDs", async () => {
    const api = { createCatalogManagedServiceModelProvider: vi.fn().mockRejectedValue(new Error("lost acknowledgement")),
      readServiceModelProviderOperationV2: vi.fn().mockResolvedValue({
        protocol: "eliotr.service-model-provider-read.v2" as const, connection, truncated: false,
      }) };
    const result = await configureCatalogManagedProviderOnce({ api: api as never, request: catalogRequest,
      generation: "deployment-1", signal: new AbortController().signal, isCurrent: () => true });
    expect(result).toEqual(connection);
    expect(api.createCatalogManagedServiceModelProvider).toHaveBeenCalledExactlyOnceWith(
      catalogRequest, "deployment-1", expect.any(AbortSignal));
    expect(api.readServiceModelProviderOperationV2).toHaveBeenCalledExactlyOnceWith(
      catalogRequest.operation_id, "deployment-1", expect.any(AbortSignal));
    expect(catalogRequest).not.toHaveProperty("model_ids");
    expect(result).not.toHaveProperty("api_key");
  });

  it("reads back saved presentation preferences after an uncertain PUT without repeating the write", async () => {
    const request = { protocol: "eliotr.service-model-provider-catalog-preferences.v1" as const,
      provider_id: "opencode-go", search: "reasoning", visibility: { mode: "exclude" as const, model_ids: ["old-model"] } };
    const saved = { ...request, updated_at: "2026-10-16T14:05:00.000Z" };
    const api = { updateServiceModelProviderCatalogPreferences: vi.fn().mockRejectedValue(new Error("lost acknowledgement")),
      readServiceModelProviderCatalogPreferences: vi.fn().mockResolvedValue(saved) };
    const result = await updateGlobalModelCatalogPreferencesOnce({ api: api as never, request,
      generation: "deployment-1", signal: new AbortController().signal, isCurrent: () => true });
    expect(result).toEqual(saved);
    expect(api.updateServiceModelProviderCatalogPreferences).toHaveBeenCalledExactlyOnceWith(
      request, "deployment-1", expect.any(AbortSignal));
    expect(api.readServiceModelProviderCatalogPreferences).toHaveBeenCalledExactlyOnceWith(
      request.provider_id, "deployment-1", expect.any(AbortSignal));
  });

  it("does not dispatch provider credentials after owner authority closes", async () => {
    const api = { createCatalogManagedServiceModelProvider: vi.fn(), readServiceModelProviderOperationV2: vi.fn() };
    await expect(configureCatalogManagedProviderOnce({ api: api as never, request: catalogRequest,
      generation: "deployment-1", signal: new AbortController().signal, isCurrent: () => false }))
      .rejects.toBeInstanceOf(GlobalModelSettingsClosedError);
    expect(api.createCatalogManagedServiceModelProvider).not.toHaveBeenCalled();
    expect(api.readServiceModelProviderOperationV2).not.toHaveBeenCalled();
  });

  it("reads only the requested service catalog page through the protected provider/search query key", async () => {
    const signal = new AbortController().signal;
    const api = { readServiceModelCatalog: vi.fn().mockResolvedValue(undefined) };
    const query = serviceModelCatalogQueryOptions(api as never, { isCurrent: () => true } as never,
      { deploymentGeneration: "deployment-1" } as never,
      { providerId: "opencode-go", search: "  step 5  ", page: 3 });
    expect(query.queryKey).toContain("opencode-go");
    expect(query.queryKey).toContain("step 5");
    const read = query.queryFn;
    if (typeof read !== "function") throw new Error("Catalog query function is missing");
    await read({ signal } as never);
    expect(api.readServiceModelCatalog).toHaveBeenCalledExactlyOnceWith("deployment-1",
      { providerId: "opencode-go", search: "step 5", page: 3 }, signal);
  });
});
