import { describe, expect, it, vi, type Mock } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createResearchModelCatalogService } from "./research-model-catalog.js";
import { createResearchProviderModelCatalogTransports } from "./research-provider-model-catalog.js";
import { createGenericCatalogRegisteredProviderReader, createGenericOpenRouterCatalogResolver } from "./research-model-catalog-generic.js";
import type { ConfiguredServiceModelProviderBinding } from "./service-model-provider-service.js";

const providerId = `compatible-${"a".repeat(24)}`;
const slug = `custom-${providerId}`;
const account = "b".repeat(32);
const registryUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/custom-providers?page=1&per_page=100`;
const catalogUrl = "https://openrouter.ai/api/v1/models";
type ConnectionResolver = Parameters<typeof createGenericOpenRouterCatalogResolver>[0]["resolve_connection"];

function context(overrides: Partial<AuthenticatedRequestContext> = {}): AuthenticatedRequestContext {
  return { request: new Request("https://owner.example/api/v1/system/research-models"),
    principal_ref: "owner-1", client_class: "owner_pwa", credential_generation: "credential-1", trace_id: "trace-1",
    access: { principal_ref: "owner-1", credential_generation: "credential-1", expires_at: "2099-01-01T00:00:00.000Z" },
    ...overrides };
}

function connection(overrides: Partial<ConfiguredServiceModelProviderBinding> = {}): ConfiguredServiceModelProviderBinding {
  return Object.freeze({ owner_id: "owner-1", operation_id: "11111111-1111-4111-8111-111111111111",
    provider_id: providerId, provider_slug: slug, model_registration_mode: "explicit_allowlist",
    model_ids: Object.freeze(["legacy/model"]), alias: "saved-generic-alias", provider_config_id: "config-1",
    metadata_sha256: "c".repeat(64), created_at: "2026-10-16T00:00:00.000Z", ...overrides });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function registry(entries: readonly unknown[], total = entries.length): Response {
  return json({ success: true, result: entries, result_info: { page: 1, total_count: total } });
}

function fixture(options: { readonly base?: string; readonly resolve?: Mock<ConnectionResolver>; readonly registry?: () => Response } = {}) {
  const bound = connection();
  const resolve = options.resolve ?? vi.fn<ConnectionResolver>(async () => bound);
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (url === registryUrl) return options.registry?.() ?? registry([{ slug, enable: true,
      base_url: options.base ?? "https://openrouter.ai/api/v1" }]);
    if (url === catalogUrl) return json({ data: [{ id: "vendor/new-model", architecture: { output_modalities: ["text"] } }] });
    throw new Error("Unexpected endpoint");
  });
  const transports = createResearchProviderModelCatalogTransports({
    gateway_base_url: `https://gateway.ai.cloudflare.com/v1/${account}/eliotr-reasoning`, fetcher,
  });
  const openrouter = transports.find(provider => provider.provider_id === "openrouter");
  if (!openrouter) throw new Error("Missing official public transport");
  const readRegistered = createGenericCatalogRegisteredProviderReader({ account_id: account, gateway_id: "eliotr-reasoning",
    control_token: "existing-control-token-fixture", fetcher });
  const resolveExternalProvider = createGenericOpenRouterCatalogResolver({ openrouter,
    resolve_connection: resolve, read_registered_provider: readRegistered });
  const statement = { bind: vi.fn(() => statement), first: vi.fn(async () => ({ owned: 1 })) };
  const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;
  const service = createResearchModelCatalogService({ database: db, externalProviders: transports, resolveExternalProvider });
  return { service, bound, fetcher, resolve, db, resolveExternalProvider };
}

