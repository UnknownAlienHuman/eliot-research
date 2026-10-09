import { createHash } from "node:crypto";
import { readDeploymentJson } from "./deployment-verification.mjs";

export const DEPLOYMENT_SCHEMA_CATALOGUE_PROTOCOL = "eliotr.cloudflare-d1.application-schema-catalogue.v1";
export const DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL = "eliotr.cloudflare-d1.application-schema-manifest.v1";
export const DEPLOYMENT_SCHEMA_ATTESTATION_PROTOCOL = "eliotr.cloudflare-d1.application-schema-attestation.v1";
export const DEPLOYMENT_SCHEMA_SCOPE = "application_schema";
export const DEPLOYMENT_SCHEMA_EXCLUSIONS = Object.freeze([
  "SQLite internal schema objects whose names begin with sqlite_ (including automatic indexes)",
  "Cloudflare D1 system migration ledger object named d1_migrations (ASCII case-insensitive)",
]);

const BINDINGS = Object.freeze([
  Object.freeze({ binding: "CORE_DB", database_name: "eliotr-core" }),
  Object.freeze({ binding: "SEARCH_DB", database_name: "eliotr-search" }),
]);
const OBJECT_TYPES = new Set(["table", "index", "view", "trigger"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_OBJECTS = 20_000;
const MAX_OBJECT_NAME_LENGTH = 1_024;
const MAX_SQL_LENGTH = 2 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const fail = (reason) => { throw new Error(`Deployment schema attestation rejected: ${reason}`); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function compareString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function asciiCaseFold(value) {
  return value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

function isExcludedObjectName(name) {
  return name.startsWith("sqlite_") || asciiCaseFold(name) === "d1_migrations";
}

function normalizeSchemaObjects(objects) {
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS) fail("invalid or oversized schema catalogue");
  const normalized = [];
  const identities = new Set();
  for (const object of objects) {
    if (!exactKeys(object, ["type", "name", "tbl_name", "sql"]) ||
        !OBJECT_TYPES.has(object.type) || typeof object.name !== "string" || object.name.length < 1 ||
        object.name.length > MAX_OBJECT_NAME_LENGTH || typeof object.tbl_name !== "string" ||
        object.tbl_name.length < 1 || object.tbl_name.length > MAX_OBJECT_NAME_LENGTH ||
        typeof object.sql !== "string" || object.sql.length < 1 || object.sql.length > MAX_SQL_LENGTH ||
        isExcludedObjectName(object.name)) {
      fail("malformed schema object");
    }
    // SQLite object names use ASCII case-insensitive identity within each type.
    const identity = `${object.type}\u0000${asciiCaseFold(object.name)}`;
    if (identities.has(identity)) fail("duplicate schema object identity");
    identities.add(identity);
    normalized.push({ type: object.type, name: object.name, tbl_name: object.tbl_name, sql: object.sql });
  }
  normalized.sort((left, right) => compareString(left.type, right.type) ||
    compareString(left.name, right.name) || compareString(left.tbl_name, right.tbl_name) ||
    compareString(left.sql, right.sql));
  return normalized;
}

/** Return the versioned canonical JSON bytes for an explicit application schema catalogue. */
export function canonicalizeDeploymentSchemaCatalogue(objects) {
  return JSON.stringify({ protocol: DEPLOYMENT_SCHEMA_CATALOGUE_PROTOCOL, objects: normalizeSchemaObjects(objects) });
}

/** SHA-256 of canonicalizeDeploymentSchemaCatalogue(objects), encoded as lowercase hex. */
export function deploymentSchemaCatalogueSha256(objects) {
  return createHash("sha256").update(canonicalizeDeploymentSchemaCatalogue(objects), "utf8").digest("hex");
}

function validateApiBase(apiBase) {
  if (typeof apiBase !== "string") fail("invalid Cloudflare API base");
  let url;
  try { url = new URL(apiBase); } catch { fail("invalid Cloudflare API base"); }
  const official = url.protocol === "https:" && url.hostname === "api.cloudflare.com" && url.port === "";
  const fixture = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!official && !fixture) || url.username || url.password || url.search || url.hash ||
      !["/client/v4", "/client/v4/"].includes(url.pathname)) fail("invalid Cloudflare API base");
  return url.href.replace(/\/$/u, "");
}

function validateReadContext(env, input, context) {
  const binding = BINDINGS.find((item) => item.binding === context?.binding);
  if (!binding || !exactKeys(context, ["protocol", "binding", "account_id", "database_id", "database_name"]) ||
      context.protocol !== "eliotr.cloudflare-d1.schema-database-context.v1" ||
      !ACCOUNT_ID.test(context.account_id ?? "") || context.account_id !== env?.CLOUDFLARE_ACCOUNT_ID ||
      !UUID.test(context.database_id ?? "") || context.database_name !== binding.database_name ||
      typeof env?.CLOUDFLARE_API_TOKEN !== "string" || env.CLOUDFLARE_API_TOKEN.length < 1 ||
      env.CLOUDFLARE_API_TOKEN.length > 4_096) fail("invalid account or D1 resource context");
  return { ...context, api_base: validateApiBase(input?.apiBase) };
}

function validateReadOptions({ maxResponseBytes, timeoutMs }) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail("invalid read bounds");
  }
}

