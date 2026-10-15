import { describe, expect, it, vi } from "vitest";
import { WorkspaceRequestError } from "../app/runtime";
import { configureGlobalModelProviderOnce, GlobalModelProviderRefusedError,
  GlobalModelSettingsClosedError } from "./globalModelSettings";

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
