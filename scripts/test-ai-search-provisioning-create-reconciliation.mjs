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
const accountId = "mock-account-ai-search-create";
const namespacePath =
  `/client/v4/accounts/${accountId}/ai-search/namespaces/${desired.namespace}`;
const first = desired.instances[0];
let mode = "normal";
let instances = new Map();
let postAttempts = 0;
let providerMutations = 0;

function reset(nextMode) {
  mode = nextMode;
  instances = new Map(
    desired.instances.slice(1).map((spec) => [
      spec.id,
      structuredClone(spec.create),
    ]),
  );
  postAttempts = 0;
  providerMutations = 0;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0
    ? undefined
    : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://mock");
    const method = req.method ?? "GET";
    if (method === "GET" && url.pathname === namespacePath) {
      send(res, 200, {
        success: true,
        result: { id: "namespace-1", name: desired.namespace },
      });
      return;
    }

    const instancePrefix = `${namespacePath}/instances/`;
    if (method === "GET" && url.pathname.startsWith(instancePrefix)) {
      const id = decodeURIComponent(url.pathname.slice(instancePrefix.length));
      const item = instances.get(id);
      if (item === undefined) {
        send(res, 404, {
          success: false,
          errors: [{ code: 1000, message: "not found" }],
          result: null,
        });
      } else {
        send(res, 200, { success: true, result: structuredClone(item) });
      }
      return;
    }

    if (method === "POST" && url.pathname === `${namespacePath}/instances`) {
      postAttempts += 1;
      const body = await readBody(req);
      assert.equal(body?.id, first.id, "only the absent first instance may be created");
      if (mode === "lost-before-write") {
        res.destroy();
        return;
      }

      const stored = mode === "drift-after-write"
        ? { ...structuredClone(body), cache: true }
        : structuredClone(body);
      instances.set(body.id, stored);
      providerMutations += 1;
      if (mode === "lost-after-write") {
        res.destroy();
        return;
      }
      send(res, 200, { success: true, result: structuredClone(stored) });
      return;
    }

    send(res, 404, {
      success: false,
      errors: [{ code: 1000, message: `${method} ${url.pathname}` }],
      result: null,
    });
  } catch (error) {
    send(res, 500, {
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

function expectPass(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`,
  );
}
function expectFailure(result, fragment) {
  assert.notEqual(result.status, 0, `${fragment} unexpectedly passed`);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(fragment, "u"));
}

try {
  reset("normal");
  const created = await runProvisioner();
  expectPass(created, "acknowledged create with exact readback");
  assert.match(created.stdout, /"disposition": "CREATED"/u);
  assert.equal(postAttempts, 1);
  assert.equal(providerMutations, 1);

  reset("lost-after-write");
  const reconciled = await runProvisioner();
  expectPass(reconciled, "lost create acknowledgement reconciliation");
  assert.match(reconciled.stdout, /"disposition": "CREATE_RECONCILED"/u);
  assert.equal(postAttempts, 1, "lost acknowledgement caused a second create");
  assert.equal(providerMutations, 1);

  reset("lost-before-write");
  const unresolved = await runProvisioner();
  expectFailure(unresolved, "create outcome is unresolved");
  assert.equal(postAttempts, 1, "unresolved create was retried");
  assert.equal(providerMutations, 0);

  reset("drift-after-write");
  const drifted = await runProvisioner();
  expectFailure(drifted, '\\"field\\": \\"cache\\"');
  assert.equal(postAttempts, 1, "mismatched readback caused a second create");
  assert.equal(providerMutations, 1);

  console.log(
    "AI Search create reconciliation: PASS (exact readback required; lost ACK reconciled; unresolved effect never retried).",
  );
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
