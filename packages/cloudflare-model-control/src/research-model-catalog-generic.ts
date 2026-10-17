import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ResearchModelCatalogError, type ExternalProviderCatalogTransport } from "./research-model-catalog.js";
import type { ConfiguredServiceModelProviderBinding } from "./service-model-provider-service.js";

const GENERIC_PROVIDER = /^compatible-[a-f0-9]{24}$/u;
const REGISTERED_GENERIC_PROVIDER = /^custom-compatible-[a-f0-9]{24}$/u;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface RegisteredGenericCatalogProvider {
  readonly slug: string;
  readonly base_url: string;
}

export function isGenericOpenRouterCatalogBinding(providerId: string, registered: RegisteredGenericCatalogProvider | null | undefined): boolean {
  return GENERIC_PROVIDER.test(providerId) && registered?.slug === `custom-${providerId}` &&
    (registered.base_url === OPENROUTER_BASE || registered.base_url === `${OPENROUTER_BASE}/`);
}

function unavailable(message: string, retryable = false, cause?: unknown): ResearchModelCatalogError {
  return new ResearchModelCatalogError("MODEL_CATALOG_PROVIDER_UNAVAILABLE", 503, message, retryable, cause);
}

/** Metadata-only read of one exact enabled slug from a complete, bounded registry page.
 * Account, gateway and credential are supplied by the deployment, never the HTTP caller. */
export function createGenericCatalogRegisteredProviderReader(options: {
  readonly account_id?: string;
  readonly gateway_id?: string;
  readonly control_token?: string;
  readonly fetcher?: typeof fetch;
}) {
  return async (slug: string, signal: AbortSignal): Promise<RegisteredGenericCatalogProvider | null> => {
    if (!REGISTERED_GENERIC_PROVIDER.test(slug)) return null;
    const token = options.control_token;
    if (!/^[a-f0-9]{32}$/u.test(options.account_id ?? "") || options.gateway_id !== "eliotr-reasoning" ||
        typeof token !== "string" || token.length < 1 || token.length > 4096 || /\s/u.test(token) ||
        token.toLowerCase().startsWith("bearer")) throw unavailable("registered provider metadata reader is unavailable", true);
    if (signal.aborted) throw new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled");
    const url = `https://api.cloudflare.com/client/v4/accounts/${options.account_id}/ai-gateway/custom-providers?page=1&per_page=100`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 5_000);
    try {
      const response = await (options.fetcher ?? globalThis.fetch)(url, { method: "GET", redirect: "manual",
        cache: "no-store", credentials: "omit", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (response.status !== 200 || response.redirected || (response.url !== "" && response.url !== url) ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || response.body === null) {
        await response.body?.cancel();
        throw unavailable("registered provider metadata is unavailable", true);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.byteLength;
          if (length > 262_144 || controller.signal.aborted) {
            await reader.cancel();
            throw unavailable("registered provider metadata is incomplete", true);
          }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (controller.signal.aborted || !record(body) || body.success !== true || !Array.isArray(body.result) ||
          body.result.length > 100 || !record(body.result_info) || body.result_info.page !== 1 ||
          body.result_info.total_count !== body.result.length) throw unavailable("registered provider metadata is incomplete", true);
      const matches = body.result.filter((entry: unknown) => record(entry) && entry.slug === slug);
      const match: unknown = matches[0];
      if (matches.length !== 1 || !record(match) || match.enable !== true || typeof match.base_url !== "string") return null;
      return Object.freeze({ slug, base_url: match.base_url });
    } catch (cause) {
      if (signal.aborted) throw new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled");
      if (cause instanceof ResearchModelCatalogError) throw cause;
      throw unavailable("registered provider metadata is unavailable", true, cause);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  };
}

/** Public directory metadata retains the configured generic identity. No account/model authority
 * is inferred from the directory, and no registry URL is ever used as a fetch destination. */
export function createGenericOpenRouterCatalogResolver(options: {
  readonly openrouter: ExternalProviderCatalogTransport;
  readonly resolve_connection: (
    context: AuthenticatedRequestContext, providerId: string,
  ) => Promise<ConfiguredServiceModelProviderBinding | null>;
  readonly read_registered_provider: (slug: string, signal: AbortSignal) => Promise<RegisteredGenericCatalogProvider | null>;
}) {
  return async (context: AuthenticatedRequestContext, providerId: string): Promise<ExternalProviderCatalogTransport | null> => {
    if (!GENERIC_PROVIDER.test(providerId)) return null;
    const resolve = async () => {
      try { return await options.resolve_connection(context, providerId); }
      catch (cause) { throw unavailable("configured provider identity is unavailable", true, cause); }
    };
    const connection = await resolve();
    if (connection === null || connection.owner_id !== context.principal_ref || connection.provider_id !== providerId ||
        connection.provider_slug !== `custom-${providerId}` || options.openrouter.provider_id !== "openrouter") return null;
    const registered = await options.read_registered_provider(connection.provider_slug, context.request.signal);
    if (!isGenericOpenRouterCatalogBinding(providerId, registered)) return null;
    const identity = (value: ConfiguredServiceModelProviderBinding) => JSON.stringify([
      value.owner_id, value.operation_id, value.provider_id, value.provider_slug, value.alias,
      value.provider_config_id, value.metadata_sha256, value.model_registration_mode, value.model_ids,
    ]);
    const expected = identity(connection);
    return Object.freeze({ provider_id: providerId,
      async listTextGeneration(input: Parameters<ExternalProviderCatalogTransport["listTextGeneration"]>[0]) {
        const page = await options.openrouter.listTextGeneration(input);
        const current = await resolve();
        if (current === null || identity(current) !== expected) throw unavailable("configured provider identity changed");
        return page;
      },
    });
  };
}
