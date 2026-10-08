import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  CUSTOM_PROVIDER_API_ORIGIN,
  CUSTOM_PROVIDER_MAX_PAGES,
  CUSTOM_PROVIDER_PAGE_SIZE,
  compileCustomProviderCreateBody,
  customProviderMatches,
  decodeCustomProvider,
  decodeCustomProviderDesired,
  decodeCustomProviderListPage,
  requireCustomProviderAccountId,
  requireCustomProviderApiToken,
} from "./custom-provider-rest-codec.js";
import {
  readCustomProviderRestEnvelope,
} from "./custom-provider-rest-response.js";
import {
  CustomProviderRestError,
  customProviderRestFailure,
  type CloudflareCustomProviderDependencies,
  type CustomProviderProvisioningDisposition,
  type CustomProviderProvisioningReceipt,
  type CustomProviderRestEffect,
  type CustomProviderRestEnvelope,
  type NormalizedCustomProviderSpec,
  type ObservedCustomProvider,
} from "./custom-provider-rest-contract.js";

interface RestClient {
  request(
    method: "GET" | "POST",
    url: string,
    body: unknown | undefined,
    effect: CustomProviderRestEffect,
  ): Promise<CustomProviderRestEnvelope>;
}

export async function ensureCloudflareCustomProvider(
  rawDesired: unknown,
  dependencies: CloudflareCustomProviderDependencies,
): Promise<CustomProviderProvisioningReceipt> {
  const desired = decodeCustomProviderDesired(rawDesired);
  const accountId = requireCustomProviderAccountId(dependencies.account_id);
  const baseUrl = `${CUSTOM_PROVIDER_API_ORIGIN}/client/v4/accounts/${accountId}/ai-gateway/custom-providers`;
  const client = createRestClient(dependencies);

  const existing = await findBySlug(client, baseUrl, accountId, desired.slug);
  if (existing !== null) {
    requireExact(
      existing,
      desired,
      "Existing custom provider differs from requested configuration",
    );
    return receipt(accountId, existing, desired, "EXISTING_MATCH");
  }

  let createAcknowledged = false;
  try {
    const envelope = await client.request(
      "POST",
      baseUrl,
      compileCustomProviderCreateBody(desired),
      "CREATE",
    );
    const acknowledged = decodeCustomProvider(
      envelope.result,
      accountId,
      true,
      "CREATE",
    );
    createAcknowledged = true;
    requireExact(
      acknowledged,
      desired,
      "Custom provider create acknowledgement differs",
      "CREATE",
      "CUSTOM_PROVIDER_READBACK_MISMATCH",
    );
    const readback = await getProvider(
      client,
      baseUrl,
      accountId,
      acknowledged.id,
      "CREATE",
    );
    requireExact(
      readback,
      desired,
      "Custom provider readback differs",
      "CREATE",
      "CUSTOM_PROVIDER_READBACK_MISMATCH",
    );
    return receipt(accountId, readback, desired, "CREATED");
  } catch (error) {
    if (!(error instanceof CustomProviderRestError) ||
        (!createAcknowledged && error.effect !== "CREATE")) {
      throw error;
    }
    return reconcileCreate(client, baseUrl, accountId, desired, error);
  }
}

async function reconcileCreate(
  client: RestClient,
  baseUrl: string,
  accountId: string,
  desired: NormalizedCustomProviderSpec,
  original: CustomProviderRestError,
): Promise<CustomProviderProvisioningReceipt> {
  try {
    const observed = await findBySlug(
      client,
      baseUrl,
      accountId,
      desired.slug,
    );
    if (observed === null) {
      customProviderRestFailure(
        "CUSTOM_PROVIDER_CREATE_UNCERTAIN",
        "Custom provider create outcome could not be reconciled",
        { retryable: true, effect: "CREATE", cause: original },
      );
    }
    requireExact(
      observed,
      desired,
      "Custom provider slug exists with different configuration after create",
      "CREATE",
    );
    return receipt(accountId, observed, desired, "CREATE_RECONCILED");
  } catch (error) {
    if (
      error instanceof CustomProviderRestError &&
      (error.code === "CUSTOM_PROVIDER_EXISTING_CONFLICT" ||
        error.code === "CUSTOM_PROVIDER_CREATE_UNCERTAIN")
    ) {
      throw error;
    }
    customProviderRestFailure(
      "CUSTOM_PROVIDER_CREATE_UNCERTAIN",
      "Custom provider create reconciliation failed",
      { retryable: true, effect: "CREATE", cause: error },
    );
  }
}

async function findBySlug(
  client: RestClient,
  baseUrl: string,
  accountId: string,
  slug: string,
): Promise<ObservedCustomProvider | null> {
  const providers = await listProviders(client, baseUrl, accountId);
  const matches = providers.filter((provider) => provider.slug === slug);
  if (matches.length > 1) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Cloudflare custom provider list contains duplicate slugs",
    );
  }
  const match = matches[0];
  return match === undefined
    ? null
    : getProvider(client, baseUrl, accountId, match.id, "NONE");
}

