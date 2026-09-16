import { URL } from "node:url";
import { TextEncoder } from "node:util";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const UTF8 = new TextEncoder();

export class ResearchDeploymentAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResearchDeploymentAuthorityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResearchDeploymentAuthorityError(code, message);
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function apiToken(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\r\n]/u.test(value)) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "Cloudflare API token is invalid");
  }
  return value;
}

function apiBase(value) {
  let parsed;
  try { parsed = new URL(value ?? "https://api.cloudflare.com/client/v4"); }
  catch { fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "Cloudflare API base URL is invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const official = parsed.protocol === "https:" && parsed.hostname === "api.cloudflare.com" && parsed.port === "";
  if ((!official && !(loopback && parsed.protocol === "http:")) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || !["/client/v4", "/client/v4/"].includes(parsed.pathname)) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "Cloudflare API origin is invalid");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  return parsed;
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", `${label} is invalid`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", `${label} is invalid`);
  return value;
}

function deploymentRow(value, label) {
  const row = plainObject(value, label);
  if (typeof row.deployment_generation !== "string" || !IDENTIFIER.test(row.deployment_generation) ||
      (row.state !== "ACTIVE" && row.state !== "RETIRED") || typeof row.created_at !== "string") {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", `${label} has an invalid deployment row`);
  }
  const fingerprint = row.backend_fingerprint;
  if (fingerprint !== null && (typeof fingerprint !== "string" || !SHA256.test(fingerprint))) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", `${label} has an invalid backend fingerprint`);
  }
  return { deployment_generation: row.deployment_generation, state: row.state, created_at: row.created_at, backend_fingerprint: fingerprint ?? null };
}

function statementResult(value, index) {
  const result = plainObject(value, `D1 batch result ${index}`);
  if (result.success !== true || !Array.isArray(result.results)) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED", `D1 deployment authority statement ${index} failed`);
  }
  const meta = plainObject(result.meta, `D1 batch metadata ${index}`);
  const changes = nonnegativeInteger(meta.changes, `D1 batch changes ${index}`);
  return { rows: result.results.map((row, rowIndex) => deploymentRow(row, `D1 batch row ${index}:${rowIndex}`)), changes };
}

async function readResponseText(response) {
  let text;
  try { text = await response.text(); }
  catch { fail("RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED", "D1 deployment authority response could not be read"); }
  if (typeof text !== "string" || UTF8.encode(text).byteLength > MAX_RESPONSE_BYTES) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "D1 deployment authority response exceeds its bound");
  }
  return text;
}

