import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_INSTRUCTION, loadWranglerOAuthCredential, resolveAuthMode,
  scrubTokenEnv, verifyWranglerOAuthAccount, WRANGLER_OAUTH_MODE } from "./lib/cloudflare-wrangler-oauth.mjs";
import { isUsageAdmissionCapability, runUsagePreflight } from "./lib/cloudflare-usage-admission.mjs";
import { assertAiSearchPrebillingManifest, consumeAiSearchPrebillingMetadataPost,
  issueAiSearchPrebillingMetadataCapability } from "./lib/cloudflare-ai-search-prebilling-capability.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Isolated state root for tests: ELIOTR_STATE_DIRECTORY overrides the shared
// gitignored .eliotr-state so parallel/serial runs never communicate through
// leftover receipts. Production default is unchanged.
const stateDirectory = process.env.ELIOTR_STATE_DIRECTORY ? resolve(process.env.ELIOTR_STATE_DIRECTORY) : resolve(repositoryRoot, ".eliotr-state");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
let token = process.env.CLOUDFLARE_API_TOKEN;
const apiBase = process.env.CLOUDFLARE_API_BASE_URL ??
  "https://api.cloudflare.com/client/v4";
const checkOnly = process.argv.includes("--check-only");
const verifyExisting = process.argv.includes("--verify-existing");
const prebillingMetadata = process.argv.includes("--prebilling-metadata-v1");
if (checkOnly && verifyExisting) {
  console.error("--check-only and --verify-existing cannot be used together");
  process.exit(2);
}
if (prebillingMetadata && (checkOnly || verifyExisting)) {
  console.error("--prebilling-metadata-v1 is an explicit create mode and cannot be combined with read-only flags");
  process.exit(2);
}
const showHelp = process.argv.includes("--help") || process.argv.includes("-h");
if (showHelp) {
  console.log("Usage: scripts/provision-ai-search.mjs [--check-only | --verify-existing | --prebilling-metadata-v1] [--help]\nProvisions the AI Search namespace and instances from infra/ai-search/instances.json. --check-only prints the plan with zero mutations. --verify-existing performs GET-only exact readback and fails if the namespace or any desired instance is missing. --prebilling-metadata-v1 allows only the exact namespace and five empty instance metadata POSTs under verified Wrangler OAuth, fresh complete inventory, and a short capability that expires before 2026-10-31T00:00:00Z.");
  process.exitCode = 0;
}
if (!showHelp) {
const namespaceDescription =
  "Eliot Research private managed retrieval namespace";
let authMode = "api-token";
try {
  authMode = resolveAuthMode(process.env);
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exit(2);
}
if (authMode === WRANGLER_OAUTH_MODE) {
  // Direct-invocation OAuth path: bearer stays in process memory only.
  if (!accountId) {
    console.error(`CLOUDFLARE_ACCOUNT_ID is required. ${LOGIN_INSTRUCTION}`);
    process.exit(2);
  }
  try {
    // Verify using Wrangler's official OAuth profile first; whoami may refresh
    // an expired cached token. Only load the resulting bearer afterward.
    const scrubbed = scrubTokenEnv(process.env);
    const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"],
      { cwd: repositoryRoot, env: scrubbed, encoding: "utf8", shell: process.platform === "win32" });
    if (result.error || result.status !== 0) {
      console.error(`Wrangler verification (wrangler whoami exit ${result.status ?? "unknown"}) failed. ${LOGIN_INSTRUCTION}`);
      process.exit(2);
    }
    await verifyWranglerOAuthAccount({ expectedAccountId: accountId, getWhoamiOutput: async () => result.stdout ?? "" });
    const credential = await loadWranglerOAuthCredential({ env: process.env, now: Date.now() });
    token = credential.bearer;
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
} else if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}

