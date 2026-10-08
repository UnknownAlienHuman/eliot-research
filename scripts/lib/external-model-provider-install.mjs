const ACCOUNT_ID = /^[a-f0-9]{32}$/iu;
const GATEWAY_ID = "eliotr-reasoning";
const CUSTOM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROVIDER_SLUG = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ROOT_KEYS = new Set(["custom_provider", "protocol", "provider_config", "secret_reference"]);
const CUSTOM_PROVIDER_KEYS = new Set([
  "base_url", "beta", "description", "enable", "link", "name", "protocol", "slug",
]);
const PROVIDER_CONFIG_KEYS = new Set([
  "alias", "default_config", "protocol", "provider_slug", "rate_limit", "rate_limit_period",
]);
const SECRET_KEYS = new Set(["secret_id", "secret_name"]);
const MAX_RATE = 2_147_483_647;

export class ExternalModelProviderInstallError extends Error {
  constructor(message, code = "EXTERNAL_MODEL_PROVIDER_INSTALL_INVALID", cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExternalModelProviderInstallError";
    this.code = code;
  }
}

function fail(message, code = "EXTERNAL_MODEL_PROVIDER_INSTALL_INVALID", cause) {
  throw new ExternalModelProviderInstallError(message, code, cause);
}

function plainObject(value, label, allowed) {
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
    if (allowed !== undefined && !allowed.has(key)) fail(`${label} contains unsupported field ${key}`);
  }
  return value;
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function optionalInteger(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RATE) fail(`${label} is invalid`);
  return value;
}

function parseInput(raw, accountId) {
  const input = plainObject(raw, "external model provider input", ROOT_KEYS);
  if (input.protocol !== "eliotr.external-model-provider.v1") {
    fail("external model provider protocol is unsupported");
  }
  // The Custom Provider adapter performs its full pure decode before its own
  // first request. Here we bind its identity to the separately decoded key attachment.
  const custom = plainObject(input.custom_provider, "custom provider input", CUSTOM_PROVIDER_KEYS);
  const customSlug = identifier(custom.slug, CUSTOM_SLUG, "custom provider slug");
  const provider = plainObject(input.provider_config, "provider config input", PROVIDER_CONFIG_KEYS);
  if (provider.protocol !== "eliotr.provider-config.v1" || typeof provider.default_config !== "boolean") {
    fail("provider config protocol or default flag is invalid");
  }
  const providerSlug = identifier(provider.provider_slug, PROVIDER_SLUG, "provider config provider slug");
  const alias = identifier(provider.alias, ALIAS, "provider config alias");
  const rateLimit = optionalInteger(provider.rate_limit, "provider config rate_limit");
  const ratePeriod = optionalInteger(provider.rate_limit_period, "provider config rate_limit_period");
  if ((rateLimit === null) !== (ratePeriod === null)) {
    fail("provider rate limit and period must be supplied together");
  }
  const providerConfig = Object.freeze({
    protocol: "eliotr.provider-config.v1",
    provider_slug: providerSlug,
    alias,
    default_config: provider.default_config,
    ...(rateLimit === null ? {} : { rate_limit: rateLimit, rate_limit_period: ratePeriod }),
  });
  const secret = plainObject(input.secret_reference, "provider secret reference", SECRET_KEYS);
  const secretId = identifier(secret.secret_id, BOUNDED_ID, "provider secret ID");
  const secretName = identifier(secret.secret_name, BOUNDED_ID, "provider secret name");
  if (providerSlug !== `custom-${customSlug}`) {
    fail("provider config does not reference the requested custom provider");
  }
  const expectedSecret = `${GATEWAY_ID}_${providerSlug}_${alias}`;
  if (expectedSecret.length > 256 || secretName !== expectedSecret) {
    fail("provider secret name does not bind the gateway, provider and alias");
  }
  return Object.freeze({
    account_id: accountId,
    gateway_id: GATEWAY_ID,
    custom_provider: input.custom_provider,
    custom_slug: customSlug,
    provider_config: providerConfig,
    provider_slug: providerSlug,
    alias,
    secret_reference: Object.freeze({ secret_id: secretId, secret_name: secretName }),
  });
}

function accountFromGatewayUrl(value) {
  if (typeof value !== "string") return null;
  let parsed;
  try { parsed = new URL(value); }
  catch { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "gateway.ai.cloudflare.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  return parts.length >= 2 && ACCOUNT_ID.test(parts[1]) ? parts[1].toLowerCase() : null;
}

export function externalModelProviderAccount(config) {
  const root = plainObject(config, "Wrangler config");
  const vars = root.vars === undefined ? {} : plainObject(root.vars, "Wrangler vars");
  const candidates = [];
  if (root.account_id !== undefined) candidates.push(root.account_id);
  const reasoningAccount = accountFromGatewayUrl(vars.AI_GATEWAY_REASONING_URL);
  if (reasoningAccount !== null) candidates.push(reasoningAccount);
  const accounts = [...new Set(candidates.map((value) =>
    typeof value === "string" ? value.toLowerCase() : value,
  ))];
  if (accounts.length !== 1 || typeof accounts[0] !== "string" || !ACCOUNT_ID.test(accounts[0])) {
    fail("Wrangler config has no single external-model account identity");
  }
  return accounts[0];
}

function apiToken(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 ||
      value !== value.trim() || /\s/u.test(value) || value.toLowerCase().startsWith("bearer")) {
    fail("Cloudflare credential is invalid", "EXTERNAL_MODEL_PROVIDER_CREDENTIAL_INVALID");
  }
  return value;
}

