import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalizeDeploymentSchemaCatalogue,
  DEPLOYMENT_SCHEMA_EXCLUSIONS,
  DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL,
  DEPLOYMENT_SCHEMA_SCOPE,
  deploymentSchemaCatalogueSha256,
} from "./deployment-schema-attestation.mjs";
import { DEPLOYMENT_SCHEMA_MANIFEST_PROVENANCE_PROTOCOL } from "./deployment-schema-manifest.mjs";
import { validateDeploymentMigrationDirectories } from "./deployment-migrations.mjs";

export const DEPLOYMENT_BUILD_EVIDENCE_PROTOCOL = "eliotr.deployment-build-evidence.v1";
export const DEPLOYMENT_BUILD_EVIDENCE_SCOPE = "BOUNDED_LOCAL_INTEGRITY";
export const DEPLOYMENT_APPLICATION_SCHEMA_EVIDENCE_PROTOCOL =
  "eliotr.deployment-application-schema-build-evidence.v1";

const MAX_PERSISTED_OBJECT_BYTES = 16 * 1024 * 1024;
const EVIDENCE_DIRECTORY_PATTERN = /^\.eliotr-state\/deployment-build-evidence-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKER_DIRECTORY_PATTERN = /^\.eliotr-state\/deployment-worker-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GENERATED_CONFIG_PATH = "apps/eliotr-core/wrangler.deploy.jsonc";
const APPLICATION_SCHEMA_MANIFEST_FILE = "deployment-application-schema-manifest.json";
const APPLICATION_SCHEMA_PROVENANCE_FILE = "deployment-application-schema-provenance.json";
const APPLICATION_SCHEMA_BINDINGS = Object.freeze([
  Object.freeze({ binding: "CORE_DB", stream: "core", database_name: "eliotr-core" }),
  Object.freeze({ binding: "SEARCH_DB", stream: "search", database_name: "eliotr-search" }),
]);
const MIGRATION_NAME_PATTERN = /^\d{4}_[A-Za-z0-9_-]+\.sql$/u;

function slash(value) {
  return value.split(path.sep).join("/");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function assertExactKeys(value, keys, label) {
  if (!hasExactKeys(value, keys)) throw new Error(`${label} has an invalid native shape`);
}

function privateObjectBytes(value) {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") throw new Error("Build evidence object is not JSON serializable");
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  if (bytes.byteLength > MAX_PERSISTED_OBJECT_BYTES) {
    throw new Error("Build evidence object exceeds its private byte bound");
  }
  return bytes;
}

function parseEvidenceJson(bytes, label) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength < 1 ||
      bytes.byteLength > MAX_PERSISTED_OBJECT_BYTES) {
    throw new Error(`${label} is absent or exceeds its private byte bound`);
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function manifestBody(manifest) {
  const body = { ...manifest };
  delete body.sha256;
  return body;
}

function bundleBody(bundle) {
  const body = { ...bundle };
  delete body.sha256;
  return body;
}

function assertManifest(root, manifest) {
  if (!manifest || manifest.protocol !== "eliotr.deployment-build-inputs.v1" || manifest.root !== root ||
      !/^[0-9a-f]{40}$/u.test(manifest.git_head ?? "") || !Array.isArray(manifest.inputs)) {
    throw new Error("Deployment build evidence received an invalid input manifest");
  }
  assertSha256(manifest.sha256, "Deployment input manifest digest");
  if (digest(Buffer.from(stableJson(manifestBody(manifest)))) !== manifest.sha256) {
    throw new Error("Deployment build evidence received a modified input manifest");
  }
  if (manifest.profile?.worker_main !== "apps/eliotr-core/src/index.ts" ||
      manifest.profile?.generated_worker_config !== GENERATED_CONFIG_PATH) {
    throw new Error("Deployment input manifest does not describe the canonical Worker build");
  }
}

function assertGeneratedConfigPin(root, pin) {
  if (!pin || pin.path !== GENERATED_CONFIG_PATH || typeof pin.worker_main !== "string" ||
      pin.worker_main !== "apps/eliotr-core/src/index.ts" ||
      typeof pin.assets_directory !== "string" || !Number.isSafeInteger(pin.byte_length) ||
      pin.byte_length < 0 || path.isAbsolute(pin.assets_directory)) {
    throw new Error("Generated deployment config pin is invalid for build evidence");
  }
  const canonicalAssets = path.resolve(root, "apps/eliotr-pwa/dist");
  const pinnedAssets = path.resolve(root, pin.assets_directory);
  if (pinnedAssets !== canonicalAssets || !inside(root, pinnedAssets)) {
    throw new Error("Generated deployment config pin changes the canonical PWA assets directory");
  }
  assertSha256(pin.sha256, "Generated deployment config pin");
}

function assertEvidenceDirectoryPath(root, absolutePath) {
  const relative = slash(path.relative(root, absolutePath));
  if (!EVIDENCE_DIRECTORY_PATTERN.test(relative)) {
    throw new Error("Build evidence must use a unique deployment evidence directory");
  }
  return relative;
}

async function assertDirectory(root, absolutePath, label) {
  const lexical = path.resolve(absolutePath);
  if (!inside(root, lexical)) throw new Error(`${label} escaped the repository`);
  const info = await lstat(lexical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  const actual = await realpath(lexical);
  if (actual !== lexical || !inside(root, actual)) throw new Error(`${label} traverses a symlink or escaped the repository`);
  return actual;
}

function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, mode: info.mode, size: info.size,
    mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, birthtimeMs: info.birthtimeMs };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs;
}

