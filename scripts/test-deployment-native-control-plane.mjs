import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeploymentMigrationSchemaProbeGroups, deploymentMigrationIntentSha256,
  readDeploymentMigrationLocalPlan, runDeploymentMigrationOperation,
  validateDeploymentMigrationIntent } from "./lib/deployment-migration-operation.mjs";
import { projectDeploymentNativeTriggerSql } from "./lib/deployment-native-trigger-representation.mjs";
import { projectDeploymentNativeCommentlessSql } from "./lib/deployment-native-sql-representation.mjs";
import { SUPPORTED_SCHEMA_REPRESENTATION, deploymentPlatformSchemaObject,
  projectSupportedDeploymentSchema } from "./lib/deployment-native-platform-schema.mjs";
import { attestDeploymentApplicationSchemas } from "./lib/deployment-schema-attestation.mjs";
import { readDeploymentMigrationEntries } from "./lib/deployment-migrations.mjs";
import { createDeploymentSchemaManifest } from "./lib/deployment-schema-manifest.mjs";
import { pinGeneratedDeploymentConfig } from "./lib/deployment-build-inputs.mjs";
import { validateDeploymentNativeSchemaProvenance } from "./lib/deployment-native-schema-provenance.mjs";
import { validateOwnerWebSchemaMaterialization } from "./lib/deployment-owner-web.mjs";
import { parseDeploymentArguments } from "./deploy-cloudflare.mjs";
import { parseDeploymentJsonc } from "./lib/deployment-jsonc.mjs";

// SQL effects/readbacks use real isolated SQLite; process/Cloudflare boundaries
// are controlled. Actual Wrangler local qualification is a separate receipt.
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const prefix = "eliotr-native-control-";
const account = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const coreId = "11111111-1111-4111-8111-111111111111";
const searchId = "22222222-2222-4222-8222-222222222222";
const names = ["0001_authority.sql", "0002_native_guard.sql"];
const original = "CREATE TRIGGER fixture_guard BEFORE INSERT ON fixture_authority BEGIN\n" +
  "  SELECT CASE WHEN NEW.id < 0 THEN RAISE(ABORT, 'fixture blocked') END;\nEND;\n";
