import type {
  DynamicRouteControlPlanePort,
  DynamicRouteCreateRequest,
} from "./dynamic-route-provisioning-contract.js";
import { DYNAMIC_ROUTE_GATEWAY_ID } from "./dynamic-route-provisioning-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  cloudflareDynamicRouteBaseUrl,
  compileCloudflareDeploymentCreateBody,
  compileCloudflareRouteCreateBody,
  decodeCloudflareApiEnvelope,
  decodeCloudflareDeployment,
  decodeCloudflareRoute,
  decodeCloudflareRouteListPage,
  decodeDynamicRouteBindingWriteReceipt,
  decodeDynamicRouteCreateRequest,
  decodeDynamicRouteRestBinding,
  dynamicRouteRequestHeaders,
  dynamicRouteRestBindingSha256,
  dynamicRouteRestFailure,
  readDynamicRouteRestJson,
  requireDynamicRouteAccountId,
  requireDynamicRouteApiToken,
  requireDynamicRouteGatewayId,
  requireProviderIdentifier,
  verifyRouteReadback,
} from "./dynamic-route-rest-codec.js";
import {
  DYNAMIC_ROUTE_REST_LIST_MAX_PAGES,
  DYNAMIC_ROUTE_REST_LIST_PER_PAGE,
  DynamicRouteRestError,
  type DecodedDynamicRoute,
  type DecodedDynamicRouteDeployment,
  type DynamicRouteRestAmbiguousEffect,
  type DynamicRouteRestBinding,
  type DynamicRouteRestControlPlane,
  type DynamicRouteRestControlPlaneDependencies,
  type DynamicRouteRestResponse,
} from "./dynamic-route-rest-contract.js";

interface RestClient {
  request(
    method: "GET" | "POST",
    url: string,
    body: unknown | undefined,
    ambiguousEffect: DynamicRouteRestAmbiguousEffect,
  ): Promise<Readonly<{ result: unknown; result_info: unknown }>>;
}

