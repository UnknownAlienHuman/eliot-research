import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAccessRuntimeVars, validateAccessRuntimeConfiguration } from "./lib/access-runtime-config.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
const checkOnly = process.argv.includes("--check-only");

if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}

const desiredPath = resolve(repositoryRoot, "infra/cloudflare/resources.json");
const desired = JSON.parse(await readFile(desiredPath, "utf8"));
const canonicalPath = resolve(repositoryRoot, desired.worker.canonical_config);
const generatedPath = resolve(repositoryRoot, desired.worker.generated_config);
const receiptPath = resolve(repositoryRoot, desired.worker.receipt);
const canonicalConfig = parseStrictJsonCompatibleJsonc(await readFile(canonicalPath, "utf8"), desired.worker.canonical_config);
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

function parseStrictJsonCompatibleJsonc(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must remain strict-JSON-compatible JSONC so the audited deploy generator can parse it without executing code: ${error.message}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function request(method, path, { body, extraHeaders, allow404 = false } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (allow404 && response.status === 404) return null;
  if (!response.ok || payload.success === false) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload, null, 2)}`);
  }
  return payload.result ?? payload;
}

function assertManifest() {
  if (desired.protocol !== "eliotr.cloudflare-foundation.v1") throw new Error(`unsupported foundation protocol ${desired.protocol}`);
  assertNonEmptyString(desired.generation, "generation");
  assertNonEmptyString(desired.worker?.name, "worker.name");
  assertUnique(desired.d1_databases.map((item) => assertNonEmptyString(item.name, "D1 name")), "D1 name");
  assertUnique(desired.d1_databases.map((item) => assertNonEmptyString(item.binding, "D1 binding")), "D1 binding");
  assertUnique(desired.r2_buckets.map((item) => assertNonEmptyString(item.name, "R2 name")), "R2 name");
  assertUnique(desired.r2_buckets.map((item) => assertNonEmptyString(item.binding, "R2 binding")), "R2 binding");
  assertUnique(desired.queues.map((item) => assertNonEmptyString(item.name, "Queue name")), "Queue name");
  const primary = desired.queues.filter((item) => item.role === "primary");
  const deadLetters = desired.queues.filter((item) => item.role === "dead_letter");
  if (primary.length !== 1 || deadLetters.length !== 1) throw new Error("exactly one primary Queue and one dead-letter Queue are required");
  if (!primary[0].binding) throw new Error("primary Queue requires a Worker binding");
}

function assertCanonicalBindingAlignment() {
  const canonicalD1 = new Map((canonicalConfig.d1_databases ?? []).map((item) => [item.binding, item]));
  const canonicalR2 = new Map((canonicalConfig.r2_buckets ?? []).map((item) => [item.binding, item]));
  const canonicalQueues = new Map((canonicalConfig.queues?.producers ?? []).map((item) => [item.binding, item]));

  for (const spec of desired.d1_databases) {
    const item = canonicalD1.get(spec.binding);
    if (!item || item.database_name !== spec.name) throw new Error(`canonical D1 binding ${spec.binding} must name ${spec.name}`);
  }
  for (const spec of desired.r2_buckets) {
    const item = canonicalR2.get(spec.binding);
    if (!item || item.bucket_name !== spec.name) throw new Error(`canonical R2 binding ${spec.binding} must name ${spec.name}`);
  }
  for (const spec of desired.queues.filter((item) => item.binding)) {
    const item = canonicalQueues.get(spec.binding);
    if (!item || item.queue !== spec.name) throw new Error(`canonical Queue binding ${spec.binding} must name ${spec.name}`);
  }
  const expectedDlq = desired.queues.find((item) => item.role === "dead_letter")?.name;
  const consumers = canonicalConfig.queues?.consumers ?? [];
  if (consumers.length !== 1 || consumers[0].queue !== desired.queues.find((item) => item.role === "primary")?.name || consumers[0].dead_letter_queue !== expectedDlq) {
    throw new Error("canonical Queue consumer must bind the desired primary Queue and DLQ exactly");
  }
}

async function inspectD1(spec) {
  const result = await request("GET", `/accounts/${enc(accountId)}/d1/database?name=${enc(spec.name)}&per_page=100`);
  const exact = (Array.isArray(result) ? result : []).filter((item) => item.name === spec.name);
  if (exact.length > 1) throw new Error(`multiple D1 databases named ${spec.name}; refusing ambiguous binding`);
  const existing = exact[0] ?? null;
  if (existing && (typeof existing.uuid !== "string" || existing.uuid.trim() === "")) {
    throw new Error(`D1 ${spec.name} readback lacks a stable uuid`);
  }
  if (existing && spec.jurisdiction !== undefined && (existing.jurisdiction ?? null) !== spec.jurisdiction) {
    throw new Error(`D1 ${spec.name} jurisdiction drift: expected ${spec.jurisdiction}, got ${existing.jurisdiction ?? "default"}`);
  }
  return { spec, existing };
}

async function inspectR2(spec) {
  const jurisdiction = spec.jurisdiction ?? "default";
  const existing = await request("GET", `/accounts/${enc(accountId)}/r2/buckets/${enc(spec.name)}`, {
    allow404: true,
    extraHeaders: { "cf-r2-jurisdiction": jurisdiction },
  });
  if (existing) {
    const actualJurisdiction = existing.jurisdiction ?? "default";
    const actualStorageClass = existing.storage_class ?? "Standard";
    if (actualJurisdiction !== jurisdiction || actualStorageClass !== spec.storage_class) {
      throw new Error(`R2 ${spec.name} immutable profile drift: expected ${jurisdiction}/${spec.storage_class}, got ${actualJurisdiction}/${actualStorageClass}`);
    }
  }
  return { spec, existing };
}

async function inspectQueues() {
  const result = await request("GET", `/accounts/${enc(accountId)}/queues`);
  const existingQueues = Array.isArray(result) ? result : [];
  return desired.queues.map((spec) => {
    const exact = existingQueues.filter((item) => item.queue_name === spec.name);
    if (exact.length > 1) throw new Error(`multiple Queues named ${spec.name}; refusing ambiguous binding`);
    const existing = exact[0] ?? null;
    if (existing && (typeof existing.queue_id !== "string" || existing.queue_id.trim() === "")) {
      throw new Error(`Queue ${spec.name} readback lacks a stable queue_id`);
    }
    return { spec, existing };
  });
}

async function createD1(plan) {
  if (plan.existing) return { ...plan, disposition: "VERIFIED" };
  const body = { name: plan.spec.name };
  if (plan.spec.jurisdiction !== undefined) body.jurisdiction = plan.spec.jurisdiction;
  const existing = await request("POST", `/accounts/${enc(accountId)}/d1/database`, { body });
  if (!existing?.uuid) throw new Error(`D1 ${plan.spec.name} creation readback lacks uuid`);
  return { ...plan, existing, disposition: "CREATED" };
}

async function createR2(plan) {
  if (plan.existing) return { ...plan, disposition: "VERIFIED" };
  const jurisdiction = plan.spec.jurisdiction ?? "default";
  const body = { name: plan.spec.name, storageClass: plan.spec.storage_class };
  if (plan.spec.location_hint) body.locationHint = plan.spec.location_hint;
  const existing = await request("POST", `/accounts/${enc(accountId)}/r2/buckets`, {
    body,
    extraHeaders: { "cf-r2-jurisdiction": jurisdiction },
  });
  if (existing?.name !== plan.spec.name) throw new Error(`R2 ${plan.spec.name} creation readback mismatch`);
  return { ...plan, existing, disposition: "CREATED" };
}

async function createQueue(plan) {
  if (plan.existing) return { ...plan, disposition: "VERIFIED" };
  const existing = await request("POST", `/accounts/${enc(accountId)}/queues`, { body: { queue_name: plan.spec.name } });
  if (existing?.queue_name !== plan.spec.name || !existing?.queue_id) throw new Error(`Queue ${plan.spec.name} creation readback mismatch`);
  return { ...plan, existing, disposition: "CREATED" };
}

function validatePublicRouteConfiguration() {
  const accessHostname = assertNonEmptyString(process.env.ELIOTR_ACCESS_HOSTNAME, "ELIOTR_ACCESS_HOSTNAME").trim().toLowerCase();
  validateHostname(accessHostname, "ELIOTR_ACCESS_HOSTNAME");
  const customDomainMode = process.env.ELIOTR_CUSTOM_DOMAIN;
  if (customDomainMode !== "0" && customDomainMode !== "1") {
    throw new Error("ELIOTR_CUSTOM_DOMAIN must be explicitly set to 0 (one protected workers.dev hostname) or 1 (one protected Custom Domain)");
  }
  if (customDomainMode === "1") {
    if (accessHostname.endsWith(".workers.dev")) throw new Error("ELIOTR_CUSTOM_DOMAIN=1 requires a non-workers.dev hostname");
  } else {
    const expectedPrefix = `${desired.worker.name}.`;
    if (!accessHostname.startsWith(expectedPrefix) || !accessHostname.endsWith(".workers.dev")) {
      throw new Error(`ELIOTR_CUSTOM_DOMAIN=0 requires the exact ${desired.worker.name}.<account-subdomain>.workers.dev hostname`);
    }
  }
  return { accessHostname, customDomainMode };
}

function buildGeneratedConfig(d1Results, publicRoute, accessRuntime) {
  const generated = structuredClone(canonicalConfig);
  const ids = new Map(d1Results.map((item) => [item.spec.binding, item.existing.uuid]));
  generated.d1_databases = generated.d1_databases.map((item) => {
    const databaseId = ids.get(item.binding);
    if (!databaseId) throw new Error(`no provisioned D1 id for binding ${item.binding}`);
    return { ...item, database_id: databaseId };
  });

  const environment = process.env.ELIOTR_ENVIRONMENT ?? "production";
  if (!["development", "staging", "production"].includes(environment)) throw new Error(`invalid ELIOTR_ENVIRONMENT ${environment}`);
  const deploymentGeneration = assertNonEmptyString(process.env.ELIOTR_DEPLOYMENT_GENERATION, "ELIOTR_DEPLOYMENT_GENERATION");
  generated.vars = applyAccessRuntimeVars({
    ...generated.vars,
    ENVIRONMENT: environment,
    DEPLOYMENT_GENERATION: deploymentGeneration,
    AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/eliotr-reasoning`,
    AI_GATEWAY_RETRIEVAL_URL: `https://gateway.ai.cloudflare.com/v1/${accountId}/eliotr-retrieval`,
  }, accessRuntime);

  if (publicRoute.customDomainMode === "1") {
    generated.routes = [{ pattern: publicRoute.accessHostname, custom_domain: true }];
    generated.workers_dev = false;
  } else {
    delete generated.routes;
    generated.workers_dev = true;
  }
  generated.preview_urls = false;
  return generated;
}