async function listProviders(
  client: RestClient,
  baseUrl: string,
  accountId: string,
): Promise<readonly ObservedCustomProvider[]> {
  const providers: ObservedCustomProvider[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  let expectedPages = 1;
  let expectedCount: number | undefined;

  for (let pageNumber = 1; pageNumber <= expectedPages; pageNumber += 1) {
    if (pageNumber > CUSTOM_PROVIDER_MAX_PAGES) {
      customProviderRestFailure(
        "CUSTOM_PROVIDER_RESPONSE_INVALID",
        "Custom provider pagination exceeds its bound",
      );
    }
    const envelope = await client.request(
      "GET",
      `${baseUrl}?page=${pageNumber}&per_page=${CUSTOM_PROVIDER_PAGE_SIZE}&order_by=${encodeURIComponent("name ASC")}`,
      undefined,
      "NONE",
    );
    const page = decodeCustomProviderListPage(
      envelope.result,
      envelope.result_info,
      accountId,
    );
    const emptyFirstPage = pageNumber === 1 && page.total_pages === 0 &&
      page.total_count === 0 && page.providers.length === 0;
    if (page.page !== pageNumber || (!emptyFirstPage && page.total_pages < pageNumber)) {
      customProviderRestFailure(
        "CUSTOM_PROVIDER_RESPONSE_INVALID",
        "Custom provider pagination returned an unexpected page",
      );
    }
    if (pageNumber === 1) {
      expectedPages = page.total_pages;
      expectedCount = page.total_count;
    } else if (
      page.total_pages !== expectedPages ||
      page.total_count !== expectedCount
    ) {
      customProviderRestFailure(
        "CUSTOM_PROVIDER_RESPONSE_INVALID",
        "Custom provider pagination changed during traversal",
      );
    }
    for (const provider of page.providers) {
      if (seenIds.has(provider.id) || seenSlugs.has(provider.slug)) {
        customProviderRestFailure(
          "CUSTOM_PROVIDER_RESPONSE_INVALID",
          "Custom provider list contains duplicate identities",
        );
      }
      seenIds.add(provider.id);
      seenSlugs.add(provider.slug);
      providers.push(provider);
    }
  }
  if (expectedCount === undefined || providers.length !== expectedCount) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider list count differs from pagination metadata",
    );
  }
  return Object.freeze(providers);
}

async function getProvider(
  client: RestClient,
  baseUrl: string,
  accountId: string,
  providerId: string,
  effect: CustomProviderRestEffect,
): Promise<ObservedCustomProvider> {
  const envelope = await client.request(
    "GET",
    `${baseUrl}/${encodeURIComponent(providerId)}`,
    undefined,
    effect,
  );
  const provider = decodeCustomProvider(
    envelope.result,
    accountId,
    true,
    effect,
  );
  if (provider.id !== providerId) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_READBACK_MISMATCH",
      "Custom provider readback returned another provider identity",
      { effect },
    );
  }
  return provider;
}

function createRestClient(
  dependencies: CloudflareCustomProviderDependencies,
): RestClient {
  return Object.freeze({
    async request(
      method: "GET" | "POST",
      url: string,
      body: unknown | undefined,
      effect: CustomProviderRestEffect,
    ) {
      let token: string;
      try {
        token = requireCustomProviderApiToken(
          await dependencies.credentials.readApiToken(),
        );
      } catch (error) {
        if (error instanceof CustomProviderRestError) throw error;
        customProviderRestFailure(
          "CUSTOM_PROVIDER_CREDENTIAL_INVALID",
          "Cloudflare custom-provider credential could not be read",
          { cause: error },
        );
      }
      const bodyJson = body === undefined
        ? undefined
        : canonicalModelGatewayJson(body);
      let response: Response;
      try {
        response = await dependencies.fetch.fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(bodyJson === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(bodyJson === undefined ? {} : { body: bodyJson }),
        });
      } catch (cause) {
        customProviderRestFailure(
          "CUSTOM_PROVIDER_TRANSPORT_FAILED",
          "Cloudflare custom-provider transport failed",
          { retryable: method === "GET", effect, cause },
        );
      }
      if (!(response instanceof Response)) {
        customProviderRestFailure(
          "CUSTOM_PROVIDER_RESPONSE_INVALID",
          "Cloudflare custom-provider transport returned an invalid response",
          { effect },
        );
      }
      return readCustomProviderRestEnvelope(response, effect);
    },
  });
}

function requireExact(
  observed: ObservedCustomProvider,
  desired: NormalizedCustomProviderSpec,
  message: string,
  effect: CustomProviderRestEffect = "NONE",
  code: "CUSTOM_PROVIDER_EXISTING_CONFLICT" | "CUSTOM_PROVIDER_READBACK_MISMATCH" =
    "CUSTOM_PROVIDER_EXISTING_CONFLICT",
): void {
  if (!customProviderMatches(observed, desired)) {
    customProviderRestFailure(code, message, { effect });
  }
}

async function receipt(
  accountId: string,
  observed: ObservedCustomProvider,
  desired: NormalizedCustomProviderSpec,
  disposition: CustomProviderProvisioningDisposition,
): Promise<CustomProviderProvisioningReceipt> {
  const gatewayProvider = `custom-${desired.slug}`;
  const configSha256 = await modelGatewaySha256(
    canonicalModelGatewayJson(desired),
  );
  return Object.freeze({
    protocol: "eliotr.custom-provider-provisioning-receipt.v1",
    disposition,
    account_id: accountId,
    provider_id: observed.id,
    provider_slug: desired.slug,
    gateway_provider: gatewayProvider,
    model_reference_prefix: `${gatewayProvider}/`,
    base_url: desired.base_url,
    config_sha256: configSha256,
    observed_modified_at: observed.modified_at,
  });
}
