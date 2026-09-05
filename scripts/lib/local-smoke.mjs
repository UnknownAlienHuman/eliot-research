import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { devArguments, executeLocal, localEnvironment, prepareLocal, ROOT, signalLocalProcess, wranglerArgs } from "./local-launch.mjs";
import { readDeploymentJson } from "./deployment-verification.mjs";

async function vacantPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function start(paths) {
  const port = await vacantPort();
  const child = spawn(process.execPath, devArguments(paths, port), {
    cwd: ROOT, env: localEnvironment(), stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  // Drain, but never retain or reflect possible credentials from Wrangler diagnostics.
  child.stdout.resume(); child.stderr.resume();
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    signalLocalProcess(child);
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { signalLocalProcess(child, "SIGKILL"); } catch { /* Report the bounded shutdown failure below. */ }
          reject(new Error("Local Worker did not close within the shutdown deadline"));
        }, 8000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i += 1) {
      if (spawnError || child.exitCode !== null) throw new Error("Local Worker exited before HTTP readiness");
      try {
        const { data } = await readDeploymentJson(`${origin}/healthz`, {}, { timeoutMs: 500 });
        assert.equal(data.ready, true);
        assert.equal(data.deployment_generation, paths.generation);
        return { origin, stop };
      } catch { await delay(250); }
    }
    throw new Error("Local Worker did not become ready with both migrated databases");
  } catch (error) { await stop(); throw error; }
}

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
    query(paths, "CORE_DB", "INSERT INTO schema_state VALUES ('local-smoke','preserved','2026-09-05T00:00:00Z')");
    running = await start(paths);
    await verifyHttp(running.origin);
    await running.stop(); running = undefined;
    // A second prepare applies no duplicate migration and preserves existing local data.
    await prepareLocal({ stateDirectory: directory, log: () => {} });
    assert.deepEqual(await verifyMigrations(paths), migrations);
    assert.deepEqual(query(paths, "CORE_DB", "SELECT value FROM schema_state WHERE key='local-smoke'"), [{ value: "preserved" }]);
    running = await start(paths);
    await verifyHttp(running.origin);
    return { protocol: "eliotr.local-launch-smoke.v1", state: "PASS", migrations,
      pwa_and_bundled_asset: "PASS", unsigned_and_forged_access_denied: "PASS",
      restart_and_idempotent_prepare: "PASS", remote_providers: "NOT_EXECUTED",
      complete_research_product: "NOT_QUALIFIED" };
  } finally { await running?.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