// Default apply retains the fresh live-usage admission fence. The explicit
// prebilling mode uses a separate native-OAuth, exact-request capability that
// cannot authorize heavy operations. Read-only modes skip usage collection.
if (!checkOnly && !verifyExisting && !prebillingMetadata) {
  let usageGate;
  try {
    usageGate = await runUsagePreflight({ env: process.env, nowMs: Date.now(), writeReceipt: true,
      receiptPath: resolve(stateDirectory, "cloudflare-usage-admission-receipt.json"), cwd: repositoryRoot });
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
  const admittedWithCapability = usageGate.decision === "ADMITTED" && isUsageAdmissionCapability(usageGate.capability);
  if (usageGate.decision === "BLOCKED" || (!checkOnly && !admittedWithCapability)) {
    console.error(`Cloudflare usage preflight ${usageGate.decision} denies AI Search provisioning before any mutation. ${usageGate.evaluation.reasons.join("; ")}${usageGate.decision === "ADMITTED" ? " Missing same-process admission capability: ADMITTED alone never authorizes mutations." : ""}`);
    process.exit(2);
  }
}

const manifestSource = await readFile(
  new URL("../infra/ai-search/instances.json", import.meta.url),
  "utf8",
);
const desired = JSON.parse(manifestSource);
let prebillingCapability = null;
const prebillingGetPaths = new Set();
if (prebillingMetadata) {
  if (authMode !== WRANGLER_OAUTH_MODE) {
    console.error("--prebilling-metadata-v1 requires verified Wrangler OAuth; static API-token mode is not eligible");
    process.exit(2);
  }
  try {
    prebillingCapability = await issueAiSearchPrebillingMetadataCapability();
    assertAiSearchPrebillingManifest(prebillingCapability, manifestSource);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exit(2);
  }
}
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const enc = encodeURIComponent;
function prebillingDenial(message) {
  const error = new Error(message);
  error.code = "AI_SEARCH_PREBILLING_ADMISSION_DENIED";
  return error;
}

async function request(method, path, body, allow404 = false) {
  if (verifyExisting && method !== "GET") {
    throw new Error(`--verify-existing permits GET requests only; refused ${method} ${path}`);
  }
  if (prebillingMetadata && method !== "GET") {
    if (method !== "POST" || prebillingCapability === null) {
      throw prebillingDenial(`--prebilling-metadata-v1 refused out-of-scope ${method} ${path}`);
    }
    consumeAiSearchPrebillingMetadataPost(prebillingCapability, {
      method,
      path,
      body,
      accountId,
    });
  }
  if (prebillingMetadata && method === "GET" && !prebillingGetPaths.has(path)) {
    throw prebillingDenial(`--prebilling-metadata-v1 refused out-of-scope GET ${path}`);
  }
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (allow404 && response.status === 404) return null;
  if (!response.ok || payload.success === false) {
    const details = JSON.stringify(payload.errors ?? payload, null, 2);
    throw new Error(
      `${method} ${path} failed (${response.status}): ${details}`,
    );
  }
  return payload.result ?? payload;
}

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function normalizedMetadata(value) {
  if (!Array.isArray(value)) return value;
  return value
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? { ...entry }
        : entry,
    )
    .sort((left, right) =>
      String(left?.field_name).localeCompare(String(right?.field_name)),
    );
}

function normalizedRetrievalOptions(value) {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return value;
  }
  return value.boost_by === undefined ? { ...value, boost_by: [] } : { ...value };
}

function normalizedIndexingOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const normalized = { ...value };
  // Current Cloudflare AI Search OpenAPI documents porter and use_ocr=false
  // as defaults, and GET may materialize these defaults or omit them.
  if (normalized.keyword_tokenizer === undefined) normalized.keyword_tokenizer = "porter";
  if (normalized.use_ocr === undefined) normalized.use_ocr = false;
  return normalized;
}

function normalizedEnable(instance) {
  const enabled = instance.enable;
  const paused = instance.paused;
  if (
    typeof enabled === "boolean" &&
    typeof paused === "boolean" &&
    enabled === paused
  ) {
    return { contradiction: { enable: enabled, paused } };
  }
  if (typeof enabled === "boolean") return enabled;
  if (typeof paused === "boolean") return !paused;
  return undefined;
}

