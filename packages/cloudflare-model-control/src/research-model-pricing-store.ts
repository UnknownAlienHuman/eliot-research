import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { canonicalJson } from "@eliotr/platform-cloudflare";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const WORKERS_AI_MODEL_ID = /^@cf\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;
const RATE = /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,12})?$/u;
const PRICING_BASIS = "EXACT_TOKEN_RATES_V1" as const;
const PRICING_PROTOCOL = "eliotr.research-model-pricing.v1" as const;
const MAX_JSON_BYTES = 65536;
const DOCUMENT_KEYS = new Set([
  "protocol",
  "pricing_snapshot_ref",
  "route_ref",
  "route_version",
  "provider",
  "exact_model_id",
  "pricing_basis",
  "input_rate_usd_per_1k_tokens",
  "output_rate_usd_per_1k_tokens",
  "effective_at",
  "expires_at",
  "provenance_ref",
  "approval_receipt_ref",
]);
const IDENTITY_KEYS = new Set([
  "pricing_snapshot_ref",
  "route_ref",
  "route_version",
  "provider",
  "exact_model_id",
]);
const PUT_INPUT_KEYS = new Set(["identity", "snapshot"]);

export type ResearchModelPricingBasis = typeof PRICING_BASIS;

/**
 * A server-owned pricing observation. The only admitted basis in this slice
 * is explicitly token based; Workers AI neuron observations are not tokens.
 * Rates are retained as decimal text and are not interpreted or multiplied by
 * this storage adapter.
 */
export interface ResearchModelPricingSnapshotDocument {
  readonly protocol: typeof PRICING_PROTOCOL;
  readonly pricing_snapshot_ref: string;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: string;
  readonly exact_model_id: string;
  readonly pricing_basis: ResearchModelPricingBasis;
  readonly input_rate_usd_per_1k_tokens: string;
  readonly output_rate_usd_per_1k_tokens: string;
  readonly effective_at: string;
  readonly expires_at: string;
  readonly provenance_ref: string;
  readonly approval_receipt_ref: string;
}

export interface ResearchModelPricingSnapshot extends ResearchModelPricingSnapshotDocument {
  readonly snapshot_sha256: string;
  readonly created_at: string;
}

export interface ResearchModelPricingSnapshotIdentity {
  readonly pricing_snapshot_ref: string;
  readonly route_ref: string;
  readonly route_version: string;
  readonly provider: string;
  readonly exact_model_id: string;
}

export interface PutResearchModelPricingSnapshotInput {
  /** Identity and contents are supplied by trusted server composition. */
  readonly identity: ResearchModelPricingSnapshotIdentity;
  readonly snapshot: ResearchModelPricingSnapshotDocument;
}

export interface ResearchModelPricingSnapshotStore {
  putImmutable(input: PutResearchModelPricingSnapshotInput): Promise<ResearchModelPricingSnapshot>;
  read(identity: ResearchModelPricingSnapshotIdentity): Promise<ResearchModelPricingSnapshot | null>;
}

export interface ResearchModelPricingSnapshotStoreOptions {
  readonly now?: () => string;
}

export type ResearchModelPricingErrorCode =
  | "MODEL_PRICING_INPUT_INVALID"
  | "MODEL_PRICING_IDENTITY_CONFLICT"
  | "MODEL_PRICING_PERSISTENCE_UNCERTAIN"
  | "MODEL_PRICING_READBACK_CORRUPT";

export class ResearchModelPricingError extends Error {
  public readonly code: ResearchModelPricingErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ResearchModelPricingErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchModelPricingError";
    this.code = code;
    this.retryable = retryable;
  }
}

interface PricingRow {
  readonly pricing_snapshot_ref: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly provider: unknown;
  readonly exact_model_id: unknown;
  readonly pricing_basis: unknown;
  readonly input_rate_usd_per_1k_tokens: unknown;
  readonly output_rate_usd_per_1k_tokens: unknown;
  readonly provenance_ref: unknown;
  readonly approval_receipt_ref: unknown;
  readonly effective_at: unknown;
  readonly expires_at: unknown;
  readonly snapshot_sha256: unknown;
  readonly snapshot_json: unknown;
  readonly created_at: unknown;
}

