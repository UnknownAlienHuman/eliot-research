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
const namespaceCollectionPath =
  `/client/v4/accounts/${accountId}/ai-search/namespaces`;
const namespacePath = `${namespaceCollectionPath}/${desired.namespace}`;
const instanceCollectionPath = `${namespacePath}/instances`;
let namespaceRecord = null;
let instances = new Map();
let namespaceMode = "normal";
let instanceMode = "normal";
let namespaceMutations = 0;
let instanceMutations = 0;

function response(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res, message = "not found") {
  response(res, 404, {
    success: false,
    errors: [{ code: 1000, message }],
    result: null,
  });
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

function exactNamespace() {
  return {
    id: "namespace-1",
    name: desired.namespace,
    description: "Eliot Research private managed retrieval namespace",
  };
}

function allInstances() {
  return new Map(
    desired.instances.map((spec) => [spec.id, providerReadback(spec)]),
  );
}

function resetNamespace(nextMode) {
  namespaceMode = nextMode;
  instanceMode = "normal";
  namespaceRecord = null;
  instances = allInstances();
  namespaceMutations = 0;
  instanceMutations = 0;
}

function resetInstance(nextMode) {
  namespaceMode = "normal";
  instanceMode = nextMode;
  namespaceRecord = exactNamespace();
  instances = allInstances();
  instances.delete(target.id);
  namespaceMutations = 0;
  instanceMutations = 0;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === namespacePath) {
      if (namespaceRecord === null) {
        notFound(res);
      } else {
        response(res, 200, {
          success: true,
          result: structuredClone(namespaceRecord),
        });
      }
      return;
    }

    if (method === "POST" && url.pathname === namespaceCollectionPath) {
      namespaceMutations += 1;
      const body = await requestJson(req);
      assert.equal(body?.name, desired.namespace);
      if (namespaceMode === "fail-before-write") {
        res.destroy();
        return;
      }
      namespaceRecord = {
        id: "namespace-1",
        name: namespaceMode === "readback-drift"
          ? "foreign-namespace"
          : body.name,
        description: body.description,
      };
      if (namespaceMode === "lost-acknowledgement") {
        res.destroy();
        return;
      }
      response(res, 200, {
        success: true,
        result: structuredClone(namespaceRecord),
      });
      return;
    }

    if (
      method === "GET" &&
      url.pathname.startsWith(`${instanceCollectionPath}/`)
    ) {
      const id = decodeURIComponent(
        url.pathname.slice(instanceCollectionPath.length + 1),
      );
      const instance = instances.get(id);
      if (instance === undefined) {
        notFound(res);
      } else {
        response(res, 200, {
          success: true,
          result: structuredClone(instance),
        });
      }
      return;
    }

    if (method === "POST" && url.pathname === instanceCollectionPath) {
      instanceMutations += 1;
      const body = await requestJson(req);
      assert.equal(body?.id, target.id);
      if (instanceMode === "fail-before-write") {
        res.destroy();
        return;
      }
      const stored = structuredClone(body);
      if (instanceMode === "readback-drift") stored.cache = true;
      instances.set(stored.id, stored);
      if (instanceMode === "lost-acknowledgement") {
        res.destroy();
        return;
      }
      response(res, 200, {
        success: true,
        result: structuredClone(stored),
      });
      return;
    }

    notFound(res, `${method} ${url.pathname}`);
  } catch (error) {
    response(res, 500, {
      success: false,
      errors: [{
        message: error instanceof Error ? error.stack : String(error),
      }],
      result: null,
    });
  }
});

await new Promise((resolveListen) =>
  server.listen(0, "127.0.0.1", resolveListen),
);
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
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveRun({
        status: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.stack ?? String(error)}`,
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

function expectPass(result, field, disposition) {
  assert.equal(
    result.status,
    0,
    `provisioner failed (signal=${result.signal ?? "none"})\n` +
      `${result.stdout}\n${result.stderr}`,
  );
  assert.match(
    result.stdout,
    new RegExp(`"${field}": "${disposition}"`, "u"),
  );
}

function expectFailure(result, fragment) {
  assert.notEqual(result.status, 0, `${fragment} unexpectedly passed`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(fragment, "u"),
  );
}

function expectMutationCounts(namespaceCount, instanceCount, label) {
  assert.equal(
    namespaceMutations,
    namespaceCount,
    `${label} issued an unexpected namespace POST count`,
  );
  assert.equal(
    instanceMutations,
    instanceCount,
    `${label} issued an unexpected instance POST count`,
  );
}

try {
  resetNamespace("normal");
  expectPass(await runProvisioner(), "namespace_disposition", "CREATED");
  expectMutationCounts(1, 0, "acknowledged namespace create");

  resetNamespace("lost-acknowledgement");
  expectPass(
    await runProvisioner(),
    "namespace_disposition",
    "CREATE_RECONCILED",
  );
  expectMutationCounts(1, 0, "lost namespace acknowledgement");

  resetNamespace("fail-before-write");
  expectFailure(
    await runProvisioner(),
    "no second namespace create was attempted",
  );
  expectMutationCounts(1, 0, "unresolved namespace create");
  assert.equal(namespaceRecord, null);

  resetNamespace("readback-drift");
  expectFailure(await runProvisioner(), "namespace post-create readback");
  expectMutationCounts(1, 0, "drifted namespace readback");

  resetInstance("normal");
  expectPass(await runProvisioner(), "disposition", "CREATED");
  expectMutationCounts(0, 1, "acknowledged instance create");

  resetInstance("lost-acknowledgement");
  expectPass(await runProvisioner(), "disposition", "CREATE_RECONCILED");
  expectMutationCounts(0, 1, "lost instance acknowledgement");

  resetInstance("fail-before-write");
  expectFailure(await runProvisioner(), "no second create was attempted");
  expectMutationCounts(0, 1, "unresolved instance create");
  assert.equal(instances.has(target.id), false);

  resetInstance("readback-drift");
  expectFailure(await runProvisioner(), "post-create readback");
  expectMutationCounts(0, 1, "drifted instance readback");

  console.log(
    "AI Search create reconciliation: PASS (namespace and instance exact " +
      "readback required; lost ACK reconciled; unresolved effects never retried).",
  );
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) =>
      error ? rejectClose(error) : resolveClose(),
    );
  });
}
