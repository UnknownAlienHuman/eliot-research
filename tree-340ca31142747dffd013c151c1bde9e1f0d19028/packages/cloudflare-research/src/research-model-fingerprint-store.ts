import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  type ModelGatewayFingerprintStorePort,
} from "@eliotr/cloudflare-ai";
import {
  decodeModelRouteDeployment,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const FINGERPRINT_KEYS = new Set([
  "exact_model_id",
  "parameters_digest",
  "pricing_snapshot_ref",
  "prompt_generation",
  "provider",
  "route_ref",
  "route_version",
  "schema_generation",
]);

export type ResearchModelFingerprintErrorCode =
  | "MODEL_FINGERPRINT_INPUT_INVALID"
  | "MODEL_FINGERPRINT_PERSISTENCE_UNCERTAIN"
  | "MODEL_FINGERPRINT_READBACK_CORRUPT";

export class ResearchModelFingerprintError extends Error {
  public readonly code: ResearchModelFingerprintErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ResearchModelFingerprintErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchModelFingerprintError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ResearchModelFingerprintStoreOptions {
  readonly now?: () => string;
}

interface FingerprintRow {
  readonly observation_seq: unknown;
  readonly fingerprint_ref: unknown;
  readonly route_ref: unknown;
  readonly fingerprint_sha256: unknown;
  readonly fingerprint_json: unknown;
  readonly observed_at: unknown;
}

function fail(
  code: ResearchModelFingerprintErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchModelFingerprintError(code, message, retryable, cause);
}

function identifier(
  value: unknown,
  label: string,
  code: ResearchModelFingerprintErrorCode = "MODEL_FINGERPRINT_INPUT_INVALID",
): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function digest(
  value: unknown,
  label: string,
  code: ResearchModelFingerprintErrorCode = "MODEL_FINGERPRINT_INPUT_INVALID",
): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(code, `${label} is invalid`);
  }
  return value;
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MODEL_FINGERPRINT_INPUT_INVALID", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("MODEL_FINGERPRINT_INPUT_INVALID", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FINGERPRINT_KEYS.has(key)) {
      fail("MODEL_FINGERPRINT_INPUT_INVALID", `${label} contains unsupported field ${key}`);
    }
  }
  return record;
}

function decodeFingerprint(value: unknown, code: ResearchModelFingerprintErrorCode): RouteFingerprint {
  let record: Record<string, unknown>;
  try {
    record = exactObject(value, "route fingerprint");
  } catch (cause) {
    if (cause instanceof ResearchModelFingerprintError && cause.code === "MODEL_FINGERPRINT_INPUT_INVALID") {
      fail(code, cause.message, cause.retryable, cause);
    }
    throw cause;
  }
  let deployment: ReturnType<typeof decodeModelRouteDeployment>;
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
    fail(code, "route fingerprint deployment is invalid", false, cause);
  }
  const provider = identifier(record.provider, "route fingerprint provider", code);
  const exactModelId = identifier(record.exact_model_id, "route fingerprint model", code);
  return Object.freeze({ ...deployment, provider, exact_model_id: exactModelId });
}

function canonicalFingerprint(value: unknown, code: ResearchModelFingerprintErrorCode): { readonly fingerprint: RouteFingerprint; readonly json: string } {
  const fingerprint = decodeFingerprint(value, code);
  return Object.freeze({ fingerprint, json: canonicalModelGatewayJson(fingerprint) });
}

function timestamp(
  value: string,
  label: string,
  code: ResearchModelFingerprintErrorCode = "MODEL_FINGERPRINT_INPUT_INVALID",
): string {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(code, `${label} is not canonical ISO-8601`);
  }
  return value;
}

function fingerprintRef(sha256: string): string {
  return `route-fingerprint-${sha256}`;
}

