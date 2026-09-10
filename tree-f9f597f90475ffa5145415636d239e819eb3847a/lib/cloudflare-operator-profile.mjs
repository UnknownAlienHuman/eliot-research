import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const OPERATOR_PROFILE_PROTOCOL = "eliotr.cloudflare-operator-profile.v1";

export const OPERATOR_PROFILE_EXPECTED = Object.freeze({
  protocol: OPERATOR_PROFILE_PROTOCOL,
  accountName: "Kleymor.metal@gmail.com's Account",
  accountId: "bc10e9f02aa57f4adc5a7a48ad1bacff",
  operatorEmail: "kleymor.metal@gmail.com",
  wranglerProfile: "default",
  authMethod: "browser-oauth",
  workersDevSubdomain: "kleymor-metal",
  workerName: "eliotr-core",
  hostname: "eliotr-core.kleymor-metal.workers.dev",
  routeMode: "workers-dev-only",
  customDomainFlag: "0",
  teamOrigin: "https://iuriilisenkov.cloudflareaccess.com",
  ownerEmails: Object.freeze(["kleymor.metal@gmail.com"]),
});

const ALLOWED_FIELDS = Object.freeze({
  "": ["protocol", "description", "account", "operator", "workers_dev", "routing", "zero_trust", "operational_policy", "secrets"],
  account: ["name", "id"],
  operator: ["email", "wrangler_profile", "auth_method", "allowed_auth_methods", "auth_note"],
  workers_dev: ["subdomain", "worker_name", "hostname"],
  routing: ["mode", "custom_domain_enabled", "eliotr_custom_domain", "route_note"],
  zero_trust: ["team_origin", "owner_emails"],
  operational_policy: ["plan", "paid_overage", "overage_note"],
  secrets: ["contains_secrets", "note"],
});

// Receipt-adjacent generated identifiers must live in ignored local state
// (.eliotr-state/, wrangler.deploy.jsonc, wrangler.local.jsonc), never in the
// tracked operator profile.
const GENERATED_ID_KEY_PATTERN =
  /(database[_-]?id|d1[_-]?uuid|resource[_-]?uuid|deployment[_-]?id|receipt|aud(ien)?ce|service[_-]?token|api[_-]?token)/i;

const SECRET_KEY_PATTERN =
  /(api[_-]?token|access[_-]?token|refresh[_-]?token|service[_-]?token|client[_-]?secret|api[_-]?key|private[_-]?key|password|passwd|pwd|secret|bearer|authorization|cookie|session[_-]?token|oauth[_-]?token|\bjwt\b)/i;

const PRIVATE_KEY_VALUE_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const JWT_VALUE_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i;
const CF_API_TOKEN_VALUE_PATTERN = /^[A-Za-z0-9_-]{40}$/;
const HARD_CAP_GUARANTEE_PATTERN = /hard\s*cap[^.]{0,80}(block|enforc|guarantee|prevents?\s+all)/i;

export class OperatorProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperatorProfileError";
  }
}

