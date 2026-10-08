import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { classifyDeploymentMigrationSql, runDeploymentMigrationOperation,
  createDeploymentMigrationSchemaProbeGroups, validateDeploymentMigrationIntent } from "./lib/deployment-migration-operation.mjs";
import { deploymentMigrationSchemaProbeGroupSha256, flattenDeploymentMigrationSchemaProbes,
  validateGroupedSchemaProbeObservations } from "./lib/deployment-migration-schema-probes.mjs";
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
const semanticRepairMigrationName = "0108_research_semantic_config_revision_glob_limits.sql";
const semanticRepairSql = await readFile(new URL("../infra/d1/core/migrations/" + semanticRepairMigrationName, import.meta.url), "utf8");
const semanticBaselineSql = await readFile(new URL("../infra/d1/core/migrations/0097_research_semantic_config_revision.sql", import.meta.url), "utf8");
const stageOperationRebuildMigrationName = "0113_research_provider_key_model_use_failure_alignment.sql";
const stageOperationRebuildSql = await readFile(new URL("../infra/d1/core/migrations/" + stageOperationRebuildMigrationName, import.meta.url), "utf8");
const stageOperationRebuildBaselineSql = await readFile(new URL("../infra/d1/core/migrations/0110_research_provider_key_model_use.sql", import.meta.url), "utf8");
const backupErasurePrimaryClosureSql = await readFile(new URL("../infra/d1/core/migrations/0117_backup_erasure_primary_closure.sql", import.meta.url), "utf8");
const stageOperationRebuildPredecessorPins = [
  { name: "0110_research_provider_key_model_use.sql",
    sha256: "cf906b6059822fb87fb2ed7d1551be55d0cbfa11adaf78e95617365fe0d3a12c" },
  { name: "0111_provider_native_model_authority.sql",
    sha256: "47829bbd0403b04ae74933e67f26e266d3c57b34086a5cf67ce843e393f8d207" },
  { name: "0112_workflow_failure_shape_alignment.sql",
    sha256: "fc3288924de8bb82078da27f23cd155c3b01aed24e4011ac8f53bfa5365dcf74" },
];
function classifySemanticRepair(sql = semanticRepairSql, overrides = {}) {
  return classifyDeploymentMigrationSql(sql, {
    migrationName: semanticRepairMigrationName,
    baselineMigrationSql: semanticBaselineSql,
    ...overrides,
  });
}
function classifyStageOperationRebuild(sql = stageOperationRebuildSql, overrides = {}) {
  return classifyDeploymentMigrationSql(sql, {
    migrationName: stageOperationRebuildMigrationName,
    baselineMigrationSql: stageOperationRebuildBaselineSql,
    predecessorMigrationHashes: stageOperationRebuildPredecessorPins,
    ...overrides,
  });
}
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

