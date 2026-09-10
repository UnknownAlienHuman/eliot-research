import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
const checkOnly = process.argv.includes("--check-only");
const hostname = process.env.ELIOTR_ACCESS_HOSTNAME?.trim().toLowerCase();
const ownerEmails = parseOwnerEmails(process.env.ELIOTR_OWNER_EMAILS);
const allowedAdditionalPolicyIds = new Set((process.env.ELIOTR_ALLOWED_ADDITIONAL_ACCESS_POLICY_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean));

if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}
if (!hostname) {
  console.error("ELIOTR_ACCESS_HOSTNAME is required for a live deployment");
  process.exit(2);
}
validateHostname(hostname);
if (ownerEmails.length === 0) {
  console.error("ELIOTR_OWNER_EMAILS must contain at least one exact owner email");
  process.exit(2);
}

const desired = JSON.parse(await readFile(resolve(repositoryRoot, "infra/cloudflare/access.json"), "utf8"));
if (desired.protocol !== "eliotr.cloudflare-access.v1" || desired.requirements?.hostname_based !== true) {
  throw new Error("unsupported or unsafe Access desired-state manifest");
}
const appName = `${desired.application.name_prefix}: ${hostname}`;
const policyName = desired.policy.name;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

function parseOwnerEmails(value) {
  if (!value) return [];
  const emails = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(emails)];
  for (const email of unique) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`invalid owner email ${email}`);
  }
  return unique.sort();
}

function validateHostname(value) {
  if (value.includes("://") || value.includes("/") || value.startsWith("*") || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)) {
    throw new Error("ELIOTR_ACCESS_HOSTNAME must be one exact lowercase hostname without scheme, path, port, or wildcard");
  }
}

async function request(method, path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload, null, 2)}`);
  }
  return payload.result ?? payload;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}
function equal(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }

function normalizedDestinations(app) {
  const destinations = Array.isArray(app.destinations) ? app.destinations : [];
  return destinations
    .filter((item) => item?.type === "public")
    .map((item) => ({ type: "public", uri: String(item.uri ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase() }))
    .sort((left, right) => left.uri.localeCompare(right.uri));
}

function normalizedEmailIncludes(policy) {
  return (Array.isArray(policy.include) ? policy.include : [])
    .flatMap((rule) => typeof rule?.email?.email === "string" ? [rule.email.email.toLowerCase()] : [])
    .sort();
}

const expectedDestination = [{ type: desired.application.destination_type, uri: hostname }];
const expectedPolicy = {
  name: policyName,
  decision: desired.policy.decision,
  include: ownerEmails.map((email) => ({ email: { email } })),
};

// Hostname-based Access is deliberate. Worker-level Access currently rejects WebSocket upgrades, while
// ResearchSession uses Durable Object WebSockets.
const applicationsResult = await request("GET", `/accounts/${enc(accountId)}/access/apps?per_page=100`);
const applications = Array.isArray(applicationsResult) ? applicationsResult : [];
const exactApps = applications.filter((app) => app.name === appName);
if (exactApps.length > 1) throw new Error(`multiple Access applications named ${appName}`);
let application = exactApps[0] ?? null;
let applicationDisposition = "VERIFIED";
let policyDisposition = "VERIFIED";

if (application) {
  const drift = [];
  if (application.type !== desired.application.type) drift.push({ field: "type", expected: desired.application.type, actual: application.type });
  if ((application.session_duration ?? "24h") !== desired.application.session_duration) drift.push({ field: "session_duration", expected: desired.application.session_duration, actual: application.session_duration });
  if ((application.app_launcher_visible ?? false) !== desired.application.app_launcher_visible) drift.push({ field: "app_launcher_visible", expected: desired.application.app_launcher_visible, actual: application.app_launcher_visible });
  if (!equal(normalizedDestinations(application), expectedDestination)) drift.push({ field: "destinations", expected: expectedDestination, actual: normalizedDestinations(application) });
  if (drift.length > 0) throw new Error(`Access application drift; refusing in-place mutation: ${JSON.stringify(drift, null, 2)}`);
} else if (checkOnly) {
  console.log(JSON.stringify({
    protocol: "eliotr.cloudflare-access-plan.v1",
    mode: "CHECK_ONLY_NO_MUTATION",
    hostname,
    application: { name: appName, disposition: "CREATE" },
    policy: { name: policyName, disposition: "CREATE_INLINE", owner_email_count: ownerEmails.length },
    websocket_compatible_contour: "HOSTNAME_BASED_ACCESS",
  }, null, 2));
  process.exit(0);
} else {
  applicationDisposition = "CREATED";
  policyDisposition = "CREATED_INLINE";
  application = await request("POST", `/accounts/${enc(accountId)}/access/apps`, {
    type: desired.application.type,
    name: appName,
    domain: hostname,
    destinations: expectedDestination,
    session_duration: desired.application.session_duration,
    app_launcher_visible: desired.application.app_launcher_visible,
    policies: [expectedPolicy],
  });
  if (!application?.id) throw new Error("Access application creation readback lacks id");
}

const policiesResult = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(application.id)}/policies`);
let policies = Array.isArray(policiesResult) ? policiesResult : [];

