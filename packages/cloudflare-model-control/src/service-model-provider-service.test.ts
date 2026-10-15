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
          return {
            async first<T>() { return (statement.get(...values as never[]) ?? null) as T | null; },
            async all<T>() { return { results: statement.all(...values as never[]) as T[] }; },
            async run() {
              const result = statement.run(...values as never[]);
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
      provider_slug: input.provider_id,
      alias: input.alias,
    })),
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

});