export function createCloudflareDynamicRouteRestControlPlane(
  dependencies: DynamicRouteRestControlPlaneDependencies,
): DynamicRouteRestControlPlane {
  const accountId = requireDynamicRouteAccountId(dependencies.account_id);
  const gatewayId = DYNAMIC_ROUTE_GATEWAY_ID;
  const baseUrl = cloudflareDynamicRouteBaseUrl(accountId, gatewayId);
  const client = createRestClient(dependencies);

  const controlPlane: DynamicRouteControlPlanePort = Object.freeze({
    async list(requestedGatewayId) {
      requireDynamicRouteGatewayId(requestedGatewayId);
      const routes: Readonly<{
        provider_route_id: string;
        name: string;
      }>[] = [];
      const seenIds = new Set<string>();
      const seenNames = new Set<string>();
      let expectedPage = 1;
      let totalPages = 1;

      do {
        const url = `${baseUrl}?page=${expectedPage}&per_page=${DYNAMIC_ROUTE_REST_LIST_PER_PAGE}`;
        const envelope = await client.request("GET", url, undefined, "NONE");
        const page = decodeCloudflareRouteListPage(
          envelope.result,
          envelope.result_info,
        );
        if (page.page !== expectedPage || page.total_pages < totalPages) {
          dynamicRouteRestFailure(
            "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
            "Cloudflare route-list pagination changed during traversal",
          );
        }
        totalPages = page.total_pages;
        for (const route of page.routes) {
          if (seenIds.has(route.id) || seenNames.has(route.name)) {
            dynamicRouteRestFailure(
              "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
              "Cloudflare route list contains duplicate identities",
            );
          }
          seenIds.add(route.id);
          seenNames.add(route.name);
          routes.push(
            Object.freeze({
              provider_route_id: route.id,
              name: route.name,
            }),
          );
        }
        expectedPage += 1;
      } while (
        expectedPage <= totalPages &&
        expectedPage <= DYNAMIC_ROUTE_REST_LIST_MAX_PAGES
      );

      if (expectedPage <= totalPages) {
        dynamicRouteRestFailure(
          "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
          "Cloudflare route list exceeds the bounded page count",
        );
      }
      return Object.freeze({ routes: Object.freeze(routes) });
    },

    async get(requestedGatewayId, providerRouteId) {
      requireDynamicRouteGatewayId(requestedGatewayId);
      const routeId = requireProviderIdentifier(providerRouteId, "route ID");
      const binding = await loadBinding(
        dependencies,
        routeId,
        accountId,
      );
      const route = await getRoute(client, baseUrl, routeId);
      const deployment = await getDeployment(
        client,
        baseUrl,
        routeId,
        binding.provider_deployment_id,
      );
      await verifyRouteReadback(route, deployment, binding);
      return normalizedRouteSnapshot(route, binding);
    },

    async create(rawRequest) {
      const request = decodeDynamicRouteCreateRequest(rawRequest);
      const definitionSha256 = await modelGatewaySha256(
        canonicalModelGatewayJson(request.route_definition),
      );
      if (definitionSha256 !== request.metadata.route_definition_sha256) {
        dynamicRouteRestFailure(
          "DYNAMIC_ROUTE_REST_INPUT_INVALID",
          "Dynamic Route definition digest does not match metadata",
        );
      }

      const routeBody = compileCloudflareRouteCreateBody(request);
      const routeEnvelope = await client.request(
        "POST",
        baseUrl,
        routeBody,
        "ROUTE_CREATE",
      );
      const route = decodeCloudflareRoute(routeEnvelope.result);
      await verifyCreatedRoute(route, request, definitionSha256);

      const deployment = await ensureDeployment(client, baseUrl, route);
      const binding = createBinding(
        accountId,
        route,
        deployment,
        request,
        definitionSha256,
      );
      const bindingSha256 = await dynamicRouteRestBindingSha256(binding);
      const writeReceipt = await putBinding(
        dependencies,
        binding,
        bindingSha256,
      );
      const readback = await loadBinding(
        dependencies,
        route.id,
        accountId,
        "BINDING_WRITE",
      );
      if (
        writeReceipt.readback_sha256 !== bindingSha256 ||
        (await dynamicRouteRestBindingSha256(readback)) !== bindingSha256
      ) {
        dynamicRouteRestFailure(
          "DYNAMIC_ROUTE_REST_BINDING_FAILED",
          "Dynamic Route immutable binding readback digest differs",
          { ambiguous_effect: "BINDING_WRITE" },
        );
      }

      const exactRoute = await getRoute(
        client,
        baseUrl,
        route.id,
        "BINDING_WRITE",
      );
      const exactDeployment = await getDeployment(
        client,
        baseUrl,
        route.id,
        deployment.id,
        "BINDING_WRITE",
      );
      await verifyRouteReadback(exactRoute, exactDeployment, readback);
      return Object.freeze({ provider_route_id: route.id });
    },
  });

  return Object.freeze({ ...controlPlane, gateway_id: gatewayId });
}

function createRestClient(
  dependencies: DynamicRouteRestControlPlaneDependencies,
): RestClient {
  return Object.freeze({
    async request(method, url, body, ambiguousEffect) {
      let token: string;
      try {
        token = requireDynamicRouteApiToken(
          await dependencies.credentials.readApiToken(),
        );
      } catch (error) {
        if (error instanceof DynamicRouteRestError) throw error;
        dynamicRouteRestFailure(
          "DYNAMIC_ROUTE_REST_CREDENTIAL_INVALID",
          "Cloudflare API credential could not be read",
        );
      }

      let response: DynamicRouteRestResponse;
      try {
        const bodyJson =
          body === undefined ? undefined : canonicalModelGatewayJson(body);
        response = await dependencies.fetch.fetch(url, {
          method,
          headers: dynamicRouteRequestHeaders(token, bodyJson !== undefined),
          ...(bodyJson === undefined ? {} : { body: bodyJson }),
        });
      } catch {
        dynamicRouteRestFailure(
          "DYNAMIC_ROUTE_REST_TRANSPORT_FAILED",
          "Cloudflare control-plane transport failed",
          {
            retryable: method === "GET",
            ambiguous_effect: ambiguousEffect,
          },
        );
      }

      const raw = await readDynamicRouteRestJson(response, ambiguousEffect);
      return decodeCloudflareApiEnvelope(raw, response, ambiguousEffect);
    },
  });
}

async function getRoute(
  client: RestClient,
  baseUrl: string,
  routeId: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect = "NONE",
): Promise<DecodedDynamicRoute> {
  const envelope = await client.request(
    "GET",
    `${baseUrl}/${encodeURIComponent(routeId)}`,
    undefined,
    ambiguousEffect,
  );
  return decodeCloudflareRoute(envelope.result);
}