function normalizedSyncInterval(instance) {
  const configuredSource = ["type", "source", "source_params", "token_id"]
    .some((key) => instance[key] !== undefined && instance[key] !== null);
  const configuredPublicEndpoint = ["public_endpoint_id", "public_endpoint_params"]
    .some((key) => instance[key] !== undefined && instance[key] !== null);
  const interval = instance.sync_interval ?? null;
  // Cloudflare's current built-in-storage readback materializes its documented
  // 21600-second default even though create requests omit sync_interval. Accept
  // that default only for the source-free, private instance shape in desired
  // state; configured sources, tokens, and public endpoints remain exact drift.
  if (interval === 21600 && !configuredSource && !configuredPublicEndpoint) {
    return null;
  }
  return interval;
}

function normalizedExisting(instance, path) {
  if (path === "namespace") return instance.namespace === undefined ? desired.namespace : instance.namespace;
  if (path === "embedding_model") {
    return instance.embedding_model ??
      instance.ai_search_model?.embedding_model ??
      instance.ai_search_model?.id ??
      instance.ai_search_model;
  }
  if (path === "reranking_model") {
    return instance.reranking_model ??
      instance.reranker_model ??
      instance.reranking?.model;
  }
  if (path === "enable") return normalizedEnable(instance);
  if (path === "custom_metadata") {
    return normalizedMetadata(instance.custom_metadata);
  }
  if (path === "retrieval_options") {
    return normalizedRetrievalOptions(instance.retrieval_options);
  }
  if (path === "indexing_options") return normalizedIndexingOptions(instance.indexing_options);
  if (path === "sync_interval") return normalizedSyncInterval(instance);
  if (path === "type" || path === "source" || path === "source_params" ||
      path === "token_id" || path === "public_endpoint_id" ||
      path === "public_endpoint_params") return instance[path] ?? null;
  return readPath(instance, path);
}

function normalizedExistingForSpec(spec, existing, path) {
  const actual = normalizedExisting(existing, path);
  const create = spec.create;
  if (
    path === "embedding_model" &&
    create.embedding_model === undefined &&
    create.index_method?.vector === false &&
    existing.index_method?.vector === false &&
    actual === "@cf/qwen/qwen3-embedding-0.6b"
  ) return undefined;
  if (
    path === "fusion_method" &&
    create.fusion_method === undefined &&
    actual === "rrf"
  ) return undefined;
  if (
    path === "reranking_model" &&
    create.reranking === false &&
    existing.reranking === false &&
    create.reranking_model === undefined &&
    actual === ""
  ) return undefined;
  return actual;
}

function expectedValue(create, path) {
  if (path === "namespace") return desired.namespace;
  if (path === "custom_metadata") {
    return normalizedMetadata(create.custom_metadata);
  }
  if (path === "retrieval_options") {
    return normalizedRetrievalOptions(create.retrieval_options);
  }
  if (path === "indexing_options") return normalizedIndexingOptions(create.indexing_options);
  if (path === "type" || path === "source" || path === "source_params" ||
      path === "token_id" || path === "sync_interval" || path === "public_endpoint_id" ||
      path === "public_endpoint_params") return null;
  return readPath(create, path);
}