async function readStableFile(root, absolutePath, label, maximumBytes = MAX_PERSISTED_OBJECT_BYTES) {
  const lexical = path.resolve(absolutePath);
  if (!inside(root, lexical)) throw new Error(`${label} escaped the repository`);
  const before = await lstat(lexical);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  const actual = await realpath(lexical);
  if (actual !== lexical || !inside(root, actual)) throw new Error(`${label} traverses a symlink or escaped the repository`);
  const bytes = await readFile(lexical);
  const after = await lstat(lexical);
  if (!after.isFile() || after.isSymbolicLink() || !sameFileIdentity(fileIdentity(before), fileIdentity(after)) ||
      after.size !== bytes.byteLength) {
    throw new Error(`${label} changed while being read`);
  }
  return bytes;
}

async function assertWorkerBundle(root, manifest, bundle, generatedConfigPin) {
  if (!bundle || bundle.protocol !== "eliotr.deployment-worker-bundle.v1" || bundle.root !== root ||
      bundle.manifest_sha256 !== manifest.sha256 || !Array.isArray(bundle.outputs) ||
      !Array.isArray(bundle.inputs) || !bundle.metafile || typeof bundle.entrypoint !== "string") {
    throw new Error("Deployment build evidence received an invalid Worker bundle attestation");
  }
  assertSha256(bundle.sha256, "Worker bundle attestation digest");
  if (digest(Buffer.from(stableJson(bundleBody(bundle)))) !== bundle.sha256) {
    throw new Error("Deployment build evidence received a modified Worker bundle attestation");
  }
  if (canonicalJson(bundle.generated_config) !== canonicalJson(generatedConfigPin)) {
    throw new Error("Worker bundle attestation does not use the pinned generated config");
  }
  if (typeof bundle.outdir !== "string" || !WORKER_DIRECTORY_PATTERN.test(slash(bundle.outdir))) {
    throw new Error("Worker bundle attestation does not use a unique deployment-worker directory");
  }
  const absoluteOutdir = path.resolve(root, bundle.outdir);
  await assertDirectory(root, absoluteOutdir, "Worker bundle output directory");
  const absoluteEntrypoint = path.resolve(bundle.entrypoint);
  if (!path.isAbsolute(bundle.entrypoint) || !inside(absoluteOutdir, absoluteEntrypoint) ||
      !absoluteEntrypoint.toLowerCase().endsWith(".js")) {
    throw new Error("Worker bundle attestation entrypoint is outside its emitted Worker output");
  }
  assertSha256(bundle.entrypoint_sha256, "Worker bundle entrypoint digest");
  if (!Number.isSafeInteger(bundle.bundle_bytes) || bundle.bundle_bytes < 0) {
    throw new Error("Worker bundle attestation entrypoint byte count is invalid");
  }
  const entrypointRelative = slash(path.relative(absoluteOutdir, absoluteEntrypoint));
  const entrypointRecord = bundle.outputs.find((item) => item?.kind === "worker-entrypoint" && item.path === entrypointRelative);
  if (!entrypointRecord || entrypointRecord.sha256 !== bundle.entrypoint_sha256 ||
      entrypointRecord.byte_length !== bundle.bundle_bytes) {
    throw new Error("Worker bundle attestation entrypoint inventory does not match its digest");
  }
  const entrypointBytes = await readStableFile(root, absoluteEntrypoint, "Worker bundle entrypoint", 32 * 1024 * 1024);
  if (entrypointBytes.byteLength !== bundle.bundle_bytes || digest(entrypointBytes) !== bundle.entrypoint_sha256) {
    throw new Error("Worker bundle entrypoint changed after final deployment readback");
  }
  const generatedConfigPath = path.resolve(root, generatedConfigPin.path);
  const generatedConfigBytes = await readStableFile(root, generatedConfigPath, "Generated deployment config");
  if (generatedConfigBytes.byteLength !== generatedConfigPin.byte_length || digest(generatedConfigBytes) !== generatedConfigPin.sha256) {
    throw new Error("Generated deployment config changed after final deployment readback");
  }
  return { absoluteEntrypoint, entrypointBytes, generatedConfigBytes };
}