async function getDeployment(
  client: RestClient,
  baseUrl: string,
  routeId: string,
  deploymentId: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect = "NONE",
): Promise<DecodedDynamicRouteDeployment> {
  const envelope = await client.request(
    "GET",
    `${baseUrl}/${encodeURIComponent(routeId)}/deployments/${encodeURIComponent(deploymentId)}`,
    undefined,
    ambiguousEffect,
  );
  return decodeCloudflareDeployment(envelope.result);
}

async function ensureDeployment(
  client: RestClient,
  baseUrl: string,
  route: DecodedDynamicRoute,
): Promise<DecodedDynamicRouteDeployment> {
  if (route.deployment !== null) {
    if (route.deployment.version_id !== route.version.id) {
      dynamicRouteRestFailure(
        "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
        "Cloudflare created route with an unrelated active deployment",
        { ambiguous_effect: "ROUTE_CREATE" },
      );
    }
    return route.deployment;
  }
  const envelope = await client.request(
    "POST",
    `${baseUrl}/${encodeURIComponent(route.id)}/deployments`,
    compileCloudflareDeploymentCreateBody(route.version.id),
    "DEPLOYMENT_CREATE",
  );
  const deployment = decodeCloudflareDeployment(envelope.result);
  if (
    deployment.route_id !== route.id ||
    deployment.version_id !== route.version.id
  ) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "Cloudflare deployment acknowledgement does not match the created route version",
      { ambiguous_effect: "DEPLOYMENT_CREATE" },
    );
  }
  return deployment;
}

async function verifyCreatedRoute(
  route: DecodedDynamicRoute,
  request: DynamicRouteCreateRequest,
  definitionSha256: string,
): Promise<void> {
  const observedSha256 = await modelGatewaySha256(
    canonicalModelGatewayJson(route.version.elements),
  );
  if (
    route.name !== request.name ||
    route.version.route_id !== route.id ||
    observedSha256 !== definitionSha256
  ) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      "Cloudflare route acknowledgement differs from the create request",
      { ambiguous_effect: "ROUTE_CREATE" },
    );
  }
}

function createBinding(
  accountId: string,
  route: DecodedDynamicRoute,
  deployment: DecodedDynamicRouteDeployment,
  request: DynamicRouteCreateRequest,
  definitionSha256: string,
): DynamicRouteRestBinding {
  return Object.freeze({
    protocol: "eliotr.dynamic-route-rest-binding.v1",
    account_id: accountId,
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    provider_route_id: route.id,
    provider_route_name: route.name,
    provider_version_id: route.version.id,
    provider_deployment_id: deployment.id,
    route_definition_sha256: definitionSha256,
    metadata: request.metadata,
  });
}

async function putBinding(
  dependencies: DynamicRouteRestControlPlaneDependencies,
  binding: DynamicRouteRestBinding,
  bindingSha256: string,
) {
  let raw: unknown;
  try {
    raw = await dependencies.bindings.putImmutable(binding, bindingSha256);
  } catch {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_BINDING_FAILED",
      "Dynamic Route immutable binding write failed",
      { ambiguous_effect: "BINDING_WRITE" },
    );
  }
  return decodeDynamicRouteBindingWriteReceipt(
    raw,
    binding,
    bindingSha256,
  );
}

async function loadBinding(
  dependencies: DynamicRouteRestControlPlaneDependencies,
  routeId: string,
  accountId: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect = "NONE",
): Promise<DynamicRouteRestBinding> {
  let raw: unknown | null;
  try {
    raw = await dependencies.bindings.get(routeId);
  } catch {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_BINDING_FAILED",
      "Dynamic Route immutable binding read failed",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  if (raw === null) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_BINDING_MISSING",
      "Dynamic Route has no authoritative immutable binding",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  const binding = decodeDynamicRouteRestBinding(raw);
  if (
    binding.account_id !== accountId ||
    binding.gateway_id !== DYNAMIC_ROUTE_GATEWAY_ID ||
    binding.provider_route_id !== routeId
  ) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_BINDING_CONFLICT",
      "Dynamic Route immutable binding targets another control-plane object",
      { ambiguous_effect: ambiguousEffect },
    );
  }
  return binding;
}

function normalizedRouteSnapshot(
  route: DecodedDynamicRoute,
  binding: DynamicRouteRestBinding,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    provider_route_id: route.id,
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    name: route.name,
    route_definition: route.version.elements,
    metadata: binding.metadata,
  });
}
