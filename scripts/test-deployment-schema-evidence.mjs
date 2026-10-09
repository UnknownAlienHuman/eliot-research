import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DEPLOYMENT_APPLICATION_SCHEMA_EVIDENCE_PROTOCOL,
  persistDeploymentBuildEvidence,
  revalidateDeploymentApplicationSchemaEvidence,
} from "./lib/deployment-build-evidence.mjs";
import {
  DEPLOYMENT_SCHEMA_EXCLUSIONS,
  DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL,
  DEPLOYMENT_SCHEMA_SCOPE,
  deploymentSchemaCatalogueSha256,
} from "./lib/deployment-schema-attestation.mjs";
import { pinGeneratedDeploymentConfig } from "./lib/deployment-build-inputs.mjs";

const CORE_ASSETS = JSON.parse(await readFile(new URL("../apps/eliotr-core/wrangler.jsonc", import.meta.url), "utf8")).assets;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const jsonDigest = (value) => digest(Buffer.from(JSON.stringify(value), "utf8"));
const temporaryRoot = resolve(tmpdir());
const temporaryPrefix = "eliot-deployment-schema-evidence-";

async function createFixture() {
  const root = resolve(await mkdtemp(join(temporaryRoot, temporaryPrefix)));
  if (dirname(root) !== temporaryRoot || !basename(root).startsWith(temporaryPrefix)) {
    throw new Error("Refusing to use an unexpected schema-evidence fixture path");
  }
  try {
    await mkdir(join(root, ".eliotr-state"));
    const outdir = ".eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc";
    await mkdir(join(root, outdir));
    const coreMigrationDirectory = join(root, "infra", "d1", "core", "migrations");
    const searchMigrationDirectory = join(root, "infra", "d1", "search", "migrations");
    await mkdir(coreMigrationDirectory, { recursive: true });
    await mkdir(searchMigrationDirectory, { recursive: true });
    const migrationFiles = [
      {
        binding: "CORE_DB",
        path: "infra/d1/core/migrations/0001_fixture_core.sql",
        name: "0001_fixture_core.sql",
        absolutePath: join(coreMigrationDirectory, "0001_fixture_core.sql"),
        bytes: Buffer.from("CREATE TABLE fixture_core (id TEXT PRIMARY KEY);\n"),
      },
      {
        binding: "SEARCH_DB",
        path: "infra/d1/search/migrations/0001_fixture_search.sql",
        name: "0001_fixture_search.sql",
        absolutePath: join(searchMigrationDirectory, "0001_fixture_search.sql"),
        bytes: Buffer.from("CREATE TABLE fixture_search (id TEXT PRIMARY KEY);\n"),
      },
    ];
    for (const migration of migrationFiles) {
      await writeFile(migration.absolutePath, migration.bytes, { flag: "wx", mode: 0o600 });
    }

    const config = {
      name: "eliotr-core",
      main: "src/index.ts",
      assets: CORE_ASSETS,
      d1_databases: [
        {
          binding: "CORE_DB",
          database_name: "eliotr-core",
          database_id: "11111111-1111-4111-8111-111111111111",
          migrations_dir: "../../infra/d1/core/migrations",
        },
        {
          binding: "SEARCH_DB",
          database_name: "eliotr-search",
          database_id: "22222222-2222-4222-8222-222222222222",
          migrations_dir: "../../infra/d1/search/migrations",
        },
      ],
    };
    const generatedConfigPath = join(root, "apps", "eliotr-core", "wrangler.deploy.jsonc");
    await mkdir(dirname(generatedConfigPath), { recursive: true });
    await writeFile(generatedConfigPath, `${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "apps", "eliotr-core", "wrangler.jsonc"), `${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
    const generatedConfigPin = await pinGeneratedDeploymentConfig({
      root,
      path: "apps/eliotr-core/wrangler.deploy.jsonc",
    });

    const inputs = migrationFiles.map((migration) => ({
      path: migration.path,
      kind: "repository",
      byte_length: migration.bytes.byteLength,
      sha256: digest(migration.bytes),
    }));
    const manifestBody = {
      protocol: "eliotr.deployment-build-inputs.v1",
      root,
      git_head: "a".repeat(40),
      profile: {
        worker_main: "apps/eliotr-core/src/index.ts",
        generated_worker_config: generatedConfigPin.path,
      },
      inputs,
    };
    const manifest = { ...manifestBody, sha256: jsonDigest(manifestBody) };
    const entrypoint = join(root, outdir, "index.js");
    const entrypointBytes = Buffer.from("export default {};\n");
    await writeFile(entrypoint, entrypointBytes, { flag: "wx", mode: 0o600 });
    const entrypointSha256 = digest(entrypointBytes);
    const bundleBody = {
      protocol: "eliotr.deployment-worker-bundle.v1",
      root,
      manifest_sha256: manifest.sha256,
      generated_config: generatedConfigPin,
      outdir,
      entrypoint,
      entrypoint_sha256: entrypointSha256,
      bundle_bytes: entrypointBytes.byteLength,
      metafile: { path: `${outdir}/bundle-meta.json`, sha256: "b".repeat(64), byte_length: 0 },
      inputs: [],
      outputs: [{
        path: "index.js",
        kind: "worker-entrypoint",
        sha256: entrypointSha256,
        byte_length: entrypointBytes.byteLength,
      }],
    };
    const bundle = { ...bundleBody, sha256: jsonDigest(bundleBody) };
    const schemaManifestResult = createSchemaManifestResult({ config, generatedConfigPin, migrationFiles });
    return {
      root,
      temporaryRoot,
      generatedConfigPath,
      generatedConfigPin,
      migrationFiles,
      manifest,
      bundle,
      schemaManifestResult,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

function createSchemaManifestResult({ config, generatedConfigPin, migrationFiles }) {
  const accountId = "0123456789abcdef0123456789abcdef";
  const streams = [];
  const provenanceStreams = [];
  for (const database of config.d1_databases) {
    const migrationEntries = migrationFiles
      .filter((migration) => migration.binding === database.binding)
      .map((migration) => ({ name: migration.name, sha256: digest(migration.bytes) }));
    const migrationBundleSha256 = jsonDigest(migrationEntries);
    const objectName = database.binding === "CORE_DB" ? "fixture_core" : "fixture_search";
    const objects = [{
      type: "table",
      name: objectName,
      tbl_name: objectName,
      sql: `CREATE TABLE ${objectName} (id TEXT PRIMARY KEY)`,
    }];
    streams.push({
      binding: database.binding,
      account_id: accountId,
      database_id: database.database_id,
      database_name: database.database_name,
      migration_bundle_sha256: migrationBundleSha256,
      objects,
    });
    provenanceStreams.push({
      binding: database.binding,
      account_id: accountId,
      database_name: database.database_name,
      database_id: database.database_id,
      migration_entries: migrationEntries,
      migration_bundle_sha256: migrationBundleSha256,
      total_sql_bytes: migrationFiles
        .filter((migration) => migration.binding === database.binding)
        .reduce((total, migration) => total + migration.bytes.byteLength, 0),
      object_count: objects.length,
      catalogue_sha256: deploymentSchemaCatalogueSha256(objects),
    });
  }
  const expectedManifest = { protocol: DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL, streams };
  const expectedManifestBytes = Buffer.from(JSON.stringify(expectedManifest), "utf8");
  const provenance = {
    protocol: "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v1",
    scope: DEPLOYMENT_SCHEMA_SCOPE,
    exclusions: [...DEPLOYMENT_SCHEMA_EXCLUSIONS],
    generated_config: {
      path: generatedConfigPin.path,
      sha256: generatedConfigPin.sha256,
      byte_length: generatedConfigPin.byte_length,
    },
    streams: provenanceStreams,
    expected_manifest_sha256: digest(expectedManifestBytes),
    expected_manifest_byte_length: expectedManifestBytes.byteLength,
  };
  return { expectedManifest, provenance };
}

function refreshManifestAndBundle(fixture, inputs) {
  const body = { ...fixture.manifest };
  delete body.sha256;
  body.inputs = inputs;
  const manifest = { ...body, sha256: jsonDigest(body) };
  const bundleBody = { ...fixture.bundle, manifest_sha256: manifest.sha256 };
  delete bundleBody.sha256;
  const bundle = { ...bundleBody, sha256: jsonDigest(bundleBody) };
  return { manifest, bundle };
}

async function assertRejectedWithoutEvidence(fixture, { manifest = fixture.manifest,
  bundle = fixture.bundle, schemaManifestResult = fixture.schemaManifestResult }, pattern) {
  const before = (await readdir(join(fixture.root, ".eliotr-state"))).sort();
  await assert.rejects(persistDeploymentBuildEvidence({
    root: fixture.root,
    manifest,
    bundle,
    generatedConfigPin: fixture.generatedConfigPin,
    schemaManifestResult,
  }), pattern);
  assert.deepEqual((await readdir(join(fixture.root, ".eliotr-state"))).sort(), before,
    "invalid schema evidence must fail before creating a partial receipt directory");
}

async function cleanupFixture(fixture) {
  const root = resolve(fixture.root);
  if (dirname(root) !== fixture.temporaryRoot || !basename(root).startsWith(temporaryPrefix)) {
    throw new Error("Refusing to remove an unexpected schema-evidence fixture");
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Refusing to remove a replaced schema-evidence fixture");
  }
  await rm(root, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}

async function runLegacyCompatibilityCase() {
  const fixture = await createFixture();
  try {
    const result = await persistDeploymentBuildEvidence({
      root: fixture.root,
      manifest: fixture.manifest,
      bundle: fixture.bundle,
      generatedConfigPin: fixture.generatedConfigPin,
    });
    assert.equal(Object.hasOwn(result, "application_schema"), false,
      "omitting the optional schema result preserves the historical receipt shape");
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runSuccessAndReceiptMismatchCases() {
  const fixture = await createFixture();
  try {
    const receipt = await persistDeploymentBuildEvidence({
      root: fixture.root,
      manifest: fixture.manifest,
      bundle: fixture.bundle,
      generatedConfigPin: fixture.generatedConfigPin,
      schemaManifestResult: fixture.schemaManifestResult,
    });
    const schemaReceipt = receipt.application_schema;
    assert.equal(schemaReceipt.protocol, DEPLOYMENT_APPLICATION_SCHEMA_EVIDENCE_PROTOCOL);
    assert.deepEqual(schemaReceipt.streams.map((stream) => stream.binding), ["CORE_DB", "SEARCH_DB"]);
    assert.equal(schemaReceipt.streams[0].migration_entries[0].sha256,
      fixture.schemaManifestResult.provenance.streams[0].migration_entries[0].sha256);
    assert.equal(schemaReceipt.streams[0].catalogue_sha256,
      fixture.schemaManifestResult.provenance.streams[0].catalogue_sha256);

    const expectedManifestBytes = await readFile(resolve(fixture.root, schemaReceipt.expected_manifest.path));
    const provenanceBytes = await readFile(resolve(fixture.root, schemaReceipt.provenance.path));
    const generatedConfigBytes = await readFile(fixture.generatedConfigPath);
    assert.equal(digest(expectedManifestBytes), schemaReceipt.expected_manifest.file_sha256);
    assert.equal(digest(provenanceBytes), schemaReceipt.provenance.file_sha256);
    assert.equal(revalidateDeploymentApplicationSchemaEvidence({
      manifest: fixture.manifest,
      bundle: fixture.bundle,
      generatedConfigPin: fixture.generatedConfigPin,
      generatedConfigBytes,
      expectedManifestBytes,
      provenanceBytes,
      persistedDirectory: receipt.persisted_directory,
      applicationSchema: schemaReceipt,
    }), true);

    const alteredReceipt = JSON.parse(JSON.stringify(schemaReceipt));
    alteredReceipt.streams[0].catalogue_sha256 = "f".repeat(64);
    assert.throws(() => revalidateDeploymentApplicationSchemaEvidence({
      manifest: fixture.manifest,
      bundle: fixture.bundle,
      generatedConfigPin: fixture.generatedConfigPin,
      generatedConfigBytes,
      expectedManifestBytes,
      provenanceBytes,
      persistedDirectory: receipt.persisted_directory,
      applicationSchema: alteredReceipt,
    }), /receipt does not match persisted object pins/u);
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runConfigMismatchCase() {
  const fixture = await createFixture();
  try {
    const invalid = structuredClone(fixture.schemaManifestResult);
    invalid.provenance.generated_config.sha256 = "c".repeat(64);
    await assertRejectedWithoutEvidence(fixture, { schemaManifestResult: invalid },
      /provenance generated config pin differs/u);
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runMigrationMismatchCases() {
  const fixture = await createFixture();
  try {
    const withoutCoreSql = fixture.manifest.inputs.filter((input) => !input.path.startsWith("infra/d1/core/migrations/"));
    const missing = refreshManifestAndBundle(fixture, withoutCoreSql);
    await assertRejectedWithoutEvidence(fixture, missing,
      /migration pins are missing from or differ from captured inputs/u);

    const changedCoreSql = fixture.manifest.inputs.map((input) => input.path === "infra/d1/core/migrations/0001_fixture_core.sql"
      ? { ...input, sha256: "d".repeat(64) } : input);
    const mismatched = refreshManifestAndBundle(fixture, changedCoreSql);
    await assertRejectedWithoutEvidence(fixture, mismatched,
      /migration pins are missing from or differ from captured inputs/u);

    const invalid = structuredClone(fixture.schemaManifestResult);
    invalid.provenance.streams[0].migration_entries[0].sha256 = "e".repeat(64);
    await assertRejectedWithoutEvidence(fixture, { schemaManifestResult: invalid },
      /migration pins are missing from or differ from captured inputs/u);
  } finally {
    await cleanupFixture(fixture);
  }
}

async function runManifestMismatchCase() {
  const fixture = await createFixture();
  try {
    const invalid = structuredClone(fixture.schemaManifestResult);
    invalid.expectedManifest.streams[0].objects[0].sql += " ";
    invalid.provenance.streams[0].catalogue_sha256 = deploymentSchemaCatalogueSha256(
      invalid.expectedManifest.streams[0].objects);
    await assertRejectedWithoutEvidence(fixture, { schemaManifestResult: invalid },
      /expected manifest bytes do not match provenance pins/u);
  } finally {
    await cleanupFixture(fixture);
  }
}

await runLegacyCompatibilityCase();
await runSuccessAndReceiptMismatchCases();
await runConfigMismatchCase();
await runMigrationMismatchCases();
await runManifestMismatchCase();
console.log("Deployment schema evidence focused fake-persistence regression passed");
