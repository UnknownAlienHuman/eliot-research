import { planOpenCodeModelRoute, type ReadOpenCodeRegisteredProvider, type OpenCodeModelRoutePlan } from
  "@eliotr/cloudflare-model-transport/opencode-model-routing.js";
import { readVerifiedCatalogModelMetadataBatch } from "@eliotr/cloudflare-research-configuration/research-catalog-model-pricing.js";
import { installedGatewayIdentity } from "./research-provider-key-configuration-composition.js";
import type { Env } from "./env.js";

type RoutingEnv = Pick<Env, "AI_GATEWAY_REASONING_URL" | "ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN">;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Bounded metadata-only GET using the existing server control credential.
 * No key/config creation, secret endpoint, fallback account or response logging. */
export function createOpenCodeRegisteredProviderReader(env: RoutingEnv, signal?: AbortSignal, fetcher?: typeof fetch): ReadOpenCodeRegisteredProvider {
  return async provider => {
    const identity = installedGatewayIdentity(env.AI_GATEWAY_REASONING_URL);
    const token = env.ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN;
    if ((provider !== "custom-opencode-go" && provider !== "custom-opencode-zen") || identity === undefined ||
        identity.gateway_id !== "eliotr-reasoning" || typeof token !== "string" || token.length < 1 || token.length > 4096 ||
        /\s/u.test(token) || token.toLowerCase().startsWith("bearer") || signal?.aborted) return null;
    const url = `https://api.cloudflare.com/client/v4/accounts/${identity.account_id}/ai-gateway/custom-providers?page=1&per_page=100`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 5_000);
    try {
      const response = await (fetcher ?? globalThis.fetch.bind(globalThis))(url, { method: "GET", redirect: "manual",
        cache: "no-store", credentials: "omit", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (response.status !== 200 || response.redirected || (response.url !== "" && response.url !== url) || response.body === null ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) { await response.body?.cancel(); return null; }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.byteLength;
          if (length > 262_144 || controller.signal.aborted) { await reader.cancel(); return null; }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (controller.signal.aborted || !object(body) || body.success !== true || !Array.isArray(body.result) || body.result.length > 100 ||
          !object(body.result_info) || body.result_info.page !== 1 || body.result_info.total_count !== body.result.length) return null;
      const matches = body.result.filter(item => object(item) && item.slug === provider);
      const match: unknown = matches[0];
      if (matches.length !== 1 || !object(match) || match.enable !== true || typeof match.base_url !== "string") return null;
      return Object.freeze({ slug: provider, base_url: match.base_url });
    } catch { return null; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
}

export function createOpenCodeDiscoveryRouting(env: RoutingEnv, signal?: AbortSignal, fetcher?: typeof fetch) {
  const readProvider = createOpenCodeRegisteredProviderReader(env, signal, fetcher);
  return async (provider: "opencode-go" | "opencode-zen", ids: readonly string[]): Promise<ReadonlyMap<string, OpenCodeModelRoutePlan>> => {
    try {
      const [registered, metadata] = await Promise.all([
        readProvider(`custom-${provider}`),
        readVerifiedCatalogModelMetadataBatch({ provider_id: provider, model_ids: ids,
          ...(signal === undefined ? {} : { signal }), ...(fetcher === undefined ? {} : { fetch: fetcher }) }),
      ]);
      return new Map(metadata.map(model => [model.model_id, planOpenCodeModelRoute({ provider_id: provider,
        provider_slug: `custom-${provider}`, model_id: model.model_id, advertised_sdk: model.advertised_sdk,
        advertised_api_base: model.advertised_api_base, registered_provider: registered })]));
    } catch { return new Map(); }
  };
}
