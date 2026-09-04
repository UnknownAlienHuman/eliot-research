import { readFile } from "node:fs/promises";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const apiBase = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
const checkOnly = process.argv.includes("--check-only");
if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}

const desired = JSON.parse(await readFile(new URL("../infra/ai-search/instances.json", import.meta.url), "utf8"));
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const enc = encodeURIComponent;

async function request(method, path, body, allow404 = false) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (allow404 && response.status === 404) return null;
  if (!response.ok || payload.success === false) {
    const details = JSON.stringify(payload.errors ?? payload, null, 2);
    throw new Error(`${method} ${path} failed (${response.status}): ${details}`);
  }
  return payload.result ?? payload;
}

function readPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}
function normalizedMetadata(value) {
  if (!Array.isArray(value)) return value;
  return value
    .map((entry) => ({
      field_name: entry?.field_name,
      data_type: entry?.data_type,
    }))
    .sort((left, right) => String(left.field_name).localeCompare(String(right.field_name)));
}
function normalizedRetrievalOptions(value) {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return {
    ...value,
    boost_by: Array.isArray(value.boost_by) ? value.boost_by : [],
  };
}
function normalizedEnable(instance) {
  const enabled = instance.enable;
  const paused = instance.paused;
  if (typeof enabled === "boolean" && typeof paused === "boolean" && enabled === paused) {
    return { contradiction: { enable: enabled, paused } };
  }
  if (typeof enabled === "boolean") return enabled;
  if (typeof paused === "boolean") return !paused;
  return undefined;
}
function normalizedExisting(instance, path) {
  if (path === "embedding_model") {
    return instance.embedding_model ?? instance.ai_search_model?.embedding_model ?? instance.ai_search_model?.id ?? instance.ai_search_model;
  }
  if (path === "reranking_model") {
    return instance.reranking_model ?? instance.reranker_model ?? instance.reranking?.model;
  }
  if (path === "enable") return normalizedEnable(instance);
  if (path === "custom_metadata") return normalizedMetadata(instance.custom_metadata);
  if (path === "retrieval_options") return normalizedRetrievalOptions(instance.retrieval_options);
  if (path === "type" || path === "source") return instance[path] ?? null;
  return readPath(instance, path);
}
function expectedValue(create, path) {
  if (path === "custom_metadata") return normalizedMetadata(create.custom_metadata);
  if (path === "retrieval_options") return normalizedRetrievalOptions(create.retrieval_options);
  if (path === "type" || path === "source") return null;
  return readPath(create, path);
}
function stable(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}
function equal(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }

const namespacePath = `/accounts/${enc(accountId)}/ai-search/namespaces/${enc(desired.namespace)}`;
const namespace = await request("GET", namespacePath, undefined, true);
if (namespace === null && checkOnly) {
  console.log(JSON.stringify({
    protocol: "eliotr.ai-search-provision-plan.v1",
    mode: "CHECK_ONLY_NO_MUTATION",
    namespace: { name: desired.namespace, disposition: "CREATE" },
    generation: desired.generation,
    instances: desired.instances.map((spec) => ({ id: spec.id, disposition: "CREATE" })),
  }, null, 2));
  process.exit(0);
}
if (namespace === null) {
  await request("POST", `/accounts/${enc(accountId)}/ai-search/namespaces`, {
    name: desired.namespace,
    description: "Eliot Research private managed retrieval namespace",
  });
  console.log(`created AI Search namespace ${desired.namespace}`);
} else {
  console.log(`verified AI Search namespace ${desired.namespace}`);
}

const comparedPaths = [
  "type", "source", "id", "ai_gateway_id", "embedding_model", "index_method",
  "fusion_method", "indexing_options", "retrieval_options", "max_num_results",
  "score_threshold", "reranking", "reranking_model", "rewrite_query", "cache",
  "chunk", "chunk_size", "chunk_overlap", "custom_metadata", "enable",
];
const receipts = [];
for (const spec of desired.instances) {
  const path = `${namespacePath}/instances/${enc(spec.id)}`;
  const existing = await request("GET", path, undefined, true);
  if (existing === null) {
    if (checkOnly) {
      receipts.push({ id: spec.id, disposition: "CREATE" });
      continue;
    }
    await request("POST", `${namespacePath}/instances`, spec.create);
    console.log(`created AI Search instance ${spec.id}`);
    receipts.push({ id: spec.id, disposition: "CREATED" });
    continue;
  }

  const drift = [];
  for (const field of comparedPaths) {
    const expected = expectedValue(spec.create, field);
    const actual = normalizedExisting(existing, field);
    if (!equal(actual, expected)) drift.push({ field, expected: stable(expected), actual: stable(actual) });
  }
  if (drift.length > 0) {
    throw new Error(
      `AI Search instance ${spec.id} differs from generation ${desired.generation}. ` +
      `Do not mutate it in place; create a new generation. Drift: ${JSON.stringify(drift, null, 2)}`,
    );
  }
  console.log(`verified AI Search instance ${spec.id}`);
  receipts.push({ id: spec.id, disposition: "VERIFIED" });
}

console.log(JSON.stringify({
  protocol: checkOnly ? "eliotr.ai-search-provision-plan.v1" : "eliotr.ai-search-provision-receipt.v1",
  mode: checkOnly ? "CHECK_ONLY_NO_MUTATION" : "APPLIED",
  namespace: desired.namespace,
  generation: desired.generation,
  embedding_generation: desired.embedding_generation,
  instances: receipts,
  activation_state: "SHADOW_PENDING_T2_T3_AND_ITEM_COUNT_READBACK",
}, null, 2));
