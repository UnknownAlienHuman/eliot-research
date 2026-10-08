import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeploymentMigrationPlan, requireUnchangedMigrationPlan, verifyDeploymentMigrationLedgers } from "./lib/deployment-migrations.mjs";

const config = { d1_databases: [
  { binding: "CORE_DB", database_id: "11111111-1111-4111-8111-111111111111", migrations_dir: "../../infra/d1/core/migrations" },
  { binding: "SEARCH_DB", database_id: "22222222-2222-4222-8222-222222222222", migrations_dir: "../../infra/d1/search/migrations" },
] };
const env = { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "fixture-secret" };
const input = { apiBase: "https://api.cloudflare.com/client/v4" };
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "eliotr-migration-proof-"));
  try {
    for (const stream of ["core", "search"]) {
      await mkdir(join(root, "infra/d1", stream, "migrations"), { recursive: true });
      await writeFile(join(root, "infra/d1", stream, "migrations/0001_initial.sql"), "SELECT 1;\n");
    }
    await action(root, await readDeploymentMigrationPlan(config, { root }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
const response = (names) => ({ success: true, result: [{ success: true, results: names.map((name) => ({ name })), meta: { changed_db: false, rows_written: 0 } }] });

test("both exact remote ledgers are read-only, bounded and recorded separately from local bytes", () => fixture(async (root, plan) => {
  const calls = [];
  const receipt = await verifyDeploymentMigrationLedgers(env, input, plan, { fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { sql: "SELECT name FROM d1_migrations ORDER BY name LIMIT 2", params: [] });
    assert.equal(init.redirect, "manual");
    return globalThis.Response.json(response(["0001_initial.sql"]));
  } });
  assert.equal(calls.length, 2);
  assert.equal(receipt.state, "PASS");
  assert.deepEqual(receipt.streams, plan);
  assert.ok(!JSON.stringify(receipt).includes(env.CLOUDFLARE_API_TOKEN));
  await requireUnchangedMigrationPlan(config, plan, { root });
  await writeFile(join(root, "infra/d1/core/migrations/0001_initial.sql"), "SELECT 2;\n");
  await assert.rejects(requireUnchangedMigrationPlan(config, plan, { root }));
}));

test("missing, extra, duplicate, malformed or failed ledger cannot attest deployment", () => fixture(async (_root, plan) => {
  const invalid = [response([]), response(["0001_initial.sql", "0002_foreign.sql"]),
    response(["0002_foreign.sql"]), { success: false, result: [] },
    { success: true, result: [{ success: false, results: [] }] },
    { success: true, result: [{ success: true, results: [{ name: "0001_initial.sql", secret: "reflected" }] }] },
    { success: true, result: [{ success: true, results: [{ name: "0001_initial.sql" }], meta: { rows_written: 1 } }] }];
  for (const payload of invalid) {
    let calls = 0;
    await assert.rejects(verifyDeploymentMigrationLedgers(env, input, plan, { fetchImpl: async () => {
      calls += 1; return globalThis.Response.json(payload);
    } }));
    assert.equal(calls, 1, "first stream mismatch must stop before the next stream");
  }
}));

test("generated config cannot redirect migration directory or ledger table", () => fixture(async (root) => {
  for (const drift of [{ migrations_dir: "../../foreign" }, { migrations_table: "other_ledger" }, { migrations_pattern: "**/*.sql" }]) {
    await assert.rejects(readDeploymentMigrationPlan({ d1_databases: [{ ...config.d1_databases[0], ...drift }, config.d1_databases[1]] }, { root }));
  }
}));

// Same ledger names never substitute for the pinned SQL directory.
test("missing/default migration directories reject same-name foreign bytes", () => fixture(async (root) => {
  await mkdir(join(root, "apps/eliotr-core/migrations"), { recursive: true });
  await writeFile(join(root, "apps/eliotr-core/migrations/0001_initial.sql"), "SELECT 999;\n");
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    for (const directory of [undefined, "", "migrations", "../../foreign"]) {
      const changed = structuredClone(config);
      const db = changed.d1_databases.find((item) => item.binding === binding);
      if (directory === undefined) delete db.migrations_dir;
      else db.migrations_dir = directory;
      await assert.rejects(readDeploymentMigrationPlan(changed, { root }), /migration plan or ledger/u);
    }
  }
}));
