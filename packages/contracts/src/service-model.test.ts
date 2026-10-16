import { describe, expect, it } from "vitest";
import { ServiceModelSettingsSchema, ServiceModelProviderCreateRequestSchema,
  ServiceModelProviderConnectionSchema, ServiceModelProviderCatalogConnectRequestSchema,
  ServiceModelProviderCatalogConnectReceiptSchema, ServiceModelProviderConnectionV2Schema,
  ServiceModelProviderCatalogPreferencesUpdateSchema } from "./service-model.js";

describe("opaque model IDs remain separate from other identities", () => {
  const request = { protocol: "eliotr.service-model-provider-create.v1",
    operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533", provider_id: "openrouter",
    display_name: "Public models", model_ids: ["~openai/gpt-astra-latest"], api_key: "synthetic-fixture-key" };
  it("round-trips leading and embedded tilde model IDs in explicit lists and preferences", () => {
    expect(ServiceModelProviderCreateRequestSchema.parse(request)).toEqual(request);
    const preferences = { protocol: "eliotr.service-model-provider-catalog-preferences.v1", provider_id: "openrouter",
      visibility: { mode: "include", model_ids: ["~openai/gpt-astra-latest", "vendor/model~variant"] }, search: "" };
    expect(ServiceModelProviderCatalogPreferencesUpdateSchema.parse(preferences)).toEqual(preferences);
  });
  it("does not widen provider/operation IDs or admit URL controls and credential fields", () => {
    expect(ServiceModelProviderCreateRequestSchema.safeParse({ ...request, provider_id: "~openrouter" }).success).toBe(false);
    expect(ServiceModelProviderCreateRequestSchema.safeParse({ ...request, operation_id: "~operation" }).success).toBe(false);
    for (const model of ["vendor/model?key=x", "vendor/model#x", "vendor/model%2Fother", "vendor/model with spaces"]) {
      expect(ServiceModelProviderCreateRequestSchema.safeParse({ ...request, model_ids: [model] }).success).toBe(false);
    }
  });
});