function validateHostname(hostname, label) {
  if (hostname.includes("://") || hostname.includes("/") || hostname.startsWith("*") || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) {
    throw new Error(`${label} must be one exact lowercase hostname without scheme, path, port, or wildcard`);
  }
}

assertManifest();
assertCanonicalBindingAlignment();
const publicRoute = validatePublicRouteConfiguration();
const accessRuntime = validateAccessRuntimeConfiguration(process.env);

// Inspect every existing resource before creating any missing resource. An immutable-profile drift in
// a later resource therefore cannot leave a partially-created environment.
const d1Plans = await Promise.all(desired.d1_databases.map(inspectD1));
const r2Plans = await Promise.all(desired.r2_buckets.map(inspectR2));
const queuePlans = await inspectQueues();

if (checkOnly) {
  console.log(JSON.stringify({
    protocol: "eliotr.cloudflare-foundation-plan.v1",
    desired_generation: desired.generation,
    mode: "CHECK_ONLY_NO_MUTATION",
    access_runtime: {
      team_domain: accessRuntime.teamDomain,
      audience_configured: true,
      service_principal_count: accessRuntime.servicePrincipalCount,
    },
    d1_databases: d1Plans.map((item) => ({ binding: item.spec.binding, name: item.spec.name, disposition: item.existing ? "VERIFY" : "CREATE" })),
    r2_buckets: r2Plans.map((item) => ({ binding: item.spec.binding, name: item.spec.name, disposition: item.existing ? "VERIFY" : "CREATE" })),
    queues: queuePlans.map((item) => ({ binding: item.spec.binding ?? null, name: item.spec.name, disposition: item.existing ? "VERIFY" : "CREATE" })),
  }, null, 2));
  process.exit(0);
}