async function createFixture(action, { ifNotExists = false } = {}) {
  const parent = resolve(tmpdir());
  const prefix = "eliotr-d1-operation-";
  const root = await mkdtemp(join(parent, prefix));
  try {
    const fixtureMigrationA = ifNotExists ? migrationA.replace("CREATE VIEW", "CREATE VIEW IF NOT EXISTS") : migrationA;
    const fixtureMigrationB = ifNotExists ? migrationB
      .replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS")
      .replace("CREATE TRIGGER", "CREATE TRIGGER IF NOT EXISTS") : migrationB;
    const coreDirectory = join(root, "infra/d1/core/migrations");
    const searchDirectory = join(root, "infra/d1/search/migrations");
    const configDirectory = join(root, "apps/eliotr-core");
    await Promise.all([mkdir(coreDirectory, { recursive: true }), mkdir(searchDirectory, { recursive: true }),
      mkdir(configDirectory, { recursive: true })]);
    await Promise.all([
      writeFile(join(coreDirectory, migrationNames[0]), fixtureMigrationA),
      writeFile(join(coreDirectory, migrationNames[1]), fixtureMigrationB),
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
        max_sql_bytes: names.reduce((sum, name) => sum + Buffer.byteLength(name === migrationNames[0] ? fixtureMigrationA : fixtureMigrationB), 0),
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
  ledgerOverride = null, databaseVersion = "production", bookmark = "fixture-bookmark", cancel = () => {},
  additionalSchemaObjects = [] } = {}) {
  const fixtureSchemaObjects = [...schemaObjects, ...additionalSchemaObjects];
  const calls = [];
  const receipts = new Map();
  const apiCalls = [];
  let schemaFailureName = null;
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
      if (schemaFailureName === query.params[1]) throw new Error("fixture schema read unavailable");
      const object = fixtureSchemaObjects.find((entry) => entry.object_type === query.params[0] && entry.name === query.params[1]);
      if (object === undefined) throw new Error("Unexpected schema probe in migration fixture");
      rows = [{ type: object.object_type, name: object.name,
        sql: mismatch === `schema:${object.name}` ? `${object.sql} ` : object.sql }];
    } else if (query.sql === "SELECT type, name, sql FROM sqlite_master WHERE name = ? COLLATE NOCASE LIMIT 2") {
      const probe = flattenDeploymentMigrationSchemaProbes(intent).find((entry) => entry.name === query.params[0]);
      const object = fixtureSchemaObjects.find((entry) => entry.name === query.params[0]);
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
  return { calls, receipts, apiCalls, run, setApplied: (names) => { appliedNames = [...names]; },
    setSchemaFailure: (name) => { schemaFailureName = name; }, getApplied: () => [...appliedNames] };
}

function expandedV2Intent(intent, additionalProbeCount) {
  const additionalSchemaObjects = Array.from({ length: additionalProbeCount }, (_, index) => {
    const name = `fixture_existing_${String(index).padStart(3, "0")}`;
    const sql = `CREATE TABLE ${name} (id INTEGER PRIMARY KEY) STRICT`;
    return { object_type: "table", name, sql, before_sql: sql, migration_names: [intent.migration_names[0]] };
  });
  const probes = [...flattenDeploymentMigrationSchemaProbes(intent), ...additionalSchemaObjects.map((object) => ({
    object_type: object.object_type, name: object.name,
    before_sql_sha256: sha256(Buffer.from(object.before_sql, "utf8")),
    create_sql_sha256: sha256(Buffer.from(object.sql, "utf8")), migration_names: object.migration_names,
  }))];
  const base = { ...intent };
  delete base.schema_probes;
  return { intent: { ...base, protocol: "eliotr.cloudflare-d1-migration-intent.v2",
    schema_probe_groups: createDeploymentMigrationSchemaProbeGroups(probes) }, additionalSchemaObjects };
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
  const plainTriggerCase = "CREATE TRIGGER plain_case AFTER INSERT ON fixture_table BEGIN SELECT CASE WHEN NEW.id = 1 THEN RAISE(ABORT, 'blocked') END; END;";
  assert.throws(() => classifyDeploymentMigrationSql(plainTriggerCase), /Unparenthesized CASE expressions.*native D1/iu);
  for (const triggerCase of [
    "CREATE TRIGGER parenthesized_case AFTER INSERT ON fixture_table BEGIN SELECT (CASE WHEN NEW.id = 1 THEN RAISE(ABORT, 'blocked') END); END;",
    "CREATE TRIGGER nested_parenthesized_case AFTER INSERT ON fixture_table BEGIN SELECT ((CASE WHEN NEW.id = 1 THEN RAISE(ABORT, 'blocked') END)); END;",
    "CREATE TRIGGER raise_where AFTER INSERT ON fixture_table BEGIN SELECT RAISE(ABORT, 'blocked') WHERE NEW.id = 1; END;",
    "CREATE TRIGGER quoted_case AFTER INSERT ON fixture_table BEGIN SELECT 'CASE END;'; -- CASE END;\n/* CASE END; */ SELECT 1; END;",
  ]) {
    assert.equal(classifyDeploymentMigrationSql(triggerCase).required_schema_objects[0].object_type, "trigger");
  }
  assert.equal(classifyDeploymentMigrationSql("CREATE VIEW ordinary_case_view AS SELECT CASE WHEN 1 THEN 1 ELSE 0 END AS value;")
    .created_schema_objects[0].object_type, "view");
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

await check("0117 admits only nullable bounded ADD COLUMN CHECK predicates", async () => {
  const result = classifyDeploymentMigrationSql(backupErasurePrimaryClosureSql);
  assert.equal(result.classification, "schema_metadata_only");
  assert.equal(result.newly_created_tables.length, 7);
  assert.equal(result.created_schema_objects.length, 36);
  assert.equal(result.required_schema_objects.length, 38);
  assert.deepEqual(result.must_probe_schema_objects, []);

  for (const sql of [
    "ALTER TABLE target ADD COLUMN counter INTEGER NOT NULL CHECK (counter IS NULL OR counter > 0);",
    "ALTER TABLE target ADD COLUMN counter INTEGER CHECK (counter IS NULL OR counter > 0) DEFAULT 0;",
    "ALTER TABLE target ADD COLUMN counter INTEGER CHECK (counter IS NULL OR counter > (SELECT 0));",
    "ALTER TABLE target ADD COLUMN counter INTEGER CHECK (counter IS NULL OR other_column > 0);",
    "ALTER TABLE target ADD COLUMN counter INTEGER CHECK (counter IS NULL OR counter > 0); DELETE FROM target;",
  ]) {
    assert.throws(() => classifyDeploymentMigrationSql(sql));
  }
});

await check("0108 is admitted only as the exact guarded empty semantic-revision replacement", async () => {
  const result = classifySemanticRepair();
  assert.equal(result.classification, "schema_metadata_only");
  assert.equal(result.statement_count, 8);
  assert.deepEqual(result.newly_created_tables, [], "the replacement must not authorize later indexes over the repaired existing table");
  assert.deepEqual(result.must_probe_schema_objects, [
    { object_type: "table", name: "research_semantic_config_revision" },
    { object_type: "trigger", name: "research_semantic_config_revision_no_update" },
    { object_type: "trigger", name: "research_semantic_config_revision_no_delete" },
  ]);
  assert.throws(() => classifyDeploymentMigrationSql(semanticRepairSql),
    /outside the reviewed schema-only allowlist/u, "the generic classifier must still reject this special SQL");
});

await check("0108 rejects a missing or weakened emptiness guard, another target, row copy, or changed baseline", async () => {
  const weakenedGuard = semanticRepairSql.replace("CHECK (empty_confirmed = 1)", "CHECK (empty_confirmed IN (0, 1))");
  assert.notEqual(weakenedGuard, semanticRepairSql);
  assert.throws(() => classifySemanticRepair(weakenedGuard));

  const missingAssertion = semanticRepairSql.replace(
    "INSERT INTO __eliotr_migration_0108_research_semantic_config_revision_empty_guard (empty_confirmed)",
    "UPDATE __eliotr_migration_0108_research_semantic_config_revision_empty_guard");
  assert.notEqual(missingAssertion, semanticRepairSql);
  assert.throws(() => classifySemanticRepair(missingAssertion));

  const otherTarget = semanticRepairSql.replace("SELECT 1 FROM research_semantic_config_revision LIMIT 1",
    "SELECT 1 FROM another_table LIMIT 1");
  assert.notEqual(otherTarget, semanticRepairSql);
  assert.throws(() => classifySemanticRepair(otherTarget));

  const rowCopy = semanticRepairSql.replace("DROP TABLE research_semantic_config_revision;",
    "INSERT INTO research_semantic_config_revision SELECT * FROM research_semantic_config_revision_0108;\nDROP TABLE research_semantic_config_revision;");
  assert.notEqual(rowCopy, semanticRepairSql);
  assert.throws(() => classifySemanticRepair(rowCopy));

  const changedBaseline = semanticBaselineSql.replace("config_json TEXT NOT NULL", "config_json TEXT");
  assert.notEqual(changedBaseline, semanticBaselineSql);
  assert.throws(() => classifySemanticRepair(semanticRepairSql, { baselineMigrationSql: changedBaseline }));
});

await check("0113 admits only the exact capped data-preserving rebuild and probes its nine triggers plus FK tables", async () => {
  assert.equal(sha256(Buffer.from(stageOperationRebuildSql, "utf8")),
    "308df2409b85ff48fce06e25b98564f02852a1a3cd2db1c6746a6b8492a9492b");
  const result = classifyStageOperationRebuild();
  const triggerNames = [
    "research_provider_key_model_price_observation_owner_insert",
    "provider_native_model_preparation_guard",
    "provider_native_model_qualification_attempt_guard",
    "provider_native_model_observation_guard",
    "provider_native_model_candidate_guard",
    "provider_native_model_qualification_proof_guard",
    "provider_native_model_qualification_complete_guard",
    "research_provider_key_model_use_stage_transition",
    "research_provider_key_model_use_stage_no_delete",
  ];
  const replacements = [
    { object_type: "table", name: "research_provider_key_model_use_stage_operation" },
    ...triggerNames.map((name) => ({ object_type: "trigger", name })),
  ];
  assert.equal(result.classification, "data_preserving_bounded_copy_rebuild");
  assert.equal(result.index_build_cost_reviewed, false);
  assert.deepEqual(result.newly_created_tables, []);
  assert.deepEqual(result.bounded_copy, {
    table: "research_provider_key_model_use_stage_operation",
    maximum_rows: 64,
    maximum_scanned_rows: 65,
    maximum_field_payload_bytes: 1_048_576,
  });
  assert.deepEqual(result.required_schema_objects, [
    ...replacements,
    { object_type: "table", name: "research_provider_key_model_use_operation" },
    { object_type: "table", name: "research_provider_key_model_price_observation" },
    { object_type: "table", name: "provider_native_model_preparation" },
  ]);
  assert.deepEqual(result.must_probe_schema_objects, replacements);
  assert.deepEqual(result.created_schema_objects, replacements.map((entry) => ({ ...entry, replacement: true })));
});

await check("0113 rejects cap/hash, predecessor, baseline, or migration-identity drift and stays outside generic DML", async () => {
  assert.throws(() => classifyDeploymentMigrationSql(stageOperationRebuildSql));
  assert.throws(() => classifyStageOperationRebuild(stageOperationRebuildSql.replace("COUNT(*) <= 64", "COUNT(*) <= 65")),
    /exact bounded-copy SQL bytes/u);
  assert.throws(() => classifyStageOperationRebuild(stageOperationRebuildSql.replace("<= 1048576 THEN", "<= 1048577 THEN")),
    /exact bounded-copy SQL bytes/u);
  assert.throws(() => classifyStageOperationRebuild(stageOperationRebuildSql, {
    migrationName: "0114_provider_native_model_proof_attempt_alignment.sql",
  }));
  assert.throws(() => classifyStageOperationRebuild(stageOperationRebuildSql, {
    baselineMigrationSql: `${stageOperationRebuildBaselineSql}\n`,
  }), /immutable 0110 source schema/u);
  const changedPredecessors = stageOperationRebuildPredecessorPins.map((pin, index) =>
    index === 1 ? { ...pin, sha256: sha256(Buffer.from("changed predecessor")) } : pin);
  assert.throws(() => classifyStageOperationRebuild(stageOperationRebuildSql, {
    predecessorMigrationHashes: changedPredecessors,
  }), /exact 0110-0112 predecessor migration pins/u);
});

await createFixture(async ({ root, intentFor }) => {
  const intent = intentFor();
  validateDeploymentMigrationIntent(intent);
  await check("v2 reads more than 64 probes in fixed groups and keeps interrupted readback as a non-retryable prefix", async () => {
    const { intent: groupedIntent, additionalSchemaObjects } = expandedV2Intent(intent, 65);
    validateDeploymentMigrationIntent(groupedIntent);
    const test = cloudflareHarness({ root, intent: groupedIntent, additionalSchemaObjects });
    const completed = await test.run();
    assert.equal(completed.protocol, "eliotr.cloudflare-d1-migration-receipt.v2");
    assert.equal(completed.overall_state, "PASS");
    assert.deepEqual(completed.observations[0].schema_probe_groups.map((group) => group.observations.length), [64, 7]);
    assert.deepEqual(completed.observations[1].schema_probe_groups.map((group) => group.observations.length), [64, 7]);
    const after = completed.observations[1];
    const validateGroupedObservation = (observation) => validateGroupedSchemaProbeObservations({
      groups: groupedIntent.schema_probe_groups, observedGroups: observation.schema_probe_groups, kind: observation.kind,
      schemaState: observation.schema_state, metadataMarkers: observation.metadata_markers,
      expectedMetadataMarkers: [{ key: "fixture_generation", value: "fixture-v1" }],
    });
    assert.equal(validateGroupedObservation(after), true);
    const forgedHash = structuredClone(after);
    forgedHash.schema_probe_groups[0].observations[0].observed_sql_sha256 = sha256("forged PASS hash");
    assert.equal(validateGroupedObservation(forgedHash), false);
    const forgedMarker = structuredClone(after);
    forgedMarker.metadata_markers[0].observed_value = "forged PASS marker";
    assert.equal(validateGroupedObservation(forgedMarker), false);
    const gap = structuredClone(after);
    gap.schema_state = "UNAVAILABLE";
    gap.schema_probe_groups[0].observations.pop();
    gap.metadata_markers = [];
    assert.equal(validateGroupedObservation(gap), false);
    const prematureMarker = structuredClone(after);
    prematureMarker.schema_state = "UNAVAILABLE";
    prematureMarker.schema_probe_groups[1].observations.pop();
    assert.equal(validateGroupedObservation(prematureMarker), false);
    const applyCount = test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length;
    test.setSchemaFailure("fixture_existing_000");
    await assert.rejects(test.run(), /Existing intent was not re-applied/u);
    const reconciled = JSON.parse([...test.receipts.values()].at(-1));
    const partial = reconciled.observations.at(-1);
    assert.equal(reconciled.overall_state, "UNKNOWN");
    assert.equal(partial.schema_state, "UNAVAILABLE");
    assert.deepEqual(partial.schema_probe_groups.map((group) => group.observations.length), [2, 0]);
    assert.deepEqual(partial.schema_probe_groups[0].observations.map((probe) => probe.state), ["PASS", "UNAVAILABLE"]);
    assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, applyCount);
  });
  await check("v2 requires every classifier-derived object and rejects a wrong observed schema hash", async () => {
    const { intent: groupedIntent, additionalSchemaObjects } = expandedV2Intent(intent, 65);
    const withoutRequired = { ...groupedIntent, schema_probe_groups: createDeploymentMigrationSchemaProbeGroups(
      flattenDeploymentMigrationSchemaProbes(groupedIntent).filter((probe) => probe.name !== "fixture_table_b")) };
    validateDeploymentMigrationIntent(withoutRequired);
    const plan = cloudflareHarness({ root, intent: groupedIntent, additionalSchemaObjects });
    await assert.rejects(plan.run(withoutRequired, { confirmLive: false }), /Missing exact schema contract probe/u);
    assert.equal(plan.apiCalls.length, 0);
    assert.equal(plan.calls.length, 0);

    const probes = flattenDeploymentMigrationSchemaProbes(groupedIntent).map((probe) => probe.name === "fixture_existing_000"
      ? { ...probe, create_sql_sha256: sha256("reviewed wrong schema hash") } : probe);
    const wrongHashIntent = { ...groupedIntent, schema_probe_groups: createDeploymentMigrationSchemaProbeGroups(probes) };
    validateDeploymentMigrationIntent(wrongHashIntent);
    const test = cloudflareHarness({ root, intent: wrongHashIntent, additionalSchemaObjects });
    await assert.rejects(test.run(), /did not reach complete ledger and schema readback/u);
    const saved = JSON.parse([...test.receipts.values()].at(-1));
    const after = saved.observations.at(-1);
    assert.equal(saved.overall_state, "UNKNOWN");
    assert.equal(after.schema_state, "MISMATCH");
    assert.equal(after.schema_probe_groups.flatMap((group) => group.observations).at(-1).state, "MISMATCH");
    const applyCount = test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length;
    await assert.rejects(test.run(), /Existing intent was not re-applied/u);
    assert.equal(test.calls.filter((call) => call.includes("wrangler d1 migrations apply")).length, applyCount);
  });
  await check("v2 enforces duplicate-free 64-probe group boundaries and the 256-probe ceiling", async () => {
    const { intent: groupedIntent } = expandedV2Intent(intent, 65);
    const duplicatedGroups = structuredClone(groupedIntent.schema_probe_groups);
    duplicatedGroups[1].probes[0] = structuredClone(duplicatedGroups[0].probes.at(-1));
    duplicatedGroups.forEach((group) => { group.group_sha256 = deploymentMigrationSchemaProbeGroupSha256(group.probes); });
    assert.throws(() => validateDeploymentMigrationIntent({ ...groupedIntent, schema_probe_groups: duplicatedGroups }),
      /Invalid or unsupported versioned/u);

    const shortFirstGroup = structuredClone(groupedIntent.schema_probe_groups);
    const moved = shortFirstGroup[0].probes.pop();
    shortFirstGroup[1].probes.unshift(moved);
    shortFirstGroup.forEach((group) => { group.group_sha256 = deploymentMigrationSchemaProbeGroupSha256(group.probes); });
    assert.throws(() => validateDeploymentMigrationIntent({ ...groupedIntent, schema_probe_groups: shortFirstGroup }),
      /Invalid or unsupported versioned/u);
    assert.throws(() => expandedV2Intent(intent, 251), /between 1 and 256/u);
  });
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

await check("literal IF NOT EXISTS view, trigger and index conflicts cannot apply or advance the ledger", async () => {
  await createFixture(async ({ root, intentFor }) => {
    const firstSql = await readFile(join(root, "infra/d1/core/migrations", migrationNames[0]), "utf8");
    const secondSql = await readFile(join(root, "infra/d1/core/migrations", migrationNames[1]), "utf8");
    assert.match(firstSql, /CREATE VIEW IF NOT EXISTS fixture_view/u);
    assert.match(secondSql, /CREATE TRIGGER IF NOT EXISTS fixture_table_b_insert/u);
    assert.match(secondSql, /CREATE INDEX IF NOT EXISTS fixture_table_b_idx/u);
    for (const name of ["fixture_view", "fixture_table_b_insert", "fixture_table_b_idx"]) {
      const test = cloudflareHarness({ root, intent: intentFor(), preflightMismatch: name });
      await assert.rejects(test.run(), /Exact schema object preconditions failed/u);
      assert.deepEqual(test.getApplied(), []);
      assert.equal(test.calls.some((call) => call.includes("wrangler d1 migrations apply")), false);
      const receipt = JSON.parse([...test.receipts.values()].at(-1));
      assert.equal(receipt.overall_state, "FAILED");
      assert.equal(receipt.attempt_history[0].command_outcome, "NOT_STARTED");
      assert.equal(receipt.observations.at(-1).schema_probes.find((probe) => probe.name === name)?.state, "MISMATCH");
    }
  }, { ifNotExists: true });
});

console.log(`D1 migration operation: ${groups} groups passed; live Cloudflare NOT_EXECUTED`);
