import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  decodeDeploymentSchemaCatalogueRows,
  DEPLOYMENT_SCHEMA_CATALOGUE_QUERY,
  DEPLOYMENT_SCHEMA_EXCLUSIONS,
  DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL,
  DEPLOYMENT_SCHEMA_SCOPE,
  deploymentSchemaCatalogueSha256,
} from "./deployment-schema-attestation.mjs";
import { pinGeneratedDeploymentConfig } from "./deployment-build-inputs.mjs";
import { readDeploymentMigrationEntries, validateDeploymentMigrationDirectories } from "./deployment-migrations.mjs";
import { executeLocal, localEnvironment, ROOT, wranglerArgs } from "./local-launch.mjs";

export const DEPLOYMENT_SCHEMA_MANIFEST_PROVENANCE_PROTOCOL =
  "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v1";
export const MAX_DEPLOYMENT_SCHEMA_MANIFEST_BYTES = 16 * 1024 * 1024;

const GENERATED_CONFIG_PATH = "apps/eliotr-core/wrangler.deploy.jsonc";
const TEMP_DIRECTORY_PREFIX = "eliotr-d1-schema-manifest-";
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATABASES = Object.freeze([
  Object.freeze({ binding: "CORE_DB", database_name: "eliotr-core" }),
  Object.freeze({ binding: "SEARCH_DB", database_name: "eliotr-search" }),
]);