function requiredFunction(module, name) {
  const fn = module[name];
  if (typeof fn !== "function") {
    fail(`Compiled cloudflare-ai module lacks ${name}`, "EXTERNAL_MODEL_PROVIDER_COMPOSITION_UNAVAILABLE");
  }
  return fn;
}

function verifyReceipts(parsed, customReceipt, configReceipt) {
  if (customReceipt?.account_id !== parsed.account_id ||
      customReceipt?.provider_slug !== parsed.custom_slug ||
      customReceipt?.gateway_provider !== parsed.provider_slug ||
      customReceipt?.model_reference_prefix !== `${parsed.provider_slug}/` ||
      configReceipt?.account_id !== parsed.account_id ||
      configReceipt?.gateway_id !== parsed.gateway_id ||
      configReceipt?.provider_slug !== parsed.provider_slug ||
      configReceipt?.alias !== parsed.alias ||
      configReceipt?.secret_id !== parsed.secret_reference.secret_id ||
      configReceipt?.secret_name !== parsed.secret_reference.secret_name) {
    fail("external model provider receipts do not bind one configuration",
      "EXTERNAL_MODEL_PROVIDER_RECEIPT_MISMATCH");
  }
}

export async function connectExternalModelProvider({
  cloudflareAi,
  input,
  accountId,
  bearer,
  fetchImpl = globalThis.fetch,
}) {
  const module = plainObject(cloudflareAi, "compiled cloudflare-ai module");
  const ensureProvider = requiredFunction(module, "ensureCloudflareCustomProvider");
  const ensureProviderConfig = requiredFunction(module, "ensureCloudflareProviderConfig");
  const canonicalJson = requiredFunction(module, "canonicalModelGatewayJson");
  const sha256 = requiredFunction(module, "modelGatewaySha256");
  const account = identifier(accountId, ACCOUNT_ID, "Cloudflare account ID").toLowerCase();
  const parsed = parseInput(input, account);
  if (typeof fetchImpl !== "function") {
    fail("Cloudflare API fetch implementation is unavailable",
      "EXTERNAL_MODEL_PROVIDER_TRANSPORT_UNAVAILABLE");
  }
  const token = apiToken(bearer);
  const credentials = Object.freeze({ readApiToken: async () => token });
  const fetchPort = Object.freeze({ fetch: (url, init) => fetchImpl(url, init) });
  try {
    const provider = await ensureProvider(parsed.custom_provider, {
      account_id: account,
      credentials,
      fetch: fetchPort,
    });
    const providerConfig = await ensureProviderConfig(parsed.provider_config, {
      account_id: account,
      gateway_id: parsed.gateway_id,
      credentials,
      fetch: fetchPort,
      secret: Object.freeze({ readSecretReference: async () => parsed.secret_reference }),
    });
    verifyReceipts(parsed, provider, providerConfig);
    const setupSha256 = await sha256(canonicalJson({
      protocol: "eliotr.external-model-provider-setup.v1",
      account_id: account,
      gateway_id: parsed.gateway_id,
      provider_id: provider.provider_id,
      provider_config_id: providerConfig.provider_config_id,
      gateway_provider: provider.gateway_provider,
      alias: parsed.alias,
      secret_id: parsed.secret_reference.secret_id,
      secret_name: parsed.secret_reference.secret_name,
      custom_provider_config_sha256: provider.config_sha256,
      provider_config_sha256: providerConfig.config_sha256,
    }));
    if (typeof setupSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(setupSha256)) {
      fail("external model provider setup digest is invalid", "EXTERNAL_MODEL_PROVIDER_RECEIPT_MISMATCH");
    }
    return Object.freeze({
      protocol: "eliotr.external-model-provider-setup-receipt.v1",
      account_id: account,
      gateway_id: parsed.gateway_id,
      provider_slug: parsed.custom_slug,
      gateway_provider: provider.gateway_provider,
      model_reference_prefix: provider.model_reference_prefix,
      alias: parsed.alias,
      secret_id: parsed.secret_reference.secret_id,
      secret_name: parsed.secret_reference.secret_name,
      provider,
      provider_config: providerConfig,
      setup_sha256: setupSha256,
    });
  } catch (cause) {
    if (cause && typeof cause.code === "string") throw cause;
    fail("external model provider composition failed", "EXTERNAL_MODEL_PROVIDER_INSTALL_FAILED", cause);
  }
}