async function rowValue(row: FingerprintRow, code: ResearchModelFingerprintErrorCode): Promise<{ readonly fingerprint: RouteFingerprint; readonly sha256: string; readonly json: string; readonly ref: string }> {
  const ref = identifier(row.fingerprint_ref, "stored fingerprint reference", code);
  const routeRef = identifier(row.route_ref, "stored fingerprint route", code);
  const sha256 = digest(row.fingerprint_sha256, "stored fingerprint digest", code);
  if (typeof row.observation_seq !== "number" || !Number.isSafeInteger(row.observation_seq) || row.observation_seq < 1) {
    fail(code, "stored fingerprint observation sequence is invalid");
  }
  if (typeof row.observed_at !== "string") fail(code, "stored fingerprint observation time is invalid");
  timestamp(row.observed_at, "stored fingerprint observed_at", code);
  if (typeof row.fingerprint_json !== "string" || row.fingerprint_json.length === 0) {
    fail(code, "stored fingerprint JSON is invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.fingerprint_json); } catch (cause) { fail(code, "stored fingerprint JSON cannot be parsed", false, cause); }
  const canonical = canonicalFingerprint(parsed, code);
  const recomputed = await modelGatewaySha256(canonical.json);
  if (canonical.json !== row.fingerprint_json || recomputed !== sha256 || canonical.fingerprint.route_ref !== routeRef) {
    fail(code, "stored fingerprint JSON is not canonical or route-bound");
  }
  if (ref !== fingerprintRef(sha256)) fail(code, "stored fingerprint reference is not deterministic");
  return { fingerprint: canonical.fingerprint, sha256, json: canonical.json, ref };
}

export function createD1ModelGatewayFingerprintStore(
  database: D1Database,
  options: ResearchModelFingerprintStoreOptions = {},
): ModelGatewayFingerprintStorePort {
  if (typeof database !== "object" || database === null || typeof database.prepare !== "function") {
    fail("MODEL_FINGERPRINT_INPUT_INVALID", "model fingerprint database binding is invalid");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const select = "observation_seq, fingerprint_ref, route_ref, fingerprint_sha256, fingerprint_json, observed_at";

  async function read(ref: string): Promise<FingerprintRow | null> {
    return database.prepare(`SELECT ${select} FROM research_model_fingerprint WHERE fingerprint_ref=?1 LIMIT 1`).bind(ref).first<FingerprintRow>();
  }

  function verifyExpected(expectedSha256: string, json: string): Promise<string> {
    const expected = digest(expectedSha256, "expected fingerprint digest");
    return modelGatewaySha256(json).then((computed) => {
      if (computed !== expected) fail("MODEL_FINGERPRINT_INPUT_INVALID", "expected fingerprint digest differs from canonical fingerprint");
      return expected;
    });
  }

  return Object.freeze({
    async putImmutable(rawFingerprint: RouteFingerprint, expectedSha256: string): Promise<unknown> {
      const canonical = canonicalFingerprint(rawFingerprint, "MODEL_FINGERPRINT_INPUT_INVALID");
      const expected = await verifyExpected(expectedSha256, canonical.json);
      const ref = fingerprintRef(expected);
      const existing = await read(ref);
      if (existing !== null) {
        const observed = await rowValue(existing, "MODEL_FINGERPRINT_READBACK_CORRUPT");
        if (observed.sha256 !== expected || observed.json !== canonical.json) fail("MODEL_FINGERPRINT_INPUT_INVALID", "fingerprint reference is bound to different bytes");
        return Object.freeze({ fingerprint_ref: ref, readback_sha256: observed.sha256 });
      }
      let inserted: FingerprintRow | null = null;
      let writeError: unknown;
      try {
        inserted = await database.prepare(
          `INSERT INTO research_model_fingerprint(fingerprint_ref, route_ref, fingerprint_sha256, fingerprint_json, observed_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(fingerprint_ref) DO NOTHING RETURNING ${select}`,
        ).bind(ref, canonical.fingerprint.route_ref, expected, canonical.json, timestamp(now(), "fingerprint observed_at")).first<FingerprintRow>();
      } catch (cause) {
        writeError = cause;
      }
      let observed: FingerprintRow | null;
      try {
        observed = inserted ?? await read(ref);
      } catch (cause) {
        fail(
          "MODEL_FINGERPRINT_PERSISTENCE_UNCERTAIN",
          "fingerprint write readback is uncertain",
          true,
          { write_error: writeError, readback_error: cause },
        );
      }
      if (observed === null) {
        fail(
          "MODEL_FINGERPRINT_PERSISTENCE_UNCERTAIN",
          "fingerprint write readback is missing",
          true,
          writeError,
        );
      }
      const readback = await rowValue(observed, "MODEL_FINGERPRINT_READBACK_CORRUPT");
      if (readback.ref !== ref || readback.sha256 !== expected || readback.json !== canonical.json) {
        fail(
          "MODEL_FINGERPRINT_PERSISTENCE_UNCERTAIN",
          "fingerprint write readback differs from requested bytes",
          true,
          writeError,
        );
      }
      return Object.freeze({ fingerprint_ref: ref, readback_sha256: readback.sha256 });
    },

    async getLatest(routeRef: string): Promise<unknown | null> {
      const requested = identifier(routeRef, "requested fingerprint route");
      const row = await database.prepare(
        `SELECT ${select} FROM research_model_fingerprint WHERE route_ref=?1 ORDER BY observation_seq DESC LIMIT 1`,
      ).bind(requested).first<FingerprintRow>();
      if (row === null) return null;
      const readback = await rowValue(row, "MODEL_FINGERPRINT_READBACK_CORRUPT");
      if (readback.fingerprint.route_ref !== requested) fail("MODEL_FINGERPRINT_READBACK_CORRUPT", "latest fingerprint route binding differs from request");
      return readback.fingerprint;
    },
  });
}
