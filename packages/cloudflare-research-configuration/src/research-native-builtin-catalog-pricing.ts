import { canonicalModelGatewayJson, modelGatewaySha256, type ModelGatewayRequestCapabilitiesV1 } from "@eliotr/cloudflare-ai";
import { createD1ResearchModelPricingSnapshotStore, type ResearchModelCatalogEntry,
  type ResearchModelPricingSnapshot } from "@eliotr/cloudflare-model-control";
import type { ResearchCatalogModelUseAuthorizationRow } from "./research-catalog-model-use-store.js";

type Operation = ResearchCatalogModelUseAuthorizationRow;

export class NativeBuiltinCatalogPricingError extends Error {
  public constructor(public readonly code: "PRICING_NOT_PROVEN" | "AUTHORITY_CHANGED", message: string) {
    super(message); this.name = "NativeBuiltinCatalogPricingError";
  }
}

/** Exact decimal division; no binary floating-point price arithmetic or inferred free tier. */
function rate(raw: unknown, divideByThousand: boolean): string {
  if (typeof raw !== "string" && typeof raw !== "number") throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native token price is absent");
  const value = String(raw);
  if (!/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,9})?$/u.test(value)) {
    throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native token price is not an exact bounded nonnegative decimal");
  }
  if (!divideByThousand) return value;
  const [whole = "0", fractional = ""] = value.split(".");
  const decimals = fractional.length + 3;
  const digits = `${whole}${fractional}`.padStart(decimals + 1, "0");
  const integer = digits.slice(0, -decimals).replace(/^0+(?=\d)/u, "");
  const fraction = digits.slice(-decimals).replace(/0+$/u, "");
  return fraction === "" ? integer : `${integer}.${fraction}`;
}

/** Cloudflare price properties remain advertisements until the real native probe succeeds.
 * Only explicit input/output token units are usable as USD token-rate observations.
 * Neurons, generic 'tokens', time, images, missing directions and extra charge dimensions fail closed.
 */
export function nativeBuiltinCatalogTokenRates(model: ResearchModelCatalogEntry): Readonly<{ input: string; output: string; cache_read: string | null }> {
  const properties = model.properties.filter(property => property.property_id === "price");
  const prices = properties[0]?.value;
  if (model.provider_id !== "cloudflare-workers-ai" || properties.length !== 1 || !Array.isArray(prices) || prices.length < 2 || prices.length > 3) {
    throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native catalog needs exact input and output token prices");
  }
  const found = new Map<string, string>();
  for (const raw of prices) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Invalid native catalog price");
    const price = raw as Record<string, unknown>;
    const unit = typeof price.unit === "string" ? price.unit.trim().toLowerCase().replace(/\s+/gu, " ") : "";
    const match = /^per (1m|m|1k|1,000|1,000,000) (input|output|cached input) tokens$/u.exec(unit);
    if (match === null || (price.currency !== undefined && price.currency !== "USD") ||
        Object.keys(price).some(key => !["unit", "price", "currency"].includes(key)) || found.has(match[2] ?? "")) {
      throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native catalog price units/currency are ambiguous or unsupported");
    }
    found.set(match[2] ?? "", rate(price.price, ["1m", "m", "1,000,000"].includes(match[1] ?? "")));
  }
  const input = found.get("input"), output = found.get("output");
  if (input === undefined || output === undefined) throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Both native token directions are required");
  return { input, output, cache_read: found.get("cached input") ?? null };
}

/** Native API metadata is an advertised request contract; only a successful exact probe qualifies it. */
export function nativeBuiltinCatalogRequestCapabilities(model: ResearchModelCatalogEntry): ModelGatewayRequestCapabilitiesV1 {
  const property = model.properties.filter(item => item.property_id === "reasoning_effort");
  if (property.length === 0) return { max_output_tokens_field: "max_tokens", reasoning_efforts: [] };
  const value = property[0]?.value;
  if (property.length !== 1 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native reasoning metadata is invalid");
  }
  const metadata = value as Record<string, unknown>;
  const supported = metadata.supported_efforts;
  const admitted = ["low", "medium", "high", "max"] as const;
  type Effort = typeof admitted[number];
  if (!Array.isArray(supported) || supported.some(effort => !admitted.includes(effort)) || new Set(supported).size !== supported.length) {
    throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native supported reasoning efforts are invalid");
  }
  const normalizations: Partial<Record<Effort, Effort>> = {};
  const mapping = metadata.normalizes_to;
  if (mapping !== undefined) {
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native reasoning mappings are invalid");
    for (const [from, to] of Object.entries(mapping)) {
      // Other native aliases (none/minimal/xhigh/null) cannot enter the strict application schema.
      if (admitted.includes(from as Effort)) {
        if (!supported.includes(to)) throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native reasoning mapping target is unsupported");
        normalizations[from as Effort] = to as Effort;
      }
    }
  }
  return { max_output_tokens_field: "max_tokens", reasoning_efforts: supported as Effort[],
    ...(Object.keys(normalizations).length === 0 ? {} : { reasoning_effort_normalizations: normalizations }) };
}