function endpoint(base, accountId, databaseId) {
  return new URL(`${base.pathname}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, base);
}

async function executeBatch(url, token, statements, fetchImpl) {
  if (statements.length < 1 || statements.length > 3) fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "D1 deployment authority batch size is invalid");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ batch: statements }),
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED", "D1 deployment authority request failed");
  }
  if (response === null || typeof response !== "object" || typeof response.text !== "function") {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "D1 deployment authority response is invalid");
  }
  const text = await readResponseText(response);
  let payload;
  try { payload = text.length === 0 ? null : JSON.parse(text); }
  catch { fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "D1 deployment authority response is not JSON"); }
  const envelope = plainObject(payload, "D1 deployment authority response");
  if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300 || envelope.success !== true ||
      !Array.isArray(envelope.result) || envelope.result.length !== statements.length) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED", `D1 deployment authority request failed (HTTP ${response.status})`);
  }
  return envelope.result.map(statementResult);
}

async function readAuthorityState(url, token, generation, fetchImpl) {
  const [result] = await executeBatch(url, token, [{
    sql: "SELECT deployment_generation,state,created_at,backend_fingerprint FROM investigation_current_deployment " +
      "WHERE state='ACTIVE' OR deployment_generation=?1 ORDER BY deployment_generation LIMIT 3",
    params: [generation],
  }], fetchImpl);
  const active = result.rows.filter((row) => row.state === "ACTIVE");
  if (active.length > 1) fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "D1 has more than one active deployment generation");
  const target = result.rows.find((row) => row.deployment_generation === generation) ?? null;
  return Object.freeze({ active: active[0] ?? null, target });
}

function assertCurrent(rows, expected, fingerprint, retired) {
  const active = rows.filter((row) => row.state === "ACTIVE");
  if (active.length !== 1 || active[0].deployment_generation !== expected || active[0].backend_fingerprint !== fingerprint) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "D1 deployment authority readback does not match the deployed generation");
  }
  if (retired !== null) {
    const old = rows.find((row) => row.deployment_generation === retired);
    if (old === undefined || old.state !== "RETIRED") {
      fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "D1 previous deployment was not retired");
    }
  }
}

export async function synchronizeResearchDeploymentAuthority({
  account_id,
  database_id,
  api_token,
  api_base_url,
  deployment_generation,
  backend_fingerprint,
  fetch_impl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const accountId = identifier(account_id, "account_id");
  const databaseId = identifier(database_id, "database_id");
  const token = apiToken(api_token);
  const generation = identifier(deployment_generation, "deployment_generation");
  if (typeof backend_fingerprint !== "string" || !SHA256.test(backend_fingerprint)) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "backend_fingerprint is invalid");
  }
  if (typeof fetch_impl !== "function" || typeof globalThis.AbortSignal?.timeout !== "function") {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "D1 deployment authority transport is unavailable");
  }
  if (typeof now !== "function") fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "deployment clock is unavailable");
  const base = apiBase(api_base_url);
  const url = endpoint(base, accountId, databaseId);
  const observed = await readAuthorityState(url, token, generation, fetch_impl);
  if (observed.active?.deployment_generation === generation) {
    if (observed.active.backend_fingerprint !== backend_fingerprint) {
      fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "active deployment fingerprint does not match the deployed backend");
    }
    return Object.freeze({ state: "ALREADY_ACTIVE", deployment_generation: generation, backend_fingerprint, retired_generation: null, readback: "PASS" });
  }
  if (observed.target !== null && observed.target.backend_fingerprint !== backend_fingerprint) {
    fail("RESEARCH_DEPLOYMENT_AUTHORITY_READBACK_INVALID", "retired deployment fingerprint is unavailable or incompatible");
  }
  let createdAt;
  try {
    const timestamp = now();
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("invalid clock");
    createdAt = new Date(timestamp).toISOString();
  } catch { fail("RESEARCH_DEPLOYMENT_AUTHORITY_INPUT_INVALID", "deployment clock is invalid"); }
  const retired = observed.active?.deployment_generation ?? null;
  const activateSql = "INSERT INTO investigation_current_deployment (deployment_generation,state,created_at,backend_fingerprint) " +
    "VALUES (?1,'ACTIVE',?2,?3) ON CONFLICT(deployment_generation) DO UPDATE SET state='ACTIVE',created_at=excluded.created_at " +
    "WHERE investigation_current_deployment.state='RETIRED' " +
    "AND investigation_current_deployment.backend_fingerprint=excluded.backend_fingerprint";
  const statements = retired === null ? [
    { sql: activateSql, params: [generation, createdAt, backend_fingerprint] },
    { sql: "SELECT deployment_generation,state,created_at,backend_fingerprint FROM investigation_current_deployment WHERE state='ACTIVE' OR deployment_generation=?1", params: [generation] },
  ] : [
    { sql: "UPDATE investigation_current_deployment SET state='RETIRED' WHERE deployment_generation=?1 AND state='ACTIVE'", params: [retired] },
    { sql: activateSql, params: [generation, createdAt, backend_fingerprint] },
    { sql: "SELECT deployment_generation,state,created_at,backend_fingerprint FROM investigation_current_deployment WHERE state='ACTIVE' OR deployment_generation IN (?1,?2)", params: [retired, generation] },
  ];
  const results = await executeBatch(url, token, statements, fetch_impl);
  const insertIndex = retired === null ? 0 : 1;
  if (retired !== null && results[0].changes < 1) fail("RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED", "D1 deployment authority CAS lost");
  if (results[insertIndex].changes < 1) fail("RESEARCH_DEPLOYMENT_AUTHORITY_SYNC_FAILED", "D1 deployment activation did not commit");
  assertCurrent(results.at(-1).rows, generation, backend_fingerprint, retired);
  return Object.freeze({ state: retired === null ? "INITIALIZED" : "ROTATED", deployment_generation: generation, backend_fingerprint, retired_generation: retired, readback: "PASS" });
}