describe("global service model settings", () => {
  it("keeps built-in Cloudflare models available without a project or external management", () => {
    const settings = { protocol: "eliotr.service-model-settings.v1", cloudflare: {
      provider_id: "cloudflare-workers-ai", connection: "builtin", binding_available: true,
      default_model_id: "@cf/zai-org/glm-5.3-flash",
    }, indexing: { provider_id: "cloudflare-ai-search", managed: true },
    external: { management_available: false, state: "unavailable", connections: [], truncated: false } };

    expect(ServiceModelSettingsSchema.safeParse(settings).success).toBe(true);
    expect(ServiceModelSettingsSchema.safeParse({ ...settings, project_id: "project-1" }).success).toBe(false);
  });

  it("accepts a global OpenAI-compatible connection and refuses unsafe credential endpoints", () => {
    const request = { protocol: "eliotr.service-model-provider-create.v1",
      operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533", provider_id: "opencode-go",
      display_name: "OpenCode Go", model_ids: ["step-5-preview-free"],
      api_key: "synthetic-credential-test-only" };

    expect(ServiceModelProviderCreateRequestSchema.safeParse({ ...request, base_url: "https://provider.example/v1" }).success).toBe(true);
    expect(ServiceModelProviderCreateRequestSchema.safeParse({ ...request, project_id: "project-1" }).success).toBe(false);
    expect(ServiceModelProviderCreateRequestSchema.safeParse({ ...request, display_name: request.api_key }).success).toBe(false);
    for (const base_url of ["http://provider.example/v1", "https://user:password@provider.example/v1",
      "https://provider.example/v1?key=credential", "https://provider.example/v1#credential"]) {
      expect(ServiceModelProviderCreateRequestSchema.safeParse({ ...request, base_url }).success).toBe(false);
    }
  });

  it("refuses key material in a provider connection readback", () => {
    const connection = { operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533", provider_id: "openrouter",
      display_name: "OpenRouter", model_ids: ["model:free"], base_url: null, status: "uncertain",
      provider_config_id: null, alias: null, failure_code: null, provider_http_status: null,
      created_at: "2026-10-15T14:00:00.000Z", updated_at: "2026-10-15T14:00:00.000Z" };

    expect(ServiceModelProviderConnectionSchema.safeParse(connection).success).toBe(true);
    expect(ServiceModelProviderConnectionSchema.safeParse({ ...connection, api_key: "must-never-be-returned" }).success).toBe(false);
  });

  it("uses an explicit catalog-managed v2 connect mode with no model ID field", () => {
    const request = { protocol: "eliotr.service-model-provider-catalog-connect.v2",
      operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533", provider_id: "opencode-go",
      display_name: "OpenCode Go", model_registration_mode: "catalog_managed",
      api_key: "synthetic-credential-test-only" };
    expect(ServiceModelProviderCatalogConnectRequestSchema.safeParse(request).success).toBe(true);
    expect(ServiceModelProviderCatalogConnectRequestSchema.safeParse({ ...request, model_ids: [] }).success).toBe(false);
    expect(ServiceModelProviderCatalogConnectRequestSchema.safeParse({ ...request, model_registration_mode: undefined }).success).toBe(false);
    expect(ServiceModelProviderCatalogConnectRequestSchema.safeParse({ ...request, api_key: request.operation_id }).success).toBe(false);
    expect(ServiceModelProviderCatalogConnectRequestSchema.safeParse({ ...request, project_id: "project-1" }).success).toBe(false);
  });

  it("reads catalog-managed connections without allowlists or credentials", () => {
    const connection = { operation_id: "6f06e11b-e2d0-4b16-8e84-44aa52d37533", provider_id: "opencode-go",
      display_name: "OpenCode Go", model_registration_mode: "catalog_managed", base_url: "https://opencode.ai/inference/go/v1",
      status: "configured", provider_config_id: "config-1", alias: "eliotr-provider", failure_code: null,
      provider_http_status: null, created_at: "2026-10-15T14:00:00.000Z", updated_at: "2026-10-15T14:00:00.000Z" };
    const receipt = { protocol: "eliotr.service-model-provider-catalog-connect.v2", operation_id: connection.operation_id,
      provider_id: connection.provider_id, display_name: connection.display_name,
      model_registration_mode: "catalog_managed", base_url: connection.base_url, alias: connection.alias,
      provider_config_id: connection.provider_config_id, provider_slug: "custom-opencode-go", status: "configured",
      created_at: connection.created_at };
    expect(ServiceModelProviderConnectionV2Schema.safeParse(connection).success).toBe(true);
    expect(ServiceModelProviderConnectionV2Schema.safeParse({ ...connection, model_ids: [] }).success).toBe(false);
    expect(ServiceModelProviderConnectionV2Schema.safeParse({ ...connection, api_key: "must-never-be-returned" }).success).toBe(false);
    expect(ServiceModelProviderCatalogConnectReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(ServiceModelProviderCatalogConnectReceiptSchema.safeParse({ ...receipt, api_key: "must-never-be-returned" }).success).toBe(false);
  });

  it("keeps visible-model preferences separate and strictly bounded as presentation state", () => {
    const preference = { protocol: "eliotr.service-model-provider-catalog-preferences.v1", provider_id: "openrouter",
      visibility: { mode: "exclude", model_ids: ["vendor/hidden-model"] }, search: "reasoning" };
    expect(ServiceModelProviderCatalogPreferencesUpdateSchema.safeParse(preference).success).toBe(true);
    expect(ServiceModelProviderCatalogPreferencesUpdateSchema.safeParse({ ...preference,
      visibility: { mode: "exclude", model_ids: ["vendor/hidden-model", "vendor/hidden-model"] } }).success).toBe(false);
    expect(ServiceModelProviderCatalogPreferencesUpdateSchema.safeParse({ ...preference, project_id: "project-1" }).success).toBe(false);
  });
});
