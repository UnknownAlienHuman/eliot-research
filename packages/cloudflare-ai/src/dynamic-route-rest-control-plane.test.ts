import { describe, expect, it, vi } from "vitest";

import type {
  DYNAMIC_ROUTE_GATEWAY_ID,
  DynamicRouteCreateRequest,
  DynamicRouteProviderMetadata,
} from "./dynamic-route-provisioning-contract.js";
import {
  DynamicRouteRestError,
  type DynamicRouteRestBinding,
  type DynamicRouteRestBindingStorePort,
  type DynamicRouteRestFetchPort,
  type DynamicRouteRestResponse,
} from "./dynamic-route-rest-contract.js";
import { createCloudflareDynamicRouteRestControlPlane } from "./dynamic-route-rest-control-plane.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "token-without-whitespace-1234567890";
const ROUTE_ID = "route-001";
const VERSION_ID = "version-001";
const DEPLOYMENT_ID = "deployment-001";
const CREATED_AT = "2026-09-03T12:00:00.000Z";
const ROUTE_DEFINITION = Object.freeze([
  Object.freeze({
    id: "entry",
    type: "conditional",
    conditions: Object.freeze([
      {
        key: "request.model",
        operator: "eq",
        value: "dynamic/eliotr-draft",
      },
    ]),
    on_match: "primary",
    on_else: "fallback",
  }),
  Object.freeze({
    id: "primary",
    type: "model",
    provider: "workers-ai",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
  }),
]);

function apiEnvelope(
  result: unknown,
  resultInfo?: unknown,
): Record<string, unknown> {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  };
}

function version(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    version_id: VERSION_ID,
    created_at: CREATED_AT,
    active: true,
    is_valid: true,
    data: ROUTE_DEFINITION,
    ...overrides,
  };
}

function deployment(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    deployment_id: DEPLOYMENT_ID,
    version_id: VERSION_ID,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function route(
  activeDeployment: Record<string, unknown> | null,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: ROUTE_ID,
    gateway_id: "eliotr-reasoning",
    name: "eliotr-draft-v1-abcdef1234567890",
    created_at: CREATED_AT,
    modified_at: CREATED_AT,
    deployment: activeDeployment,
    version: version(),
    ...overrides,
  };
}

// POST /deployments acknowledgement shape (ROUTE_ACK_KEYS in the codec).
function deploymentAck(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: ROUTE_ID,
    created_at: CREATED_AT,
    modified_at: CREATED_AT,
    gateway_id: "eliotr-reasoning",
    name: "eliotr-draft-v1-abcdef1234567890",
    elements: ROUTE_DEFINITION,
    ...overrides,
  };
}

// Minimal route-list item shape (no nested graph; decoded to id+name only).
function routeListItem(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: ROUTE_ID,
    account_tag: ACCOUNT_ID,
    gateway_id: "eliotr-reasoning",
    name: "eliotr-draft-v1-abcdef1234567890",
    created_at: CREATED_AT,
    modified_at: CREATED_AT,
    ...overrides,
  };
}

