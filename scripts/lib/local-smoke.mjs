import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { executeLocal, prepareLocal, ROOT, wranglerArgs } from "./local-launch.mjs";
import { startLocalWorker } from "./local-worker.mjs";
import { initializeLocalNamespace } from "./local-namespace.mjs";
import { localPolicyQuery } from "./local-read-policy.mjs";


function query(paths, binding, sql) {
  const output = executeLocal(wranglerArgs(paths, ["d1", "execute", binding, "--command", sql, "--json"]), { capture: true });
  const batches = JSON.parse(output);
  assert.ok(Array.isArray(batches) && batches.length === 1 && batches[0].success === true, "D1 query did not produce one success result");
  return batches[0].results;
}

async function verifyMigrations(paths) {
  const counts = {};
  for (const [binding, directory] of [["CORE_DB", "core"], ["SEARCH_DB", "search"]]) {
    const expected = (await readdir(resolve(ROOT, "infra/d1", directory, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
    const rows = query(paths, binding, "SELECT name FROM d1_migrations ORDER BY name");
    assert.deepEqual(rows.map((row) => row.name), expected, "Local migration ledger differs from tracked migration files");
    assert.deepEqual(query(paths, binding, "PRAGMA foreign_key_check"), [], "Local schema violates foreign keys");
    assert.deepEqual(query(paths, binding, "PRAGMA quick_check"), [{ quick_check: "ok" }]);
    counts[binding] = expected.length;
  }
  return counts;
}

async function verifyHttp(origin) {
  const page = await fetch(`${origin}/`, { redirect: "manual", signal: globalThis.AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  assert.ok(page.headers.get("content-type")?.includes("text/html"));
  const html = await page.text();
  assert.ok(html.includes('id="app"'));
  const asset = /src="(\/assets\/[^"<>]+\.js)"/u.exec(html)?.[1];
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