function stable(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function errorDescription(error) {
  return error instanceof Error ? error.message : String(error);
}

const comparedPaths = [
  "type",
  "source",
  "source_params",
  "token_id",
  "sync_interval",
  "id",
  "namespace",
  "public_endpoint_id",
  "public_endpoint_params",
  "ai_gateway_id",
  "embedding_model",
  "index_method",
  "fusion_method",
  "indexing_options",
  "retrieval_options",
  "max_num_results",
  "score_threshold",
  "reranking",
  "reranking_model",
  "rewrite_query",
  "cache",
  "chunk",
  "chunk_size",
  "chunk_overlap",
  "custom_metadata",
  "enable",
];

function configurationDrift(spec, existing) {
  const drift = [];
  for (const field of comparedPaths) {
    // Cloudflare's current instance GET schema and examples omit the
    // create-only `chunk` flag. Compare it whenever a response does expose it;
    // otherwise the GET route cannot report that setting for verification.
    if (field === "chunk" && !Object.hasOwn(existing, "chunk")) continue;
    const expected = expectedValue(spec.create, field);
    const actual = normalizedExistingForSpec(spec, existing, field);
    if (!equal(actual, expected)) {
      drift.push({
        field,
        expected: stable(expected),
        actual: stable(actual),
      });
    }
  }
  return drift;
}

function assertExactInstance(spec, existing, phase) {
  const drift = configurationDrift(spec, existing);
  if (drift.length > 0) {
    throw new Error(
      `AI Search instance ${spec.id} ${phase} differs from generation ` +
        `${desired.generation}. Do not mutate it in place; create a new ` +
        `generation. Drift: ${JSON.stringify(drift, null, 2)}`,
    );
  }
}

function assertExactNamespace(namespace, phase) {
  if (
    typeof namespace !== "object" ||
    namespace === null ||
    Array.isArray(namespace)
  ) {
    throw new Error(`AI Search namespace ${phase} is not an object`);
  }
  const drift = [];
  if (namespace.name !== desired.namespace) {
    drift.push({ field: "name", expected: desired.namespace, actual: stable(namespace.name) });
  }
  if (namespace.description !== namespaceDescription) {
    drift.push({ field: "description", expected: namespaceDescription, actual: stable(namespace.description) });
  }
  if (namespace.public_endpoint_id !== undefined && namespace.public_endpoint_id !== null) {
    drift.push({ field: "public_endpoint_id", expected: null, actual: stable(namespace.public_endpoint_id) });
  }
  if (namespace.public_endpoint_params !== undefined && namespace.public_endpoint_params !== null) {
    drift.push({ field: "public_endpoint_params", expected: null, actual: stable(namespace.public_endpoint_params) });
  }
  if (typeof namespace.created_at !== "string" || !Number.isFinite(Date.parse(namespace.created_at))) {
    drift.push({ field: "created_at", expected: "valid date-time", actual: stable(namespace.created_at) });
  }
  if (drift.length > 0) {
    throw new Error(
      `AI Search namespace ${phase} differs from the requested namespace. ` +
        `Drift: ${JSON.stringify(drift, null, 2)}`,
    );
  }
}

async function reconcileNamespaceCreate(namespacePath, createError) {
  let observed;
  try {
    observed = await request("GET", namespacePath, undefined, true);
  } catch (readError) {
    throw new Error(
      "AI Search namespace create has an unknown effect; authoritative " +
        "readback failed and no second namespace create was attempted. " +
        `Initial create failure: ${errorDescription(createError)}`,
      { cause: readError },
    );
  }
  if (observed === null) {
    throw new Error(
      "AI Search namespace create could not be reconciled; no second " +
        "namespace create was attempted because the first effect is unknown",
      { cause: createError },
    );
  }
  try {
    assertExactNamespace(observed, "post-create readback");
  } catch (readbackError) {
    throw new Error(
      "AI Search namespace create has an unknown effect and post-create " +
        "readback is not exact; no second namespace create was attempted. " +
        `Initial create failure: ${errorDescription(createError)}`,
      { cause: readbackError },
    );
  }
}

async function reconcileInstanceCreate(path, spec, createError) {
  let observed;
  try {
    observed = await request("GET", path, undefined, true);
  } catch (readError) {
    throw new Error(
      `AI Search create for ${spec.id} has an unknown effect; authoritative ` +
        "readback failed and no second create was attempted. " +
        `Initial create failure: ${errorDescription(createError)}`,
      { cause: readError },
    );
  }
  if (observed === null) {
    throw new Error(
      `AI Search create for ${spec.id} could not be reconciled; no second ` +
        "create was attempted because the first create effect is unknown",
      { cause: createError },
    );
  }
  try {
    assertExactInstance(spec, observed, "post-create readback");
  } catch (readbackError) {
    throw new Error(
      `AI Search create for ${spec.id} has an unknown effect and post-create ` +
        "readback is not exact; no second create was attempted. " +
        `Initial create failure: ${errorDescription(createError)}`,
      { cause: readbackError },
    );
  }
}

const namespacePath =
  `/accounts/${enc(accountId)}/ai-search/namespaces/${enc(desired.namespace)}`;
const namespaceCollectionPath =
  `/accounts/${enc(accountId)}/ai-search/namespaces`;
if (prebillingMetadata) {
  prebillingGetPaths.add(namespacePath);
  for (const spec of desired.instances) {
    prebillingGetPaths.add(`${namespacePath}/instances/${enc(spec.id)}`);
  }
}
const namespace = await request("GET", namespacePath, undefined, true);
if (verifyExisting && namespace === null) {
  throw new Error(`--verify-existing found missing resource: AI Search namespace ${desired.namespace}`);
}
let namespaceDisposition;
if (namespace === null && checkOnly) {
  console.log(
    JSON.stringify(
      {
        protocol: "eliotr.ai-search-provision-plan.v1",
        mode: "CHECK_ONLY_NO_MUTATION",
        namespace: desired.namespace,
        namespace_disposition: "CREATE",
        generation: desired.generation,
        instances: desired.instances.map((spec) => ({
          id: spec.id,
          disposition: "CREATE",
        })),
      },
      null,
      2,
    ),
  );
  process.exitCode = 0;
}
if (namespace !== null || !checkOnly) {
if (namespace === null) {
  let createError;
  try {
    await request("POST", namespaceCollectionPath, {
      name: desired.namespace,
      description: namespaceDescription,
    });
  } catch (error) {
    if (error?.code === "AI_SEARCH_PREBILLING_ADMISSION_DENIED") throw error;
    createError = error;
  }

  if (createError !== undefined) {
    await reconcileNamespaceCreate(namespacePath, createError);
    namespaceDisposition = "CREATE_RECONCILED";
    console.log(`reconciled AI Search namespace ${desired.namespace}`);
  } else {
    const created = await request("GET", namespacePath, undefined, true);
    if (created === null) {
      throw new Error(
        `AI Search namespace ${desired.namespace} is absent from ` +
          "post-create readback",
      );
    }
    assertExactNamespace(created, "post-create readback");
    namespaceDisposition = "CREATED";
    console.log(`created and verified AI Search namespace ${desired.namespace}`);
  }
} else {
  assertExactNamespace(namespace, "readback");
  namespaceDisposition = "VERIFIED";
  console.log(`verified AI Search namespace ${desired.namespace}`);
}

const receipts = [];
for (const spec of desired.instances) {
  const path = `${namespacePath}/instances/${enc(spec.id)}`;
  const existing = await request("GET", path, undefined, true);
  if (existing !== null) {
    assertExactInstance(spec, existing, "readback");
    console.log(`verified AI Search instance ${spec.id}`);
    receipts.push({ id: spec.id, disposition: "VERIFIED" });
    continue;
  }
  if (verifyExisting) {
    throw new Error(`--verify-existing found missing resource: AI Search instance ${spec.id}`);
  }
  if (checkOnly) {
    receipts.push({ id: spec.id, disposition: "CREATE" });
    continue;
  }

  let createError;
  try {
    await request("POST", `${namespacePath}/instances`, spec.create);
  } catch (error) {
    if (error?.code === "AI_SEARCH_PREBILLING_ADMISSION_DENIED") throw error;
    createError = error;
  }

  if (createError !== undefined) {
    await reconcileInstanceCreate(path, spec, createError);
    console.log(`reconciled AI Search instance ${spec.id}`);
    receipts.push({ id: spec.id, disposition: "CREATE_RECONCILED" });
    continue;
  }

  const created = await request("GET", path, undefined, true);
  if (created === null) {
    throw new Error(
      `AI Search instance ${spec.id} is absent from post-create readback`,
    );
  }
  assertExactInstance(spec, created, "post-create readback");
  console.log(`created and verified AI Search instance ${spec.id}`);
  receipts.push({ id: spec.id, disposition: "CREATED" });
}

console.log(
  JSON.stringify(
    {
      protocol: checkOnly
        ? "eliotr.ai-search-provision-plan.v1"
        : "eliotr.ai-search-provision-receipt.v1",
      mode: checkOnly ? "CHECK_ONLY_NO_MUTATION" : "APPLIED",
      namespace: desired.namespace,
      namespace_disposition: namespaceDisposition,
      generation: desired.generation,
      embedding_generation: desired.embedding_generation,
      instances: receipts,
      activation_state: "SHADOW_PENDING_T2_T3_AND_ITEM_COUNT_READBACK",
    },
    null,
    2,
  ),
);
}
}
