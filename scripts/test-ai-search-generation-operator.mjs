import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desired = JSON.parse(
  await readFile(resolve(root, "infra/ai-search/instances.json"), "utf8"),
);
const accountId = "mock-generation-account";
const databaseId = "mock-generation-database";
const apiToken = "mock-generation-token";
const stateRoot = await mkdtemp(resolve(tmpdir(), "eliotr-generation-operator-"));
let database;
let mode = "normal";
let requests = 0;
let writeAttempts = 0;
let appliedWrites = 0;

async function ensureCloudflareAiBuild() {
  try {
    await access(resolve(root, "packages/cloudflare-ai/dist/index.js"));
    return;
  } catch {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "tsc",
        "-b",
        "packages/cloudflare-ai/tsconfig.json",
        "--pretty",
        "false",
      ],
      { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
    );
    assert.equal(
      result.status,
      0,
      `failed to build @eliotr/cloudflare-ai\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function freshDatabase() {
  database?.close();
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const directory = resolve(root, "infra/d1/search/migrations");
  return readdir(directory).then(async (names) => {
    for (const name of names.filter((value) => /^\d+_.*\.sql$/u.test(value)).sort()) {
      database.exec(await readFile(resolve(directory, name), "utf8"));
    }
    mode = "normal";
    requests = 0;
    writeAttempts = 0;
    appliedWrites = 0;
  });
}

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
  return chunks.length === 0
    ? null
    : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const queryPath =
  `/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
const server = createServer(async (req, res) => {
  try {
    requests += 1;
    const url = new URL(req.url ?? "/", "http://mock");
    if (
      req.method !== "POST" ||
      url.pathname !== queryPath ||
      req.headers.authorization !== `Bearer ${apiToken}`
    ) {
      response(res, 404, {
        success: false,
        errors: [{ code: 1000, message: "unexpected request" }],
        result: null,
      });
      return;
    }
    const body = await requestJson(req);
    assert(body && typeof body.sql === "string" && Array.isArray(body.params));
    const mutation = /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(body.sql);
    if (mutation) writeAttempts += 1;

    if (mutation && mode === "fail-before-write") {
      mode = "normal";
      response(res, 503, {
        success: false,
        errors: [{ code: 2001, message: "write unavailable" }],
        result: null,
      });
      return;
    }

    const statement = database.prepare(body.sql);
    const rows = statement.all(...body.params);
    if (mutation && rows.length > 0) appliedWrites += 1;

    if (mutation && mode === "lost-acknowledgement") {
      mode = "normal";
      response(res, 504, {
        success: false,
        errors: [{ code: 2002, message: "acknowledgement lost" }],
        result: null,
      });
      return;
    }

    response(res, 200, {
      success: true,
      errors: [],
      messages: [],
      result: [{ success: true, results: rows, meta: {} }],
    });
  } catch (error) {
    response(res, 400, {
      success: false,
      errors: [{ code: 3000, message: error instanceof Error ? error.message : String(error) }],
      result: null,
    });
  }
});

await ensureCloudflareAiBuild();
await freshDatabase();
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert(address && typeof address === "object");
const apiBase = `http://127.0.0.1:${address.port}/client/v4`;

function run(command, args = [], stateName = "default") {
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "scripts/manage-ai-search-generation.mjs"),
        command,
        "--database-id",
        databaseId,
        "--api-base-url",
        apiBase,
        "--state-directory",
        resolve(stateRoot, stateName),
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_TOKEN: apiToken,
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
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

function parsedSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed (signal=${result.signal ?? "none"})\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

function parsedFailure(result, code, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  const document = JSON.parse(result.stderr);
  assert.equal(document.error.code, code, result.stderr);
  return document;
}

const T0 = "2026-09-04T03:00:00.000Z";
const T1 = "2026-09-04T03:01:00.000Z";
const T2 = "2026-09-04T03:02:00.000Z";
const T3 = "2026-09-04T03:03:00.000Z";

try {
  const empty = parsedSuccess(await run("status"), "empty status");
  assert.equal(empty.registry_snapshot, null);
  assert.equal(requests, 1);
  assert.equal(writeAttempts, 0);

  const beforeUnconfirmed = requests;
  parsedFailure(
    await run("declare", [
      "--expected-item-count", "2",
      "--declared-at", T0,
    ]),
    "AI_SEARCH_GENERATION_OPERATOR_INPUT_INVALID",
    "unconfirmed declaration",
  );
  assert.equal(requests, beforeUnconfirmed, "unconfirmed mutation contacted D1");

  const declared = parsedSuccess(await run("declare", [
    "--expected-item-count", "2",
    "--declared-at", T0,
    "--confirm-live",
  ]), "declaration");
  assert.equal(declared.persistence_receipt.disposition, "CREATED");
  assert.equal(declared.persistence_receipt.revision, 1);
  assert.equal(writeAttempts, 1);
  assert.equal(appliedWrites, 1);

  const replay = parsedSuccess(await run("declare", [
    "--expected-item-count", "2",
    "--declared-at", T0,
    "--confirm-live",
  ]), "declaration replay");
  assert.equal(replay.persistence_receipt.disposition, "EXISTING");
  assert.equal(writeAttempts, 1, "exact declaration replay issued another CAS");

  const partial = parsedSuccess(await run("observe", [
    "--indexed-item-count", "1",
    "--readback-item-count", "1",
    "--failed-item-count", "0",
    "--mismatch-count", "0",
    "--observed-at", T1,
    "--confirm-live",
  ]), "partial observation");
  assert.equal(partial.persistence_receipt.revision, 2);

  const complete = parsedSuccess(await run("observe", [
    "--indexed-item-count", "2",
    "--readback-item-count", "2",
    "--failed-item-count", "0",
    "--mismatch-count", "0",
    "--golden-set-result-ref", "golden-set-g2-pass",
    "--observed-at", T2,
    "--confirm-live",
  ]), "complete observation");
  assert.equal(complete.persistence_receipt.revision, 3);

  const writesBeforeConflict = writeAttempts;
  parsedFailure(
    await run("promote", [
      "--expected-active-head", "wrong-generation",
      "--promoted-at", T3,
      "--confirm-generation", desired.generation,
      "--confirm-live",
    ]),
    "AI_SEARCH_ACTIVE_HEAD_CONFLICT",
    "stale active-head promotion",
  );
  assert.equal(writeAttempts, writesBeforeConflict, "stale promotion issued a CAS");

  const promoted = parsedSuccess(await run("promote", [
    "--expected-active-head", "none",
    "--promoted-at", T3,
    "--confirm-generation", desired.generation,
    "--confirm-live",
  ]), "promotion");
  assert.equal(promoted.persistence_receipt.active_head_generation, desired.generation);
  assert.equal(promoted.persistence_receipt.revision, 4);

  const active = parsedSuccess(await run("status"), "active status");
  assert.equal(
    active.registry_snapshot.artifact.registry.active_head_generation,
    desired.generation,
  );

  await freshDatabase();
  mode = "lost-acknowledgement";
  const reconciled = parsedSuccess(await run("declare", [
    "--expected-item-count", "2",
    "--declared-at", T0,
    "--confirm-live",
  ], "lost-ack"), "lost acknowledgement");
  assert.equal(reconciled.persistence_receipt.disposition, "RECONCILED");
  assert.equal(writeAttempts, 1, "lost acknowledgement issued a second CAS");
  assert.equal(appliedWrites, 1);

  await freshDatabase();
  mode = "fail-before-write";
  const uncertain = parsedFailure(
    await run("declare", [
      "--expected-item-count", "2",
      "--declared-at", T0,
      "--confirm-live",
    ], "uncertain"),
    "AI_SEARCH_REGISTRY_WRITE_UNCERTAIN",
    "unresolved declaration",
  );
  assert.equal(uncertain.error.ambiguous_effect, "REGISTRY_CAS");
  assert.equal(writeAttempts, 1, "unresolved effect issued a second CAS");
  assert.equal(appliedWrites, 0);

  console.log(
    "AI Search generation operator: PASS (guarded declare/observe/promote, replay, conflict, lost-ACK reconciliation and no retry of uncertain CAS).",
  );
} finally {
  database?.close();
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  await rm(stateRoot, { recursive: true, force: true });
}