/** Persist verified native catalog rates under the existing durable owner check/use authorization.
 * The approval reference identifies that real operation; it is not a synthesized upstream receipt.
 */
export function createResearchNativeBuiltinCatalogPricing(input: {
  readonly database: D1Database;
  readonly read_current_authority: (operation: Operation) => Promise<Operation | null>;
  readonly read_advertised_model: (modelId: string) => Promise<ResearchModelCatalogEntry | null>;
  readonly now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const store = createD1ResearchModelPricingSnapshotStore(input.database, { now });
  return Object.freeze({
    async ensure(operation: Operation, routes: readonly { route_ref: string; route_version: string }[], expiresAt: string): Promise<readonly ResearchModelPricingSnapshot[]> {
      const authority = await input.read_current_authority(operation);
      if (authority === null || canonicalModelGatewayJson(authority) !== canonicalModelGatewayJson(operation) ||
          operation.provider_id !== "cloudflare-workers-ai" || operation.provider_operation_id !== null ||
          !["PREPARING", "QUALIFYING", "IMPORTING"].includes(operation.state)) {
        throw new NativeBuiltinCatalogPricingError("AUTHORITY_CHANGED", "Native price approval needs the current durable owner operation");
      }
      const model = await input.read_advertised_model(operation.model_id);
      if (model === null || model.model_id !== operation.model_id || model.capabilities.text_generation !== "supported") {
        throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Exact native catalog model is unavailable");
      }
      const rates = nativeBuiltinCatalogTokenRates(model);
      const sourceSha = await modelGatewaySha256(canonicalModelGatewayJson({ provider: model.provider_id, model_id: model.model_id,
        properties: model.properties.filter(property => property.property_id === "price") }));
      const observed = now();
      if (!Number.isSafeInteger(Date.parse(observed)) || !Number.isSafeInteger(Date.parse(expiresAt)) ||
          Date.parse(expiresAt) <= Date.parse(observed) || new Set(routes.map(route => `${route.route_ref}:${route.route_version}`)).size !== routes.length) {
        throw new NativeBuiltinCatalogPricingError("PRICING_NOT_PROVEN", "Native price interval or exact route set is invalid");
      }
      const after = await input.read_current_authority(operation);
      if (after === null || canonicalModelGatewayJson(after) !== canonicalModelGatewayJson(authority)) {
        throw new NativeBuiltinCatalogPricingError("AUTHORITY_CHANGED", "Native price authority changed during catalog read");
      }
      const snapshots: ResearchModelPricingSnapshot[] = [];
      for (const route of routes) {
        const snapshotSha = await modelGatewaySha256(canonicalModelGatewayJson({ operation_id: operation.operation_id,
          owner: operation.owner_id, project: operation.project_id, model: model.model_id, route, rates, source_sha256: sourceSha }));
        const identity = { ...route, provider: "workers-ai", exact_model_id: model.model_id, pricing_snapshot_ref: `native-price-${snapshotSha}` };
        const existing = await store.read(identity);
        if (existing !== null) { snapshots.push(existing); continue; }
        snapshots.push(await store.putImmutable({ identity, snapshot: { protocol: "eliotr.research-model-pricing.v1", ...identity,
          pricing_basis: "EXACT_TOKEN_RATES_V1", input_rate_usd_per_1k_tokens: rates.input,
          output_rate_usd_per_1k_tokens: rates.output, effective_at: observed, expires_at: expiresAt,
          provenance_ref: `cloudflare-native-catalog-${sourceSha}`, approval_receipt_ref: `catalog-model-use-${operation.operation_id}`,
          catalog_metadata: { protocol: "eliotr.native-builtin-catalog-pricing.v1", model_id: model.model_id,
            rates_usd_per_1k_tokens: rates, source_sha256: sourceSha, properties: model.properties,
            owner_ref: operation.owner_id, project_id: operation.project_id, operation_id: operation.operation_id } } }));
      }
      return snapshots;
    },
  });
}
