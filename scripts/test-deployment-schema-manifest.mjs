import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createDeploymentSchemaManifest,
  MAX_DEPLOYMENT_SCHEMA_MANIFEST_BYTES,
} from "./lib/deployment-schema-manifest.mjs";
import {
  DEPLOYMENT_SCHEMA_CATALOGUE_QUERY,
  DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL,
  deploymentSchemaCatalogueSha256,
} from "./lib/deployment-schema-attestation.mjs";
import { pinGeneratedDeploymentConfig } from "./lib/deployment-build-inputs.mjs";
import { readDeploymentMigrationEntries } from "./lib/deployment-migrations.mjs";
import { WRANGLER } from "./lib/local-launch.mjs";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CORE_ASSETS = JSON.parse(await readFile(new URL("../apps/eliotr-core/wrangler.jsonc", import.meta.url), "utf8")).assets;
const CORE_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "22222222-2222-4222-8222-222222222222";
const FIXTURE_PREFIX = "eliotr-schema-manifest-test-";

async function createFixture() {
  const tempBase = await realpath(tmpdir());
  const root = resolve(await mkdtemp(join(tempBase, FIXTURE_PREFIX)));
  if (dirname(root) !== tempBase || !basename(root).startsWith(FIXTURE_PREFIX)) {
    throw new Error("Refusing an unexpected schema-manifest test fixture path");
  }
  try {
    const coreMigrations = join(root, "infra", "d1", "core", "migrations");
    const searchMigrations = join(root, "infra", "d1", "search", "migrations");
    const coreConfigDirectory = join(root, "apps", "eliotr-core");
    await mkdir(coreMigrations, { recursive: true });
    await mkdir(searchMigrations, { recursive: true });
    await mkdir(coreConfigDirectory, { recursive: true });
    await writeFile(join(coreMigrations, "0001_fixture.sql"),
      "CREATE TABLE synthetic_core (id TEXT PRIMARY KEY);\n", { flag: "wx", mode: 0o600 });
    await writeFile(join(searchMigrations, "0001_fixture.sql"),
      "CREATE TABLE synthetic_search (id TEXT PRIMARY KEY);\n", { flag: "wx", mode: 0o600 });

    const config = {
      name: "eliotr-core",
      main: "src/index.ts",
      assets: CORE_ASSETS,
      d1_databases: [
        {
          binding: "CORE_DB",
          database_name: "eliotr-core",
          database_id: CORE_ID,
          migrations_dir: "../../infra/d1/core/migrations",
        },
        {
          binding: "SEARCH_DB",
          database_name: "eliotr-search",
          database_id: SEARCH_ID,
          migrations_dir: "../../infra/d1/search/migrations",
        },
      ],
    };
    const configPath = join(coreConfigDirectory, "wrangler.deploy.jsonc");
    await writeFile(configPath, JSON.stringify(config) + "\n", { flag: "wx", mode: 0o600 });
    await writeFile(join(coreConfigDirectory, "wrangler.jsonc"), JSON.stringify(config) + "\n", { flag: "wx", mode: 0o600 });
    const generatedConfigPin = await pinGeneratedDeploymentConfig({
      root,
      path: "apps/eliotr-core/wrangler.deploy.jsonc",
    });
    return { root, config, generatedConfigPin, tempBase };
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

async function cleanupFixture(fixture) {
  const root = resolve(fixture.root);
  if (dirname(root) !== fixture.tempBase || !basename(root).startsWith(FIXTURE_PREFIX)) {
    throw new Error("Refusing to remove an unexpected schema-manifest fixture");
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Refusing to remove a replaced schema-manifest fixture");
  }
  await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

function catalogueRows(binding, { truncate = false } = {}) {
  const name = binding === "CORE_DB" ? "synthetic_core" : "synthetic_search";
  const object = {
    type: "table",
    name,
    tbl_name: name,
    sql: "CREATE TABLE " + name + " (id TEXT PRIMARY KEY)",
  };
  const rows = [{
    row_kind: 0,
    type: object.type,
    name: object.name,
    tbl_name: object.tbl_name,
    sql: object.sql,
    object_count: null,
  }];
  if (!truncate) {
    rows.push({ row_kind: 1, type: null, name: null, tbl_name: null, sql: null, object_count: 1 });
  }
  return { object, rows };
}

function makeFakeRunner(fixture, { driftConfig = false, driftMigration = false, truncate = false } = {}) {
  const calls = [];
  let queryCount = 0;
  const execute = (args, options) => {
    calls.push({ args: [...args], options });
    assert.equal(args[0], WRANGLER);
    assert.equal(options.cwd, fixture.root);
    assert.equal(options.capture, true);
    assert.equal(options.env.CI, "true");
    assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
    assert.equal(options.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
    assert.equal(options.env.CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
    assert.equal(Object.keys(options.env).some((key) =>
      /^(CF_|ELIOTR_|ACCESS_|AI_GATEWAY_|MCP_|GOOGLE_)/iu.test(key)), false);
    assert.equal(Object.keys(options.env).some((key) =>
      /^CLOUDFLARE_/iu.test(key) &&
      !["CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "CLOUDFLARE_INCLUDE_PROCESS_ENV"].includes(key)), false);
    assert.ok(args.includes("--local"));
    assert.equal(args.includes("--remote"), false);
    assert.equal(args[args.indexOf("--config") + 1],
      resolve(fixture.root, "apps/eliotr-core/wrangler.deploy.jsonc"));
    const persist = args[args.indexOf("--persist-to") + 1];
    assert.equal(dirname(dirname(persist)), fixture.tempBase);
    assert.ok(basename(dirname(persist)).startsWith("eliotr-d1-schema-manifest-"));
    assert.equal(persist.includes(".eliotr-state"), false);

    if (args[2] === "migrations") {
      if (args[3] === "apply" && args[4] === "CORE_DB" && driftMigration) {
        const migrationPath = join(fixture.root, "infra", "d1", "core", "migrations", "0001_fixture.sql");
        return readFile(migrationPath).then(async (bytes) => {
          await writeFile(migrationPath, Buffer.concat([bytes, Buffer.from("-- drift\n")]));
          return "";
        });
      }
      return "";
    }
    assert.equal(args[2], "execute");
    assert.equal(args[args.indexOf("--command") + 1], DEPLOYMENT_SCHEMA_CATALOGUE_QUERY);
    const binding = args[3];
    queryCount += 1;
    const { rows } = catalogueRows(binding, { truncate: truncate && binding === "CORE_DB" });
    if (driftConfig && binding === "SEARCH_DB") {
      return readFile(join(fixture.root, "apps", "eliotr-core", "wrangler.deploy.jsonc")).then(async (bytes) => {
        await writeFile(join(fixture.root, "apps", "eliotr-core", "wrangler.deploy.jsonc"),
          Buffer.concat([bytes, Buffer.from(" ")]));
        return JSON.stringify([{ success: true, results: rows }]);
      });
    }
    return JSON.stringify([{ success: true, results: rows }]);
  };
  return { execute, calls, get queryCount() { return queryCount; } };
}

async function runSuccessCase() {
  const fixture = await createFixture();
  try {
    const fake = makeFakeRunner(fixture);
    const result = await createDeploymentSchemaManifest({
      root: fixture.root,
      config: fixture.config,
      accountId: ACCOUNT_ID,
      generatedConfigPin: fixture.generatedConfigPin,
      execute: fake.execute,
    });
    assert.equal(result.expectedManifest.protocol, DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL);
    assert.deepEqual(result.expectedManifest.streams.map((stream) => stream.binding), ["CORE_DB", "SEARCH_DB"]);
    assert.deepEqual(result.expectedManifest.streams.map((stream) => stream.database_id), [CORE_ID, SEARCH_ID]);
    assert.equal(result.provenance.generated_config.sha256, fixture.generatedConfigPin.sha256);
    assert.equal(result.provenance.generated_config.byte_length, fixture.generatedConfigPin.byte_length);
    assert.equal(result.provenance.streams.length, 2);
    assert.equal(result.provenance.streams[0].migration_entries[0].name, "0001_fixture.sql");
    assert.equal(result.provenance.streams[0].migration_bundle_sha256,
      (await readDeploymentMigrationEntries(fixture.config, "CORE_DB", { root: fixture.root }))
        .local_migration_bundle_sha256);
    assert.equal(result.provenance.streams[0].catalogue_sha256,
      deploymentSchemaCatalogueSha256(result.expectedManifest.streams[0].objects));
    assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2) + "\n", "utf8") <=
      MAX_DEPLOYMENT_SCHEMA_MANIFEST_BYTES);
    assert.equal(fake.calls.length, 4);
    assert.deepEqual(fake.calls.slice(0, 2).map(({ args }) => args.slice(1, 5)), [
      ["d1", "migrations", "apply", "CORE_DB"],
      ["d1", "migrations", "apply", "SEARCH_DB"],
    ]);
    assert.deepEqual(fake.calls.slice(2).map(({ args }) => args[3]), ["CORE_DB", "SEARCH_DB"]);
    const persistPath = fake.calls[0].args[fake.calls[0].args.indexOf("--persist-to") + 1];
    await assert.rejects(lstat(dirname(persistPath)), { code: "ENOENT" });
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runConfigDriftCase() {
  const fixture = await createFixture();
  try {
    const fake = makeFakeRunner(fixture, { driftConfig: true });
    await assert.rejects(createDeploymentSchemaManifest({
      root: fixture.root,
      config: fixture.config,
      accountId: ACCOUNT_ID,
      generatedConfigPin: fixture.generatedConfigPin,
      execute: fake.execute,
    }), /generated config changed during materialization/u);
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runMigrationDriftCase() {
  const fixture = await createFixture();
  try {
    const fake = makeFakeRunner(fixture, { driftMigration: true });
    await assert.rejects(createDeploymentSchemaManifest({
      root: fixture.root,
      config: fixture.config,
      accountId: ACCOUNT_ID,
      generatedConfigPin: fixture.generatedConfigPin,
      execute: fake.execute,
    }), /migration bundle changed during local materialization/u);
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runTruncationCase() {
  const fixture = await createFixture();
  try {
    const fake = makeFakeRunner(fixture, { truncate: true });
    await assert.rejects(createDeploymentSchemaManifest({
      root: fixture.root,
      config: fixture.config,
      accountId: ACCOUNT_ID,
      generatedConfigPin: fixture.generatedConfigPin,
      execute: fake.execute,
    }), /catalogue response truncated or incomplete/u);
    assert.equal(fake.queryCount, 1, "the first incomplete catalogue rejects the paired result");
  } finally {
    await cleanupFixture(fixture);
  }
}

await runSuccessCase();
await runConfigDriftCase();
await runMigrationDriftCase();
await runTruncationCase();
console.log("Deployment schema manifest focused fake-runner regression passed");