const projected = projectDeploymentNativeTriggerSql(original).sql;
const coreSql = "CREATE TABLE fixture_authority (id INTEGER PRIMARY KEY) STRICT;\n";
const searchSql = "CREATE TABLE fixture_search (id INTEGER PRIMARY KEY) STRICT;\n";
const assets = parseDeploymentJsonc(await readFile(new URL("../apps/eliotr-core/wrangler.jsonc", import.meta.url), "utf8")).assets;
let groups = 0;
const selection = process.argv[2];
async function check(name, action) {
  if (selection !== undefined && !name.startsWith(selection)) return;
  await action(); groups += 1; console.log(`Native D1 control plane: ${name}: PASS`);
}
async function fixture(action, { supported = false } = {}) {
  const sourceSql = supported ? original.replace("  SELECT", "  /* pending comment */ SELECT") : original;
  const effectSql = supported ? projectDeploymentNativeCommentlessSql(sourceSql).sql : projected;
  const temp = await realpath(tmpdir()), root = resolve(await mkdtemp(join(temp, prefix)));
  assert.equal(dirname(root), temp); assert.ok(basename(root).startsWith(prefix));
  const database = new DatabaseSync(":memory:");
  try {
    for (const folder of ["apps/eliotr-core", "infra/d1/core/migrations", "infra/d1/search/migrations", ".eliotr-state"]) {
      await mkdir(join(root, folder), { recursive: true });
    }
    const config = { name: "eliotr-core", main: "src/index.ts", preview_urls: false, assets,
      vars: { ENVIRONMENT: "production" }, d1_databases: [
        { binding: "CORE_DB", database_name: "eliotr-core", database_id: coreId, migrations_dir: "../../infra/d1/core/migrations" },
        { binding: "SEARCH_DB", database_name: "eliotr-search", database_id: searchId, migrations_dir: "../../infra/d1/search/migrations" }] };
    const bytes = Buffer.from(JSON.stringify(config));
    await writeFile(join(root, "apps/eliotr-core/wrangler.deploy.jsonc"), bytes);
    await writeFile(join(root, "apps/eliotr-core/wrangler.jsonc"), bytes);
    await writeFile(join(root, "infra/d1/core/migrations", names[0]), coreSql);
    await writeFile(join(root, "infra/d1/core/migrations", names[1]), sourceSql);
    await writeFile(join(root, "infra/d1/search/migrations/0001_search.sql"), searchSql);
    const bundle = await readDeploymentMigrationEntries(config, "CORE_DB", { root });
    const pendingPins = [bundle.migration_entries[1]];
    const effective = [bundle.migration_entries[0], { name: names[1], sha256: sha(effectSql) }];
    const intent = { protocol: supported ? "eliotr.cloudflare-d1-migration-intent.v5" : "eliotr.cloudflare-d1-migration-intent.v4", intent_id: randomUUID(), account_id: account,
      generated_config_sha256: sha(bytes), database: { binding: "CORE_DB", database_name: "eliotr-core", database_id: coreId },
      migration_names: [names[1]], migration_hashes: pendingPins, local_migration_bundle_sha256: bundle.local_migration_bundle_sha256,
      migration_transport: { protocol: supported ? "eliotr.d1-native-trigger-case-commentless.v1" : "eliotr.d1-native-trigger-case.v1", migration_hashes: [effective[1]],
        local_migration_bundle_sha256: sha(JSON.stringify(effective)) },
      risk_review: { classification: "schema_metadata_only", summary: "One guarded fixture trigger; reviewed canonical source and equivalent native representation.",
        reviewed_bundle_sha256: sha(JSON.stringify(pendingPins)), index_build_cost_reviewed: false, constraint_scan_bounds: [] },
      schema_probe_groups: createDeploymentMigrationSchemaProbeGroups([{ object_type: "trigger", name: "fixture_guard",
        ...(supported ? { before_raw_sql_sha256: null, create_raw_sql_sha256: sha(effectSql.trim().replace(/;$/u, "")) } : {}),
        before_sql_sha256: null, create_sql_sha256: sha(effectSql.trim().replace(/;$/u, "")), migration_names: [names[1]] }]),
      max_migrations: 1, max_sql_bytes: Buffer.byteLength(effectSql), deadline_at: "2030-01-01T00:00:00.000Z", max_runtime_ms: 60000 };
    const intentPath = ".eliotr-state/native-intent.json";
    await writeFile(join(root, intentPath), JSON.stringify(intent));
    database.exec(coreSql + "CREATE TABLE d1_migrations(name TEXT UNIQUE); INSERT INTO d1_migrations VALUES ('" + names[0] + "');");
    await action({ root, config, bytes, intent, intentPath, bundle, database, sourceSql, effectSql, supported });
  } finally {
    database.close();
    const info = await lstat(root);
    assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal(await realpath(root), root);
    assert.equal(dirname(root), temp); assert.ok(basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: false });
  }
}
function operationHarness(context, { outcome = "success", apply = true, tamperSchemaSql = false } = {}) {
  const { root, intent, database, bytes, sourceSql = original, effectSql = projected } = context;
  let effects = 0, apiCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    apiCalls += 1;
    if ((init.method ?? "GET") === "GET") return Response.json({ success: true,
      result: { uuid: coreId, name: "eliotr-core", version: "production", account_id: account } });
    assert.equal(init.method, "POST"); assert.ok(String(url).endsWith("/query"));
    const query = JSON.parse(init.body); assert.match(query.sql, /^SELECT /u);
    const rows = database.prepare(query.sql).all(...(query.params ?? []));
    if (tamperSchemaSql) for (const row of rows) if (typeof row.sql === "string") row.sql = row.sql.replace("SELECT ", "SELECT/* forged */ ");
    return Response.json({ success: true, result: [{ success: true,
      results: rows, meta: { changed_db: false, rows_written: 0 } }] });
  };
  const execute = async (command, args, cwd, _environment, commandOptions) => {
    effects += 1;
    assert.equal(commandOptions.shell, false);
    assert.equal(command, process.execPath); assert.match(args[0], /[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/u);
    assert.deepEqual(args.slice(1), ["d1", "migrations", "apply", "eliotr-core", "--remote", "--config", "wrangler.deploy.jsonc"]);
    assert.equal(cwd, join(root, ".eliotr-state/d1-native-migrations", intent.intent_id, "apps/eliotr-core"));
    assert.ok((await readFile(join(cwd, "wrangler.deploy.jsonc"))).equals(bytes));
    const mirrored = join(cwd, "../../infra/d1/core/migrations");
    assert.equal(await readFile(join(mirrored, names[0]), "utf8"), coreSql);
    assert.equal(await readFile(join(mirrored, names[1]), "utf8"), effectSql);
    assert.equal(await readFile(join(root, "infra/d1/core/migrations", names[1]), "utf8"), sourceSql);
    const receipt = JSON.parse(await readFile(join(root, ".eliotr-state/d1-migration-receipts", intent.intent_id + ".json")));
    assert.equal(receipt.time_travel.bookmark, "fixture-bookmark");
    if (apply) database.exec(effectSql + "INSERT INTO d1_migrations VALUES ('" + names[1] + "');");
    if (outcome === "unknown") throw Object.assign(new Error("Controlled lost process ACK"), { started: true, uncertain: true });
    return { status: 0 };
  };
  const run = () => runDeploymentMigrationOperation({ root, intent, confirmLive: true,
    environment: { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "fixture-token", ELIOTR_ENVIRONMENT: "production" },
    execute, fetchImpl, capture: async () => JSON.stringify({ bookmark: "fixture-bookmark" }),
    now: () => Date.parse("2026-10-11T00:00:00.000Z"), log: () => {} });
  const receipt = async () => JSON.parse(await readFile(join(root, ".eliotr-state/d1-migration-receipts", intent.intent_id + ".json")));
  return { run, receipt, get effects() { return effects; }, get apiCalls() { return apiCalls; } };
}
function catalogueExecutor(context, { drift } = {}) {
  const databases = new Map(), calls = [];
  return {
    calls, close: () => { for (const db of databases.values()) db.close(); },
    execute: async (args, options) => {
      calls.push({ args, cwd: options.cwd });
      assert.ok(args.includes("--local")); assert.equal(args.includes("--remote"), false);
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      assert.notEqual(options.cwd, context.root);
      const configFile = args[args.indexOf("--config") + 1];
      assert.ok((await readFile(configFile)).equals(context.bytes));
      const binding = options.diagnosticContext.binding;
      if (args[2] === "migrations") {
        const db = new DatabaseSync(":memory:"); databases.set(binding, db);
        const folder = join(options.cwd, "infra/d1", binding === "CORE_DB" ? "core" : "search", "migrations");
        for (const name of readdirSync(folder).sort()) db.exec(readFileSync(join(folder, name), "utf8"));
        if (context.supported) db.exec(deploymentPlatformSchemaObject(SUPPORTED_SCHEMA_REPRESENTATION.source_platform_profile).sql);
        return "";
      }
      const sql = args[args.indexOf("--command") + 1];
      const rows = databases.get(binding).prepare(sql).all();
      if (binding === "SEARCH_DB" && drift) {
        const file = drift === "intent" ? context.intentPath : drift === "config" ? "apps/eliotr-core/wrangler.deploy.jsonc" : "infra/d1/core/migrations/" + names[1];
        await writeFile(join(context.root, file), Buffer.concat([await readFile(join(context.root, file)), Buffer.from(" \n")]));
      }
      return JSON.stringify([{ success: true, results: rows }]);
    },
  };
}
async function schemaResult(context, options) {
  const executor = catalogueExecutor(context, options);
  try {
    const pin = await pinGeneratedDeploymentConfig({ root: context.root });
    const result = await createDeploymentSchemaManifest({ root: context.root, config: context.config, accountId: account,
      generatedConfigPin: pin, migrationIntentFile: context.intentPath, execute: executor.execute });
    assert.equal(executor.calls.length, 4);
    return { result, pin };
  } finally { executor.close(); }
}
function capturedInputs(context, result) {
  return new Map(result.provenance.streams.map(stream => [stream.binding,
    stream.migration_entries.map(entry => ({ ...entry, byte_length: readFileSync(join(context.root,
      `infra/d1/${stream.binding === "CORE_DB" ? "core" : "search"}/migrations`, entry.name)).length }))]));
}