const fail = (reason) => { throw new Error("Deployment schema manifest rejected: " + reason); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function inside(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  fail("input contains a non-JSON value");
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function fileIdentity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

async function readStableFile(root, absolutePath, label) {
  const lexical = resolve(absolutePath);
  if (!inside(root, lexical)) fail(label + " escaped the repository");
  const before = await lstat(lexical);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DEPLOYMENT_SCHEMA_MANIFEST_BYTES) {
    fail(label + " is not a bounded regular file");
  }
  const actual = await realpath(lexical);
  if (actual !== lexical || !inside(root, actual)) fail(label + " traverses a symlink or escaped the repository");
  const bytes = await readFile(lexical);
  const after = await lstat(lexical);
  if (!after.isFile() || after.isSymbolicLink() ||
      !sameFileIdentity(fileIdentity(before), fileIdentity(after)) || after.size !== bytes.byteLength) {
    fail(label + " changed while being read");
  }
  return bytes;
}

function validateGeneratedConfigPin(pin) {
  if (!isRecord(pin) || pin.path !== GENERATED_CONFIG_PATH || !SHA256.test(pin.sha256 ?? "") ||
      !Number.isSafeInteger(pin.byte_length) || pin.byte_length < 1) {
    fail("generated config pin is invalid");
  }
}

async function readPinnedConfig(root, suppliedConfig, suppliedPin) {
  validateGeneratedConfigPin(suppliedPin);
  const currentPin = await pinGeneratedDeploymentConfig({ root, path: GENERATED_CONFIG_PATH });
  if (canonicalJson(currentPin) !== canonicalJson(suppliedPin)) fail("generated config pin changed");

  const absolutePath = resolve(root, GENERATED_CONFIG_PATH);
  const bytes = await readStableFile(root, absolutePath, "generated deployment config");
  if (bytes.byteLength !== suppliedPin.byte_length || sha256(bytes) !== suppliedPin.sha256) {
    fail("generated config bytes do not match the supplied pin");
  }

  let config;
  try {
    config = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("generated config is not valid JSON");
  }
  if (!isRecord(suppliedConfig) || canonicalJson(config) !== canonicalJson(suppliedConfig)) {
    fail("selected config object does not match the pinned generated config");
  }
  return config;
}

async function assertGeneratedConfigUnchanged(root, config, pin) {
  try {
    const current = await readPinnedConfig(root, config, pin);
    if (canonicalJson(current) !== canonicalJson(config)) fail("generated config changed during materialization");
  } catch {
    fail("generated config changed during materialization");
  }
}

function validateSelectedConfig(config, accountId, root) {
  if (!ACCOUNT_ID.test(accountId ?? "") || !Array.isArray(config?.d1_databases) ||
      config.d1_databases.length !== DATABASES.length) {
    fail("account or generated D1 binding set is invalid");
  }
  const byBinding = new Map();
  const ids = new Set();
  for (const database of config.d1_databases) {
    if (!isRecord(database) || !DATABASES.some((item) => item.binding === database.binding) ||
        byBinding.has(database.binding) || !UUID.test(database.database_id ?? "") ||
        database.remote === true || (database.remote !== undefined && database.remote !== false)) {
      fail("generated D1 bindings are ambiguous or not local-only");
    }
    const expected = DATABASES.find((item) => item.binding === database.binding);
    if (database.database_name !== expected.database_name || ids.has(database.database_id.toLowerCase())) {
      fail("generated D1 resource identity is invalid");
    }
    ids.add(database.database_id.toLowerCase());
    byBinding.set(database.binding, database);
  }
  if (byBinding.size !== DATABASES.length) fail("generated Core/Search binding pair is incomplete");
  validateDeploymentMigrationDirectories(config, { root });
  return DATABASES.map((expected) => byBinding.get(expected.binding));
}

function sameMigrationPin(left, right) {
  return canonicalJson({
    binding: left.binding,
    database_name: left.database_name,
    database_id: left.database_id,
    migration_entries: left.migration_entries,
    migration_names: left.migration_names,
    local_migration_bundle_sha256: left.local_migration_bundle_sha256,
    total_sql_bytes: left.total_sql_bytes,
  }) === canonicalJson({
    binding: right.binding,
    database_name: right.database_name,
    database_id: right.database_id,
    migration_entries: right.migration_entries,
    migration_names: right.migration_names,
    local_migration_bundle_sha256: right.local_migration_bundle_sha256,
    total_sql_bytes: right.total_sql_bytes,
  });
}

async function readMigrationPins(config, root) {
  const pins = [];
  for (const { binding } of DATABASES) {
    const pin = await readDeploymentMigrationEntries(config, binding, { root });
    if (pin.binding !== binding || !Array.isArray(pin.migration_entries) ||
        pin.migration_entries.length < 1 || !SHA256.test(pin.local_migration_bundle_sha256 ?? "")) {
      fail("migration reader returned an incomplete stream pin");
    }
    pins.push(pin);
  }
  return pins;
}

async function createSyntheticPaths() {
  const tempBase = await realpath(tmpdir());
  const directory = resolve(await mkdtemp(join(tempBase, TEMP_DIRECTORY_PREFIX)));
  try {
    const info = await lstat(directory);
    const actual = await realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || actual !== directory ||
        dirname(directory) !== tempBase || !basename(directory).startsWith(TEMP_DIRECTORY_PREFIX)) {
      fail("synthetic D1 directory is not uniquely owned under the OS temp root");
    }
    const persist = resolve(directory, "persist");
    await mkdir(persist, { recursive: false, mode: 0o700 });
    return { directory, persist, tempBase };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

async function removeSyntheticPaths(paths) {
  const directory = resolve(paths.directory);
  if (dirname(directory) !== paths.tempBase || !basename(directory).startsWith(TEMP_DIRECTORY_PREFIX)) {
    fail("refusing to remove a directory not owned by this producer");
  }
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
      fail("refusing to remove a replaced synthetic D1 directory");
    }
    await rm(directory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function runLocal(execute, paths, root, args, binding, phase) {
  return execute(wranglerArgs(paths, args), {
    cwd: root,
    env: localEnvironment(),
    capture: true,
    diagnosticContext: { binding, phase },
  });
}

async function readLocalCatalogue(execute, paths, root, binding) {
  const output = await runLocal(execute, paths, root,
    ["d1", "execute", binding, "--command", DEPLOYMENT_SCHEMA_CATALOGUE_QUERY, "--json"],
    binding, "d1-migrations-verify");
  if (typeof output !== "string" ||
      Buffer.byteLength(output, "utf8") > MAX_DEPLOYMENT_SCHEMA_MANIFEST_BYTES) {
    fail("local D1 JSON readback exceeds the manifest byte bound");
  }

  let batches;
  try {
    batches = JSON.parse(output);
  } catch {
    fail("local D1 JSON readback is malformed");
  }
  if (!Array.isArray(batches) || batches.length !== 1 || !isRecord(batches[0]) ||
      batches[0].success !== true || !Array.isArray(batches[0].results) ||
      (batches[0].errors !== undefined &&
       (!Array.isArray(batches[0].errors) || batches[0].errors.length !== 0))) {
    fail("local D1 query did not return one complete successful JSON result");
  }
  const objects = decodeDeploymentSchemaCatalogueRows(batches[0].results);
  if (objects.length < 1) fail("local D1 application schema is empty");
  return objects;
}

function freezeStream(database, accountId, migrationPin, objects) {
  return freezeDeep({
    binding: migrationPin.binding,
    account_id: accountId,
    database_id: database.database_id,
    database_name: database.database_name,
    migration_bundle_sha256: migrationPin.local_migration_bundle_sha256,
    objects,
  });
}

/**
 * Materialize the selected Core/Search migration bundles in fresh local D1 state and
 * return the attestor's expected manifest plus source provenance. This is input material,
 * not an independently trusted artifact; the caller must persist and receipt-pin it.
 */
export async function createDeploymentSchemaManifest({
  root = ROOT,
  config,
  accountId,
  generatedConfigPin,
  execute = executeLocal,
} = {}) {
  if (typeof root !== "string" || root.length === 0 || typeof execute !== "function") {
    fail("producer root or local executor is invalid");
  }
  const absoluteRoot = resolve(root);
  const pinnedConfig = await readPinnedConfig(absoluteRoot, config, generatedConfigPin);
  const databases = validateSelectedConfig(pinnedConfig, accountId, absoluteRoot);
  const migrationPins = await readMigrationPins(pinnedConfig, absoluteRoot);
  const syntheticPaths = await createSyntheticPaths();

  try {
    const paths = {
      config: resolve(absoluteRoot, GENERATED_CONFIG_PATH),
      persist: syntheticPaths.persist,
    };
    for (const { binding } of DATABASES) {
      await runLocal(execute, paths, absoluteRoot,
        ["d1", "migrations", "apply", binding], binding, "d1-migrations");
    }

    const streams = [];
    const provenanceStreams = [];
    for (let index = 0; index < DATABASES.length; index += 1) {
      const { binding } = DATABASES[index];
      const objects = await readLocalCatalogue(execute, paths, absoluteRoot, binding);
      const migrationPin = migrationPins[index];
      const database = databases[index];
      streams.push(freezeStream(database, accountId, migrationPin, objects));
      provenanceStreams.push({
        binding,
        account_id: accountId,
        database_name: migrationPin.database_name,
        database_id: migrationPin.database_id,
        migration_entries: migrationPin.migration_entries.map(({ name, sha256: fileSha256 }) => ({
          name,
          sha256: fileSha256,
        })),
        migration_bundle_sha256: migrationPin.local_migration_bundle_sha256,
        total_sql_bytes: migrationPin.total_sql_bytes,
        object_count: objects.length,
        catalogue_sha256: deploymentSchemaCatalogueSha256(objects),
      });
    }

    await assertGeneratedConfigUnchanged(absoluteRoot, pinnedConfig, generatedConfigPin);
    const afterMigrationPins = await readMigrationPins(pinnedConfig, absoluteRoot);
    if (migrationPins.some((pin, index) => !sameMigrationPin(pin, afterMigrationPins[index]))) {
      fail("migration bundle changed during local materialization");
    }

    const expectedManifest = freezeDeep({
      protocol: DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL,
      streams,
    });
    const manifestBytes = Buffer.from(JSON.stringify(expectedManifest), "utf8");
    const provenance = freezeDeep({
      protocol: DEPLOYMENT_SCHEMA_MANIFEST_PROVENANCE_PROTOCOL,
      scope: DEPLOYMENT_SCHEMA_SCOPE,
      exclusions: [...DEPLOYMENT_SCHEMA_EXCLUSIONS],
      generated_config: {
        path: generatedConfigPin.path,
        sha256: generatedConfigPin.sha256,
        byte_length: generatedConfigPin.byte_length,
      },
      streams: provenanceStreams,
      expected_manifest_sha256: sha256(manifestBytes),
      expected_manifest_byte_length: manifestBytes.byteLength,
    });
    const result = { expectedManifest, provenance };
    const persistedShape = Buffer.from(JSON.stringify(result, null, 2) + "\n", "utf8");
    if (persistedShape.byteLength > MAX_DEPLOYMENT_SCHEMA_MANIFEST_BYTES) {
      fail("expected manifest and provenance exceed the 16 MiB persistence bound");
    }
    return freezeDeep(result);
  } finally {
    await removeSyntheticPaths(syntheticPaths);
  }
}
