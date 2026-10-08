import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desired = JSON.parse(
  await readFile(resolve(root, "infra/ai-search/instances.json"), "utf8"),
);
const accountId = "mock-account-ai-search-readback";
const first = desired.instances[0];
const literal = desired.instances.find((instance) => instance.id === "private-literal-g2");
assert(literal, "private literal AI Search fixture must exist");
let mode = "compatible";
let mutations = 0;

function response(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function providerReadback(spec = first) {
  const readback = structuredClone(spec.create);
  // Match the current Cloudflare GET schema: it omits the create-only chunk
  // flag, materializes the documented use_ocr=false default, and exposes
  // namespace/public endpoint readback fields.
  delete readback.chunk;
  readback.created_at = "2026-10-03T20:14:14.000Z";
  readback.modified_at = "2026-10-03T20:14:14.000Z";
  readback.namespace = desired.namespace;
  readback.public_endpoint_id = null;
  readback.public_endpoint_params = null;
  readback.sync_interval = 21600;
  if (readback.indexing_options) readback.indexing_options.use_ocr = false;
  if (Array.isArray(readback.custom_metadata)) {
    readback.custom_metadata.reverse();
  }
  if (readback.retrieval_options) {
    delete readback.retrieval_options.boost_by;
  }
  if (typeof readback.enable === "boolean") {
    readback.paused = !readback.enable;
    delete readback.enable;
  }
  if (spec.id === literal.id) {
    // Cloudflare readback supplies defaults omitted by the disabled-vector
    // literal create request and uses an empty model string when reranking is off.
    readback.embedding_model = "@cf/qwen/qwen3-embedding-0.6b";
    readback.fusion_method = "rrf";
    readback.reranking_model = "";
  }
  if (mode === "metadata-drift") {
    readback.custom_metadata[0].field_name = "source_token";
  }
  if (mode === "metadata-shape-drift") {
    readback.custom_metadata[0].forged_authority = true;
  }
  if (mode === "cache-drift") readback.cache = true;
  if (mode === "instance-public-endpoint-drift") {
    readback.public_endpoint_id = "unexpected-endpoint";
    readback.public_endpoint_params = { enabled: true, instances_allowed: [first.id] };
  }
  if (mode === "instance-source-config-drift") {
    readback.type = "r2";
    readback.source = "r2";
    readback.source_params = { prefix: "private/" };
    readback.token_id = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e";
  }
  if (mode === "instance-sync-interval-drift") readback.sync_interval = 900;
  if (mode === "instance-sync-interval-public-endpoint") {
    readback.sync_interval = 21600;
    readback.public_endpoint_id = "unexpected-endpoint";
    readback.public_endpoint_params = { enabled: true, instances_allowed: [first.id] };
  }
  if (spec.id === first.id && mode === "prose-explicit-default-lookalikes") {
    readback.embedding_model = "@cf/unknown/alternate-embedding";
    readback.fusion_method = "max";
    readback.reranking_model = "";
  }
  if (spec.id === literal.id && mode === "literal-embedding-model-drift") {
    readback.embedding_model = "@cf/unknown/alternate-embedding";
  }
  if (spec.id === literal.id && mode === "literal-fusion-default-drift") {
    readback.fusion_method = "linear";
  }
  if (spec.id === literal.id && mode === "literal-reranking-model-drift") {
    readback.reranking_model = "@cf/baai/bge-reranker-base";
  }
  if (spec.id === literal.id && mode === "literal-vector-enabled-default-model") {
    readback.index_method.vector = true;
  }
  if (spec.id === literal.id && mode === "literal-reranking-enabled-empty-model") {
    readback.reranking = true;
  }
  if (mode === "instance-namespace-drift") readback.namespace = "foreign-namespace";
  if (mode === "chunk-drift") readback.chunk = false;
  return readback;
}

function providerNamespaceReadback() {
  const readback = {
    created_at: "2026-10-03T20:14:14.000Z",
    name: desired.namespace,
    description: "Eliot Research private managed retrieval namespace",
    public_endpoint_id: null,
    public_endpoint_params: null,
  };
  if (mode === "namespace-name-drift") readback.name = "foreign-namespace";
  if (mode === "namespace-description-drift") readback.description = "Foreign description";
  if (mode === "namespace-public-endpoint-drift") {
    readback.public_endpoint_id = "unexpected-endpoint";
    readback.public_endpoint_params = { enabled: true, instances_allowed: [] };
  }
  if (mode === "namespace-enabled-params-without-id") {
    readback.public_endpoint_params = { enabled: true, instances_allowed: [] };
  }
  return readback;
}

const namespacePath =
  `/client/v4/accounts/${accountId}/ai-search/namespaces/${desired.namespace}`;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const method = req.method ?? "GET";
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) mutations += 1;

  if (method === "GET" && url.pathname === namespacePath) {
    response(res, 200, {
      success: true,
      result: providerNamespaceReadback(),
    });
    return;
  }
  const instancePrefix = `${namespacePath}/instances/`;
  if (method === "GET" && url.pathname.startsWith(instancePrefix)) {
    const id = decodeURIComponent(url.pathname.slice(instancePrefix.length));
    if (id === first.id || id === literal.id) {
      const spec = id === first.id ? first : literal;
      response(res, 200, { success: true, result: providerReadback(spec) });
    } else {
      response(res, 404, {
        success: false,
        errors: [{ code: 1000, message: "not found" }],
        result: null,
      });
    }
    return;
  }
  response(res, 404, {
    success: false,
    errors: [{ code: 1000, message: "unexpected route" }],
    result: null,
  });
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;

