import { createHash } from "node:crypto";

const MAX_CLIENTS = 64;
const MAX_CONFIG_CHARS = 32 * 1024;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u;
const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BINDING_KEYS = new Set(["client_id", "token_id"]);
const SERVICE_KEYS = [
  "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID",
  "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID",
  "ELIOTR_MCP_ACCESS_SERVICE_TOKENS",
  "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS",
];

function fail(message) { throw new Error(message); }

function plainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) fail(`${label} cannot contain accessors`);
    if (!BINDING_KEYS.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
  return value;
}

function parseArray(raw, label) {
  if (raw === undefined) return undefined;
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length === 0 || raw.length > MAX_CONFIG_CHARS) fail(`${label} must be a bounded JSON array`);
    try { value = JSON.parse(raw); }
    catch { fail(`${label} must be a JSON array`); }
  }
  if (!Array.isArray(value)) fail(`${label} must be a JSON array`);
  return value;
}

export function validateMcpAccessServiceClientId(value, label = "MCP service-token Client ID") {
  if (typeof value !== "string" || value.length > 256 || value !== value.trim() || !CLIENT_ID.test(value)) {
    fail(`${label} must be the exact Cloudflare Access service-token Client ID`);
  }
  return value;
}

export function validateMcpAccessServiceTokenId(value, label = "MCP service-token UUID") {
  if (typeof value !== "string" || value !== value.trim() || !TOKEN_ID.test(value)) {
    fail(`${label} must be the exact Cloudflare Access service-token UUID`);
  }
  return value.toLowerCase();
}

function compareBindings(left, right) {
  if (left.client_id !== right.client_id) return left.client_id < right.client_id ? -1 : 1;
  if (left.token_id !== right.token_id) return left.token_id < right.token_id ? -1 : 1;
  return Number(right.legacy) - Number(left.legacy);
}

function freezeBindings(bindings) {
  if (bindings.length > MAX_CLIENTS) fail("MCP service-token configuration exceeds 64 clients");
  const tokenIds = new Set();
  const clientIds = new Set();
  for (const binding of bindings) {
    if (tokenIds.has(binding.token_id)) fail("MCP service-token UUIDs must be unique");
    if (clientIds.has(binding.client_id)) fail("MCP service-token Client IDs must be unique");
    tokenIds.add(binding.token_id);
    clientIds.add(binding.client_id);
  }
  return Object.freeze([...bindings].sort(compareBindings).map((binding) => Object.freeze({
    token_id: binding.token_id,
    client_id: binding.client_id,
    legacy: binding.legacy,
  })));
}

function additionalBindings(raw) {
  const decoded = parseArray(raw, "ELIOTR_MCP_ACCESS_SERVICE_TOKENS");
  if (decoded === undefined) return [];
  return decoded.map((entry, index) => {
    const value = plainObject(entry, `MCP service-token binding ${index}`);
    if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "token_id") || !Object.hasOwn(value, "client_id")) {
      fail(`MCP service-token binding ${index} must contain exactly token_id and client_id`);
    }
    return {
      token_id: validateMcpAccessServiceTokenId(value.token_id, `MCP service-token binding ${index} token_id`),
      client_id: validateMcpAccessServiceClientId(value.client_id, `MCP service-token binding ${index} client_id`),
      legacy: false,
    };
  });
}

export function hasMcpAccessServiceConfiguration(environment) {
  return SERVICE_KEYS.some((key) => environment?.[key] !== undefined);
}

export function readMcpAccessServiceBindings(environment) {
  const legacyToken = environment?.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID;
  const legacyClient = environment?.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID;
  if ((legacyToken === undefined) !== (legacyClient === undefined)) {
    fail("legacy MCP service-token UUID and Client ID must be configured together");
  }
  const bindings = additionalBindings(environment?.ELIOTR_MCP_ACCESS_SERVICE_TOKENS);
  if (legacyToken !== undefined) {
    bindings.push({
      token_id: validateMcpAccessServiceTokenId(legacyToken, "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID"),
      client_id: validateMcpAccessServiceClientId(legacyClient, "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID"),
      legacy: true,
    });
  }
  return freezeBindings(bindings);
}

function additionalClientIds(raw) {
  const decoded = parseArray(raw, "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS");
  if (decoded === undefined) return undefined;
  if (decoded.length > MAX_CLIENTS) fail("MCP service-token Client ID configuration exceeds 64 clients");
  const values = decoded.map((value, index) =>
    validateMcpAccessServiceClientId(value, `MCP service-token Client ID ${index}`),
  ).sort();
  if (new Set(values).size !== values.length) fail("MCP service-token Client IDs must be unique");
  return Object.freeze(values);
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function readMcpAccessRuntimeClients(environment) {
  const source = environment ?? {};
  const rawLegacyToken = source.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID;
  const rawLegacyClient = source.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID;
  if (rawLegacyToken !== undefined && rawLegacyClient === undefined) {
    fail("legacy MCP service-token UUID requires its Client ID");
  }
  const legacyClientId = rawLegacyClient === undefined
    ? null
    : validateMcpAccessServiceClientId(rawLegacyClient, "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID");
  if (rawLegacyToken !== undefined) {
    validateMcpAccessServiceTokenId(rawLegacyToken, "ELIOTR_MCP_ACCESS_SERVICE_TOKEN_ID");
  }
  const derived = additionalBindings(source.ELIOTR_MCP_ACCESS_SERVICE_TOKENS)
    .map((binding) => binding.client_id).sort();
  const explicit = additionalClientIds(source.ELIOTR_MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS);
  if (explicit !== undefined && source.ELIOTR_MCP_ACCESS_SERVICE_TOKENS !== undefined && !sameStrings(explicit, derived)) {
    fail("MCP service-token runtime Client IDs differ from the provisioner bindings");
  }
  const additional = explicit ?? Object.freeze(derived);
  const all = [...(legacyClientId === null ? [] : [legacyClientId]), ...additional];
  if (all.length > MAX_CLIENTS || new Set(all).size !== all.length) {
    fail("MCP service-token runtime Client IDs must contain at most 64 unique values");
  }
  return Object.freeze({
    legacyClientId,
    additionalClientIds: Object.freeze([...additional]),
    count: all.length,
  });
}

function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function mcpAccessServiceBindingSha256(bindings) {
  return sha256(JSON.stringify({
    protocol: "eliotr.mcp.access-service-bindings.v1",
    bindings: [...bindings].sort(compareBindings).map((binding) => ({
      client_id: binding.client_id,
      legacy: binding.legacy,
      token_id: binding.token_id,
    })),
  }));
}

export function mcpAccessRuntimeClientSha256(clients) {
  return sha256(JSON.stringify({
    protocol: "eliotr.mcp.access-runtime-clients.v1",
    legacy_client_id: clients.legacyClientId,
    additional_client_ids: [...clients.additionalClientIds].sort(),
  }));
}