await check("v4-plan-only", () => fixture(async context => {
  const plan = await runDeploymentMigrationOperation({ root: context.root, intent: context.intent,
    execute: () => { throw new Error("Plan must not execute"); }, fetchImpl: () => { throw new Error("Plan must not query"); } });
  assert.equal(plan.state, "PLAN_ONLY"); assert.equal(plan.sql_bytes, Buffer.byteLength(projected));
}));
await check("v4-effect-and-exact-replay", () => fixture(async context => {
  const harness = operationHarness(context);
  const receipt = await harness.run(); assert.equal(receipt.overall_state, "PASS");
  assert.equal(receipt.protocol, "eliotr.cloudflare-d1-migration-receipt.v4");
  assert.deepEqual(receipt.migration_transport, context.intent.migration_transport);
  assert.throws(() => context.database.exec("INSERT INTO fixture_authority VALUES (-1)"), /fixture blocked/u);
  context.database.exec("INSERT INTO fixture_authority VALUES (1)");
  assert.equal((await harness.run()).overall_state, "ALREADY_APPLIED");
  assert.equal(harness.effects, 1); assert.equal((await harness.receipt()).attempt_history.length, 1);
}));
await check("v4-unknown-no-reapply", () => fixture(async context => {
  const harness = operationHarness(context, { outcome: "unknown", apply: false });
  await assert.rejects(harness.run, /same intent will not be reapplied/u);
  assert.equal((await harness.receipt()).overall_state, "UNKNOWN");
  await assert.rejects(harness.run, /Existing intent was not re-applied/u); assert.equal(harness.effects, 1);
}));
await check("v4-commit-lost-ack-reconciliation", () => fixture(async context => {
  const harness = operationHarness(context, { outcome: "unknown" });
  await assert.rejects(harness.run, /same intent will not be reapplied/u);
  assert.equal((await harness.receipt()).overall_state, "UNKNOWN");
  assert.equal((await harness.run()).overall_state, "ALREADY_APPLIED"); assert.equal(harness.effects, 1);
}));
await check("v4-pin-shape-and-legacy-guard-negatives", () => fixture(async context => {
  for (const field of ["migration_hashes", "migration_transport"]) {
    const intent = structuredClone(context.intent);
    if (field === "migration_hashes") intent.migration_hashes[0].sha256 = "0".repeat(64);
    else intent.migration_transport.migration_hashes[0].sha256 = "0".repeat(64);
    await assert.rejects(() => readDeploymentMigrationLocalPlan(intent, context.root));
  }
  assert.throws(() => validateDeploymentMigrationIntent({ ...context.intent, surprise: true }), /Invalid or unsupported/u);
  const legacy = structuredClone(context.intent); legacy.protocol = "eliotr.cloudflare-d1-migration-intent.v3"; delete legacy.migration_transport;
  await assert.rejects(() => readDeploymentMigrationLocalPlan(legacy, context.root), /Unparenthesized CASE/u);
  await writeFile(join(context.root, "infra/d1/core/migrations", names[1]), original + "-- drift\n");
  await assert.rejects(() => readDeploymentMigrationLocalPlan(context.intent, context.root), /bundle differs/u);
}));
await check("v4-saved-receipt-transport-tamper", () => fixture(async context => {
  const harness = operationHarness(context); await harness.run();
  const receipt = await harness.receipt(); receipt.migration_transport.local_migration_bundle_sha256 = "0".repeat(64);
  await writeFile(join(context.root, ".eliotr-state/d1-migration-receipts", context.intent.intent_id + ".json"), JSON.stringify(receipt));
  await assert.rejects(harness.run, /receipt/u); assert.equal(harness.effects, 1);
}));
await check("v2-full-catalogue-and-provenance", () => fixture(async context => {
  const { result, pin } = await schemaResult(context);
  assert.equal(result.provenance.protocol, "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v2");
  assert.equal(result.expectedManifest.streams[0].objects.find(object => object.type === "trigger").sql,
    projected.trim().replace(/;$/u, ""));
  assert.deepEqual(result.expectedManifest.streams.map(stream => stream.objects.length), [2, 1]);
  const input = { root: context.root, representation: result.provenance.migration_representation,
    sourceStreams: result.provenance.streams, capturedMigrations: capturedInputs(context, result), generatedConfigPin: pin };
  assert.equal(validateDeploymentNativeSchemaProvenance(input), true);
  for (const target of ["selected", "unselected", "unknown-field", "intent", "path"]) {
    const representation = structuredClone(input.representation);
    if (target === "selected" || target === "unselected") representation.streams[target === "selected" ? 0 : 1].migration_bundle_sha256 = "0".repeat(64);
    if (target === "unknown-field") representation.surprise = true;
    if (target === "intent") { representation.intent.account_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      representation.intent_sha256 = deploymentMigrationIntentSha256(representation.intent); }
    if (target === "path") representation.intent_file.path = "../native-intent.json";
    assert.throws(() => validateDeploymentNativeSchemaProvenance({ ...input, representation }));
  }
  const manifest = { root: context.root, sha256: "fixture-manifest", inputs: [...input.capturedMigrations].flatMap(([binding, entries]) =>
    entries.map(entry => ({ path: `infra/d1/${binding === "CORE_DB" ? "core" : "search"}/migrations/${entry.name}`, ...entry }))) };
  const source = { bytes: context.bytes, pin, normalizedConfig: structuredClone(context.config) };
  source.normalizedConfig.assets.directory = "../eliotr-web/dist/client";
  validateOwnerWebSchemaMaterialization(manifest, { manifest_sha256: manifest.sha256 }, source, result);
  const downgraded = structuredClone(result); downgraded.provenance.protocol = "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v1";
  assert.throws(() => validateOwnerWebSchemaMaterialization(manifest, { manifest_sha256: manifest.sha256 }, source, downgraded), /provenance fields/u);
}));
for (const drift of ["intent", "config", "migration"]) {
  await check("v2-materialization-drift-" + drift, () => fixture(async context => {
    await assert.rejects(() => schemaResult(context, { drift }));
  }));
}
await check("explicit-deployment-intent-option", async () => {
  assert.equal(parseDeploymentArguments(["--maintenance", "--migration-intent-file", ".eliotr-state/intent.json"]).migrationIntentFile, ".eliotr-state/intent.json");
  for (const args of [["--migration-intent-file"], ["--migration-intent-file", ""],
    ["--migration-intent-file", "--confirm-live"], ["--migration-intent-file", "a", "--migration-intent-file", "b"], ["--unknown-intent-option"]]) {
    assert.throws(() => parseDeploymentArguments(args), /arguments are invalid/u);
  }
});
await check("v5-raw-probe-refuses-arbitrary-comment-variant", () => fixture(async context => {
  const harness = operationHarness(context, { tamperSchemaSql: true });
  await assert.rejects(harness.run);
  const saved = await harness.receipt();
  assert.notEqual(saved.overall_state, "PASS"); assert.equal(harness.effects, 1);
  const probe = saved.observations.find(item => item.kind === "AFTER_APPLY").schema_probe_groups[0].observations[0];
  assert.equal(probe.state, "MISMATCH"); assert.equal(probe.observed_sql_sha256, probe.expected_sql_sha256);
  assert.notEqual(probe.raw_sql_sha256, probe.expected_sql_sha256);
}, { supported: true }));
await check("v5-effect-original-pins-and-exact-replay", () => fixture(async context => {
  const harness = operationHarness(context);
  const result = await harness.run();
  assert.equal(result.protocol, "eliotr.cloudflare-d1-migration-receipt.v5"); assert.equal(result.overall_state, "PASS");
  const after = result.observations.find(item => item.kind === "AFTER_APPLY");
  const probe = after.schema_probe_groups[0].observations[0];
  assert.equal(probe.raw_sql_sha256, probe.observed_sql_sha256);
  assert.equal(probe.observed_sql_sha256, context.intent.schema_probe_groups[0].probes[0].create_sql_sha256);
  assert.equal((await harness.run()).overall_state, "ALREADY_APPLIED"); assert.equal(harness.effects, 1);
  const saved = await harness.receipt(); delete saved.observations[0].schema_probe_groups[0].observations[0].raw_sql_sha256;
  await writeFile(join(context.root, ".eliotr-state/d1-migration-receipts", context.intent.intent_id + ".json"), JSON.stringify(saved));
  await assert.rejects(harness.run, /receipt/u); assert.equal(harness.effects, 1);
}, { supported: true }));
await check("v5-unknown-remains-no-reapply", () => fixture(async context => {
  const harness = operationHarness(context, { outcome: "unknown", apply: false });
  await assert.rejects(harness.run, /same intent will not be reapplied/u);
  assert.equal((await harness.receipt()).overall_state, "UNKNOWN");
  await assert.rejects(harness.run, /Existing intent was not re-applied/u); assert.equal(harness.effects, 1);
}, { supported: true }));
await check("v5-committed-lost-ack-reconciles", () => fixture(async context => {
  const harness = operationHarness(context, { outcome: "unknown" });
  await assert.rejects(harness.run, /same intent will not be reapplied/u);
  assert.equal((await harness.receipt()).overall_state, "UNKNOWN");
  assert.equal((await harness.run()).overall_state, "ALREADY_APPLIED"); assert.equal(harness.effects, 1);
}, { supported: true }));
await check("v5-protocol-and-effective-pin-negatives", () => fixture(async context => {
  for (const kind of ["v4-mix", "v5-mix", "effect"]) {
    const intent = structuredClone(context.intent);
    if (kind === "v4-mix") intent.protocol = "eliotr.cloudflare-d1-migration-intent.v4";
    if (kind === "v5-mix") intent.migration_transport.protocol = "eliotr.d1-native-trigger-case.v1";
    if (kind === "effect") intent.migration_transport.migration_hashes[0].sha256 = "0".repeat(64);
    await assert.rejects(() => readDeploymentMigrationLocalPlan(intent, context.root));
  }
}, { supported: true }));
await check("v5-full-raw-provenance-owner-gate-and-attestation", () => fixture(async context => {
  const { result, pin } = await schemaResult(context);
  assert.equal(result.expectedManifest.protocol, "eliotr.cloudflare-d1.application-schema-manifest.v2");
  assert.equal(result.provenance.protocol, "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v3");
  assert.deepEqual(result.expectedManifest.representation, SUPPORTED_SCHEMA_REPRESENTATION);
  const inputs = capturedInputs(context, result);
  validateDeploymentNativeSchemaProvenance({ root: context.root, representation: result.provenance.migration_representation,
    sourceStreams: result.provenance.streams, capturedMigrations: inputs, generatedConfigPin: pin });
  const manifest = { root: context.root, sha256: "fixture-manifest", inputs: [...inputs].flatMap(([binding, entries]) =>
    entries.map(entry => ({ path: "infra/d1/" + (binding === "CORE_DB" ? "core" : "search") + "/migrations/" + entry.name, ...entry }))) };
  const source = { bytes: context.bytes, pin, normalizedConfig: structuredClone(context.config) };
  source.normalizedConfig.assets.directory = "../eliotr-web/dist/client";
  validateOwnerWebSchemaMaterialization(manifest, { manifest_sha256: manifest.sha256 }, source, result);
  for (const kind of ["manifest-downgrade", "provenance-downgrade", "intent-downgrade", "profile-tamper", "extra-platform"]) {
    const bad = structuredClone(result);
    if (kind === "manifest-downgrade") bad.expectedManifest.protocol = "eliotr.cloudflare-d1.application-schema-manifest.v1";
    if (kind === "provenance-downgrade") bad.provenance.protocol = "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v2";
    if (kind === "intent-downgrade") bad.provenance.migration_representation.intent.protocol = "eliotr.cloudflare-d1-migration-intent.v4";
    if (kind === "profile-tamper") bad.expectedManifest.representation.target_platform_profile = "wildcard";
    if (kind === "extra-platform") bad.expectedManifest.streams[0].objects.push({ type: "table", name: "_cf_EXTRA", tbl_name: "_cf_EXTRA", sql: "CREATE TABLE _cf_EXTRA(x)" });
    bad.provenance.expected_manifest_sha256 = sha(JSON.stringify(bad.expectedManifest));
    bad.provenance.expected_manifest_byte_length = Buffer.byteLength(JSON.stringify(bad.expectedManifest));
    await assert.rejects(async () => validateOwnerWebSchemaMaterialization(manifest, { manifest_sha256: manifest.sha256 }, source, bad));
  }
  const remote = result.expectedManifest.streams.map(stream => projectSupportedDeploymentSchema(stream.objects, result.expectedManifest.representation));
  const env = { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: "fixture-token" };
  const read = objects => ({ readJson: async (url, _headers, options) => {
    assert.equal(typeof options.fetchImpl, "function");
    const index = String(url).includes(coreId) ? 0 : 1;
    const rows = objects[index].map(object => ({ row_kind: 0, ...object, object_count: null }));
    rows.push({ row_kind: 1, type: null, name: null, tbl_name: null, sql: null, object_count: rows.length });
    return { status: 200, data: { success: true, errors: [], messages: [], result: [{ success: true, results: rows,
      meta: { changed_db: false, rows_written: 0 } }] } };
  }, fetchImpl: async () => { throw new Error("No real API call allowed"); } });
  const receipt = await attestDeploymentApplicationSchemas(env, { apiBase: "https://api.cloudflare.com/client/v4" }, context.config,
    result.expectedManifest, read(remote));
  assert.equal(receipt.protocol, "eliotr.cloudflare-d1.application-schema-attestation.v2");
  assert.deepEqual(receipt.streams.map(stream => stream.raw_objects), remote);
  assert.notEqual(receipt.streams[0].raw_catalogue_sha256, receipt.streams[0].expected_raw_catalogue_sha256);
  for (const kind of ["missing", "extra", "altered-platform", "literal", "whitespace"]) {
    const bad = structuredClone(remote);
    if (kind === "missing") bad[0].pop();
    if (kind === "extra") bad[0].push({ type: "table", name: "foreign_extra", tbl_name: "foreign_extra", sql: "CREATE TABLE foreign_extra(x)" });
    if (kind === "altered-platform") bad[0].find(object => object.name === "_cf_KV").sql += " ";
    if (kind === "literal") bad[0].find(object => object.type === "trigger").sql = bad[0].find(object => object.type === "trigger").sql.replace("fixture blocked", "fixture changed");
    if (kind === "whitespace") bad[0].find(object => object.type === "trigger").sql += " ";
    await assert.rejects(() => attestDeploymentApplicationSchemas(env, { apiBase: "https://api.cloudflare.com/client/v4" },
      context.config, result.expectedManifest, read(bad)));
  }
}, { supported: true }));
assert.ok(groups > 0, "Unknown or empty test selection");
console.log(`Native D1 control plane: ${groups} focused groups passed; no remote/native-provider effect.`);
