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
const target = desired.instances[0];
assert(target && typeof target.id === "string");
const accountId = "mock-account-ai-search-reconciliation";
let instances = new Map();
let mode = "normal";
let mutations = 0;

function response(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function requestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function providerReadback(spec) {
  const readback = structuredClone(spec.create);
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
  return readback;
}

function reset(nextMode) {
  mode = nextMode;
  mutations = 0;
  instances = new Map(
    desired.instances.map((spec) => [spec.id, providerReadback(spec)]),
  );
  instances.delete(target.id);
}

const namespacePath =
  `/client/v4/accounts/${accountId}/ai-search/namespaces/${desired.namespace}`;
const instanceCollectionPath = `${namespacePath}/instances`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === namespacePath) {
      response(res, 200, {
        success: true,
        result: { id: "namespace-1", name: desired.namespace },
      });
      return;
    }
    if (method === "GET" && url.pathname.startsWith(`${instanceCollectionPath}/`)) {
      const id = decodeURIComponent(
        url.pathname.slice(instanceCollectionPath.length + 1),
      );
      const instance = instances.get(id);
      if (instance === undefined) {
        response(res, 404, {
          success: false,
          errors: [{ code: 1000, message: "not found" }],
          result: null,
        });
      } else {
        response(res, 200, { success: true, result: structuredClone(instance) });
      }
      return;
    }
    if (method === "POST" && url.pathname === instanceCollectionPath) {
      mutations += 1;
      const body = await requestJson(req);
      if (mode === "fail-before-write") {
        response(res, 503, {
          success: false,
          errors: [{ code: 2001, message: "write unavailable" }],
          result: null,
        });
        return;
      }
      const stored = structuredClone(body);
      if (mode === "readback-drift") stored.cache = true;
      instances.set(stored.id, stored);
      if (mode === "lost-acknowledgement") {
        response(res, 504, {
          success: false,
          errors: [{ code: 2002, message: "acknowledgement lost" }],
          result: null,
        });
        return;
      }
      response(res, 200, { success: true, result: structuredClone(stored) });
      return;
    }

    response(res, 404, {
      success: false,
      errors: [{ code: 1000, message: "unexpected route" }],
      result: null,
    });
  } catch (error) {
    response(res, 500, {
      success: false,
      errors: [{ message: error instanceof Error ? error.stack : String(error) }],
      result: null,
    });
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;

function runProvisioner() {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "scripts/provision-ai-search.mjs")],
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

function expectPass(result, disposition) {
  assert.equal(
    result.status,
    0,
    `provisioner failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, new RegExp(`"disposition": "${disposition}"`, "u"));
  assert.equal(mutations, 1, `${disposition} issued more than one POST`);
}
function expectFailure(result, fragment) {
  assert.notEqual(result.status, 0, `${fragment} unexpectedly passed`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(fragment, "u"));
  assert.equal(mutations, 1, `${fragment} issued more than one POST`);
}

try {
  reset("normal");
  expectPass(await runProvisioner(), "CREATED");

  reset("lost-acknowledgement");
  expectPass(await runProvisioner(), "CREATE_RECONCILED");

  reset("fail-before-write");
  expectFailure(await runProvisioner(), "no second create was attempted");
  assert.equal(instances.has(target.id), false);

  reset("readback-drift");
  expectFailure(await runProvisioner(), "post-create readback");

  console.log(
    "AI Search create reconciliation: PASS (exact readback required; lost ACK reconciled; unresolved effects never retried).",
  );
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