async function writePrivateObject(root, directory, fileName, value) {
  const absolutePath = path.resolve(directory, fileName);
  if (!inside(directory, absolutePath) || path.basename(absolutePath) !== fileName) {
    throw new Error("Build evidence object path escaped its private directory");
  }
  const bytes = privateObjectBytes(value);
  await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  const persisted = await readStableFile(root, absolutePath, `Persisted ${fileName}`);
  if (!persisted.equals(bytes)) throw new Error(`Persisted ${fileName} changed during readback`);
  return Object.freeze({ path: slash(path.relative(root, absolutePath)), file_sha256: digest(persisted) });
}

function validateApplicationSchemaPayload({
  manifest,
  bundle,
  generatedConfigPin,
  generatedConfigBytes,
  expectedManifest,
  provenance,
} = {}) {
  const reject = (reason) => { throw new Error(`Deployment application schema evidence rejected: ${reason}`); };
  const root = manifest?.root;
  if (typeof root !== "string" || root.length === 0) reject("captured input manifest is absent");
  assertManifest(root, manifest);
  assertGeneratedConfigPin(root, generatedConfigPin);
  if (!bundle || bundle.protocol !== "eliotr.deployment-worker-bundle.v1" || bundle.root !== root ||
      bundle.manifest_sha256 !== manifest.sha256 || !Array.isArray(bundle.outputs) ||
      !Array.isArray(bundle.inputs) || !bundle.metafile || typeof bundle.entrypoint !== "string") {
    reject("Worker bundle is not bound to the captured input manifest");
  }
  assertSha256(bundle.sha256, "Worker bundle attestation digest");
  if (digest(Buffer.from(stableJson(bundleBody(bundle)))) !== bundle.sha256 ||
      canonicalJson(bundle.generated_config) !== canonicalJson(generatedConfigPin)) {
    reject("Worker bundle or generated config pin is inconsistent");
  }
  if (!(Buffer.isBuffer(generatedConfigBytes) || generatedConfigBytes instanceof Uint8Array) ||
      generatedConfigBytes.byteLength !== generatedConfigPin.byte_length ||
      digest(Buffer.from(generatedConfigBytes)) !== generatedConfigPin.sha256) {
    reject("generated config bytes do not match the bundle-bound pin");
  }

  let config;
  try {
    config = JSON.parse(Buffer.from(generatedConfigBytes).toString("utf8"));
  } catch (error) {
    reject(`generated config is not valid JSON (${error.message})`);
  }
  if (config.name !== "eliotr-core" || config.main !== "src/index.ts" ||
      config.assets?.directory !== "../eliotr-pwa/dist" || !Array.isArray(config.d1_databases) ||
      config.d1_databases.length !== APPLICATION_SCHEMA_BINDINGS.length) {
    reject("generated config does not contain the canonical Worker and D1 profile");
  }
  try {
    validateDeploymentMigrationDirectories(config, { root });
  } catch (error) {
    reject(`generated config migration directories are invalid (${error.message})`);
  }
  const databases = new Map();
  for (const database of config.d1_databases) {
    if (!isRecord(database) || !APPLICATION_SCHEMA_BINDINGS.some(({ binding }) => binding === database.binding) ||
        databases.has(database.binding) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(database.database_id ?? "")) {
      reject("generated Core/Search D1 bindings are ambiguous");
    }
    const expected = APPLICATION_SCHEMA_BINDINGS.find(({ binding }) => binding === database.binding);
    if (database.database_name !== expected.database_name) reject("generated D1 resource name is inconsistent");
    databases.set(database.binding, database);
  }
  if (databases.size !== APPLICATION_SCHEMA_BINDINGS.length) reject("generated Core/Search D1 pair is incomplete");

  assertExactKeys(expectedManifest, ["protocol", "streams"], "Expected schema manifest");
  if (expectedManifest.protocol !== DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL ||
      !Array.isArray(expectedManifest.streams) || expectedManifest.streams.length !== APPLICATION_SCHEMA_BINDINGS.length) {
    reject("expected schema manifest protocol or Core/Search pair is invalid");
  }
  assertExactKeys(provenance,
    ["protocol", "scope", "exclusions", "generated_config", "streams", "expected_manifest_sha256", "expected_manifest_byte_length"],
    "Schema provenance");
  if (provenance.protocol !== DEPLOYMENT_SCHEMA_MANIFEST_PROVENANCE_PROTOCOL ||
      provenance.scope !== DEPLOYMENT_SCHEMA_SCOPE ||
      canonicalJson(provenance.exclusions) !== canonicalJson(DEPLOYMENT_SCHEMA_EXCLUSIONS) ||
      !Array.isArray(provenance.streams) || provenance.streams.length !== APPLICATION_SCHEMA_BINDINGS.length) {
    reject("schema provenance protocol, scope, exclusions, or Core/Search pair is invalid");
  }
  assertExactKeys(provenance.generated_config, ["path", "sha256", "byte_length"], "Provenance generated config pin");
  if (provenance.generated_config.path !== generatedConfigPin.path ||
      provenance.generated_config.sha256 !== generatedConfigPin.sha256 ||
      provenance.generated_config.byte_length !== generatedConfigPin.byte_length) {
    reject("schema provenance generated config pin differs from the Worker bundle");
  }

  const capturedMigrations = new Map(APPLICATION_SCHEMA_BINDINGS.map(({ binding }) => [binding, []]));
  const inputPaths = new Set();
  for (const input of manifest.inputs) {
    assertExactKeys(input, ["path", "kind", "byte_length", "sha256"], "Captured deployment input");
    if (typeof input.path !== "string" || inputPaths.has(input.path) ||
        !Number.isSafeInteger(input.byte_length) || input.byte_length < 0 ||
        typeof input.kind !== "string") {
      reject("captured deployment input record is malformed or duplicated");
    }
    assertSha256(input.sha256, "Captured deployment input digest");
    inputPaths.add(input.path);
    const match = /^infra\/d1\/(core|search)\/migrations\/(.+\.sql)$/u.exec(input.path);
    if (match) {
      const binding = match[1] === "core" ? "CORE_DB" : "SEARCH_DB";
      const name = match[2];
      if (input.kind !== "repository" || !MIGRATION_NAME_PATTERN.test(name)) {
        reject(`captured migration input is invalid: ${input.path}`);
      }
      capturedMigrations.get(binding).push({ name, sha256: input.sha256, byte_length: input.byte_length });
    }
  }

  const accountIds = new Set();
  const usedDatabaseIds = new Set();
  const streams = [];
  for (let index = 0; index < APPLICATION_SCHEMA_BINDINGS.length; index += 1) {
    const expectedIdentity = APPLICATION_SCHEMA_BINDINGS[index];
    const schemaStream = expectedManifest.streams[index];
    const sourceStream = provenance.streams[index];
    assertExactKeys(schemaStream,
      ["binding", "account_id", "database_id", "database_name", "migration_bundle_sha256", "objects"],
      `Expected ${expectedIdentity.binding} schema stream`);
    assertExactKeys(sourceStream,
      ["binding", "account_id", "database_name", "database_id", "migration_entries", "migration_bundle_sha256",
        "total_sql_bytes", "object_count", "catalogue_sha256"],
      `${expectedIdentity.binding} schema provenance stream`);
    if (schemaStream.binding !== expectedIdentity.binding || sourceStream.binding !== expectedIdentity.binding ||
        schemaStream.database_name !== expectedIdentity.database_name ||
        sourceStream.database_name !== expectedIdentity.database_name ||
        schemaStream.account_id !== sourceStream.account_id ||
        typeof schemaStream.account_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(schemaStream.account_id) ||
        schemaStream.database_id !== sourceStream.database_id ||
        schemaStream.database_id !== databases.get(expectedIdentity.binding).database_id ||
        usedDatabaseIds.has(schemaStream.database_id) ||
        schemaStream.migration_bundle_sha256 !== sourceStream.migration_bundle_sha256 ||
        !Array.isArray(schemaStream.objects) || schemaStream.objects.length < 1 ||
        !Array.isArray(sourceStream.migration_entries) || sourceStream.migration_entries.length < 1 ||
        !Number.isSafeInteger(sourceStream.total_sql_bytes) || sourceStream.total_sql_bytes < 1 ||
        sourceStream.object_count !== schemaStream.objects.length) {
      reject(`${expectedIdentity.binding} schema identity or provenance does not match the generated config`);
    }
    accountIds.add(schemaStream.account_id);
    usedDatabaseIds.add(schemaStream.database_id);
    assertSha256(schemaStream.migration_bundle_sha256, `${expectedIdentity.binding} migration bundle digest`);
    assertSha256(sourceStream.catalogue_sha256, `${expectedIdentity.binding} catalogue digest`);

    const declaredMigrations = [];
    for (const entry of sourceStream.migration_entries) {
      assertExactKeys(entry, ["name", "sha256"], `${expectedIdentity.binding} migration entry`);
      if (!MIGRATION_NAME_PATTERN.test(entry.name ?? "") ||
          (declaredMigrations.length > 0 && declaredMigrations.at(-1).name >= entry.name)) {
        reject(`${expectedIdentity.binding} migration entries are invalid or unordered`);
      }
      assertSha256(entry.sha256, `${expectedIdentity.binding} migration file digest`);
      declaredMigrations.push({ name: entry.name, sha256: entry.sha256 });
    }
    const captured = capturedMigrations.get(expectedIdentity.binding).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (captured.length !== declaredMigrations.length || captured.some((entry, entryIndex) =>
      entry.name !== declaredMigrations[entryIndex].name || entry.sha256 !== declaredMigrations[entryIndex].sha256)) {
      reject(`${expectedIdentity.binding} migration pins are missing from or differ from captured inputs`);
    }
    const totalSqlBytes = captured.reduce((total, entry) => total + entry.byte_length, 0);
    if (totalSqlBytes !== sourceStream.total_sql_bytes ||
        digest(Buffer.from(JSON.stringify(declaredMigrations), "utf8")) !== sourceStream.migration_bundle_sha256) {
      reject(`${expectedIdentity.binding} migration aggregate does not match captured file pins`);
    }
    let catalogueSha256;
    try {
      canonicalizeDeploymentSchemaCatalogue(schemaStream.objects);
      catalogueSha256 = deploymentSchemaCatalogueSha256(schemaStream.objects);
    } catch (error) {
      reject(`${expectedIdentity.binding} schema catalogue is invalid (${error.message})`);
    }
    if (catalogueSha256 !== sourceStream.catalogue_sha256) {
      reject(`${expectedIdentity.binding} catalogue digest does not match its objects`);
    }
    streams.push({
      binding: expectedIdentity.binding,
      account_id: schemaStream.account_id,
      database_id: schemaStream.database_id,
      database_name: expectedIdentity.database_name,
      migration_bundle_sha256: sourceStream.migration_bundle_sha256,
      migration_entries: declaredMigrations,
      catalogue_sha256: catalogueSha256,
      object_count: schemaStream.objects.length,
    });
  }
  if (accountIds.size !== 1 || usedDatabaseIds.size !== APPLICATION_SCHEMA_BINDINGS.length) {
    reject("Core/Search schema streams do not identify one account and two distinct databases");
  }

  const rawManifestBytes = Buffer.from(JSON.stringify(expectedManifest), "utf8");
  if (rawManifestBytes.byteLength > MAX_PERSISTED_OBJECT_BYTES ||
      !Number.isSafeInteger(provenance.expected_manifest_byte_length) ||
      provenance.expected_manifest_byte_length !== rawManifestBytes.byteLength ||
      provenance.expected_manifest_sha256 !== digest(rawManifestBytes)) {
    reject("expected manifest bytes do not match provenance pins");
  }
  const rawProvenanceBytes = Buffer.from(JSON.stringify(provenance), "utf8");
  if (rawProvenanceBytes.byteLength > MAX_PERSISTED_OBJECT_BYTES) reject("schema provenance exceeds its byte bound");
  privateObjectBytes(expectedManifest);
  privateObjectBytes(provenance);
  const streamsJson = JSON.stringify(streams);
  return {
    streams: JSON.parse(streamsJson),
    expectedManifestSha256: digest(rawManifestBytes),
    expectedManifestByteLength: rawManifestBytes.byteLength,
    provenanceSha256: digest(rawProvenanceBytes),
    provenanceByteLength: rawProvenanceBytes.byteLength,
  };
}