function fail(message) {
  throw new OperatorProfileError(message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value, expected, label) {
  if (value !== expected) {
    fail(`${label} drift: expected ${JSON.stringify(expected)} but received ${JSON.stringify(value)}`);
  }
}

const SECRET_KEY_ALLOWLIST = new Set(["secrets", "contains_secrets"]);

function isSecretLikeKey(key) {
  if (SECRET_KEY_ALLOWLIST.has(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}

function checkAllowedKeys(profile) {
  if (!isPlainObject(profile)) fail("operator profile must be a JSON object");
  for (const key of Object.keys(profile)) {
    if (!ALLOWED_FIELDS[""].includes(key)) {
      fail(`unexpected top-level field ${JSON.stringify(key)}; generated receipt IDs must not be committed`);
    }
    if (GENERATED_ID_KEY_PATTERN.test(key)) {
      fail(`forbidden generated-identifier field ${JSON.stringify(key)}; belongs in ignored receipts`);
    }
  }
  for (const section of Object.keys(ALLOWED_FIELDS)) {
    if (section === "") continue;
    const node = profile[section];
    if (!isPlainObject(node)) fail(`operator profile section ${JSON.stringify(section)} must be an object`);
    for (const key of Object.keys(node)) {
      if (!ALLOWED_FIELDS[section].includes(key)) {
        fail(`unexpected field ${section}.${JSON.stringify(key)}; generated receipt IDs must not be committed`);
      }
      if (GENERATED_ID_KEY_PATTERN.test(key)) {
        fail(`forbidden generated-identifier field ${section}.${JSON.stringify(key)}`);
      }
      if (isSecretLikeKey(key)) {
        fail(`secret-like field ${section}.${JSON.stringify(key)} is prohibited in the tracked profile`);
      }
    }
  }
  // Top-level keys are also scanned for secret-like names (defense in depth).
  for (const key of Object.keys(profile)) {
    if (isSecretLikeKey(key)) {
      fail(`secret-like field ${JSON.stringify(key)} is prohibited in the tracked profile`);
    }
  }
}

function scanValuesForTokenMaterial(value, path) {
  if (typeof value === "string") {
    if (
      PRIVATE_KEY_VALUE_PATTERN.test(value) ||
      JWT_VALUE_PATTERN.test(value) ||
      BEARER_VALUE_PATTERN.test(value) ||
      CF_API_TOKEN_VALUE_PATTERN.test(value.trim())
    ) {
      fail(`token material detected at ${path}; secrets must never be stored in the tracked profile`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanValuesForTokenMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (isSecretLikeKey(key)) {
        fail(`secret-like field ${path}.${key} is prohibited in the tracked profile`);
      }
      scanValuesForTokenMaterial(entry, `${path}.${key}`);
    }
  }
}

export function validateOperatorProfile(profile) {
  if (!isPlainObject(profile)) fail("operator profile must be a JSON object");

  checkAllowedKeys(profile);

  exact(profile.protocol, OPERATOR_PROFILE_EXPECTED.protocol, "protocol");

  if (!isPlainObject(profile.account)) fail("account section must be an object");
  exact(profile.account.name, OPERATOR_PROFILE_EXPECTED.accountName, "account.name");
  exact(profile.account.id, OPERATOR_PROFILE_EXPECTED.accountId, "account.id");

  if (!isPlainObject(profile.operator)) fail("operator section must be an object");
  exact(profile.operator.email, OPERATOR_PROFILE_EXPECTED.operatorEmail, "operator.email");
  exact(profile.operator.wrangler_profile, OPERATOR_PROFILE_EXPECTED.wranglerProfile, "operator.wrangler_profile");
  exact(profile.operator.auth_method, OPERATOR_PROFILE_EXPECTED.authMethod, "operator.auth_method");
  if (
    !Array.isArray(profile.operator.allowed_auth_methods) ||
    profile.operator.allowed_auth_methods.length !== 1 ||
    profile.operator.allowed_auth_methods[0] !== "browser-oauth"
  ) {
    fail("operator.allowed_auth_methods drift: browser-oauth must be the ONLY auth method");
  }
  if (typeof profile.operator.auth_note !== "string" || profile.operator.auth_note.trim() === "") {
    fail("operator.auth_note must document browser OAuth as the only auth method");
  }

  if (!isPlainObject(profile.workers_dev)) fail("workers_dev section must be an object");
  exact(profile.workers_dev.subdomain, OPERATOR_PROFILE_EXPECTED.workersDevSubdomain, "workers_dev.subdomain");
  exact(profile.workers_dev.worker_name, OPERATOR_PROFILE_EXPECTED.workerName, "workers_dev.worker_name");
  exact(profile.workers_dev.hostname, OPERATOR_PROFILE_EXPECTED.hostname, "workers_dev.hostname");

  if (!isPlainObject(profile.routing)) fail("routing section must be an object");
  exact(profile.routing.mode, OPERATOR_PROFILE_EXPECTED.routeMode, "routing.mode");
  if (profile.routing.custom_domain_enabled !== false) {
    fail("routing drift: custom_domain_enabled must be false (workers.dev only)");
  }
  exact(String(profile.routing.eliotr_custom_domain), OPERATOR_PROFILE_EXPECTED.customDomainFlag, "routing.eliotr_custom_domain");

  if (!isPlainObject(profile.zero_trust)) fail("zero_trust section must be an object");
  exact(profile.zero_trust.team_origin, OPERATOR_PROFILE_EXPECTED.teamOrigin, "zero_trust.team_origin");
  if (
    !Array.isArray(profile.zero_trust.owner_emails) ||
    profile.zero_trust.owner_emails.length !== OPERATOR_PROFILE_EXPECTED.ownerEmails.length ||
    profile.zero_trust.owner_emails.some((email, index) => email !== OPERATOR_PROFILE_EXPECTED.ownerEmails[index])
  ) {
    fail("zero_trust.owner_emails drift: expected the single owner Access email");
  }

  if (!isPlainObject(profile.operational_policy)) fail("operational_policy section must be an object");
  exact(profile.operational_policy.plan, "free-tier", "operational_policy.plan");
  if (profile.operational_policy.paid_overage !== false) {
    fail("operational_policy drift: paid_overage must be false (no paid overage)");
  }
  if (
    typeof profile.operational_policy.overage_note !== "string" ||
    profile.operational_policy.overage_note.trim() === ""
  ) {
    fail("operational_policy.overage_note must record the free-tier/no-overage policy");
  }
  if (HARD_CAP_GUARANTEE_PATTERN.test(profile.operational_policy.overage_note)) {
    fail("operational_policy.overage_note must not claim a hard cap Cloudflare does not provide");
  }

  if (!isPlainObject(profile.secrets)) fail("secrets section must be an object");
  if (profile.secrets.contains_secrets !== false) {
    fail("secrets.contains_secrets must be false; this file is non-secret");
  }
  if (typeof profile.secrets.note !== "string" || profile.secrets.note.trim() === "") {
    fail("secrets.note must explicitly prohibit secrets in the tracked profile");
  }

  scanValuesForTokenMaterial(profile, "$");

  return Object.freeze({
    protocol: profile.protocol,
    accountId: profile.account.id,
    accountName: profile.account.name,
    operatorEmail: profile.operator.email,
    wranglerProfile: profile.operator.wrangler_profile,
    authMethod: profile.operator.auth_method,
    hostname: profile.workers_dev.hostname,
    workersDevSubdomain: profile.workers_dev.subdomain,
    routeMode: profile.routing.mode,
    teamOrigin: profile.zero_trust.team_origin,
    ownerEmails: Object.freeze([...profile.zero_trust.owner_emails]),
  });
}

export async function loadOperatorProfile(profilePath = "infra/cloudflare/operator-profile.json") {
  const absolute = resolve(process.cwd(), profilePath);
  let raw;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (error) {
    throw new OperatorProfileError(`cannot read operator profile at ${absolute}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new OperatorProfileError(`operator profile at ${absolute} is not valid JSON: ${error.message}`);
  }
  return validateOperatorProfile(parsed);
}