function classifyPolicies(items) {
  const owners = items.filter((item) => item.name === policyName);
  if (owners.length > 1) throw new Error(`multiple Access owner policies named ${policyName}`);
  const additional = items.filter((item) => item.name !== policyName);
  const unapproved = additional.filter((item) => !item.id || !allowedAdditionalPolicyIds.has(item.id));
  if (unapproved.length > 0) {
    throw new Error(`undeclared additional Access policies may broaden access: ${JSON.stringify(unapproved.map((item) => ({ id: item.id ?? null, name: item.name ?? null })))}`);
  }
  return { owner: owners[0] ?? null, additional };
}

let classified = classifyPolicies(policies);
if (!classified.owner && checkOnly) {
  console.log(JSON.stringify({
    protocol: "eliotr.cloudflare-access-plan.v1",
    mode: "CHECK_ONLY_NO_MUTATION",
    hostname,
    application: { id: application.id, name: appName, disposition: "VERIFY" },
    policy: { name: policyName, disposition: "CREATE", owner_email_count: ownerEmails.length },
    approved_additional_policy_count: classified.additional.length,
    websocket_compatible_contour: "HOSTNAME_BASED_ACCESS",
  }, null, 2));
  process.exit(0);
}
if (!classified.owner) {
  await request("POST", `/accounts/${enc(accountId)}/access/apps/${enc(application.id)}/policies`, expectedPolicy);
  policyDisposition = "CREATED";
  const readback = await request("GET", `/accounts/${enc(accountId)}/access/apps/${enc(application.id)}/policies`);
  policies = Array.isArray(readback) ? readback : [];
  classified = classifyPolicies(policies);
}
const policy = classified.owner;
if (!policy) throw new Error("Access owner policy creation readback is missing");
const policyDrift = [];
if (policy.decision !== expectedPolicy.decision) policyDrift.push({ field: "decision", expected: expectedPolicy.decision, actual: policy.decision });
if (!equal(normalizedEmailIncludes(policy), ownerEmails)) policyDrift.push({ field: "include.email", expected: ownerEmails, actual: normalizedEmailIncludes(policy) });
if (Array.isArray(policy.exclude) && policy.exclude.length > 0) policyDrift.push({ field: "exclude", expected: [], actual: policy.exclude });
if (Array.isArray(policy.require) && policy.require.length > 0) policyDrift.push({ field: "require", expected: [], actual: policy.require });
if (policyDrift.length > 0) throw new Error(`Access owner policy drift; refusing in-place mutation: ${JSON.stringify(policyDrift, null, 2)}`);

if (checkOnly) {
  console.log(JSON.stringify({
    protocol: "eliotr.cloudflare-access-plan.v1",
    mode: "CHECK_ONLY_NO_MUTATION",
    hostname,
    application: { id: application.id, name: appName, disposition: "VERIFY" },
    policy: { id: policy.id ?? null, name: policyName, disposition: "VERIFY", owner_email_count: ownerEmails.length },
    approved_additional_policy_count: classified.additional.length,
    websocket_compatible_contour: "HOSTNAME_BASED_ACCESS",
  }, null, 2));
  process.exit(0);
}

const receipt = {
  protocol: "eliotr.cloudflare-access-receipt.v1",
  application: {
    id: application.id,
    name: appName,
    destination: hostname,
    disposition: applicationDisposition,
  },
  policy: {
    id: policy.id ?? null,
    name: policyName,
    owner_email_count: ownerEmails.length,
    owner_email_set_sha256: createHash("sha256").update(ownerEmails.join("\n"), "utf8").digest("hex"),
    disposition: policyDisposition,
  },
  websocket_compatible_contour: "HOSTNAME_BASED_ACCESS",
  approved_additional_policy_count: classified.additional.length,
  approved_additional_policy_ids_sha256: createHash("sha256").update([...allowedAdditionalPolicyIds].sort().join("\n"), "utf8").digest("hex"),
  worker_level_access: "PROHIBITED_FOR_RESEARCH_SESSION_WEBSOCKETS",
  created_at: new Date().toISOString(),
};
const receiptPath = resolve(repositoryRoot, ".eliotr-state/cloudflare-access-receipt.json");
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
