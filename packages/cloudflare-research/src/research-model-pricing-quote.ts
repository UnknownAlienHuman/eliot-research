import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  ModelGatewayExecutionError,
  type ModelGatewayPricingPort,
  type ModelGatewayPricingQuote,
  type ModelGatewayPricingQuoteInput,
} from "@eliotr/cloudflare-ai";
import {
  decodeModelRouteDeployment,
  type ModelRouteDeployment,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";
import {
  createD1ResearchModelPricingSnapshotStore,
  ResearchModelPricingError,
  type ResearchModelPricingSnapshot,
  type ResearchModelPricingSnapshotIdentity,
} from "./research-model-pricing-store.js";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RATE = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,12})?$/u;
const QUOTE_INPUT_KEYS = new Set([
  "fingerprint",
  "pricing_snapshot_ref",
  "input_tokens",
  "output_tokens",
]);
const FINGERPRINT_KEYS = new Set([
  "route_ref",
  "route_version",
  "prompt_generation",
  "schema_generation",
  "parameters_digest",
  "pricing_snapshot_ref",
  "provider",
  "exact_model_id",
]);

export interface ResearchModelPricingQuotePortOptions {
  /** Validated server clock used for effective/expiry checks. */
  readonly now?: () => number;
}

interface DecimalRate {
  readonly units: bigint;
  readonly scale: number;
}

function pricingFailure(
  message: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_PRICING_FAILED", message, options);
}

function exactObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    pricingFailure(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) pricingFailure(`${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key)) pricingFailure(`${label} contains unsupported fields`);
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) pricingFailure(`${label} is invalid`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) pricingFailure(`${label} is invalid`);
  return value;
}

function snapshotFingerprint(value: unknown): RouteFingerprint {
  const record = exactObject(value, FINGERPRINT_KEYS, "route fingerprint");
  let deployment: ModelRouteDeployment;
  try {
    deployment = decodeModelRouteDeployment({
      route_ref: record.route_ref,
      route_version: record.route_version,
      prompt_generation: record.prompt_generation,
      schema_generation: record.schema_generation,
      parameters_digest: record.parameters_digest,
      pricing_snapshot_ref: record.pricing_snapshot_ref,
    });
  } catch (cause) {
    pricingFailure("route fingerprint deployment is invalid", { cause });
  }
  return Object.freeze({
    ...deployment,
    provider: identifier(record.provider, "route fingerprint provider"),
    exact_model_id: identifier(record.exact_model_id, "route fingerprint model"),
  });
}

function quoteInput(value: ModelGatewayPricingQuoteInput): {
  readonly fingerprint: RouteFingerprint;
  readonly pricing_snapshot_ref: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
} {
  const record = exactObject(value, QUOTE_INPUT_KEYS, "model pricing quote input");
  const fingerprint = snapshotFingerprint(record.fingerprint);
  const snapshotRef = identifier(record.pricing_snapshot_ref, "pricing snapshot reference");
  if (snapshotRef !== fingerprint.pricing_snapshot_ref) {
    pricingFailure("pricing snapshot reference does not match the route fingerprint");
  }
  const counts: number[] = [];
  for (const [raw, label] of [
    [record.input_tokens, "input token count"],
    [record.output_tokens, "output token count"],
  ] as const) {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      pricingFailure(`${label} must be a nonnegative safe integer`);
    }
    counts.push(raw);
  }
  const inputTokens = counts[0];
  const outputTokens = counts[1];
  if (inputTokens === undefined || outputTokens === undefined) pricingFailure("token counts are missing");
  return Object.freeze({
    fingerprint,
    pricing_snapshot_ref: snapshotRef,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
}

function parseRate(value: string, label: string): DecimalRate {
  if (!RATE.test(value)) pricingFailure(`${label} is not an exact decimal token rate`);
  const dot = value.indexOf(".");
  const whole = dot < 0 ? value : value.slice(0, dot);
  const fraction = dot < 0 ? "" : value.slice(dot + 1);
  return Object.freeze({ units: BigInt(`${whole}${fraction}`), scale: fraction.length });
}

function decimalCost(
  inputRateText: string,
  outputRateText: string,
  inputTokens: number,
  outputTokens: number,
): DecimalRate {
  const inputRate = parseRate(inputRateText, "input token rate");
  const outputRate = parseRate(outputRateText, "output token rate");
  const scale = Math.max(inputRate.scale, outputRate.scale);
  const inputUnits = inputRate.units * 10n ** BigInt(scale - inputRate.scale);
  const outputUnits = outputRate.units * 10n ** BigInt(scale - outputRate.scale);
  return Object.freeze({
    // Rates are USD per 1,000 tokens; shifting the exact integer by three
    // decimal places avoids a floating-point multiply or divide.
    units: inputUnits * BigInt(inputTokens) + outputUnits * BigInt(outputTokens),
    scale: scale + 3,
  });
}

function decimalNumber(value: DecimalRate): number {
  const digits = value.units.toString();
  const integer = value.scale === 0 || digits.length > value.scale
    ? digits.slice(0, Math.max(1, digits.length - value.scale))
    : "0";
  const fraction = value.scale === 0
    ? ""
    : digits.padStart(value.scale + 1, "0").slice(-value.scale);
  const result = Number(fraction.length === 0 ? integer : `${integer}.${fraction}`);
  if (!Number.isFinite(result) || result < 0) pricingFailure("calculated pricing estimate is not finite");
  return result;
}

function currentMilliseconds(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch (cause) {
    pricingFailure("pricing clock could not be read", { cause });
  }
  if (!Number.isSafeInteger(value)) pricingFailure("pricing clock is invalid");
  return value;
}

async function readSnapshot(
  store: ReturnType<typeof createD1ResearchModelPricingSnapshotStore>,
  identity: ResearchModelPricingSnapshotIdentity,
): Promise<ResearchModelPricingSnapshot> {
  let snapshot: ResearchModelPricingSnapshot | null;
  try {
    snapshot = await store.read(identity);
  } catch (cause) {
    const retryable = cause instanceof ResearchModelPricingError && cause.retryable;
    pricingFailure("pricing snapshot could not be read", { retryable, cause });
  }
  if (snapshot === null) pricingFailure("approved pricing snapshot is unavailable");
  return snapshot;
}

function assertCurrentSnapshot(snapshot: ResearchModelPricingSnapshot, nowMs: number): void {
  if (snapshot.pricing_basis !== "EXACT_TOKEN_RATES_V1" || snapshot.approval_receipt_ref.length === 0) {
    pricingFailure("pricing snapshot is not an approved exact-token snapshot");
  }
  const effectiveAt = Date.parse(snapshot.effective_at);
  const expiresAt = Date.parse(snapshot.expires_at);
  if (!Number.isFinite(effectiveAt) || !Number.isFinite(expiresAt) || effectiveAt > nowMs || expiresAt <= nowMs) {
    pricingFailure("pricing snapshot is not currently effective");
  }
}

async function quoteRef(
  snapshot: ResearchModelPricingSnapshot,
  fingerprint: RouteFingerprint,
  inputTokens: number,
  outputTokens: number,
): Promise<string> {
  const material = canonicalModelGatewayJson({
    protocol: "eliotr.research-model-pricing-quote.v1",
    snapshot_sha256: sha256(snapshot.snapshot_sha256, "pricing snapshot digest"),
    fingerprint,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
  const digest = await modelGatewaySha256(material);
  return `model-pricing-quote-${digest}`;
}

/** Reads an exact approved D1 snapshot and prices observed token counts. */
export function createD1ResearchModelPricingQuotePort(
  database: D1Database,
  options: ResearchModelPricingQuotePortOptions = {},
): ModelGatewayPricingPort {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      (options.now !== undefined && typeof options.now !== "function")) {
    pricingFailure("pricing quote port options are invalid");
  }
  let store: ReturnType<typeof createD1ResearchModelPricingSnapshotStore>;
  try {
    store = createD1ResearchModelPricingSnapshotStore(database);
  } catch (cause) {
    pricingFailure("pricing snapshot store is unavailable", { cause });
  }
  const now = options.now ?? (() => Date.now());
  return Object.freeze({
    async quote(rawInput: ModelGatewayPricingQuoteInput): Promise<ModelGatewayPricingQuote> {
      const input = quoteInput(rawInput);
      const identity: ResearchModelPricingSnapshotIdentity = {
        pricing_snapshot_ref: input.pricing_snapshot_ref,
        route_ref: input.fingerprint.route_ref,
        route_version: input.fingerprint.route_version,
        provider: input.fingerprint.provider,
        exact_model_id: input.fingerprint.exact_model_id,
      };
      const snapshot = await readSnapshot(store, identity);
      assertCurrentSnapshot(snapshot, currentMilliseconds(now));
      const billed = decimalNumber(decimalCost(
        snapshot.input_rate_usd_per_1k_tokens,
        snapshot.output_rate_usd_per_1k_tokens,
        input.input_tokens,
        input.output_tokens,
      ));
      const ref = await quoteRef(snapshot, input.fingerprint, input.input_tokens, input.output_tokens);
      return Object.freeze({
        quote_ref: ref,
        pricing_snapshot_ref: input.pricing_snapshot_ref,
        billed_usd: billed,
      });
    },
  });
}