const CATALOGUE_QUERY = `WITH application_schema AS (
  SELECT type, name, tbl_name, sql
  FROM sqlite_master
  WHERE substr(name, 1, 7) <> 'sqlite_'
    AND name COLLATE NOCASE <> 'd1_migrations'
), catalogue_rows AS (
  SELECT 0 AS row_kind, type, name, tbl_name, sql, NULL AS object_count
  FROM application_schema
  UNION ALL
  SELECT 1 AS row_kind, NULL, NULL, NULL, NULL, COUNT(*) AS object_count
  FROM application_schema
)
SELECT row_kind, type, name, tbl_name, sql, object_count
FROM catalogue_rows
ORDER BY row_kind, type, name, tbl_name, sql`;

function decodeCatalogueRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_OBJECTS + 1) {
    fail("catalogue result is absent or oversized");
  }
  const objects = [];
  let sentinelCount = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!exactKeys(row, ["row_kind", "type", "name", "tbl_name", "sql", "object_count"])) {
      fail("malformed catalogue response row");
    }
    if (row.row_kind === 0) {
      if (sentinelCount !== null || row.object_count !== null) fail("malformed catalogue object row");
      objects.push({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql });
    } else if (row.row_kind === 1) {
      if (sentinelCount !== null || index !== rows.length - 1 || row.type !== null || row.name !== null ||
          row.tbl_name !== null || row.sql !== null || !Number.isSafeInteger(row.object_count) || row.object_count < 0) {
        fail("malformed or misplaced catalogue completeness sentinel");
      }
      sentinelCount = row.object_count;
    } else {
      fail("unknown catalogue response row kind");
    }
  }
  if (sentinelCount === null || sentinelCount !== objects.length) fail("catalogue response truncated or incomplete");
  return normalizeSchemaObjects(objects);
}

/**
 * Read the complete application-schema catalogue for one explicit Core/Search D1 binding.
 * SQLite internals and D1's d1_migrations ledger are excluded by the versioned query contract.
 */
