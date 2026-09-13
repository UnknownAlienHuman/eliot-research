import {
  canonicalModelGatewayJson,
  decodeDynamicRouteRestBinding,
  dynamicRouteRestBindingSha256,
  DynamicRouteRestError,
  type DynamicRouteRestBinding,
  type DynamicRouteRestBindingStorePort,
  type DynamicRouteRestBindingWriteReceipt,
} from "@eliotr/cloudflare-ai";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BINDING_BYTES = 256 * 1024;
const SELECT = "provider_route_id,binding_sha256,binding_json";

interface DynamicRouteRestBindingRow {
  readonly provider_route_id: unknown;
  readonly binding_sha256: unknown;
  readonly binding_json: unknown;
}

interface StoredBinding {
  readonly binding: DynamicRouteRestBinding;
  readonly json: string;
  readonly sha256: string;
}

function failure(
  code: "DYNAMIC_ROUTE_REST_INPUT_INVALID" | "DYNAMIC_ROUTE_REST_BINDING_FAILED" | "DYNAMIC_ROUTE_REST_BINDING_CONFLICT",
  message: string,
  options: { readonly retryable?: boolean; readonly ambiguous_effect?: "NONE" | "BINDING_WRITE" } = {},
): never {
  throw new DynamicRouteRestError(code, message, options);
}

function routeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    failure("DYNAMIC_ROUTE_REST_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    failure("DYNAMIC_ROUTE_REST_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function assertDatabase(database: D1Database): void {
  if (database === null || typeof database !== "object" || typeof database.prepare !== "function") {
    failure("DYNAMIC_ROUTE_REST_INPUT_INVALID", "Dynamic Route binding database is invalid");
  }
}

async function canonicalBinding(raw: unknown): Promise<StoredBinding> {
  let binding: DynamicRouteRestBinding;
  try {
    binding = decodeDynamicRouteRestBinding(raw);
  } catch (error) {
    if (error instanceof DynamicRouteRestError) throw error;
    failure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", "Dynamic Route binding is malformed");
  }
  const json = canonicalModelGatewayJson(binding);
  if (new TextEncoder().encode(json).byteLength > MAX_BINDING_BYTES) {
    failure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", "Dynamic Route binding exceeds its byte bound");
  }
  const digest = await dynamicRouteRestBindingSha256(binding);
  return Object.freeze({ binding, json, sha256: digest });
}

async function decodeStoredRow(row: DynamicRouteRestBindingRow): Promise<StoredBinding> {
  if (typeof row.provider_route_id !== "string" ||
      typeof row.binding_sha256 !== "string" ||
      typeof row.binding_json !== "string" ||
      row.binding_json.length === 0) {
    failure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", "Stored Dynamic Route binding is malformed");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.binding_json) as unknown;
  } catch {
    failure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", "Stored Dynamic Route binding JSON is invalid");
  }
  const stored = await canonicalBinding(raw);
  if (row.provider_route_id !== stored.binding.provider_route_id ||
      row.binding_sha256 !== stored.sha256 || row.binding_json !== stored.json) {
    failure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", "Stored Dynamic Route binding readback differs from its digest");
  }
  return stored;
}

async function readRow(database: D1Database, providerRouteId: string): Promise<DynamicRouteRestBindingRow | null> {
  return database.prepare(
    `SELECT ${SELECT} FROM dynamic_route_rest_binding WHERE provider_route_id=?1 LIMIT 1`,
  ).bind(providerRouteId).first<DynamicRouteRestBindingRow>();
}

function receipt(stored: StoredBinding): DynamicRouteRestBindingWriteReceipt {
  return Object.freeze({ binding: stored.binding, readback_sha256: stored.sha256 });
}

/** Durable immutable D1 backing for the Cloudflare Dynamic Route binding port. */
export function createD1DynamicRouteRestBindingStore(
  database: D1Database,
): DynamicRouteRestBindingStorePort {
  assertDatabase(database);

  return Object.freeze({
    async get(providerRouteId: string): Promise<unknown | null> {
      const route = routeId(providerRouteId, "requested provider route ID");
      let row: DynamicRouteRestBindingRow | null;
      try {
        row = await readRow(database, route);
      } catch {
        failure("DYNAMIC_ROUTE_REST_BINDING_FAILED", "Dynamic Route binding read failed", { retryable: true });
      }
      if (row === null) return null;
      const stored = await decodeStoredRow(row);
      return stored.binding;
    },

    async putImmutable(
      rawBinding: DynamicRouteRestBinding,
      expectedSha256: string,
    ): Promise<unknown> {
      const expected = sha256(expectedSha256, "expected binding digest");
      const requested = await canonicalBinding(rawBinding);
      if (requested.sha256 !== expected) {
        failure("DYNAMIC_ROUTE_REST_INPUT_INVALID", "expected binding digest differs from canonical binding");
      }
      const providerRouteId = requested.binding.provider_route_id;

      let existing: DynamicRouteRestBindingRow | null;
      try {
        existing = await readRow(database, providerRouteId);
      } catch {
        failure("DYNAMIC_ROUTE_REST_BINDING_FAILED", "Dynamic Route binding read failed", { retryable: true });
      }
      if (existing !== null) {
        const stored = await decodeStoredRow(existing);
        if (stored.sha256 !== expected || stored.json !== requested.json) {
          failure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", "provider route ID is bound to different bytes");
        }
        return receipt(stored);
      }

      let inserted: DynamicRouteRestBindingRow | null = null;
      let writeFailed = false;
      try {
        inserted = await database.prepare(
          `INSERT INTO dynamic_route_rest_binding(${SELECT}) VALUES (?1,?2,?3) ` +
          `ON CONFLICT(provider_route_id) DO NOTHING RETURNING ${SELECT}`,
        ).bind(providerRouteId, expected, requested.json).first<DynamicRouteRestBindingRow>();
      } catch {
        writeFailed = true;
      }

      let observed: DynamicRouteRestBindingRow | null;
      try {
        observed = inserted ?? await readRow(database, providerRouteId);
      } catch {
        failure("DYNAMIC_ROUTE_REST_BINDING_FAILED", "Dynamic Route binding write readback failed", {
          retryable: true,
          ambiguous_effect: "BINDING_WRITE",
        });
      }
      if (observed === null) {
        failure("DYNAMIC_ROUTE_REST_BINDING_FAILED", writeFailed
          ? "Dynamic Route binding write outcome is uncertain"
          : "Dynamic Route binding write readback is missing", {
            retryable: true,
            ambiguous_effect: "BINDING_WRITE",
          });
      }
      const stored = await decodeStoredRow(observed);
      if (stored.sha256 !== expected || stored.json !== requested.json) {
        failure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", "Dynamic Route binding write readback differs from requested bytes");
      }
      return receipt(stored);
    },
  });
}