const d1Results = [];
for (const plan of d1Plans) d1Results.push(await createD1(plan));
const r2Results = [];
for (const plan of r2Plans) r2Results.push(await createR2(plan));
const queueResults = [];
for (const plan of queuePlans) queueResults.push(await createQueue(plan));

const generatedConfig = buildGeneratedConfig(d1Results, publicRoute, accessRuntime);
await mkdir(dirname(generatedPath), { recursive: true });
await writeFile(generatedPath, `${JSON.stringify(generatedConfig, null, 2)}\n`, { mode: 0o600 });

const receipt = {
  protocol: "eliotr.cloudflare-foundation-receipt.v1",
  desired_generation: desired.generation,
  deployment_generation: generatedConfig.vars.DEPLOYMENT_GENERATION,
  environment: generatedConfig.vars.ENVIRONMENT,
  generated_config: desired.worker.generated_config,
  account_ref: `cloudflare-account:${accountId.slice(0, 6)}…${accountId.slice(-4)}`,
  d1_databases: d1Results.map((item) => ({ binding: item.spec.binding, name: item.spec.name, database_id: item.existing.uuid, disposition: item.disposition })),
  r2_buckets: r2Results.map((item) => ({ binding: item.spec.binding, name: item.spec.name, jurisdiction: item.spec.jurisdiction ?? "default", storage_class: item.spec.storage_class, disposition: item.disposition })),
  queues: queueResults.map((item) => ({ binding: item.spec.binding ?? null, name: item.spec.name, queue_id: item.existing.queue_id, role: item.spec.role, disposition: item.disposition })),
  access_hostname: publicRoute.accessHostname,
  access_team_domain: generatedConfig.vars.ACCESS_TEAM_DOMAIN,
  access_audience_configured: generatedConfig.vars.ACCESS_AUDIENCE.length > 0,
  access_service_principal_count: accessRuntime.servicePrincipalCount,
  public_route_mode: publicRoute.customDomainMode === "1" ? "CUSTOM_DOMAIN_ONLY" : "WORKERS_DEV_ONLY",
  alternative_public_routes: "PROHIBITED",
  access_provisioning: "SEPARATE_REQUIRED_GATE",
  created_at: new Date().toISOString(),
};
await mkdir(dirname(receiptPath), { recursive: true });
await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(receipt, null, 2));
