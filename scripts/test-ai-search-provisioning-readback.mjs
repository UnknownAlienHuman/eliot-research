import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desired = JSON.parse(
  await readFile(resolve(root, "infra/ai-search/instances.json"), "utf8"),
);
const accountId = "mock-account-ai-search-readback";
const first = desired.instances[0];
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

function providerReadback() {
  const readback = structuredClone(first.create);
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
  if (mode === "metadata-drift") {
    readback.custom_metadata[0].field_name = "source_token";
  }
  if (mode === "cache-drift") readback.cache = true;
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
      result: { id: "namespace-1", name: desired.namespace },
    });
    return;
  }
  const instancePrefix = `${namespacePath}/instances/`;
  if (method === "GET" && url.pathname.startsWith(instancePrefix)) {
    const id = decodeURIComponent(url.pathname.slice(instancePrefix.length));
    if (id === first.id) {
      response(res, 200, { success: true, result: providerReadback() });
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
}

try {
  mode = "compatible";
  expectPass(
    await runProvisioner(),
    "provider-compatible metadata order, paused state and omitted empty boosts",
  );
  assert.equal(mutations, 0, "compatible check-only path mutated provider state");

  mode = "metadata-drift";
  expectDrift(await runProvisioner(), "custom_metadata");
  assert.equal(mutations, 0, "metadata drift path mutated provider state");

  mode = "cache-drift";
  expectDrift(await runProvisioner(), "cache");
  assert.equal(mutations, 0, "cache drift path mutated provider state");

  console.log(
    "AI Search provisioning readback: PASS (compatible variants normalized; metadata/cache drift rejected before mutation).",
  );
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
