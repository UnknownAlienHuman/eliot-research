import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ResearchModelCatalogError, type ExternalProviderCatalogTransport } from "./research-model-catalog.js";
import type { ConfiguredServiceModelProviderBinding } from "./service-model-provider-service.js";

const GENERIC_PROVIDER = /^compatible-[a-f0-9]{24}$/u;
const REGISTERED_GENERIC_PROVIDER = /^custom-compatible-[a-f0-9]{24}$/u;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const REGISTRY_PAGE_SIZE = 100;
const REGISTRY_MAX_PAGES = 4;
const REGISTRY_MAX_BYTES = 262_144;
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

/** SDK 7.3 V4PagePaginationArray advances the requested page until an empty result.
 * Verify uniqueness across that complete scan, within one byte/deadline/page budget.
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
    const controller = new AbortController();
    const abort = () => controller.abort();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectInterrupted!: (error: ResearchModelCatalogError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const interrupt = () => {
      void activeReader?.cancel().catch(() => undefined);
      rejectInterrupted(signal.aborted
        ? new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled")
        : unavailable("registered provider metadata deadline elapsed", true));
    };
    controller.signal.addEventListener("abort", interrupt, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 5_000);
    let totalBytes = 0;
    let totalRows = 0;
    let declaredTotal: number | undefined;
    let match: Record<string, unknown> | undefined;
    const seen = new Set<string>();
    try {
      for (let page = 1; page <= REGISTRY_MAX_PAGES; page++) {
        const url = `https://api.cloudflare.com/client/v4/accounts/${options.account_id}/ai-gateway/custom-providers?page=${page}&per_page=${REGISTRY_PAGE_SIZE}`;
        const fetching = (options.fetcher ?? globalThis.fetch)(url, { method: "GET", redirect: "manual",
          cache: "no-store", credentials: "omit", signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
        void fetching.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
        const response = await Promise.race([fetching, interrupted]);
        const contentLength = response.headers.get("content-length");
        const codings = response.headers.get("content-encoding")?.split(",").map(value => value.trim().toLowerCase());
        const identityRepresentation = codings === undefined || codings.every(value => value === "identity");
        // Fetch exposes decoded bytes for known content codings, while Content-Length can still
        // describe the compressed wire representation. Only identity lengths are comparable.
        if (response.status !== 200 || response.redirected || (response.url !== "" && response.url !== url) ||
            response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || response.body === null ||
            codings?.some(value => !["identity", "gzip", "br", "deflate"].includes(value)) ||
            (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) ||
              (identityRepresentation && Number(contentLength) > REGISTRY_MAX_BYTES - totalBytes)))) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable("registered provider metadata is unavailable or oversized", true);
        }
        const reader = response.body.getReader();
        activeReader = reader;
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const item = await Promise.race([reader.read(), interrupted]);
            if (item.done) break;
            length += item.value.byteLength;
            totalBytes += item.value.byteLength;
            if (totalBytes > REGISTRY_MAX_BYTES || controller.signal.aborted) {
              throw unavailable("registered provider metadata exceeded its global byte budget", true);
            }
            chunks.push(item.value);
          }
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock(); activeReader = undefined;
        }
        if (identityRepresentation && contentLength !== null && Number(contentLength) !== length) {
          throw unavailable("registered provider metadata body is truncated", true);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (controller.signal.aborted || !record(body) || body.success !== true || !Array.isArray(body.result) || body.result.length > REGISTRY_PAGE_SIZE) {
          throw unavailable("registered provider metadata is incomplete", true);
        }
        const info = body.result_info;
        if (info !== undefined) {
          if (!record(info) || (info.page !== undefined && info.page !== page) ||
              (info.per_page !== undefined && (!Number.isSafeInteger(info.per_page) || (info.per_page as number) < body.result.length ||
                (info.per_page as number) < 1 || (info.per_page as number) > REGISTRY_PAGE_SIZE)) ||
              (info.count !== undefined && info.count !== body.result.length)) throw unavailable("registered provider pagination is inconsistent", true);
          if (info.total_count !== undefined) {
            if (!Number.isSafeInteger(info.total_count) || (info.total_count as number) < 0 ||
                (declaredTotal !== undefined && info.total_count !== declaredTotal)) throw unavailable("registered provider total is inconsistent", true);
            declaredTotal = info.total_count as number;
          }
        }
        for (const entry of body.result as unknown[]) {
          if (!record(entry) || typeof entry.slug !== "string" || entry.slug.length === 0) throw unavailable("registered provider identity is malformed", true);
          if (seen.has(entry.slug)) {
            if (entry.slug === slug) return null;
            throw unavailable("registered provider pagination repeats an identity", true);
          }
          seen.add(entry.slug);
          if (entry.slug === slug) match = entry;
        }
        totalRows += body.result.length;
        if (declaredTotal !== undefined && totalRows > declaredTotal) throw unavailable("registered provider total is inconsistent", true);
        if (body.result.length === 0) {
          if (declaredTotal !== undefined && totalRows !== declaredTotal) throw unavailable("registered provider metadata is truncated", true);
          return match?.enable === true && typeof match.base_url === "string" ? Object.freeze({ slug, base_url: match.base_url }) : null;
        }
      }
      throw unavailable("registered provider pagination exceeded its page budget without exhaustion", true);
    } catch (cause) {
      if (signal.aborted) throw new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled");
      if (cause instanceof ResearchModelCatalogError) throw cause;
      throw unavailable("registered provider metadata is unavailable", true, cause);
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", interrupt);
    }
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
