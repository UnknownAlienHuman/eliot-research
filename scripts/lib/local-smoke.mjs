import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { executeLocal, prepareLocal, ROOT, wranglerArgs } from "./local-launch.mjs";
import { startLocalWorker } from "./local-worker.mjs";
import { initializeLocalNamespace } from "./local-namespace.mjs";
import { localPolicyQuery } from "./local-read-policy.mjs";


function query(paths, binding, sql, phase = "local-smoke-query") {
  const output = executeLocal(wranglerArgs(paths, ["d1", "execute", binding, "--command", sql, "--json"]), {
    capture: true, diagnosticContext: { binding, phase },
  });
  const batches = JSON.parse(output);
  assert.ok(Array.isArray(batches) && batches.length === 1 && batches[0].success === true, "D1 query did not produce one success result");
  return batches[0].results;
}

function queryBatch(paths, binding, statements, phase = "local-smoke-query") {
  const output = executeLocal(wranglerArgs(paths, ["d1", "execute", binding, "--command", statements.join(";\n"), "--json"]), {
    capture: true, diagnosticContext: { binding, phase },
  });
  const batches = JSON.parse(output);
  assert.ok(Array.isArray(batches) && batches.length === statements.length, "D1 batch did not produce one result per statement");
  for (const batch of batches) assert.equal(batch.success, true, "D1 batch statement failed");
  return batches.map((batch) => batch.results);
}

