import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { classifyDeploymentMigrationSql, runDeploymentMigrationOperation,
  validateDeploymentMigrationIntent } from "./lib/deployment-migration-operation.mjs";
import { readDeploymentMigrationEntries } from "./lib/deployment-migrations.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const coreDatabaseId = "11111111-1111-4111-8111-111111111111";
const searchDatabaseId = "22222222-2222-4222-8222-222222222222";
const tableASql = "CREATE TABLE fixture_table_a (id INTEGER PRIMARY KEY) STRICT";
const tableBSql = "CREATE TABLE fixture_table_b (id INTEGER PRIMARY KEY) STRICT";
const indexSql = "CREATE INDEX fixture_table_b_idx ON fixture_table_b(id)";
const triggerSql = "CREATE TRIGGER fixture_table_b_insert AFTER INSERT ON fixture_table_b BEGIN SELECT 1; END";
const oldViewSql = "CREATE VIEW fixture_view AS SELECT 1 AS id";
const viewSql = "CREATE VIEW fixture_view AS SELECT id FROM fixture_table_b";
const schemaStateSql = "CREATE TABLE schema_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)";
const migrationA = `${tableASql};\n${oldViewSql};\n`;
const migrationB = `${tableBSql};\n${indexSql};\n${triggerSql};\n` +
  `DROP VIEW IF EXISTS fixture_view;\n${viewSql};\n` +
  "INSERT INTO schema_state(key, value, updated_at) VALUES ('fixture_generation', 'fixture-v1', '2026-10-03T00:00:00Z') " +
  "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;\n";
const migrationNames = ["0001_fixture_a.sql", "0002_fixture_b.sql"];
const schemaObjects = [
  { object_type: "table", name: "fixture_table_a", sql: tableASql, migration_names: [migrationNames[0]] },
  { object_type: "table", name: "fixture_table_b", sql: tableBSql, migration_names: [migrationNames[1]] },
  { object_type: "index", name: "fixture_table_b_idx", sql: indexSql, migration_names: [migrationNames[1]] },
  { object_type: "trigger", name: "fixture_table_b_insert", sql: triggerSql, migration_names: [migrationNames[1]] },
  { object_type: "view", name: "fixture_view", sql: viewSql, before_sql: oldViewSql,
    migration_names: migrationNames },
  { object_type: "table", name: "schema_state", sql: schemaStateSql, before_sql: schemaStateSql,
    migration_names: [migrationNames[1]] },
];
let groups = 0;
async function check(name, action) {
  await action();
  groups += 1;
  console.log(`D1 migration operation: ${name}: PASS`);
}

function removeTemporaryDirectory(path, parent, prefix) {
  const target = resolve(path);
  if (dirname(target) !== parent || !basename(target).startsWith(prefix)) {
    throw new Error("Refusing to remove an unexpected D1 migration fixture path");
  }
  return rm(target, { recursive: true, force: true });
}