export async function readDeploymentApplicationSchemaCatalogue(env, input, context, {
  fetchImpl = fetch,
  readJson = readDeploymentJson,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = validateReadContext(env, input, context);
  validateReadOptions({ maxResponseBytes, timeoutMs });
  if (typeof fetchImpl !== "function" || typeof readJson !== "function") fail("invalid read adapter");

  const url = `${target.api_base}/accounts/${encodeURIComponent(target.account_id)}/d1/database/${encodeURIComponent(target.database_id)}/query`;
  const body = JSON.stringify({ sql: CATALOGUE_QUERY, params: [] });
  const headers = {
    Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    "Content-Type": "application/json",
  };
  const { data, status } = await readJson(url, headers, {
    maxBytes: maxResponseBytes,
    timeoutMs,
    fetchImpl: (address, init) => fetchImpl(address, { ...init, method: "POST", body }),
  });
  if (status !== 200 || !isRecord(data) || data.success !== true || !Array.isArray(data.errors) ||
      data.errors.length !== 0 || !Array.isArray(data.messages) ||
      !Array.isArray(data.result) || data.result.length !== 1) {
    fail("D1 query denied or response envelope malformed");
  }
  const result = data.result[0];
  if (!isRecord(result) || result.success !== true || !Array.isArray(result.results) || !isRecord(result.meta) ||
      result.meta.changed_db !== false || result.meta.rows_written !== 0) {
    fail("D1 catalogue query failed or was not read-only");
  }
  const objects = decodeCatalogueRows(result.results);
  const catalogueSha256 = deploymentSchemaCatalogueSha256(objects);
  return Object.freeze({
    protocol: DEPLOYMENT_SCHEMA_CATALOGUE_PROTOCOL,
    scope: DEPLOYMENT_SCHEMA_SCOPE,
    exclusions: DEPLOYMENT_SCHEMA_EXCLUSIONS,
    binding: target.binding,
    account_id: target.account_id,
    database_id: target.database_id,
    database_name: target.database_name,
    object_count: objects.length,
    catalogue_sha256: catalogueSha256,
    objects: Object.freeze(objects.map((object) => Object.freeze(object))),
  });
}

function resolveDeploymentContexts(env, config, expectedManifest) {
  if (!isRecord(config) || !Array.isArray(config.d1_databases) || config.d1_databases.length !== 2 ||
      !exactKeys(expectedManifest, ["protocol", "streams"]) ||
      expectedManifest.protocol !== DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL ||
      !Array.isArray(expectedManifest.streams) || expectedManifest.streams.length !== 2) {
    fail("expected manifest or generated D1 bindings are malformed");
  }
  const configByBinding = new Map();
  for (const db of config.d1_databases) {
    if (!isRecord(db) || !["CORE_DB", "SEARCH_DB"].includes(db.binding) || configByBinding.has(db.binding)) {
      fail("generated D1 bindings are ambiguous");
    }
    configByBinding.set(db.binding, db);
  }
  if (configByBinding.size !== BINDINGS.length) fail("generated D1 binding set is incomplete");

  const contexts = [];
  const seenIds = new Set();
  for (let index = 0; index < BINDINGS.length; index += 1) {
    const binding = BINDINGS[index];
    const configured = configByBinding.get(binding.binding);
    const expected = expectedManifest.streams[index];
    if (!isRecord(configured) || configured.database_name !== binding.database_name ||
        !UUID.test(configured.database_id ?? "") || seenIds.has(configured.database_id) ||
        !exactKeys(expected, ["binding", "account_id", "database_id", "database_name", "migration_bundle_sha256", "objects"]) ||
        expected.binding !== binding.binding || expected.account_id !== env?.CLOUDFLARE_ACCOUNT_ID ||
        expected.database_id !== configured.database_id || expected.database_name !== binding.database_name ||
        !SHA256.test(expected.migration_bundle_sha256 ?? "") || !Array.isArray(expected.objects) ||
        expected.objects.length < 1 || expected.objects.length > MAX_OBJECTS) {
      fail("expected manifest does not match exact Core/Search resource identity");
    }
    const objects = normalizeSchemaObjects(expected.objects);
    contexts.push({
      context: {
        protocol: "eliotr.cloudflare-d1.schema-database-context.v1",
        binding: binding.binding,
        account_id: expected.account_id,
        database_id: expected.database_id,
        database_name: expected.database_name,
      },
      migration_bundle_sha256: expected.migration_bundle_sha256,
      expected_objects: objects,
      expected_catalogue_sha256: deploymentSchemaCatalogueSha256(objects),
    });
    seenIds.add(configured.database_id);
  }
  return contexts;
}

/**
 * Compare both deployed D1 application catalogues against explicit trusted input.
 * The caller must provide catalogues captured from the exact migration bundle named by each
 * migration_bundle_sha256; this function never derives expectations from ledgers or local SQL.
 * A failure on either database rejects the whole operation and returns no partial PASS receipt.
 */
export async function attestDeploymentApplicationSchemas(env, input, config, expectedManifest, options = {}) {
  const contexts = resolveDeploymentContexts(env, config, expectedManifest);
  const streams = [];
  for (let index = 0; index < contexts.length; index += 1) {
    const expected = contexts[index];
    const observed = await readDeploymentApplicationSchemaCatalogue(env, input, expected.context, options);
    if (observed.catalogue_sha256 !== expected.expected_catalogue_sha256 ||
        canonicalizeDeploymentSchemaCatalogue(observed.objects) !==
          canonicalizeDeploymentSchemaCatalogue(expected.expected_objects)) {
      fail(`application schema catalogue mismatch for ${expected.context.binding}`);
    }
    streams.push(Object.freeze({
      binding: expected.context.binding,
      account_id: expected.context.account_id,
      database_id: expected.context.database_id,
      database_name: expected.context.database_name,
      migration_bundle_sha256: expected.migration_bundle_sha256,
      object_count: observed.object_count,
      catalogue_sha256: observed.catalogue_sha256,
    }));
  }
  return Object.freeze({
    protocol: DEPLOYMENT_SCHEMA_ATTESTATION_PROTOCOL,
    state: "PASS",
    scope: DEPLOYMENT_SCHEMA_SCOPE,
    catalogue_protocol: DEPLOYMENT_SCHEMA_CATALOGUE_PROTOCOL,
    exclusions: DEPLOYMENT_SCHEMA_EXCLUSIONS,
    streams: Object.freeze(streams),
  });
}