function runProvisioner() {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "scripts/provision-ai-search.mjs"), "--check-only"],
      {
        cwd: root,
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_TOKEN: "mock-token",
          CLOUDFLARE_API_BASE_URL: apiBase,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

function expectPass(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`,
  );
}
function expectDrift(result, field) {
  assert.notEqual(result.status, 0, `${field} drift unexpectedly passed`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(`"field": "${field}"`, "u"));
  return result;
}

try {
  mode = "compatible";
  expectPass(
    await runProvisioner(),
    "provider-compatible metadata order, paused state and omitted empty boosts",
  );
  assert.equal(mutations, 0, "compatible check-only path mutated provider state");

  mode = "literal-embedding-model-drift";
  expectDrift(await runProvisioner(), "embedding_model");
  assert.equal(mutations, 0, "alternate disabled-vector embedding model path mutated provider state");

  mode = "literal-fusion-default-drift";
  expectDrift(await runProvisioner(), "fusion_method");
  assert.equal(mutations, 0, "alternate literal fusion method path mutated provider state");

  mode = "literal-reranking-model-drift";
  expectDrift(await runProvisioner(), "reranking_model");
  assert.equal(mutations, 0, "configured disabled-reranking model path mutated provider state");

  mode = "literal-vector-enabled-default-model";
  const enabledVectorDefault = expectDrift(await runProvisioner(), "index_method");
  assert.match(`${enabledVectorDefault.stdout}\n${enabledVectorDefault.stderr}`, /"field": "embedding_model"/u);
  assert.equal(mutations, 0, "embedding default with vector search enabled mutated provider state");

  mode = "literal-reranking-enabled-empty-model";
  const enabledRerankingEmpty = expectDrift(await runProvisioner(), "reranking");
  assert.match(`${enabledRerankingEmpty.stdout}\n${enabledRerankingEmpty.stderr}`, /"field": "reranking_model"/u);
  assert.equal(mutations, 0, "empty model with reranking enabled mutated provider state");

  mode = "prose-explicit-default-lookalikes";
  const explicitProseDrift = expectDrift(await runProvisioner(), "embedding_model");
  for (const field of ["fusion_method", "reranking_model"]) {
    assert.match(`${explicitProseDrift.stdout}\n${explicitProseDrift.stderr}`, new RegExp(`"field": "${field}"`, "u"));
  }
  assert.equal(mutations, 0, "explicit prose model/fusion configuration drift mutated provider state");

  mode = "instance-sync-interval-drift";
  expectDrift(await runProvisioner(), "sync_interval");
  assert.equal(mutations, 0, "non-default sync interval path mutated provider state");

  mode = "instance-sync-interval-public-endpoint";
  expectDrift(await runProvisioner(), "public_endpoint_id");
  assert.equal(mutations, 0, "public endpoint path with default sync interval mutated provider state");

  mode = "metadata-drift";
  expectDrift(await runProvisioner(), "custom_metadata");
  assert.equal(mutations, 0, "metadata drift path mutated provider state");

  mode = "metadata-shape-drift";
  expectDrift(await runProvisioner(), "custom_metadata");
  assert.equal(mutations, 0, "metadata shape drift path mutated provider state");

  mode = "cache-drift";
  expectDrift(await runProvisioner(), "cache");
  assert.equal(mutations, 0, "cache drift path mutated provider state");

  mode = "namespace-name-drift";
  expectDrift(await runProvisioner(), "name");
  assert.equal(mutations, 0, "namespace name drift path mutated provider state");

  mode = "namespace-description-drift";
  expectDrift(await runProvisioner(), "description");
  assert.equal(mutations, 0, "namespace description drift path mutated provider state");

  mode = "namespace-public-endpoint-drift";
  expectDrift(await runProvisioner(), "public_endpoint_id");
  assert.equal(mutations, 0, "namespace endpoint drift path mutated provider state");

  mode = "namespace-enabled-params-without-id";
  expectDrift(await runProvisioner(), "public_endpoint_params");
  assert.equal(mutations, 0, "namespace enabled endpoint params path mutated provider state");

  mode = "instance-public-endpoint-drift";
  expectDrift(await runProvisioner(), "public_endpoint_id");
  assert.equal(mutations, 0, "instance endpoint drift path mutated provider state");

  mode = "instance-namespace-drift";
  expectDrift(await runProvisioner(), "namespace");
  assert.equal(mutations, 0, "instance namespace drift path mutated provider state");

  mode = "instance-source-config-drift";
  const sourceConfigDrift = expectDrift(await runProvisioner(), "source_params");
  assert.match(`${sourceConfigDrift.stdout}\n${sourceConfigDrift.stderr}`, /"field": "type"/u);
  assert.match(`${sourceConfigDrift.stdout}\n${sourceConfigDrift.stderr}`, /"field": "source"/u);
  assert.match(`${sourceConfigDrift.stdout}\n${sourceConfigDrift.stderr}`, /"field": "token_id"/u);
  assert.match(`${sourceConfigDrift.stdout}\n${sourceConfigDrift.stderr}`, /"field": "sync_interval"/u);
  assert.equal(mutations, 0, "instance source configuration drift path mutated provider state");

  mode = "chunk-drift";
  expectDrift(await runProvisioner(), "chunk");
  assert.equal(mutations, 0, "reported chunk drift path mutated provider state");

  console.log(
    "AI Search provisioning readback: PASS (documented instance defaults accepted only for matching source-free/disabled literal configuration; alternate config, identity and endpoint drift rejected before mutation).",
  );
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
