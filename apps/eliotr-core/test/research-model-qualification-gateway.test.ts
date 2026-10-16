import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DynamicRouteQualificationProbeInput } from "@eliotr/cloudflare-ai";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { qualificationModelGatewayConfiguration } from "../src/research-model-qualification-http.js";
import { RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL } from "../src/research-prepared-model-transport.js";

const seams = vi.hoisted(() => ({ settings: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/service-model-settings-composition.js", () => ({
  createServiceModelSettingsComposition: seams.settings,
}));

const deployment = { route_ref: "dynamic/eliotr-balanced", route_version: "route-v1", pricing_snapshot_ref: "price-v1" };
const context = { client_class: "owner_pwa", principal_ref: "owner-fixture", credential_generation: "credential-v1" } as AuthenticatedRequestContext;
const native = { gateway: vi.fn() };
const baseEnv = { AI: native, AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning` } as unknown as Env;

function fixture(provider: "workers-ai" | "openrouter") {
  const model = provider === "workers-ai" ? "@cf/zai-org/glm-5.3-flash" : "dots-studio/dots-3-note-preview:free";
  const policy = {
    version: 1, transport: "cloudflare-ai-gateway", provider, model,
    api: provider === "workers-ai" ? "compat-chat-completions" : "openrouter-chat-completions",
    billing: provider === "workers-ai" ? { mode: "unified" } : { mode: "byok", alias: "prepared-old-alias" },
    capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low"] },
  };
  // This unit exercises gateway assembly after the route's separately-tested strict probe decoder.
  const probe = { expected_provider: provider, expected_model: model, provisioning: { deployment } } as unknown as DynamicRouteQualificationProbeInput;
  return { model, probe, policies: JSON.stringify({
    protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
    model_selections: [{ stage: "SYNTHESIZE", route_ref: deployment.route_ref, route_version: deployment.route_version,
      provider, model, transport_policy: policy }],
  }) };
}

function configure(provider: "workers-ai" | "openrouter", token: string | undefined) {
  const input = fixture(provider);
  return qualificationModelGatewayConfiguration({ ...baseEnv, ELIOTR_MODEL_GATEWAY_TOKEN: token,
    ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON: input.policies }, context, input.probe);
}

beforeEach(() => {
  seams.settings.mockReset().mockReturnValue({ service: { resolveConfiguredProvider: seams.resolve } });
  seams.resolve.mockReset().mockResolvedValue({
    owner_id: "owner-fixture", operation_id: "global-operation", provider_id: "openrouter", provider_slug: "openrouter",
    model_ids: [fixture("openrouter").model], alias: "saved-global-alias", provider_config_id: "provider-config",
    metadata_sha256: "b".repeat(64), created_at: "2026-10-16T00:00:00.000Z",
  });
  native.gateway.mockClear();
});

describe("qualification HTTP provider-aware gateway composition", () => {
  it.each([undefined, "server-held-external-token", " bearer"])(
    "keeps builtin qualification native and independent of global registration with token %s", async (token) => {
      seams.settings.mockImplementation(() => { throw new Error("builtin qualification must not read global registration"); });
      const configured = await configure("workers-ai", token);
      expect(configured.ai_gateway_binding).toBe(native);
      expect(configured).not.toHaveProperty("gateway_token");
      expect(configured.transport_policy?.provider).toBe("workers-ai");
      expect(seams.settings).not.toHaveBeenCalled();
      expect(seams.resolve).not.toHaveBeenCalled();
      expect(native.gateway).not.toHaveBeenCalled();
    },
  );

  it("selects the HTTP credential and exact saved global alias for an external prepared model", async () => {
    const configured = await configure("openrouter", "server-held-external-token");
    expect(configured.gateway_token).toBe("server-held-external-token");
    expect(configured).not.toHaveProperty("ai_gateway_binding");
    expect(configured.transport_policy?.billing).toEqual({ mode: "byok", alias: "saved-global-alias" });
    expect(seams.resolve).toHaveBeenCalledWith(context, "openrouter", { model_id: fixture("openrouter").model });
    expect(native.gateway).not.toHaveBeenCalled();
  });

  it.each([undefined, " bearer"])("fails external qualification before dispatch for unavailable token %s", async (token) => {
    await expect(configure("openrouter", token)).rejects.toMatchObject({
      code: "RESEARCH_MODEL_TRANSPORT_CONFIGURATION_REQUIRED", status: 503,
    });
    expect(native.gateway).not.toHaveBeenCalled();
  });
});