async function createFixture(action) {
  const parent = resolve(tmpdir());
  const prefix = "eliotr-d1-operation-";
  const root = await mkdtemp(join(parent, prefix));
  try {
    const coreDirectory = join(root, "infra/d1/core/migrations");
    const searchDirectory = join(root, "infra/d1/search/migrations");
    const configDirectory = join(root, "apps/eliotr-core");
    await Promise.all([mkdir(coreDirectory, { recursive: true }), mkdir(searchDirectory, { recursive: true }),
      mkdir(configDirectory, { recursive: true })]);
    await Promise.all([
      writeFile(join(coreDirectory, migrationNames[0]), migrationA),
      writeFile(join(coreDirectory, migrationNames[1]), migrationB),
      writeFile(join(searchDirectory, "0001_search_fixture.sql"), "CREATE TABLE search_fixture (id INTEGER PRIMARY KEY) STRICT;\n"),
    ]);
    const config = { name: "eliotr-core", preview_urls: false, vars: { ENVIRONMENT: "production" }, d1_databases: [
      { binding: "CORE_DB", database_name: "eliotr-core", database_id: coreDatabaseId, migrations_dir: "../../infra/d1/core/migrations" },
      { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: searchDatabaseId, migrations_dir: "../../infra/d1/search/migrations" },
    ] };
    const configBytes = Buffer.from(JSON.stringify(config));
    await writeFile(join(configDirectory, "wrangler.deploy.jsonc"), configBytes);
    const entries = await readDeploymentMigrationEntries(config, "CORE_DB", { root });
    const byName = new Map(entries.migration_entries.map((entry) => [entry.name, entry]));
    const intentFor = (names = migrationNames) => {
      const hashes = names.map((name) => ({ name, sha256: byName.get(name).sha256 }));
      const selectedProbes = schemaObjects.filter((object) => object.migration_names.some((name) => names.includes(name)))
        .map(({ object_type, name, sql, before_sql, migration_names: covered }) => ({ object_type, name,
          before_sql_sha256: before_sql === undefined || (object_type === "view" && names.includes(migrationNames[0]))
            ? null : sha256(before_sql),
          create_sql_sha256: sha256(object_type === "view" && !names.includes(migrationNames[1]) ? oldViewSql : sql),
          migration_names: covered.filter((migration) => names.includes(migration)) }));
      const reviewed = sha256(JSON.stringify(hashes));
      return {
        protocol: "eliotr.cloudflare-d1-migration-intent.v1", intent_id: randomUUID(), account_id: accountId,
        generated_config_sha256: sha256(configBytes),
        database: { binding: "CORE_DB", database_name: "eliotr-core", database_id: coreDatabaseId },
        migration_names: [...names], migration_hashes: hashes,
        local_migration_bundle_sha256: entries.local_migration_bundle_sha256,
        risk_review: { classification: "schema_metadata_only", summary: "Bounded fixture schema and marker updates reviewed.",
          reviewed_bundle_sha256: reviewed, index_build_cost_reviewed: true },
        schema_probes: selectedProbes, max_migrations: names.length,
        max_sql_bytes: names.reduce((sum, name) => sum + Buffer.byteLength(name === migrationNames[0] ? migrationA : migrationB), 0),
        deadline_at: "2030-01-01T00:00:00.000Z", max_runtime_ms: 60_000,
      };
    };
    await action({ root, config, configBytes, entries, byName, intentFor });
  } finally {
    await removeTemporaryDirectory(root, parent, prefix);
  }
}

