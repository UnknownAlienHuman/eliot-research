import { describe, expect, it, vi } from "vitest";
import type { BoundWorkspaceApis } from "../app/runtime";
import { bindModelSettingsSecretLifetime, configureProviderKeyOnceAndReadBack, ModelSettingsRequestClosedError } from "./modelSettingsLifecycle";

type ProviderApi = BoundWorkspaceApis["connections"]["providers"];

const context = {
  principal: "owner-1", credentialGeneration: "credential-1", deploymentGeneration: "deployment-1",
  expiresAt: "2027-01-01T00:00:00.000Z", cacheEpoch: 1,
};
const configuration = {
  operation_id: "11111111-1111-4111-8111-111111111111",
  alias: `eliotr-${"a".repeat(48)}`,
  provider_config_id: "provider-config-1",
  status: "configured_not_qualified" as const,
  failure_code: null,
  provider_http_status: null,
  created_at: "2026-10-15T12:00:00.000Z",
  updated_at: "2026-10-15T12:00:00.000Z",
};
const page = {
  protocol: "eliotr.research-provider-key-configuration.v1" as const,
  project_id: "project-1",
  provider_id: "openrouter" as const,
  configurations: [configuration],
  truncated: false,
};

describe("safe model-settings key lifecycle", () => {
  it("clears the form and aborts work synchronously when the privacy epoch closes", () => {
    let current = true;
    const listeners = new Set<() => void>();
    const privacy = {
      isCurrent: vi.fn(() => current),
      subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const clear = vi.fn();
    const abort = vi.fn();
    const dispose = bindModelSettingsSecretLifetime(privacy, context, clear, abort);

    current = false;
    for (const listener of listeners) listener();

    expect(clear).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    dispose();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a key write from a stale project or closed owner epoch", async () => {
    const providers = {
      configureResearchProviderKey: vi.fn(),
      readResearchProviderKeyConfigurations: vi.fn(),
    } as unknown as ProviderApi;
    await expect(configureProviderKeyOnceAndReadBack({
      providers, projectId: "project-1", deploymentGeneration: "deployment-1",
      operationId: configuration.operation_id, providerKey: "synthetic-test-key-not-real-123456",
      signal: new AbortController().signal, isCurrent: () => false,
    })).rejects.toBeInstanceOf(ModelSettingsRequestClosedError);
    expect(providers.configureResearchProviderKey).not.toHaveBeenCalled();
    expect(providers.readResearchProviderKeyConfigurations).not.toHaveBeenCalled();
  });

  it("never repeats a lost key POST and reconciles with the same hidden operation ID", async () => {
    const providers = {
      configureResearchProviderKey: vi.fn().mockRejectedValue(new Error("acknowledgement lost")),
      readResearchProviderKeyConfigurations: vi.fn().mockResolvedValue(page),
    } as unknown as ProviderApi;
    const controller = new AbortController();
    const result = await configureProviderKeyOnceAndReadBack({
      providers, projectId: "project-1", deploymentGeneration: "deployment-1",
      operationId: configuration.operation_id, providerKey: "synthetic-test-key-not-real-123456",
      signal: controller.signal, isCurrent: () => true,
    });
    expect(result).toEqual(configuration);
    expect(providers.configureResearchProviderKey).toHaveBeenCalledTimes(1);
    expect(providers.readResearchProviderKeyConfigurations).toHaveBeenCalledTimes(1);
    expect(providers.readResearchProviderKeyConfigurations).toHaveBeenCalledWith(
      "project-1", "deployment-1", controller.signal, configuration.operation_id,
    );
  });

  it("does not issue stale readback after the owner epoch closes during dispatch", async () => {
    let resolveWrite: (value: unknown) => void = () => undefined;
    let current = true;
    const providers = {
      configureResearchProviderKey: vi.fn(() => new Promise(resolve => { resolveWrite = resolve; })),
      readResearchProviderKeyConfigurations: vi.fn().mockResolvedValue(page),
    } as unknown as ProviderApi;
    const controller = new AbortController();
    const pending = configureProviderKeyOnceAndReadBack({
      providers, projectId: "project-1", deploymentGeneration: "deployment-1",
      operationId: configuration.operation_id, providerKey: "synthetic-test-key-not-real-123456",
      signal: controller.signal, isCurrent: () => current,
    });
    current = false;
    controller.abort();
    resolveWrite({});

    await expect(pending).rejects.toBeInstanceOf(ModelSettingsRequestClosedError);
    expect(providers.configureResearchProviderKey).toHaveBeenCalledTimes(1);
    expect(providers.readResearchProviderKeyConfigurations).not.toHaveBeenCalled();
  });
});
