import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const OPERATOR_PROFILE_PROTOCOL = "eliotr.cloudflare-operator-profile.v1";

// Actual runtime profile lives in ignored local state (never committed).
export const DEFAULT_LOCAL_OPERATOR_PROFILE_PATH =
  ".eliotr-state/cloudflare/operator-profile.json";

// Tracked account-neutral template (fictional placeholders only).
export const TRACKED_OPERATOR_PROFILE_TEMPLATE_PATH =
  "infra/cloudflare/operator-profile.json";

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

const ACCOUNT_ID_FORMAT = /^[0-9a-f]{32}$/i;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKERS_DEV_HOSTNAME_FORMAT = /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i;
const ACCESS_TEAM_ORIGIN_FORMAT = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/i;

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

function checkShapeInvariants(profile) {
  if (typeof profile.protocol !== "string") fail("protocol must be a string");
  exact(profile.protocol, OPERATOR_PROFILE_PROTOCOL, "protocol");

  if (!isPlainObject(profile.account)) fail("account section must be an object");
  if (typeof profile.account.name !== "string" || profile.account.name.trim() === "") {
    fail("account.name must be a non-empty string");
  }
  if (typeof profile.account.id !== "string" || !ACCOUNT_ID_FORMAT.test(profile.account.id.trim())) {
    fail("account.id must be a 32-character hex string");
  }

  if (!isPlainObject(profile.operator)) fail("operator section must be an object");
  if (typeof profile.operator.email !== "string" || !EMAIL_FORMAT.test(profile.operator.email.trim())) {
    fail("operator.email must be a valid email address");
  }
  if (typeof profile.operator.wrangler_profile !== "string" || profile.operator.wrangler_profile.trim() === "") {
    fail("operator.wrangler_profile must be a non-empty string");
  }
  exact(profile.operator.auth_method, "browser-oauth", "operator.auth_method");
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
  if (typeof profile.workers_dev.subdomain !== "string" || profile.workers_dev.subdomain.trim() === "") {
    fail("workers_dev.subdomain must be a non-empty string");
  }
  if (typeof profile.workers_dev.worker_name !== "string" || profile.workers_dev.worker_name.trim() === "") {
    fail("workers_dev.worker_name must be a non-empty string");
  }
  if (
    typeof profile.workers_dev.hostname !== "string" ||
    !WORKERS_DEV_HOSTNAME_FORMAT.test(profile.workers_dev.hostname.trim())
  ) {
    fail("workers_dev.hostname must be a <worker>.<subdomain>.workers.dev hostname");
  }

  if (!isPlainObject(profile.routing)) fail("routing section must be an object");
  exact(profile.routing.mode, "workers-dev-only", "routing.mode");
  if (profile.routing.custom_domain_enabled !== false) {
    fail("routing drift: custom_domain_enabled must be false (workers.dev only)");
  }
  exact(String(profile.routing.eliotr_custom_domain), "0", "routing.eliotr_custom_domain");

  if (!isPlainObject(profile.zero_trust)) fail("zero_trust section must be an object");
  if (
    typeof profile.zero_trust.team_origin !== "string" ||
    !ACCESS_TEAM_ORIGIN_FORMAT.test(profile.zero_trust.team_origin.trim())
  ) {
    fail("zero_trust.team_origin must be an https://<team>.cloudflareaccess.com origin");
  }
  if (!Array.isArray(profile.zero_trust.owner_emails) || profile.zero_trust.owner_emails.length < 1) {
    fail("zero_trust.owner_emails must be a non-empty email list");
  }
  for (const email of profile.zero_trust.owner_emails) {
    if (typeof email !== "string" || !EMAIL_FORMAT.test(email.trim())) {
      fail("zero_trust.owner_emails must contain only valid email addresses");
    }
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
}

// Supplied expectations come from ignored local state or explicit env vars —
// never from constants embedded in this module. Only supplied fields are
// compared; omitted fields are skipped.
function checkSuppliedExpectations(profile, expected) {
  if (expected == null) return;
  if (!isPlainObject(expected)) fail("expected operator identity must be an object");
  const fieldComparisons = [
    ["accountName", profile.account.name, "account.name"],
    ["accountId", profile.account.id, "account.id"],
    ["operatorEmail", profile.operator.email, "operator.email"],
    ["wranglerProfile", profile.operator.wrangler_profile, "operator.wrangler_profile"],
    ["authMethod", profile.operator.auth_method, "operator.auth_method"],
    ["workersDevSubdomain", profile.workers_dev.subdomain, "workers_dev.subdomain"],
    ["workerName", profile.workers_dev.worker_name, "workers_dev.worker_name"],
    ["hostname", profile.workers_dev.hostname, "workers_dev.hostname"],
    ["routeMode", profile.routing.mode, "routing.mode"],
    ["customDomainFlag", String(profile.routing.eliotr_custom_domain), "routing.eliotr_custom_domain"],
    ["teamOrigin", profile.zero_trust.team_origin, "zero_trust.team_origin"],
  ];
  for (const [key, actual, label] of fieldComparisons) {
    if (expected[key] !== undefined) exact(actual, expected[key], label);
  }
  if (expected.ownerEmails !== undefined) {
    if (
      !Array.isArray(expected.ownerEmails) ||
      profile.zero_trust.owner_emails.length !== expected.ownerEmails.length ||
      profile.zero_trust.owner_emails.some((email, index) => email !== expected.ownerEmails[index])
    ) {
      fail("zero_trust.owner_emails drift against supplied expectations");
    }
  }
}

// Compare a validated profile summary against live readback (for example
// `wrangler whoami` output and Access organization readback). Fail-closed on
// any supplied-field drift. Never embeds account constants.
export function assertOperatorProfileMatchesReadback(summary, readback, label = "live readback") {
  if (!isPlainObject(summary)) fail("profile summary must be an object");
  if (!isPlainObject(readback)) fail(`${label} must be an object`);
  const comparisons = [
    ["accountId", summary.accountId],
    ["accountName", summary.accountName],
    ["operatorEmail", summary.operatorEmail],
    ["hostname", summary.hostname],
    ["workersDevSubdomain", summary.workersDevSubdomain],
    ["teamOrigin", summary.teamOrigin],
  ];
  for (const [key, actual] of comparisons) {
    if (readback[key] !== undefined && readback[key] !== actual) {
      fail(`${label} drift at ${key}: expected ${JSON.stringify(actual)} but received ${JSON.stringify(readback[key])}`);
    }
  }
  if (readback.ownerEmails !== undefined) {
    const expectedOwners = summary.ownerEmails ?? [];
    if (
      !Array.isArray(readback.ownerEmails) ||
      readback.ownerEmails.length !== expectedOwners.length ||
      readback.ownerEmails.some((email, index) => email !== expectedOwners[index])
    ) {
      fail(`${label} drift at ownerEmails against supplied expectations`);
    }
  }
  return true;
}

// Build supplied expectations from explicit env vars (no embedded constants).
export function expectedFromEnv(env = process.env) {
  const expected = {};
  if (env.CLOUDFLARE_ACCOUNT_ID) expected.accountId = String(env.CLOUDFLARE_ACCOUNT_ID).trim();
  if (env.CLOUDFLARE_ACCOUNT_NAME) expected.accountName = String(env.CLOUDFLARE_ACCOUNT_NAME).trim();
  if (env.ELIOTR_OWNER_EMAILS) {
    expected.ownerEmails = String(env.ELIOTR_OWNER_EMAILS).split(",").map((s) => s.trim()).filter(Boolean);
    if (expected.ownerEmails.length === 1) expected.operatorEmail = expected.ownerEmails[0];
  }
  if (env.ELIOTR_OPERATOR_EMAIL) expected.operatorEmail = String(env.ELIOTR_OPERATOR_EMAIL).trim();
  if (env.ELIOTR_WRANGLER_PROFILE) expected.wranglerProfile = String(env.ELIOTR_WRANGLER_PROFILE).trim();
  if (env.ELIOTR_ACCESS_HOSTNAME) expected.hostname = String(env.ELIOTR_ACCESS_HOSTNAME).trim();
  if (env.ELIOTR_ACCESS_TEAM_DOMAIN) expected.teamOrigin = String(env.ELIOTR_ACCESS_TEAM_DOMAIN).trim();
  if (env.ELIOTR_WORKERS_DEV_SUBDOMAIN) expected.workersDevSubdomain = String(env.ELIOTR_WORKERS_DEV_SUBDOMAIN).trim();
  if (env.ELIOTR_WORKER_NAME) expected.workerName = String(env.ELIOTR_WORKER_NAME).trim();
  return expected;
}

export function validateOperatorProfile(profile, expected) {
  if (!isPlainObject(profile)) fail("operator profile must be a JSON object");

  checkAllowedKeys(profile);
  checkShapeInvariants(profile);
  checkSuppliedExpectations(profile, expected);
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

export async function loadOperatorProfile(
  profilePath = DEFAULT_LOCAL_OPERATOR_PROFILE_PATH,
  expected,
) {
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
  return validateOperatorProfile(parsed, expected);
}
