import { modelGatewayCustomProviderRoutingId } from "./model-gateway-provider-namespace.js";

export type OpenCodeRoutingBlockReason = "PROVIDER_UNSUPPORTED" | "MODEL_ID_INVALID" | "CREDENTIAL_NAMESPACE_MISMATCH" |
  "SDK_UNSUPPORTED" | "ADVERTISED_API_BASE_MISMATCH" | "REGISTERED_BASE_UNVERIFIED" | "REGISTERED_BASE_INCOMPATIBLE";

export type OpenCodeModelRoutePlan = Readonly<{
  status: "eligible_unverified";
  api: "custom-responses" | "custom-chat-completions" | "custom-anthropic-messages";
  model_id: string;
  provider_slug: string;
  registered_base_url: string;
  gateway_path: string;
  expected_upstream_url: string;
}> | Readonly<{ status: "blocked"; reason: OpenCodeRoutingBlockReason }>;

export interface OpenCodeModelRouteInput {
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly model_id: string;
  readonly advertised_sdk: string | null;
  readonly advertised_api_base: string | null;
  /** Exact authenticated CF custom-provider metadata, not the D1 connection's historical input URL. */
  readonly registered_provider?: Readonly<{ slug: string; base_url: string }> | null;
}

export interface OpenCodeRegisteredProvider { readonly slug: string; readonly base_url: string }
export type ReadOpenCodeRegisteredProvider = (provider: string) => Promise<OpenCodeRegisteredProvider | null>;

/** Runtime policies have already passed exact-model SDK qualification. */
export function openCodePolicyMetadata(provider: string, api: string): Readonly<{ sdk: string; base: string }> | null {
  const product = provider === "custom-opencode-go" ? "/inference/go" : provider === "custom-opencode-zen" ? "/inference" : null;
  if (product === null) return null;
  if (api === "custom-responses") return { sdk: "@ai-sdk/openai", base: `https://opencode.ai${product}/openai/v1` };
  if (api === "custom-chat-completions") return { sdk: "@ai-sdk/openai-compatible", base: `https://opencode.ai${product}/openai/v1` };
  if (api === "custom-anthropic-messages") return { sdk: "@ai-sdk/anthropic", base: `https://opencode.ai${product}/anthropic/v1` };
  return null;
}

const MODEL_ID = /^[A-Za-z0-9~][A-Za-z0-9._:~@/-]{0,255}$/u;
const blocked = (reason: OpenCodeRoutingBlockReason): OpenCodeModelRoutePlan => Object.freeze({ status: "blocked", reason });

function exactOpenCodeBase(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.origin !== "https://opencode.ai" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
        !/^https:\/\/opencode\.ai(?:\/|$)/u.test(raw) || /[%\\]/u.test(raw)) return null;
    return url;
  } catch { return null; }
}

/** Select from model-specific SDK metadata, never a model-name pin or Proxy fallback.
 * A matching route is only transport eligibility; pricing, owner consent and the
 * one-shot native qualification remain separate authorities. No I/O or mutations. */
export function planOpenCodeModelRoute(input: OpenCodeModelRouteInput): OpenCodeModelRoutePlan {
  const product = input.provider_id === "opencode-go" ? "/inference/go"
    : input.provider_id === "opencode-zen" ? "/inference" : null;
  if (product === null) return blocked("PROVIDER_UNSUPPORTED");
  if (!MODEL_ID.test(input.model_id)) return blocked("MODEL_ID_INVALID");
  if (input.provider_slug !== `custom-${input.provider_id}`) return blocked("CREDENTIAL_NAMESPACE_MISMATCH");
  const codec = input.advertised_sdk === "@ai-sdk/openai"
    ? { api: "custom-responses" as const, family: "/openai/v1", suffix: "/responses" }
    : input.advertised_sdk === "@ai-sdk/openai-compatible"
      ? { api: "custom-chat-completions" as const, family: "/openai/v1", suffix: "/chat/completions" }
      : input.advertised_sdk === "@ai-sdk/anthropic"
        ? { api: "custom-anthropic-messages" as const, family: "/anthropic/v1", suffix: "/messages" } : null;
  if (codec === null) return blocked("SDK_UNSUPPORTED");
  const sdkBase = input.advertised_api_base === null ? null : exactOpenCodeBase(input.advertised_api_base);
  if (sdkBase === null || sdkBase.pathname.replace(/\/$/u, "") !== `${product}${codec.family}`) {
    return blocked("ADVERTISED_API_BASE_MISMATCH");
  }
  if (input.registered_provider === null || input.registered_provider === undefined) return blocked("REGISTERED_BASE_UNVERIFIED");
  if (input.registered_provider.slug !== input.provider_slug) return blocked("CREDENTIAL_NAMESPACE_MISMATCH");
  const registered = exactOpenCodeBase(input.registered_provider.base_url);
  if (registered === null) return blocked("REGISTERED_BASE_INCOMPATIBLE");
  const basePath = registered.pathname.replace(/\/$/u, "");
  // Both an origin base and a common product prefix can multiplex all three
  // codecs. An existing SDK-specific base can serve only that exact family.
  if (!["", product, `${product}/openai/v1`, `${product}/anthropic/v1`].includes(basePath)) {
    return blocked("REGISTERED_BASE_INCOMPATIBLE");
  }
  const upstreamPath = `${product}${codec.family}${codec.suffix}`;
  if (basePath !== "" && !upstreamPath.startsWith(`${basePath}/`)) return blocked("REGISTERED_BASE_INCOMPATIBLE");
  const providerPath = upstreamPath.slice(basePath.length);
  return Object.freeze({ status: "eligible_unverified", api: codec.api, model_id: input.model_id,
    provider_slug: input.provider_slug, registered_base_url: `${registered.origin}${basePath}`,
    gateway_path: `/${modelGatewayCustomProviderRoutingId(input.provider_slug)}${providerPath}`,
    expected_upstream_url: `${registered.origin}${upstreamPath}` });
}
