import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desired = JSON.parse(
  await readFile(resolve(root, "infra/ai-search/instances.json"), "utf8"),
);
const accountId = "mock-generation-account";
const databaseId = "mock-generation-database";
const apiToken = "mock-generation-token";
const oauthBearer = "mock-generation-oauth-bearer";
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
      ![`Bearer ${apiToken}`, `Bearer ${oauthBearer}`].includes(req.headers.authorization)
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
    const changes = mutation
      ? database.prepare("SELECT changes() AS changes").get().changes
      : 0;
    assert(Number.isSafeInteger(changes) && changes >= 0);
    if (mutation && changes > 0) appliedWrites += 1;

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
      result: [{ success: true, results: rows, meta: { changes } }],
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

function run(command, args = [], stateName = "default", environment = {}) {
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
          ...environment,
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

async function installFakeWranglerPnpm(directory, activeAccountId) {
  await mkdir(directory, { recursive: true });
  const body = process.platform === "win32"
    ? [
        "@echo off",
        'if not "%1"=="exec" exit /b 21',
        'if not "%2"=="wrangler" exit /b 22',
        'if not "%3"=="whoami" exit /b 23',
        'if defined CLOUDFLARE_API_TOKEN exit /b 24',
        `echo id ${activeAccountId} ok`,
        "exit /b 0",
        "",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        '[ "$1" = "exec" ] || exit 21',
        '[ "$2" = "wrangler" ] || exit 22',
        '[ "$3" = "whoami" ] || exit 23',
        '[ -z "$CLOUDFLARE_API_TOKEN" ] || exit 24',
        `printf '%s\\n' 'id ${activeAccountId} ok'`,
        "exit 0",
        "",
      ].join("\n");
  const executable = resolve(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  await writeFile(executable, body, "utf8");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return { [pathKey]: `${directory}${process.platform === "win32" ? ";" : ":"}${process.env[pathKey] ?? ""}` };
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
  const driftedDesired = structuredClone(desired);
  const driftedPrimary = driftedDesired.instances.find(
    (instance) => instance?.purpose === "private natural-language source sections",
  );
  assert(driftedPrimary, "primary desired instance is missing");
  driftedPrimary.create.embedding_model = "@cf/incompatible/embedding-model";
  const driftedDesiredPath = resolve(stateRoot, "drifted-desired.json");
  await writeFile(
    driftedDesiredPath,
    `${JSON.stringify(driftedDesired, null, 2)}\n`,
    "utf8",
  );
  const beforeProfileDrift = requests;
  parsedFailure(
    await run("status", ["--desired-state", driftedDesiredPath]),
    "AI_SEARCH_GENERATION_OPERATOR_INPUT_INVALID",
    "drifted desired profile",
  );
  assert.equal(
    requests,
    beforeProfileDrift,
    "drifted desired profile contacted D1",
  );

  const empty = parsedSuccess(await run("status"), "empty status");
  assert.equal(empty.registry_snapshot, null);
  assert.equal(requests, 1);
  assert.equal(writeAttempts, 0);

  const oauthProfilePath = resolve(stateRoot, "wrangler-oauth.toml");
  await writeFile(
    oauthProfilePath,
    `oauth_token = "${oauthBearer}"\nexpiration_time = "2030-01-01T00:00:00.000Z"\n`,
    "utf8",
  );
  const oauthBin = resolve(stateRoot, "wrangler-oauth-bin");
  const oauthPath = await installFakeWranglerPnpm(oauthBin, accountId);
  const oauthEnvironment = {
    ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth",
    ELIOTR_WRANGLER_CONFIG_FILE: oauthProfilePath,
    ...oauthPath,
  };
  const beforeOAuthStatus = requests;
  const oauthStatus = parsedSuccess(
    await run("status", [], "oauth-valid", oauthEnvironment),
    "Wrangler OAuth status",
  );
  assert.equal(oauthStatus.registry_snapshot, null);
  assert.equal(requests, beforeOAuthStatus + 1);
  assert(!JSON.stringify(oauthStatus).includes(oauthBearer), "OAuth bearer leaked into receipt");

  const wrongAccountBin = resolve(stateRoot, "wrangler-wrong-account-bin");
  const wrongAccountPath = await installFakeWranglerPnpm(wrongAccountBin, "different-account");
  const beforeOAuthMismatch = requests;
  const oauthMismatch = parsedFailure(
    await run("status", [], "oauth-mismatch", {
      ...oauthEnvironment,
      ...wrongAccountPath,
    }),
    "AI_SEARCH_GENERATION_OPERATOR_INPUT_INVALID",
    "Wrangler OAuth account mismatch",
  );
  assert.equal(requests, beforeOAuthMismatch, "mismatched OAuth account contacted D1");
  assert(!JSON.stringify(oauthMismatch).includes(oauthBearer), "OAuth bearer leaked into error");

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
