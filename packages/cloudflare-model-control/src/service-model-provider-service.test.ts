import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  createServiceModelProviderService,
  type ServiceModelProviderManagementPort,
} from "./service-model-provider-service.js";

const root = new URL("../../../", import.meta.url);
const migration = await readFile(
  new URL("infra/d1/core/migrations/0152_service_model_provider_operation.sql", root),
  "utf8",
);
const NOW = Date.parse("2026-10-15T14:00:00.000Z");
const REQUEST = {
  protocol: "eliotr.service-model-provider-create.v1" as const,
  operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533",
  provider_id: "opencode-go",
  display_name: "OpenCode Go",
  base_url: "https://provider.example/v1",
  model_ids: ["step-5-preview-free"],
  api_key: "synthetic-credential-test-only",
};

function ownerContext(overrides: Partial<AuthenticatedRequestContext> = {}): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.test/api/v1/system/model-providers"),
    principal_ref: "owner-1",
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    trace_id: "trace-1",
    access: {
      principal_ref: "owner-1",
      credential_generation: "credential-1",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function database(): { readonly d1: D1Database; readonly sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = sqlite.prepare(sql);
          // D1 binds numbered placeholders positionally. Node 22's SQLite API
          // needs their exact names; later Node versions also accept positions.
          const names = [...new Set(sql.match(/\?[1-9][0-9]*/gu) ?? [])];
          const params = names.length === 0 ? values : [Object.fromEntries(names.map(name => [name, values[Number(name.slice(1)) - 1]]))];
          return {
            async first<T>() { return (statement.get(...params as never[]) ?? null) as T | null; },
            async all<T>() { return { results: statement.all(...params as never[]) as T[] }; },
            async run() {
              const result = statement.run(...params as never[]);
              return { success: true, meta: { changes: Number(result.changes) } } as D1Result<unknown>;
            },
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
  return { d1, sqlite };
}

function managementPort(overrides: Partial<ServiceModelProviderManagementPort> = {}): ServiceModelProviderManagementPort {
  return {
    available: true,
    create: vi.fn(async (input) => ({
      provider_config_id: `config-${input.operation_id}`,
      provider_slug: input.provider_id === "openrouter" && input.base_url === null
        ? input.provider_id
        : "custom-" + input.provider_id,
      alias: input.alias,
    })),
    read: vi.fn(async () => null),
    ...overrides,
  };
}

describe("global service model provider operations", () => {
  it("persists only safe metadata and replays a configured operation without another management write", async () => {
    const store = database();
    const management = managementPort();
    const service = createServiceModelProviderService({ database: store.d1, managementPort: management, now: () => NOW });

    const created = await service.create(ownerContext(), REQUEST);
    const replayed = await service.create(ownerContext(), REQUEST);
    const listed = await service.list(ownerContext());

    expect(created.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(created.receipt.provider_slug).toBe("custom-opencode-go");
    expect(management.create).toHaveBeenCalledTimes(1);
    expect(listed.connections).toMatchObject([{
      provider_id: "opencode-go",
      status: "configured",
      provider_config_id: "config-6f06e11b-e2d0-4b16-8e84-44aa52d37533",
    }]);
    expect(JSON.stringify(store.sqlite.prepare("SELECT * FROM service_model_provider_operation").all()))
      .not.toContain(REQUEST.api_key);
    expect(store.sqlite.prepare("PRAGMA table_info(service_model_provider_operation)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "api_key" })]));
  });

  it("returns the exact pre-effect 503 when management is absent and creates no intent", async () => {
    const store = database();
    const service = createServiceModelProviderService({ database: store.d1, now: () => NOW });

    await expect(service.create(ownerContext(), REQUEST)).rejects.toMatchObject({
      code: "SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE",
      status: 503,
      effect: "NONE",
    });
    expect(store.sqlite.prepare("SELECT count(*) AS count FROM service_model_provider_operation").get())
      .toEqual({ count: 0 });
  });

  it("latches a lost acknowledgement as uncertain and never calls the management port again", async () => {
    const store = database();
    const management = managementPort({
      create: vi.fn(async () => {
        throw Object.assign(new Error("synthetic lost acknowledgement"), { effect: "UNKNOWN" });
      }),
    });
    const service = createServiceModelProviderService({ database: store.d1, managementPort: management, now: () => NOW });

    await expect(service.create(ownerContext(), REQUEST)).rejects.toMatchObject({
      code: "SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN",
      status: 503,
      effect: "UNKNOWN",
    });
    await expect(service.create(ownerContext(), REQUEST)).rejects.toMatchObject({
      code: "SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN",
      status: 503,
      effect: "UNKNOWN",
    });
    expect(management.create).toHaveBeenCalledTimes(1);
    await expect(service.readOperation(ownerContext(), REQUEST.operation_id)).resolves.toMatchObject({
      operation_id: REQUEST.operation_id,
      status: "uncertain",
      provider_config_id: null,
      alias: null,
    });
  });

  it("reconciles an uncertain custom provider by read-only native readback without another POST", async () => {
    const store = database();
    const management = managementPort({
      create: vi.fn(async () => {
        throw Object.assign(new Error("synthetic lost acknowledgement"), { effect: "UNKNOWN" });
      }),
      read: vi.fn(async (input) => ({
        provider_config_id: "reconciled-config",
        provider_slug: input.provider_slug,
        alias: input.alias,
      })),
    });
    const service = createServiceModelProviderService({ database: store.d1, managementPort: management, now: () => NOW });

    await expect(service.create(ownerContext(), REQUEST)).rejects.toMatchObject({
      code: "SERVICE_MODEL_PROVIDER_OUTCOME_UNKNOWN",
      status: 503,
      effect: "UNKNOWN",
    });
    const reconciled = await service.readOperation(ownerContext(), REQUEST.operation_id);

    expect(reconciled).toMatchObject({
      operation_id: REQUEST.operation_id,
      provider_id: "opencode-go",
      status: "configured",
      provider_config_id: "reconciled-config",
    });
    expect(management.create).toHaveBeenCalledTimes(1);
    expect(management.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reconciled)).not.toContain(REQUEST.api_key);
  });

  it("resolves only the exact configured global provider/model for its owner", async () => {
    const store = database();
    const management = managementPort();
    const service = createServiceModelProviderService({ database: store.d1, managementPort: management, now: () => NOW });
    const operationId = "a9f79914-a0a5-4f27-9e81-3b9b6c403a61";
    const modelId = "dots-studio/dots-3-note-preview:free";
    const created = await service.create(ownerContext(), {
      protocol: "eliotr.service-model-provider-create.v1",
      operation_id: operationId,
      provider_id: "openrouter",
      display_name: "OpenRouter",
      model_ids: [modelId],
      api_key: "synthetic-openrouter-key-for-test",
    });

    const resolved = await service.resolveConfiguredProvider(ownerContext(), "openrouter", { model_id: modelId });
    const exact = await service.resolveConfiguredProvider(ownerContext(), "openrouter", {
      model_id: modelId, operation_id: operationId,
    });
    const wrongModel = await service.resolveConfiguredProvider(ownerContext(), "openrouter", {
      model_id: "another/model:free",
    });
    const foreign = await service.resolveConfiguredProvider(ownerContext({
      principal_ref: "owner-2", credential_generation: "credential-2",
      access: { principal_ref: "owner-2", credential_generation: "credential-2", expires_at: "2099-01-01T00:00:00.000Z" },
    }), "openrouter", { model_id: modelId });

    expect(resolved).toMatchObject({
      owner_id: "owner-1", operation_id: operationId, provider_id: "openrouter",
      provider_slug: "openrouter", model_ids: [modelId], alias: created.receipt.alias,
      provider_config_id: created.receipt.provider_config_id,
    });
    expect(exact).toEqual(resolved);
    expect(wrongModel).toBeNull();
    expect(foreign).toBeNull();
    expect(management.read).not.toHaveBeenCalled();
  });

  it("does not let a failed global operation authorize fallback, but ignores it after a unique configured save", async () => {
    const store = database();
    const failedManagement = managementPort({
      create: vi.fn(async () => {
        throw Object.assign(new Error("synthetic credential rejection"), {
          effect: "NONE", code: "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID", http_status: 401,
        });
      }),
    });
    const failedService = createServiceModelProviderService({
      database: store.d1, managementPort: failedManagement, now: () => NOW,
    });
    const modelId = "dots-studio/dots-3-note-preview:free";
    const failedRequest = {
      protocol: "eliotr.service-model-provider-create.v1" as const,
      operation_id: "a72422bc-e5d8-43c3-96ad-22f3d8c4f9dd",
      provider_id: "openrouter", display_name: "OpenRouter", model_ids: [modelId],
      api_key: "synthetic-openrouter-key-for-test",
    };
    await expect(failedService.create(ownerContext(), failedRequest)).rejects.toMatchObject({
      code: "SERVICE_MODEL_PROVIDER_PROVIDER_REJECTED", effect: "NONE",
    });
    await expect(failedService.resolveConfiguredProvider(ownerContext(), "openrouter", { model_id: modelId }))
      .rejects.toMatchObject({ code: "SERVICE_MODEL_PROVIDER_PROVIDER_REJECTED", status: 502 });

    const configured = createServiceModelProviderService({
      database: store.d1, managementPort: managementPort(), now: () => NOW,
    });
    const saved = await configured.create(ownerContext(), {
      ...failedRequest, operation_id: "b9f381b8-0576-420d-8105-5cf6a8d6e205",
    });
    await expect(configured.resolveConfiguredProvider(ownerContext(), "openrouter", { model_id: modelId }))
      .resolves.toMatchObject({ operation_id: saved.receipt.operation_id, alias: saved.receipt.alias });
  });

});