function cloudflareHarness({ root, intent, applied = [], failure = null, mismatch = null, preflightMismatch = null,
  preflightNameVariant = false, preflightTypeOverride = null,
  ledgerOverride = null, databaseVersion = "production", bookmark = "fixture-bookmark", cancel = () => {} } = {}) {
  const calls = [];
  const receipts = new Map();
  const apiCalls = [];
  let appliedNames = [...applied];
  const environment = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "fixture-token", ELIOTR_ENVIRONMENT: "production" };
  const read = async (path, encoding) => {
    const saved = receipts.get(resolve(path));
    if (saved !== undefined) return encoding === "utf8" ? saved : Buffer.from(saved);
    return readFile(path, encoding);
  };
  const statFile = async (path) => {
    const saved = receipts.get(resolve(path));
    return saved === undefined ? stat(path) : { size: Buffer.byteLength(saved), isFile: () => true };
  };
  const saveReceipt = async (receipt, path, { createOnly = false } = {}) => {
    const resolvedPath = resolve(path);
    if (createOnly && receipts.has(resolvedPath)) throw new Error("fixture receipt already exists");
    receipts.set(resolvedPath, `${JSON.stringify(receipt)}\n`);
    calls.push(`SAVE ${receipt.overall_state}`);
  };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    apiCalls.push({ method, url: String(url), body: init.body === undefined ? null : JSON.parse(init.body) });
    const address = new URL(url);
    if (method === "GET" && address.pathname.endsWith(`/d1/database/${intent.database.database_id}`)) {
      return Response.json({ success: true, result: { uuid: intent.database.database_id,
        name: "eliotr-core", version: databaseVersion, account_id: accountId } });
    }
    if (method !== "POST" || !address.pathname.endsWith(`/d1/database/${intent.database.database_id}/query`)) {
      throw new Error(`Unexpected fixture API request: ${method} ${address.pathname}`);
    }
    const query = apiCalls.at(-1).body;
    let rows;
    if (query.sql.startsWith("SELECT name FROM d1_migrations")) {
      rows = ledgerOverride === null ? appliedNames.map((name) => ({ name })) : ledgerOverride.map((name) => ({ name }));
    } else if (query.sql === "SELECT type, name, sql FROM sqlite_master WHERE type = ? AND name = ? LIMIT 2") {
      const object = schemaObjects.find((entry) => entry.object_type === query.params[0] && entry.name === query.params[1]);
      if (object === undefined) throw new Error("Unexpected schema probe in migration fixture");
      rows = [{ type: object.object_type, name: object.name,
        sql: mismatch === `schema:${object.name}` ? `${object.sql} ` : object.sql }];
    } else if (query.sql === "SELECT type, name, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 2") {
      const probe = intent.schema_probes.find((entry) => entry.name === query.params[0]);
      const object = schemaObjects.find((entry) => entry.name === query.params[0]);
      if (probe === undefined || object === undefined) throw new Error("Unexpected schema precondition in migration fixture");
      const shouldConflict = preflightMismatch === object.name;
      if (probe.before_sql_sha256 === null && !shouldConflict) rows = [];
      else {
        const expectedBeforeSql = probe.before_sql_sha256 === null ? object.sql : object.before_sql;
        if (expectedBeforeSql === undefined) throw new Error("Fixture lacks the reviewed existing schema SQL");
        rows = [{ type: preflightTypeOverride && shouldConflict ? preflightTypeOverride : object.object_type,
          name: preflightNameVariant && shouldConflict ? object.name.toUpperCase() : object.name,
          sql: shouldConflict ? `${expectedBeforeSql} ` : expectedBeforeSql }];
      }
    } else if (query.sql === "SELECT key, value FROM schema_state WHERE key = ? LIMIT 2") {
      rows = [{ key: "fixture_generation", value: mismatch === "metadata" ? "stale" : "fixture-v1" }];
    } else throw new Error(`Unexpected fixture SQL: ${query.sql}`);
    return Response.json({ success: true, result: [{ success: true, results: rows,
      meta: { changed_db: false, rows_written: 0 } }] });
  };
  const execute = async (command, args, cwd, childEnvironment) => {
    const label = `${command} ${args.join(" ")}`;
    calls.push(label);
    assert.equal(childEnvironment.CLOUDFLARE_ACCOUNT_ID, accountId);
    assert.equal(args.includes("eliotr-core"), true, "apply command targets the approved database name");
    const saved = [...receipts.values()].at(-1);
    assert.ok(saved && JSON.parse(saved).time_travel?.bookmark === "fixture-bookmark",
      "receipt with the Time Travel bookmark is durable before apply starts");
    if (failure === "PARTIAL") {
      appliedNames = [intent.migration_names[0]];
      throw Object.assign(new Error("fixture timeout after first migration"), { started: true, uncertain: true });
    }
    if (failure === "UNKNOWN") {
      throw Object.assign(new Error("fixture command timed out after start"), { started: true, uncertain: true });
    }
    if (failure === "CANCEL") {
      cancel();
      throw Object.assign(new Error("fixture command cancelled after start"), { started: true, uncertain: true });
    }
    appliedNames = [...appliedNames, ...intent.migration_names];
    return { status: 0 };
  };
  const capture = async (command, args) => {
    const label = `${command} ${args.join(" ")}`;
    calls.push(`CAPTURE ${label}`);
    assert.ok(label.includes("time-travel info eliotr-core"));
    return JSON.stringify({ bookmark });
  };
  const run = (currentIntent = intent, options = {}) => runDeploymentMigrationOperation({ intent: currentIntent, root,
    environment: options.environment ?? environment, confirmLive: options.confirmLive ?? true,
    execute, capture, fetchImpl, read, statFile, saveReceipt, now: () => Date.parse("2026-10-03T00:00:00.000Z"), log: () => {},
    signal: options.signal });
  return { calls, receipts, apiCalls, run, setApplied: (names) => { appliedNames = [...names]; }, getApplied: () => [...appliedNames] };
}