// List pages carry pagination inside `result`; `result_info` must be absent.
function routeListPage(
  items: readonly Record<string, unknown>[],
  page: number,
  perPage: number,
): Record<string, unknown> {
  return apiEnvelope({
    routes: items,
    page,
    per_page: perPage,
    order_by: "name",
    order_by_direction: "asc",
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): DynamicRouteRestResponse {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function createRequest(): Promise<DynamicRouteCreateRequest> {
  const digest = await modelGatewaySha256(
    canonicalModelGatewayJson(ROUTE_DEFINITION),
  );
  const metadata: DynamicRouteProviderMetadata = Object.freeze({
    route_ref: "dynamic/eliotr-draft",
    route_version: "1",
    prompt_generation: "prompt-v1",
    schema_generation: "schema-v1",
    parameters_digest: "b".repeat(64),
    pricing_snapshot_ref: "pricing-v1",
    route_definition_sha256: digest,
  });
  return Object.freeze({
    gateway_id: "eliotr-reasoning",
    name: "eliotr-draft-v1-abcdef1234567890",
    route_definition: ROUTE_DEFINITION,
    metadata,
  });
}

function fakeBindings(): DynamicRouteRestBindingStorePort & {
  readonly records: Map<string, DynamicRouteRestBinding>;
  readonly putImmutable: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
} {
  const records = new Map<string, DynamicRouteRestBinding>();
  const get = vi.fn(async (routeId: string) => records.get(routeId) ?? null);
  const putImmutable = vi.fn(
    async (binding: DynamicRouteRestBinding, expectedSha256: string) => {
      if (records.has(binding.provider_route_id)) {
        throw new Error("immutable conflict");
      }
      records.set(binding.provider_route_id, binding);
      return { binding, readback_sha256: expectedSha256 };
    },
  );
  return { records, get, putImmutable };
}

function fakeFetch(
  responses: readonly (DynamicRouteRestResponse | Error)[],
): DynamicRouteRestFetchPort & {
  readonly fetch: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const fetch = vi.fn(async () => {
    const response = responses[index++];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("unexpected fetch");
    return response;
  });
  return { fetch };
}

function controlPlane(
  fetch: DynamicRouteRestFetchPort,
  bindings: DynamicRouteRestBindingStorePort = fakeBindings(),
  token = TOKEN,
) {
  return createCloudflareDynamicRouteRestControlPlane({
    account_id: ACCOUNT_ID,
    fetch,
    bindings,
    credentials: { readApiToken: vi.fn(async () => token) },
  });
}

async function expectRestError(
  promise: Promise<unknown>,
  code: DynamicRouteRestError["code"],
  ambiguousEffect: DynamicRouteRestError["ambiguous_effect"] = "NONE",
): Promise<DynamicRouteRestError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DynamicRouteRestError);
    const typed = error as DynamicRouteRestError;
    expect(typed.code).toBe(code);
    expect(typed.ambiguous_effect).toBe(ambiguousEffect);
    expect(typed.message).not.toContain(TOKEN);
    expect(typed.message).not.toContain("secret-provider-body");
    return typed;
  }
  throw new Error("expected DynamicRouteRestError");
}

async function successfulCreateFixture() {
  const request = await createRequest();
  const bindings = fakeBindings();
  const fetch = fakeFetch([
    jsonResponse(apiEnvelope(route(null))),
    jsonResponse(apiEnvelope(deploymentAck())),
    jsonResponse(apiEnvelope(route(deployment()))),
    jsonResponse(apiEnvelope(route(deployment()))),
  ]);
  return {
    request,
    bindings,
    fetch,
    adapter: controlPlane(fetch, bindings),
  };
}