function buildApplicationSchemaReference({ expectedManifestReference, provenanceReference, validated }) {
  return {
    protocol: DEPLOYMENT_APPLICATION_SCHEMA_EVIDENCE_PROTOCOL,
    scope: DEPLOYMENT_SCHEMA_SCOPE,
    exclusions: [...DEPLOYMENT_SCHEMA_EXCLUSIONS],
    expected_manifest: {
      ...expectedManifestReference,
      sha256: validated.expectedManifestSha256,
      byte_length: validated.expectedManifestByteLength,
    },
    provenance: {
      ...provenanceReference,
      sha256: validated.provenanceSha256,
      byte_length: validated.provenanceByteLength,
    },
    generated_config: {
      path: GENERATED_CONFIG_PATH,
      sha256: validated.generatedConfigSha256,
      byte_length: validated.generatedConfigByteLength,
    },
    streams: validated.streams,
  };
}

/**
 * Revalidate stored application-schema bytes against their captured build and receipt pins.
 * This proves consistency and bounded local integrity only; it does not authenticate who produced them.
 */
export function revalidateDeploymentApplicationSchemaEvidence({
  manifest,
  bundle,
  generatedConfigPin,
  generatedConfigBytes,
  expectedManifestBytes,
  provenanceBytes,
  persistedDirectory,
  applicationSchema,
} = {}) {
  const root = manifest?.root;
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("Deployment application schema evidence rejected: captured input manifest is absent");
  }
  const expectedManifest = parseEvidenceJson(expectedManifestBytes, "Persisted expected schema manifest");
  const provenance = parseEvidenceJson(provenanceBytes, "Persisted schema provenance");
  if (!privateObjectBytes(expectedManifest).equals(Buffer.from(expectedManifestBytes)) ||
      !privateObjectBytes(provenance).equals(Buffer.from(provenanceBytes))) {
    throw new Error("Deployment application schema evidence rejected: persisted object encoding is inconsistent");
  }
  const validated = validateApplicationSchemaPayload({
    manifest,
    bundle,
    generatedConfigPin,
    generatedConfigBytes,
    expectedManifest,
    provenance,
  });
  const resolvedDirectory = path.resolve(root, persistedDirectory ?? "");
  const relativeDirectory = slash(path.relative(root, resolvedDirectory));
  if (relativeDirectory !== persistedDirectory || assertEvidenceDirectoryPath(root, resolvedDirectory) !== relativeDirectory) {
    throw new Error("Deployment application schema evidence rejected: persisted directory is invalid");
  }
  const expectedManifestReference = {
    path: `${relativeDirectory}/${APPLICATION_SCHEMA_MANIFEST_FILE}`,
    file_sha256: digest(Buffer.from(expectedManifestBytes)),
  };
  const provenanceReference = {
    path: `${relativeDirectory}/${APPLICATION_SCHEMA_PROVENANCE_FILE}`,
    file_sha256: digest(Buffer.from(provenanceBytes)),
  };
  validated.generatedConfigSha256 = generatedConfigPin.sha256;
  validated.generatedConfigByteLength = generatedConfigPin.byte_length;
  const expectedReceipt = buildApplicationSchemaReference({
    expectedManifestReference,
    provenanceReference,
    validated,
  });
  if (canonicalJson(applicationSchema) !== canonicalJson(expectedReceipt)) {
    throw new Error("Deployment application schema evidence rejected: receipt does not match persisted object pins");
  }
  return true;
}