await check("actual Core candidate classifier inventory is explicitly 21 supported and 16 named for separate review", async () => {
  const directory = new URL("../infra/d1/core/migrations/", import.meta.url);
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(directory)).filter((name) => {
    const number = Number(name.slice(0, 4));
    return name.endsWith(".sql") && number >= 67 && number <= 103;
  }).sort();
  const supported = new Set(["0067", "0072", "0077", "0078", "0079", "0080", "0083", "0084", "0085", "0086",
    "0087", "0088", "0089", "0090", "0091", "0092", "0093", "0094", "0097", "0098", "0099"]);
  assert.equal(files.length, 37);
  const accepted = [];
  const denied = [];
  for (const name of files) {
    try {
      classifyDeploymentMigrationSql(await readFile(new URL(name, directory), "utf8"));
      accepted.push(name.slice(0, 4));
    } catch { denied.push(name.slice(0, 4)); }
  }
  assert.deepEqual(accepted, [...supported].sort());
  assert.deepEqual(denied, ["0068", "0069", "0070", "0071", "0073", "0074", "0075", "0076", "0081", "0082",
    "0095", "0096", "0100", "0101", "0102", "0103"]);
});

await check("SQL allowlist ignores comments and literals, permits bounded triggers, rejects rebuilds/backfills/risky indexes", async () => {
  assert.equal(classifyDeploymentMigrationSql("-- UPDATE source SET v=1\nCREATE TABLE \"safe_table\" (note TEXT DEFAULT 'DROP TABLE');").newly_created_tables[0], "safe_table");
  assert.equal(classifyDeploymentMigrationSql(triggerSql).required_schema_objects[0].object_type, "trigger");
  assert.deepEqual(classifyDeploymentMigrationSql(`DROP VIEW IF EXISTS fixture_view; ${viewSql};`)
    .must_probe_schema_objects[0], { object_type: "view", name: "fixture_view" });
  assert.equal(classifyDeploymentMigrationSql("CREATE TABLE created_here(id INTEGER) STRICT; CREATE INDEX created_here_idx ON created_here(id);")
    .required_schema_objects.at(-1).object_type, "index");
  for (const sql of ["CREATE TABLE rebuilt AS SELECT * FROM existing;",
    "INSERT INTO target SELECT * FROM source;", "UPDATE schema_state SET value='x', updated_at='2026-10-03T00:00:00Z' WHERE key='generation' OR 1=1;",
    "PRAGMA foreign_keys=OFF;", "CREATE INDEX fixture_existing_idx ON existing_table(id);"]) {
    assert.throws(() => classifyDeploymentMigrationSql(sql));
  }
});