describe("Cloudflare Dynamic Routing REST control plane", () => {
  it("creates route, deployment, immutable binding, and exact readback", async () => {
    const { request, bindings, fetch, adapter } =
      await successfulCreateFixture();

    await expect(adapter.create(request)).resolves.toEqual({
      provider_route_id: ROUTE_ID,
    });
    expect(fetch.fetch).toHaveBeenCalledTimes(4);

    const calls = fetch.fetch.mock.calls as unknown as readonly [
      string,
      RequestInit,
    ][];
    expect(calls.map(([url, init]) => [init.method, url])).toEqual([
      [
        "POST",
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/eliotr-reasoning/routes`,
      ],
      [
        "POST",
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/eliotr-reasoning/routes/${ROUTE_ID}/deployments`,
      ],
      [
        "GET",
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/eliotr-reasoning/routes/${ROUTE_ID}`,
      ],
      [
        "GET",
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/eliotr-reasoning/routes/${ROUTE_ID}`,
      ],
    ]);

    const routeBody = JSON.parse(String(calls[0]?.[1].body)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(routeBody).sort()).toEqual(["elements", "name"]);
    expect(routeBody.name).toBe(request.name);
    expect(routeBody.elements).toEqual(ROUTE_DEFINITION);
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({
      version_id: VERSION_ID,
    });
    for (const [, init] of calls) {
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers.Accept).toBe("application/json");
    }

    expect(bindings.putImmutable).toHaveBeenCalledTimes(1);
    expect(bindings.records.get(ROUTE_ID)).toMatchObject({
      protocol: "eliotr.dynamic-route-rest-binding.v1",
      provider_route_id: ROUTE_ID,
      provider_version_id: VERSION_ID,
      provider_deployment_id: DEPLOYMENT_ID,
      metadata: request.metadata,
    });
  });

  it("accepts a route response that already deployed its initial version", async () => {
    const request = await createRequest();
    const bindings = fakeBindings();
    const fetch = fakeFetch([
      jsonResponse(apiEnvelope(route(deployment()))),
      jsonResponse(apiEnvelope(route(deployment()))),
      jsonResponse(apiEnvelope(route(deployment()))),
    ]);

    await expect(controlPlane(fetch, bindings).create(request)).resolves.toEqual({
      provider_route_id: ROUTE_ID,
    });
    expect(fetch.fetch).toHaveBeenCalledTimes(3);
    expect(fetch.fetch.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("lists all bounded pages with deterministic provider summaries", async () => {
    // page 1 is full (per_page 1), so the codec derives a second page;
    // page 2 is short, which terminates traversal.
    const fetch = fakeFetch([
      jsonResponse(routeListPage([routeListItem()], 1, 1)),
      jsonResponse(
        routeListPage(
          [
            routeListItem({
              id: "route-002",
              name: "eliotr-verify-v1-abcdef1234567890",
            }),
          ],
          2,
          2,
        ),
      ),
    ]);

    await expect(
      controlPlane(fetch).list("eliotr-reasoning"),
    ).resolves.toEqual({
      routes: [
        {
          provider_route_id: ROUTE_ID,
          name: "eliotr-draft-v1-abcdef1234567890",
        },
        {
          provider_route_id: "route-002",
          name: "eliotr-verify-v1-abcdef1234567890",
        },
      ],
    });
  });

  it("uses the bearerless connector request port with the native data-page envelope", async () => {
    const requestPort = {
      request: vi.fn(async () => jsonResponse({
        success: true,
        data: {
          routes: [routeListItem()], page: 1, per_page: 100,
          order_by: "name", order_by_direction: "asc",
        },
      })),
    };
    const adapter = createCloudflareDynamicRouteRestControlPlane({
      account_id: ACCOUNT_ID,
      bindings: fakeBindings(),
      request_port: requestPort,
    });
    await expect(adapter.list("eliotr-reasoning")).resolves.toEqual({
      routes: [{ provider_route_id: ROUTE_ID, name: "eliotr-draft-v1-abcdef1234567890" }],
    });
    expect(requestPort.request).toHaveBeenCalledWith(
      "GET",
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai-gateway/gateways/eliotr-reasoning/routes?page=1&per_page=100`,
      undefined,
      "NONE",
    );
  });

  it("reads a route only through an exact immutable binding", async () => {
    const request = await createRequest();
    const bindings = fakeBindings();
    bindings.records.set(
      ROUTE_ID,
      Object.freeze({
        protocol: "eliotr.dynamic-route-rest-binding.v1",
        account_id: ACCOUNT_ID,
        gateway_id: "eliotr-reasoning",
        provider_route_id: ROUTE_ID,
        provider_route_name: request.name,
        provider_version_id: VERSION_ID,
        provider_deployment_id: DEPLOYMENT_ID,
        route_definition_sha256: request.metadata.route_definition_sha256,
        metadata: request.metadata,
      }),
    );
    const fetch = fakeFetch([
      jsonResponse(apiEnvelope(route(deployment()))),
      jsonResponse(apiEnvelope(deployment())),
    ]);

    await expect(
      controlPlane(fetch, bindings).get("eliotr-reasoning", ROUTE_ID),
    ).resolves.toEqual({
      provider_route_id: ROUTE_ID,
      gateway_id: "eliotr-reasoning",
      name: request.name,
      route_definition: ROUTE_DEFINITION,
      metadata: request.metadata,
    });
  });

  it("rejects invalid inputs and credentials before dispatch", async () => {
    const request = await createRequest();
    const fetch = fakeFetch([]);
    await expectRestError(
      controlPlane(fetch).create({
        ...request,
        route_definition: { nodes: [] },
      }),
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
    );
    await expectRestError(
      controlPlane(fetch, fakeBindings(), "bad token").create(request),
      "DYNAMIC_ROUTE_REST_CREDENTIAL_INVALID",
    );
    await expectRestError(
      controlPlane(fetch).list(
        "other-gateway" as typeof DYNAMIC_ROUTE_GATEWAY_ID,
      ),
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
    );
    expect(fetch.fetch).not.toHaveBeenCalled();
  });

  it("classifies mutation ambiguity without exposing provider bodies", async () => {
    const request = await createRequest();
    await expectRestError(
      controlPlane(fakeFetch([new Error(`transport ${TOKEN}`)])).create(
        request,
      ),
      "DYNAMIC_ROUTE_REST_TRANSPORT_FAILED",
      "ROUTE_CREATE",
    );
    await expectRestError(
      controlPlane(
        fakeFetch([
          jsonResponse(apiEnvelope(route(null))),
          new Error(`deployment ${TOKEN}`),
        ]),
      ).create(request),
      "DYNAMIC_ROUTE_REST_TRANSPORT_FAILED",
      "DEPLOYMENT_CREATE",
    );

    const bindings = fakeBindings();
    bindings.putImmutable.mockImplementationOnce(async () => {
      throw new Error("secret-provider-body");
    });
    await expectRestError(
      controlPlane(
        fakeFetch([
          jsonResponse(apiEnvelope(route(null))),
          jsonResponse(apiEnvelope(deploymentAck())),
          jsonResponse(apiEnvelope(route(deployment()))),
        ]),
        bindings,
      ).create(request),
      "DYNAMIC_ROUTE_REST_BINDING_FAILED",
      "BINDING_WRITE",
    );
  });

  it("rejects unknown fields, oversized responses, and create drift", async () => {
    const request = await createRequest();
    await expectRestError(
      controlPlane(
        fakeFetch([
          jsonResponse({
            ...apiEnvelope(route(null)),
            secret_provider_body: true,
          }),
        ]),
      ).create(request),
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "ROUTE_CREATE",
    );
    await expectRestError(
      controlPlane(
        fakeFetch([
          jsonResponse(apiEnvelope(route(null)), 200, {
            "content-length": String(512 * 1024 + 1),
          }),
        ]),
      ).create(request),
      "DYNAMIC_ROUTE_REST_RESPONSE_TOO_LARGE",
      "ROUTE_CREATE",
    );
    await expectRestError(
      controlPlane(
        fakeFetch([
          jsonResponse(
            apiEnvelope(route(null, { name: "other-route" })),
          ),
        ]),
      ).create(request),
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "ROUTE_CREATE",
    );
  });

  it("fails closed for missing bindings and stale provider state", async () => {
    const fetch = fakeFetch([]);
    await expectRestError(
      controlPlane(fetch).get("eliotr-reasoning", ROUTE_ID),
      "DYNAMIC_ROUTE_REST_BINDING_MISSING",
    );
    expect(fetch.fetch).not.toHaveBeenCalled();

    const request = await createRequest();
    const bindings = fakeBindings();
    bindings.records.set(
      ROUTE_ID,
      Object.freeze({
        protocol: "eliotr.dynamic-route-rest-binding.v1",
        account_id: ACCOUNT_ID,
        gateway_id: "eliotr-reasoning",
        provider_route_id: ROUTE_ID,
        provider_route_name: request.name,
        provider_version_id: VERSION_ID,
        provider_deployment_id: DEPLOYMENT_ID,
        route_definition_sha256: request.metadata.route_definition_sha256,
        metadata: request.metadata,
      }),
    );
    const driftFetch = fakeFetch([
      jsonResponse(
        apiEnvelope(
          route(deployment(), {
            version: version({ data: [{ id: "drift" }] }),
          }),
        ),
      ),
    ]);
    await expectRestError(
      controlPlane(driftFetch, bindings).get("eliotr-reasoning", ROUTE_ID),
      "DYNAMIC_ROUTE_REST_READBACK_MISMATCH",
    );
  });

  it("exposes no update or delete mutation surface", () => {
    const adapter = controlPlane(fakeFetch([])) as unknown as Record<
      string,
      unknown
    >;
    // adopt (7214e4ea) only reads the provider route and writes the local
    // immutable binding; it adds no provider mutation.
    expect(Object.keys(adapter).sort()).toEqual([
      "adopt",
      "create",
      "gateway_id",
      "get",
      "list",
    ]);
    expect(adapter.update).toBeUndefined();
    expect(adapter.delete).toBeUndefined();
  });
});