export async function persistDeploymentBuildEvidence({
  root = process.cwd(), manifest, bundle, generatedConfigPin, schemaManifestResult,
} = {}) {
  const absoluteRoot = path.resolve(root);
  await assertDirectory(absoluteRoot, absoluteRoot, "Deployment build root");
  assertManifest(absoluteRoot, manifest);
  assertGeneratedConfigPin(absoluteRoot, generatedConfigPin);
  const { absoluteEntrypoint, entrypointBytes, generatedConfigBytes } = await assertWorkerBundle(
    absoluteRoot, manifest, bundle, generatedConfigPin);
  let validatedSchema;
  if (schemaManifestResult !== undefined) {
    if (!hasExactKeys(schemaManifestResult, ["expectedManifest", "provenance"])) {
      throw new Error("Deployment application schema evidence rejected: producer result has an invalid native shape");
    }
    validatedSchema = validateApplicationSchemaPayload({
      manifest,
      bundle,
      generatedConfigPin,
      generatedConfigBytes,
      expectedManifest: schemaManifestResult.expectedManifest,
      provenance: schemaManifestResult.provenance,
    });
    validatedSchema.generatedConfigSha256 = generatedConfigPin.sha256;
    validatedSchema.generatedConfigByteLength = generatedConfigPin.byte_length;
  }

  const stateDirectory = path.resolve(absoluteRoot, ".eliotr-state");
  await assertDirectory(absoluteRoot, stateDirectory, "Deployment state directory");
  const evidenceDirectory = path.resolve(stateDirectory, `deployment-build-evidence-${randomUUID()}`);
  const relativeEvidenceDirectory = assertEvidenceDirectoryPath(absoluteRoot, evidenceDirectory);
  await mkdir(evidenceDirectory, { recursive: false, mode: 0o700 });
  await assertDirectory(absoluteRoot, evidenceDirectory, "Private build evidence directory");

  const persistedManifest = await writePrivateObject(absoluteRoot, evidenceDirectory,
    "deployment-build-inputs.json", manifest);
  const persistedBundle = await writePrivateObject(absoluteRoot, evidenceDirectory,
    "deployment-worker-bundle.json", bundle);
  let applicationSchema;
  if (schemaManifestResult !== undefined) {
    const persistedSchemaManifest = await writePrivateObject(absoluteRoot, evidenceDirectory,
      APPLICATION_SCHEMA_MANIFEST_FILE, schemaManifestResult.expectedManifest);
    const persistedSchemaProvenance = await writePrivateObject(absoluteRoot, evidenceDirectory,
      APPLICATION_SCHEMA_PROVENANCE_FILE, schemaManifestResult.provenance);
    applicationSchema = buildApplicationSchemaReference({
      expectedManifestReference: persistedSchemaManifest,
      provenanceReference: persistedSchemaProvenance,
      validated: validatedSchema,
    });
    revalidateDeploymentApplicationSchemaEvidence({
      manifest,
      bundle,
      generatedConfigPin,
      generatedConfigBytes,
      expectedManifestBytes: privateObjectBytes(schemaManifestResult.expectedManifest),
      provenanceBytes: privateObjectBytes(schemaManifestResult.provenance),
      persistedDirectory: relativeEvidenceDirectory,
      applicationSchema,
    });
  }
  return freezeDeep({
    protocol: DEPLOYMENT_BUILD_EVIDENCE_PROTOCOL,
    scope: DEPLOYMENT_BUILD_EVIDENCE_SCOPE,
    source_head: manifest.git_head,
    persisted_directory: relativeEvidenceDirectory,
    input_manifest: { path: persistedManifest.path, file_sha256: persistedManifest.file_sha256, manifest_sha256: manifest.sha256 },
    bundle_attestation: { path: persistedBundle.path, file_sha256: persistedBundle.file_sha256, attestation_sha256: bundle.sha256 },
    entrypoint: { path: slash(path.relative(absoluteRoot, absoluteEntrypoint)), raw_sha256: digest(entrypointBytes), byte_length: entrypointBytes.byteLength },
    generated_config: { path: generatedConfigPin.path, sha256: generatedConfigPin.sha256, byte_length: generatedConfigPin.byte_length },
    ...(applicationSchema === undefined ? {} : { application_schema: applicationSchema }),
  });
}