describe("registered generic OpenRouter catalog binding", () => {
  it.each(["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/"])(
    "retains the exact logical connection identity using registered base %s", async base => {
      const { service, bound, fetcher, resolve, db } = fixture({ base });
      const before = JSON.stringify(bound);
      const page = await service.listExternalProviderForService(context(), providerId);
      expect(page.provider_id).toBe(providerId);
      expect(page.models).toMatchObject([{ provider_id: providerId, model_id: "vendor/new-model",
        account_availability: "unknown", capabilities: { text_generation: "unknown" },
        billing: { account_entitlement: "not_established_by_catalog" } }]);
      expect(page).not.toHaveProperty("project_id");
      expect(JSON.stringify(bound)).toBe(before);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(resolve.mock.calls[0]).toEqual([expect.objectContaining({ principal_ref: "owner-1" }), providerId]);
      expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([registryUrl, catalogUrl]);
      const publicRequest = fetcher.mock.calls[1]?.[1];
      expect([...new Headers(publicRequest?.headers)]).toEqual([["accept", "application/json"]]);
      expect(publicRequest).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
      expect(db.prepare).not.toHaveBeenCalled();
    },
  );

  it("keeps the project wrapper and the generic model identity after project authorization", async () => {
    const { service, db } = fixture();
    const page = await service.listExternalProvider(context(), "project-1", providerId);
    expect(page).toMatchObject({ project_id: "project-1", provider_id: providerId,
      models: [{ provider_id: providerId, model_id: "vendor/new-model" }] });
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://evil.example/api/v1", "http://openrouter.ai/api/v1", "https://openrouter.ai.evil.example/api/v1",
    "https://openrouter.ai@evil.example/api/v1", "https://user:secret@openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1?url=http://127.0.0.1", "https://openrouter.ai/api/v1#fragment",
    "https://openrouter.ai:444/api/v1", "https://openrouter.ai/api/other/../v1",
    "https://openrouter.ai/api/%76%31", "http://169.254.169.254/latest/meta-data", "https://127.0.0.1/api/v1",
  ])("does not fetch a catalog for unknown or disguised registered base %s", async base => {
    const { service, fetcher } = fixture({ base });
    await expect(service.listExternalProviderForService(context(), providerId)).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", status: 503, retryable: false,
    });
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([registryUrl]);
  });

  it.each(["unknown-provider", "compatible-unknown", "custom-compatible-" + "a".repeat(24)])(
    "returns the existing nonretryable unsupported contract for %s without registry access", async id => {
      const { service, fetcher, resolve } = fixture();
      await expect(service.listExternalProviderForService(context(), id)).rejects.toMatchObject({
        code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", status: 503, retryable: false,
      });
      expect(resolve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([null, connection({ owner_id: "another-owner" }), connection({ provider_id: "openrouter" }),
    connection({ provider_slug: "custom-someone-else" })])("requires the exact owner-scoped configured connection", async bound => {
    const resolve = vi.fn<ConnectionResolver>(async () => bound);
    const { service, fetcher } = fixture({ resolve });
    await expect(service.listExternalProviderForService(context(), providerId)).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", retryable: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, connection({ alias: "changed-alias" }), connection({ operation_id: "22222222-2222-4222-8222-222222222222" }),
    connection({ metadata_sha256: "d".repeat(64) })])("rejects revoked or changed connection identity before returning metadata", async changed => {
    const resolve = vi.fn<ConnectionResolver>().mockResolvedValueOnce(connection()).mockResolvedValueOnce(changed);
    const { service } = fixture({ resolve });
    await expect(service.listExternalProviderForService(context(), providerId)).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", retryable: false,
    });
  });

  it("requires owner authorization before resolving a generic binding", async () => {
    const { service, resolve, fetcher } = fixture();
    await expect(service.listExternalProviderForService(context({ client_class: "trusted_agent" }), providerId))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_OWNER_REQUIRED" });
    expect(resolve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not replace an existing named provider adapter with the generic resolver", async () => {
    const { service, resolve, fetcher } = fixture();
    const page = await service.listExternalProviderForService(context(), "openrouter");
    expect(page.provider_id).toBe("openrouter"); expect(resolve).not.toHaveBeenCalled();
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([catalogUrl]);
  });

  it.each([
    { entries: [] },
    { entries: [{ slug, enable: false, base_url: "https://openrouter.ai/api/v1" }] },
    { entries: [{ slug: "custom-other", enable: true, base_url: "https://openrouter.ai/api/v1" }] },
    { entries: [{ slug, enable: true, base_url: "https://openrouter.ai/api/v1" },
      { slug, enable: true, base_url: "https://openrouter.ai/api/v1" }] },
  ])("never falls back when registered identity is missing, disabled or ambiguous", async ({ entries }) => {
    const { service, fetcher } = fixture({ registry: () => registry(entries) });
    await expect(service.listExternalProviderForService(context(), providerId)).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not accept a partial registry page as proof that the slug is unique", async () => {
    const { service, fetcher } = fixture({ registry: () => registry([
      { slug, enable: true, base_url: "https://openrouter.ai/api/v1" },
    ], 101) });
    await expect(service.listExternalProviderForService(context(), providerId)).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not follow a registry redirect or forward its credential elsewhere", async () => {
    const { service, fetcher } = fixture({ registry: () => new Response(null, { status: 302,
      headers: { location: "https://evil.example/providers" } }) });
    await expect(service.listExternalProviderForService(context(), providerId)).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", credentials: "omit" });
  });

  it("bounds the registry response before any public catalog read", async () => {
    const { service, fetcher } = fixture({ registry: () => new Response("x".repeat(262_145), {
      headers: { "content-type": "application/json" },
    }) });
    await expect(service.listExternalProviderForService(context(), providerId)).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE", retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