function fail(
  code: ResearchModelPricingErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchModelPricingError(code, message, retryable, cause);
}

function objectValue(value: unknown, label: string, code: ResearchModelPricingErrorCode, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) fail(code, `${label} contains unsupported fields`);
  }
  return record;
}

function identifier(value: unknown, label: string, code: ResearchModelPricingErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function exactModelId(value: unknown, label: string, code: ResearchModelPricingErrorCode): string {
  if (typeof value !== "string" || value.length > 256 || (!IDENTIFIER.test(value) && !WORKERS_AI_MODEL_ID.test(value))) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string, code: ResearchModelPricingErrorCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function canonicalIso(value: unknown, label: string, code: ResearchModelPricingErrorCode): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(code, `${label} is invalid`);
  const parsed = Date.parse(value);
  if (new Date(parsed).toISOString() !== value) fail(code, `${label} is not canonical ISO-8601`);
  return value;
}

function rate(value: unknown, label: string, code: ResearchModelPricingErrorCode): string {
  if (typeof value !== "string" || !RATE.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function decodeDocument(value: unknown, code: ResearchModelPricingErrorCode): ResearchModelPricingSnapshotDocument {
  const record = objectValue(value, "pricing snapshot", code, DOCUMENT_KEYS);
  if (record.protocol !== PRICING_PROTOCOL) fail(code, "pricing snapshot protocol is unsupported");
  if (record.pricing_basis !== PRICING_BASIS) fail(code, "pricing snapshot basis is unsupported");
  const effective = canonicalIso(record.effective_at, "pricing snapshot effective_at", code);
  const expires = canonicalIso(record.expires_at, "pricing snapshot expires_at", code);
  if (Date.parse(expires) <= Date.parse(effective)) fail(code, "pricing snapshot expiry must follow its effective date");
  return Object.freeze({
    protocol: PRICING_PROTOCOL,
    pricing_snapshot_ref: identifier(record.pricing_snapshot_ref, "pricing_snapshot_ref", code),
    route_ref: identifier(record.route_ref, "route_ref", code),
    route_version: identifier(record.route_version, "route_version", code),
    provider: identifier(record.provider, "provider", code),
    exact_model_id: exactModelId(record.exact_model_id, "exact_model_id", code),
    pricing_basis: PRICING_BASIS,
    input_rate_usd_per_1k_tokens: rate(record.input_rate_usd_per_1k_tokens, "input token rate", code),
    output_rate_usd_per_1k_tokens: rate(record.output_rate_usd_per_1k_tokens, "output token rate", code),
    effective_at: effective,
    expires_at: expires,
    provenance_ref: identifier(record.provenance_ref, "provenance_ref", code),
    approval_receipt_ref: identifier(record.approval_receipt_ref, "approval_receipt_ref", code),
  });
}

function decodeIdentity(value: unknown, code: ResearchModelPricingErrorCode): ResearchModelPricingSnapshotIdentity {
  const record = objectValue(value, "pricing snapshot identity", code, IDENTITY_KEYS);
  return Object.freeze({
    pricing_snapshot_ref: identifier(record.pricing_snapshot_ref, "pricing_snapshot_ref", code),
    route_ref: identifier(record.route_ref, "route_ref", code),
    route_version: identifier(record.route_version, "route_version", code),
    provider: identifier(record.provider, "provider", code),
    exact_model_id: exactModelId(record.exact_model_id, "exact_model_id", code),
  });
}

function sameIdentity(left: ResearchModelPricingSnapshotIdentity, right: ResearchModelPricingSnapshotDocument): boolean {
  return left.pricing_snapshot_ref === right.pricing_snapshot_ref &&
    left.route_ref === right.route_ref &&
    left.route_version === right.route_version &&
    left.provider === right.provider &&
    left.exact_model_id === right.exact_model_id;
}

function documentProjection(value: ResearchModelPricingSnapshotDocument): ResearchModelPricingSnapshotDocument {
  return {
    protocol: value.protocol,
    pricing_snapshot_ref: value.pricing_snapshot_ref,
    route_ref: value.route_ref,
    route_version: value.route_version,
    provider: value.provider,
    exact_model_id: value.exact_model_id,
    pricing_basis: value.pricing_basis,
    input_rate_usd_per_1k_tokens: value.input_rate_usd_per_1k_tokens,
    output_rate_usd_per_1k_tokens: value.output_rate_usd_per_1k_tokens,
    effective_at: value.effective_at,
    expires_at: value.expires_at,
    provenance_ref: value.provenance_ref,
    approval_receipt_ref: value.approval_receipt_ref,
  };
}

function sameSnapshot(left: ResearchModelPricingSnapshotDocument, right: ResearchModelPricingSnapshotDocument): boolean {
  return canonicalJson(documentProjection(left)) === canonicalJson(documentProjection(right));
}

function jsonText(value: unknown, label: string, code: ResearchModelPricingErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_JSON_BYTES) fail(code, `${label} is invalid`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail(code, `${label} is not JSON`, false, cause); }
  if (canonicalJson(parsed) !== value) fail(code, `${label} is not canonical JSON`);
  return value;
}

function selectColumns(): string {
  return "pricing_snapshot_ref,route_ref,route_version,provider,exact_model_id,pricing_basis,input_rate_usd_per_1k_tokens,output_rate_usd_per_1k_tokens,provenance_ref,approval_receipt_ref,effective_at,expires_at,snapshot_sha256,snapshot_json,created_at";
}

export function createD1ResearchModelPricingSnapshotStore(
  database: D1Database,
  options: ResearchModelPricingSnapshotStoreOptions = {},
): ResearchModelPricingSnapshotStore {
  if (typeof database !== "object" || database === null || typeof database.prepare !== "function") fail("MODEL_PRICING_INPUT_INVALID", "pricing snapshot database binding is invalid");
  const now = options.now ?? (() => new Date().toISOString());

  async function readRow(ref: string): Promise<PricingRow | null> {
    return database.prepare(`SELECT ${selectColumns()} FROM research_model_pricing_snapshot WHERE pricing_snapshot_ref=?1 LIMIT 1`).bind(ref).first<PricingRow>();
  }

  async function decodeRow(row: PricingRow): Promise<ResearchModelPricingSnapshot> {
    const snapshotJson = jsonText(row.snapshot_json, "stored pricing snapshot JSON", "MODEL_PRICING_READBACK_CORRUPT");
    let parsed: unknown;
    try { parsed = JSON.parse(snapshotJson); } catch (cause) { fail("MODEL_PRICING_READBACK_CORRUPT", "stored pricing snapshot JSON cannot be parsed", false, cause); }
    const document = decodeDocument(parsed, "MODEL_PRICING_READBACK_CORRUPT");
    const storedDigest = digest(row.snapshot_sha256, "stored pricing snapshot digest", "MODEL_PRICING_READBACK_CORRUPT");
    const computedDigest = await modelGatewaySha256(snapshotJson);
    if (computedDigest !== storedDigest) fail("MODEL_PRICING_READBACK_CORRUPT", "stored pricing snapshot digest differs from canonical bytes");
    const columns: readonly [unknown, unknown, string][] = [
      [row.pricing_snapshot_ref, document.pricing_snapshot_ref, "pricing_snapshot_ref"],
      [row.route_ref, document.route_ref, "route_ref"],
      [row.route_version, document.route_version, "route_version"],
      [row.provider, document.provider, "provider"],
      [row.exact_model_id, document.exact_model_id, "exact_model_id"],
      [row.pricing_basis, document.pricing_basis, "pricing_basis"],
      [row.input_rate_usd_per_1k_tokens, document.input_rate_usd_per_1k_tokens, "input rate"],
      [row.output_rate_usd_per_1k_tokens, document.output_rate_usd_per_1k_tokens, "output rate"],
      [row.provenance_ref, document.provenance_ref, "provenance_ref"],
      [row.approval_receipt_ref, document.approval_receipt_ref, "approval_receipt_ref"],
      [row.effective_at, document.effective_at, "effective_at"],
      [row.expires_at, document.expires_at, "expires_at"],
    ];
    for (const [stored, expected, label] of columns) if (stored !== expected) fail("MODEL_PRICING_READBACK_CORRUPT", `stored pricing ${label} binding differs from canonical snapshot`);
    const createdAt = canonicalIso(row.created_at, "stored pricing created_at", "MODEL_PRICING_READBACK_CORRUPT");
    if (canonicalJson(document) !== snapshotJson) fail("MODEL_PRICING_READBACK_CORRUPT", "stored pricing snapshot is not canonical");
    return Object.freeze({ ...document, snapshot_sha256: storedDigest, created_at: createdAt });
  }

  async function readExact(identity: ResearchModelPricingSnapshotIdentity): Promise<ResearchModelPricingSnapshot | null> {
    let row: PricingRow | null;
    try { row = await readRow(identity.pricing_snapshot_ref); } catch (cause) { fail("MODEL_PRICING_PERSISTENCE_UNCERTAIN", "pricing snapshot readback is unavailable", true, cause); }
    if (row === null) return null;
    const snapshot = await decodeRow(row);
    if (!sameIdentity(identity, snapshot)) fail("MODEL_PRICING_IDENTITY_CONFLICT", "pricing snapshot reference is bound to another route identity");
    return snapshot;
  }

  return Object.freeze({
    async putImmutable(input: PutResearchModelPricingSnapshotInput): Promise<ResearchModelPricingSnapshot> {
      const request = objectValue(input, "pricing snapshot write input", "MODEL_PRICING_INPUT_INVALID", PUT_INPUT_KEYS);
      const identity = decodeIdentity(request.identity, "MODEL_PRICING_INPUT_INVALID");
      const document = decodeDocument(request.snapshot, "MODEL_PRICING_INPUT_INVALID");
      if (!sameIdentity(identity, document)) fail("MODEL_PRICING_INPUT_INVALID", "pricing snapshot does not match its trusted route identity");
      const snapshotJson = canonicalJson(document);
      if (new TextEncoder().encode(snapshotJson).byteLength > MAX_JSON_BYTES) fail("MODEL_PRICING_INPUT_INVALID", "pricing snapshot exceeds its bound");
      const snapshotSha256 = await modelGatewaySha256(snapshotJson);
      const existing = await readExact(identity);
      if (existing !== null) {
        if (existing.snapshot_sha256 !== snapshotSha256 || !sameSnapshot(existing, document)) fail("MODEL_PRICING_IDENTITY_CONFLICT", "pricing snapshot reference is bound to different canonical bytes");
        return existing;
      }
      const createdAt = canonicalIso(now(), "pricing snapshot created_at", "MODEL_PRICING_INPUT_INVALID");
      let inserted: PricingRow | null = null;
      let writeError: unknown;
      try {
        inserted = await database.prepare(
          `INSERT INTO research_model_pricing_snapshot(${selectColumns()}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) ON CONFLICT(pricing_snapshot_ref) DO NOTHING RETURNING ${selectColumns()}`,
        ).bind(
          document.pricing_snapshot_ref, document.route_ref, document.route_version, document.provider, document.exact_model_id,
          document.pricing_basis, document.input_rate_usd_per_1k_tokens, document.output_rate_usd_per_1k_tokens,
          document.provenance_ref, document.approval_receipt_ref, document.effective_at, document.expires_at,
          snapshotSha256, snapshotJson, createdAt,
        ).first<PricingRow>();
      } catch (cause) { writeError = cause; }
      let observed: PricingRow | null;
      try { observed = inserted ?? await readRow(identity.pricing_snapshot_ref); } catch (cause) { fail("MODEL_PRICING_PERSISTENCE_UNCERTAIN", "pricing snapshot write readback is unavailable", true, { write_error: writeError, readback_error: cause }); }
      if (observed === null) fail("MODEL_PRICING_PERSISTENCE_UNCERTAIN", "pricing snapshot write readback is missing", true, writeError);
      const readback = await decodeRow(observed);
      if (!sameIdentity(identity, readback) || readback.snapshot_sha256 !== snapshotSha256 || !sameSnapshot(readback, document)) fail("MODEL_PRICING_IDENTITY_CONFLICT", "pricing snapshot write readback differs from requested canonical bytes");
      return readback;
    },

    async read(rawIdentity: ResearchModelPricingSnapshotIdentity): Promise<ResearchModelPricingSnapshot | null> {
      const identity = decodeIdentity(rawIdentity, "MODEL_PRICING_INPUT_INVALID");
      return readExact(identity);
    },
  });
}