await createFixture(async ({ root, intentFor }) => {
  const intent = intentFor();
  validateDeploymentMigrationIntent(intent);
  await check("precondition hashes are mandatory and full-suffix replacements may start from absence", async () => {
    const missingBefore = structuredClone(intent);
    delete missingBefore.schema_probes[0].before_sql_sha256;
    assert.throws(() => validateDeploymentMigrationIntent(missingBefore));
    assert.equal(intent.schema_probes.find((probe) => probe.name === "fixture_view").before_sql_sha256, null);
    const freshWithExistingHash = structuredClone(intent);
    freshWithExistingHash.schema_probes.find((probe) => probe.name === "fixture_table_a").before_sql_sha256 = sha256(tableASql);
    const test = cloudflareHarness({ root, intent });
    await assert.rejects(test.run(freshWithExistingHash, { confirmLive: false, environment: {} }), /absence precondition/u);
    assert.equal(test.calls.length, 0);
    assert.equal(test.apiCalls.length, 0);
    assert.equal(test.receipts.size, 0);
  });
  await check("local-only plan validates pins with zero command, network, credential or receipt effects", async () => {
    const test = cloudflareHarness({ root, intent });
    const result = await test.run(intent, { confirmLive: false, environment: {} });
    assert.equal(result.state, "PLAN_ONLY");
    assert.equal(result.migration_count, 2);
    assert.equal(test.calls.length, 0);
    assert.equal(test.apiCalls.length, 0);
    assert.equal(test.receipts.size, 0);
  });
  await check("wrong account, database UUID/config pin, or reviewed SQL hash denies before remote effects", async () => {
    const cases = [
      [intent, { environment: { CLOUDFLARE_ACCOUNT_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", CLOUDFLARE_API_TOKEN: "x" } }],
      [intent, { environment: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: "x", ELIOTR_ENVIRONMENT: "staging" } }],
      [{ ...intent, database: { ...intent.database, database_id: searchDatabaseId } }, {}],
      [{ ...intent, database: { ...intent.database, database_name: "other-database" } }, {}],
      [{ ...intent, generated_config_sha256: sha256("foreign config") }, {}],
      [{ ...intent, migration_hashes: intent.migration_hashes.map((item, index) => index === 0
        ? { ...item, sha256: sha256("foreign SQL") } : item),
      risk_review: { ...intent.risk_review,
        reviewed_bundle_sha256: sha256(JSON.stringify(intent.migration_hashes.map((item, index) => index === 0
          ? { ...item, sha256: sha256("foreign SQL") } : item))) } }, {}],
    ];
    for (const [changed, options] of cases) {
      const test = cloudflareHarness({ root, intent });
      await assert.rejects(test.run(changed, options));
      assert.equal(test.apiCalls.length, 0);
      assert.equal(test.calls.filter((call) => call.startsWith("CAPTURE ") || call.startsWith("pnpm ")).length, 0);
      assert.equal(test.receipts.size, 0);
    }
  });
  await check("remote preview database and incomplete pending suffix stop before Time Travel or apply", async () => {
    for (const variant of ["preview", "missing-prefix", "extra", "duplicate"]) {
      const test = cloudflareHarness({ root, intent,
        ...(variant === "preview" ? { databaseVersion: "preview" } : {}),
        ...(variant === "extra" ? { ledgerOverride: ["0001_foreign.sql"] } : {}),
        ...(variant === "duplicate" ? { ledgerOverride: [migrationNames[0], migrationNames[0]] } : {}) });
      if (variant === "preview") {
        await assert.rejects(test.run(), /production-version readback/u);
      }
      if (variant === "missing-prefix") {
        const shorter = { ...intent, migration_names: [migrationNames[1]], migration_hashes: [intent.migration_hashes[1]],
          max_migrations: 1, max_sql_bytes: intent.migration_hashes.length ? Buffer.byteLength(migrationB) : 1,
          schema_probes: intent.schema_probes.filter((probe) => probe.migration_names.includes(migrationNames[1])) };
        shorter.risk_review = { ...shorter.risk_review,
          reviewed_bundle_sha256: sha256(JSON.stringify(shorter.migration_hashes)) };
        await assert.rejects(test.run(shorter));
      } else if (variant !== "preview") await assert.rejects(test.run());
      assert.equal(test.calls.some((call) => call.startsWith("CAPTURE ") || call.includes("migrations apply")), false);
      assert.equal(test.receipts.size, 0);
    }
  });
  await check("successful operation pins account/name, captures bookmark before apply, and requires schema plus metadata readback", async () => {
    const test = cloudflareHarness({ root, intent });
    const receipt = await test.run();
    assert.equal(receipt.overall_state, "PASS");
    assert.equal(receipt.time_travel.bookmark, "fixture-bookmark");
    assert.equal(receipt.target.database_name, "eliotr-core");
    assert.deepEqual(receipt.observations.at(-1).metadata_markers, [
      { key: "fixture_generation", expected_value: "fixture-v1", observed_value: "fixture-v1", state: "PASS" },
    ]);
    assert.ok(test.calls.indexOf("CAPTURE pnpm exec wrangler d1 time-travel info eliotr-core --json --config wrangler.deploy.jsonc") <
      test.calls.findIndex((call) => call.startsWith("SAVE ATTEMPT_STARTED")));
    assert.ok(test.calls.findIndex((call) => call.startsWith("SAVE ATTEMPT_STARTED")) <
      test.calls.findIndex((call) => call.includes("wrangler d1 migrations apply eliotr-core")));
    assert.deepEqual(test.getApplied(), migrationNames);
    assert.ok(test.apiCalls.some(({ body }) => body?.sql === "SELECT key, value FROM schema_state WHERE key = ? LIMIT 2"));
    const beforeView = receipt.observations.find((observation) => observation.kind === "BEFORE_APPLY")
      .schema_probes.find((probe) => probe.name === "fixture_view");
    const afterView = receipt.observations.at(-1).schema_probes.find((probe) => probe.name === "fixture_view");
    assert.equal(beforeView.expected_sql_sha256, null, "the first CREATE in this pending suffix pins view absence");
    assert.equal(beforeView.state, "PASS");
    assert.equal(afterView.expected_sql_sha256, sha256(viewSql), "the later named replacement is read back exactly");
    assert.equal(afterView.state, "PASS");
  });
  await check("pre-existing view replacement passes only with its reviewed old SQL hash", async () => {
    const replacementIntent = intentFor([migrationNames[1]]);
    const test = cloudflareHarness({ root, intent: replacementIntent, applied: [migrationNames[0]] });
    const receipt = await test.run();
    const beforeView = receipt.observations.find((observation) => observation.kind === "BEFORE_APPLY")
      .schema_probes.find((probe) => probe.name === "fixture_view");
    assert.equal(beforeView.expected_sql_sha256, sha256(oldViewSql));
    assert.equal(beforeView.observed_sql_sha256, sha256(oldViewSql));
    assert.equal(beforeView.state, "PASS");
    assert.equal(receipt.overall_state, "PASS");
  });
  await check("pre-existing replacement with a changed old SQL hash records NOT_STARTED without apply", async () => {
    const replacementIntent = intentFor([migrationNames[1]]);
    const test = cloudflareHarness({ root, intent: replacementIntent, applied: [migrationNames[0]],
      preflightMismatch: "fixture_view" });
    await assert.rejects(test.run(), /Exact schema object preconditions failed/u);
    assert.deepEqual(test.getApplied(), [migrationNames[0]]);
    assert.equal(test.calls.some((call) => call.includes("wrangler d1 migrations apply")), false);
    const receipt = JSON.parse([...test.receipts.values()].at(-1));
    assert.equal(receipt.overall_state, "FAILED");
    assert.equal(receipt.attempt_history[0].command_outcome, "NOT_STARTED");
    assert.equal(receipt.observations.at(-1).schema_probes.find((probe) => probe.name === "fixture_view").state, "MISMATCH");
  });
  await check("same-name view, trigger, index and case/type conflicts fail preflight without ledger advance", async () => {
    const cases = [
      { name: "fixture_view", preflightNameVariant: true },
      { name: "fixture_table_b_insert", preflightTypeOverride: "view" },
      { name: "fixture_table_b_idx", preflightNameVariant: true },
    ];
    for (const options of cases) {
      const test = cloudflareHarness({ root, intent, preflightMismatch: options.name, ...options });
      await assert.rejects(test.run(), /Exact schema object preconditions failed/u);
      assert.deepEqual(test.getApplied(), []);
      assert.equal(test.calls.some((call) => call.includes("wrangler d1 migrations apply")), false);
      const receipt = JSON.parse([...test.receipts.values()].at(-1));
      assert.equal(receipt.overall_state, "FAILED");
      assert.equal(receipt.attempt_history[0].command_outcome, "NOT_STARTED");
      assert.equal(receipt.observations.at(-1).schema_probes.some((probe) => probe.state === "MISMATCH"), true);
    }
  });
  await check("invalid Time Travel bookmark fails before any receipt or migration command", async () => {
    const test = cloudflareHarness({ root, intent, bookmark: "bad\nbookmark" });
    await assert.rejects(test.run(), /Time Travel bookmark readback is invalid/u);
    assert.equal(test.receipts.size, 0);
    assert.equal(test.calls.some((call) => call.includes("migrations apply")), false);
  });
  await check("same canonical intent reconciles ALREADY_APPLIED without rerunning; altered same-ID intent denies", async () => {
    const test = cloudflareHarness({ root, intent });
    const first = await test.run();
    const applyCount = test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length;
    const repeated = await test.run();
    assert.equal(repeated.overall_state, "ALREADY_APPLIED");
    assert.equal(repeated.attempt_history.length, 1);
    assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, applyCount);
    await assert.rejects(test.run({ ...intent, max_runtime_ms: 60_001 }), /Existing migration receipt does not match/u);
    assert.equal(first.overall_state, "PASS");
    assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, applyCount);
  });
  await check("schema or literal metadata drift after command cannot create a PASS receipt", async () => {
    for (const mismatch of ["schema:fixture_table_b", "metadata"]) {
      const test = cloudflareHarness({ root, intent, mismatch });
      await assert.rejects(test.run(), /did not reach complete ledger and schema readback/u);
      const saved = JSON.parse([...test.receipts.values()].at(-1));
      assert.equal(saved.overall_state, "UNKNOWN");
      assert.notEqual(saved.observations.at(-1).schema_state, "PASS");
      assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, 1);
    }
  });
  await check("partial started command is reconciled and same intent cannot automatically resume", async () => {
    const test = cloudflareHarness({ root, intent, failure: "PARTIAL" });
    await assert.rejects(test.run(), /same intent will not be reapplied/u);
    const saved = JSON.parse([...test.receipts.values()].at(-1));
    assert.equal(saved.overall_state, "PARTIAL");
    assert.equal(saved.attempt_history[0].command_outcome, "UNKNOWN");
    await assert.rejects(test.run(), /reconciliation requires a new explicitly approved intent/u);
    assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, 1);
  });
  await check("started timeout without ledger progress stays UNKNOWN and does not automatically retry", async () => {
    const test = cloudflareHarness({ root, intent, failure: "UNKNOWN" });
    await assert.rejects(test.run(), /same intent will not be reapplied/u);
    const saved = JSON.parse([...test.receipts.values()].at(-1));
    assert.equal(saved.overall_state, "UNKNOWN");
    await assert.rejects(test.run(), /reconciliation requires a new explicitly approved intent/u);
    assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, 1);
  });
  await check("cancellation after command start records UNKNOWN without retry", async () => {
    const controller = new globalThis.AbortController();
    const test = cloudflareHarness({ root, intent, failure: "CANCEL", cancel: () => controller.abort() });
    await assert.rejects(test.run(intent, { signal: controller.signal }), /same intent will not be reapplied/u);
    const saved = JSON.parse([...test.receipts.values()].at(-1));
    assert.equal(saved.overall_state, "UNKNOWN");
    assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, 1);
  });
});

console.log(`D1 migration operation: ${groups} groups passed; live Cloudflare NOT_EXECUTED`);