function quoteSqliteIdentifier(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function migrationQuickCheck(paths, binding) {
  const tableRows = query(paths, binding, "PRAGMA table_list", "d1-migrations-verify");
  const tableNames = new Set();
  for (const row of tableRows) {
    // Include ordinary, virtual, and shadow objects in the main schema. D1's
    // internal _cf_ objects are listed too, but workerd rejects them as
    // user-scoped PRAGMA targets; the closed-file check below covers them.
    if (row.schema === "main" && ["table", "virtual", "shadow"].includes(row.type) &&
      typeof row.name === "string" && !row.name.toLowerCase().startsWith("_cf_")) {
      tableNames.add(row.name);
    }
  }
  const statements = ["PRAGMA foreign_key_check", ...[...tableNames].sort().map((tableName) =>
    `PRAGMA quick_check(${quoteSqliteIdentifier(tableName)})` )];
  const results = queryBatch(paths, binding, statements, "d1-migrations-verify");
  assert.deepEqual(results.shift(), [], "Local schema violates foreign keys");
  for (const [index, tableName] of [...tableNames].sort().entries()) {
    const result = results[index];
    assert.deepEqual(result, [{ quick_check: "ok" }], `Local quick_check failed for ${binding}.${tableName}`);
  }
}

function sameNames(rows, expected) {
  return rows.length === expected.length && rows.every((row, index) => row.name === expected[index]);
}

function assertPathWithin(root, candidate, message) {
  const suffix = relative(root, candidate);
  assert.ok(suffix && !suffix.startsWith("..") && !isAbsolute(suffix), message);
}

async function verifyClosedDatabaseFiles(paths, expectedByBinding) {
  const persist = resolve(paths.persist);
  const stateRoot = resolve(persist, "..");
  const stateParent = resolve(ROOT, ".eliotr-state");
  assertPathWithin(stateParent, stateRoot, "Local D1 state escaped the smoke harness directory");
  assert.match(basename(stateRoot), /^smoke-/u, "Local D1 state is not a smoke-owned mkdtemp");
  assert.equal(basename(persist), "state", "Local D1 persistence root is unexpected");
  const directory = resolve(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const ownedPaths = [stateRoot, persist, resolve(persist, "v3"), resolve(persist, "v3", "d1"), directory];
  for (const ownedPath of ownedPaths) {
    assert.equal((await lstat(ownedPath)).isSymbolicLink(), false, `Local D1 path is a symlink: ${ownedPath}`);
  }
  const realStateRoot = await realpath(stateRoot);
  assertPathWithin(realStateRoot, await realpath(persist), "Local D1 persistence escaped its canonical state root");
  const realDirectory = await realpath(directory);
  assertPathWithin(realStateRoot, realDirectory, "Local D1 database directory escaped its canonical state root");
  const entries = await readdir(directory, { withFileTypes: true });
  const sqliteEntries = entries.filter((entry) => entry.name.endsWith(".sqlite"));
  assert.ok(sqliteEntries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
    "Local D1 persistence contains a non-file or symlink SQLite entry");
  const metadataEntries = sqliteEntries.filter((entry) => entry.name === "metadata.sqlite");
  assert.ok(metadataEntries.length <= 1, "Local D1 persistence contains duplicate metadata files");
  // Miniflare reserves metadata.sqlite for the storage service itself; it is
  // not a D1 binding. The remaining files must be exactly the two databases.
  const files = sqliteEntries.filter((entry) => entry.name !== "metadata.sqlite");
  assert.equal(files.length, expectedByBinding.size, "Local D1 persistence file set is not exactly the two harness databases");
  const seen = new Set();
  for (const entry of files) {
    const path = resolve(directory, entry.name);
    assertPathWithin(realDirectory, await realpath(path), "Local D1 database file escaped its closed harness directory");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const ledger = database.prepare("SELECT name FROM d1_migrations ORDER BY name").all();
      const binding = [...expectedByBinding.entries()].find(([, expected]) => sameNames(ledger, expected))?.[0];
      assert.ok(binding && !seen.has(binding), "Local D1 persistence file has an unknown or duplicate migration ledger");
      const wholeCheck = database.prepare("PRAGMA quick_check").all();
      assert.equal(wholeCheck.length, 1, `Closed local whole-file quick_check failed for ${binding}`);
      assert.equal(wholeCheck[0].quick_check, "ok", `Closed local whole-file quick_check failed for ${binding}`);
      seen.add(binding);
    } finally { database.close(); }
  }
  assert.deepEqual(seen, new Set(expectedByBinding.keys()), "Closed local D1 files did not cover both bindings");
}

async function verifyMigrations(paths) {
  const counts = {};
  const expectedByBinding = new Map();
  for (const [binding, directory] of [["CORE_DB", "core"], ["SEARCH_DB", "search"]]) {
    const expected = (await readdir(resolve(ROOT, "infra/d1", directory, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expectedByBinding.set(binding, expected);
    const rows = query(paths, binding, "SELECT name FROM d1_migrations ORDER BY name", "d1-migrations-verify");
    assert.deepEqual(rows.map((row) => row.name), expected, "Local migration ledger differs from tracked migration files");
    // A whole-schema quick_check can exceed workerd's VDBE budget even when
    // each bounded object check succeeds. The closed-file whole check below
    // preserves the prior global page/freelist and cross-object coverage;
    // SQLite's existing quick_check exclusions (such as UNIQUE/index-content
    // validation) are unchanged rather than newly introduced here.
    migrationQuickCheck(paths, binding);
    counts[binding] = expected.length;
  }
  await verifyClosedDatabaseFiles(paths, expectedByBinding);
  return counts;
}

async function verifyHttp(origin) {
  const page = await fetch(`${origin}/`, { redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  assert.ok(page.headers.get("content-type")?.includes("text/html"));
  const html = await page.text();
  assert.ok(html.includes('id="app"'));
  // Vite emits /assets while the static Astro build emits /_astro. Keep the
  // assertion bound to a bundled JavaScript entry in either supported build.
  const asset = /src="(\/(?:assets|_astro)\/[^"<>]+\.js)"/u.exec(html)?.[1];
  assert.ok(asset, "PWA did not include a bundled application entry");
  const script = await fetch(`${origin}${asset}`, { redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
  assert.equal(script.status, 200);
  assert.ok(script.headers.get("content-type")?.includes("javascript"));
  // Missing or forged credentials must never obtain the catalog. No test authentication switch.
  for (const headers of [{}, { "cf-access-jwt-assertion": "forged.token.signature" },
    { "cf-access-client-id": "forged", "cf-access-client-secret": "forged" }]) {
    const response = await fetch(`${origin}/api/v1/research/catalog`, { headers, redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
    assert.equal(response.status, 401);
    const problem = await response.json();
    assert.equal(problem.status, 401);
    assert.equal(typeof problem.trace_id, "string");
    assert.ok(problem.code.startsWith("ACCESS_"));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const missing = await fetch(`${origin}/api/v1/does-not-exist`, { signal: globalThis.AbortSignal.timeout(5000) });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "ROUTE_NOT_FOUND");
}

export async function smokeLocal() {
  // Isolated local state is disposable; the owner's local development databases are never reset.
  await mkdir(resolve(ROOT, ".eliotr-state"), { recursive: true });
  const directory = await mkdtemp(resolve(ROOT, ".eliotr-state/smoke-"));
  let running;
  try {
    const paths = await prepareLocal({ stateDirectory: directory, log: () => {} });
    const migrations = await verifyMigrations(paths);
    // Controlled OS-operator fixture, not a signed-login claim. Separate Worker tests verify real RSA assertions.
    const command = { protocol: "eliotr.local-namespace-init.v1", namespace: "smoke-import", owner_incarnation_ref: "smoke-installation",
      expected_ownership_revision: 0, expected_policy_revision: 0, created_at: new Date().toISOString(), policy: {
        allowed_ownership_modes: ["immutable_import"], source_class: "document", assurance_ceiling: "QUALIFIED",
        instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", allowed_use: ["research"], disclosure_ceiling: "owner-only",
        license_policy_ref: "smoke-license", default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "smoke-residency",
        default_retention_policy_id: "smoke-retention", minimum_quality_state: "standard" } };
    const identity = { protocol: "eliotr.owner-session.v1", principal_ref: "smoke-operator", client_class: "owner_pwa",
      credential_generation: "controlled-smoke-identity", expires_at: new Date(Date.now() + 3600000).toISOString() };
    const namespaceReceipt = await initializeLocalNamespace({ command, identity, query: localPolicyQuery(paths) });
    assert.equal(namespaceReceipt.read_access_granted, false);
    query(paths, "CORE_DB", "INSERT INTO schema_state VALUES ('local-smoke','preserved','2026-09-05T00:00:00Z')");
    running = await startLocalWorker(paths);
    await verifyHttp(running.origin);
    await running.stop(); running = undefined;
    // A second prepare applies no duplicate migration and preserves existing local data.
    await prepareLocal({ stateDirectory: directory, log: () => {} });
    assert.deepEqual(await verifyMigrations(paths), migrations);
    assert.deepEqual(await initializeLocalNamespace({ command, identity, query: localPolicyQuery(paths) }), namespaceReceipt);
    assert.deepEqual(query(paths, "CORE_DB", "SELECT COUNT(*) AS n FROM scope_read_policy"), [{ n: 0 }]);
    assert.deepEqual(query(paths, "CORE_DB", "SELECT value FROM schema_state WHERE key='local-smoke'"), [{ value: "preserved" }]);
    running = await startLocalWorker(paths);
    await verifyHttp(running.origin);
    return { protocol: "eliotr.local-launch-smoke.v1", state: "PASS", migrations,
      pwa_and_bundled_asset: "PASS", unsigned_and_forged_access_denied: "PASS",
      restart_and_idempotent_prepare: "PASS", namespace_initialization_and_replay: "PASS", remote_providers: "NOT_EXECUTED",
      complete_research_product: "NOT_QUALIFIED" };
  } finally { await running?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
