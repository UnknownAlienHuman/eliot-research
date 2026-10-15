import { describe, expect, it } from "vitest";
import { ServiceModelSettingsSchema, ServiceModelProviderCreateRequestSchema,
  ServiceModelProviderConnectionSchema } from "./service-model.js";

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
});
