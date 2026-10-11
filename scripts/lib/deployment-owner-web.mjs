import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { parseDeploymentJsonc } from "./deployment-jsonc.mjs";
import { inspectWebBuild, OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES, WORKER_GZIP_BUDGET_BYTES } from "./emitted-build-budget-evidence.mjs";
import { assertCoreWorkerRouteParity } from "./core-worker-route-parity.mjs";
import { pinGeneratedDeploymentConfig } from "./deployment-build-inputs.mjs";
import { DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL, DEPLOYMENT_SCHEMA_SCOPE,
  DEPLOYMENT_SCHEMA_EXCLUSIONS, deploymentSchemaCatalogueSha256 } from "./deployment-schema-attestation.mjs";
import { DEPLOYMENT_SCHEMA_MANIFEST_PROVENANCE_PROTOCOL,
  DEPLOYMENT_SCHEMA_MANIFEST_NATIVE_PROVENANCE_PROTOCOL } from "./deployment-schema-manifest.mjs";
import { validateDeploymentNativeSchemaProvenance } from "./deployment-native-schema-provenance.mjs";
import { readOwnerWebStartup, ownerWebStartupBindings } from "./deployment-owner-web-startup.mjs";

import { SUPPORTED_SCHEMA_MANIFEST_PROTOCOL, SUPPORTED_SCHEMA_PROVENANCE_PROTOCOL,
  validateSupportedSchemaRepresentation, projectSupportedDeploymentSchema } from "./deployment-native-platform-schema.mjs";

const CONFIG = "apps/eliotr-core/wrangler.deploy.jsonc";
const CLIENT = "apps/eliotr-web/dist/client";
const WORKER = "apps/eliotr-web/dist/eliotr_core";
const PROOF = "apps/eliotr-web/dist/owner-web-inputs.json";
const WORKER_GRAPH = WORKER + "/owner-worker-graph.json";
const NATIVE_LOG = "apps/eliotr-web/dist/owner-web-native.log";
const CUSTODY_SCOPE = "Local custody of the observed inventory; not independent compiler attestation";
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const fail = (message) => { throw new Error("Owner-web deployment rejected: " + message); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const slash = (value) => value.split(path.sep).join("/");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (value) => Buffer.from(JSON.stringify(value), "utf8");
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isRecord(value)) return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function same(left, right) { return canonical(left) === canonical(right); }
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
function relativeFile(root, name) {
  if (typeof name !== "string" || name.length === 0 || name.includes("\\") || path.isAbsolute(name) ||
      name.split("/").some((part) => part === "" || part === "." || part === "..")) fail("invalid graph path");
  const absolute = path.resolve(root, name);
  if (!inside(root, absolute) || slash(path.relative(root, absolute)) !== name) fail("graph path escaped root");
  return absolute;
}
async function stableFile(root, absolute, limit = MAX_OBJECT_BYTES) {
  if (!inside(root, absolute)) fail("file escaped root");
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit || await realpath(absolute) !== absolute) {
    fail("graph/config file is not a bounded regular file: " + slash(path.relative(root, absolute)));
  }
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (!after.isFile() || after.isSymbolicLink() || bytes.byteLength !== before.size ||
      ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs", "birthtimeMs"].some((key) => before[key] !== after[key])) {
    fail("file changed during read");
  }
  return bytes;
}
function parsed(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("invalid " + label); }
}
function assertManifest(root, manifest) {
  const body = { ...manifest };
  delete body.sha256;
  if (manifest?.protocol !== "eliotr.deployment-build-inputs.v1" || manifest.root !== root ||
      !Array.isArray(manifest.inputs) || !SHA256.test(manifest.sha256 ?? "") || digest(json(body)) !== manifest.sha256) {
    fail("invalid captured input manifest");
  }
}

/** Only the generated asset directory changes; installed runtime configuration stays intact. */
export async function normalizeOwnerWebDeploymentConfig({ root, expectedBytes }) {
  root = path.resolve(root);
  const absolute = path.resolve(root, CONFIG);
  const bytes = await stableFile(root, absolute);
  if (!bytes.equals(expectedBytes)) fail("provisioned config changed before normalization");
  const config = parsed(bytes, "generated config");
  if (config.name !== "eliotr-core" || config.main !== "src/index.ts" ||
      config.assets?.directory !== "../eliotr-pwa/dist") fail("unexpected provisioner build profile");
  config.assets.directory = "../eliotr-web/dist/client";
  const canonicalConfig = parseDeploymentJsonc((await stableFile(root, path.resolve(root, "apps/eliotr-core/wrangler.jsonc"))).toString("utf8"), "canonical Wrangler config");
  assertCoreWorkerRouteParity(canonicalConfig, config, { assetProfile: "owner-web" });
  const normalized = Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8");
  await writeFile(absolute, normalized);
  if (!(await stableFile(root, absolute)).equals(normalized)) fail("normalized config changed during pin");
  return { bytes: normalized, config, pin: await pinGeneratedDeploymentConfig({ root,
    path: absolute, assetProfile: "owner-web" }) };
}

export function createOwnerWebBuildContext({ manifest, generatedConfigPin }) {
  return Object.freeze({ nonce: randomUUID(), key: randomBytes(32).toString("hex"), startedAt: new Date().toISOString(),
    inputManifestSha256: manifest.sha256, generatedConfigSha256: generatedConfigPin.sha256 });
}

/** Root owns this builder and its same-prepared-graph emitted-budget check. */
export async function buildOwnerWebDeployment({ root, environment, execute, context }) {
  const { buildOwnerWebDeploymentGraph } = await import("./deployment-owner-web-builder.mjs");
  if (typeof buildOwnerWebDeploymentGraph !== "function") fail("root combined builder is unavailable");
  await buildOwnerWebDeploymentGraph({ root, execute, environment: { ...environment,
    ELIOTR_OWNER_WEB_DEPLOY_CONFIG: path.resolve(root, CONFIG),
    ELIOTR_OWNER_WEB_DEPLOY_CONFIG_SHA256: context.generatedConfigSha256,
    ELIOTR_OWNER_WEB_CAPTURED_INPUTS_SHA256: context.inputManifestSha256,
    ELIOTR_OWNER_WEB_BUILD_NONCE: context.nonce,
    ELIOTR_OWNER_WEB_INPUT_MANIFEST_KEY: context.key } });
}

/** Exact @cloudflare/vite-plugin 1.54.11 projection over Wrangler 4.143.1 defaults. */
async function assertEmittedConfig(root, emitted, generatedConfigPin) {
  const requireFromRoot = createRequire(path.resolve(root, "package.json"));
  const wrangler = requireFromRoot("wrangler");
  const wranglerPackage = requireFromRoot("wrangler/package.json");
  const pluginPackage = parsed(await readFile(path.resolve(root,
    "apps/eliotr-web/node_modules/@cloudflare/vite-plugin/package.json")), "installed Vite plugin package");
  if (wranglerPackage.version !== "4.143.1" || pluginPackage.version !== "1.54.11" ||
      typeof wrangler.unstable_readConfig !== "function") fail("unsupported installed config projection tools");
  const configPath = path.resolve(root, CONFIG);
  const pinnedConfig = parsed(await stableFile(root, configPath), "pinned generated config");
  const definedEnvironments = Object.keys(pinnedConfig.env ?? {});
  const normalized = wrangler.unstable_readConfig({ config: configPath },
    { hideWarnings: true, preserveOriginalMain: true });
  if (!isRecord(normalized) || normalized.configPath !== configPath || normalized.userConfigPath !== configPath ||
      normalized.name !== "eliotr-core" || normalized.topLevelName !== "eliotr-core" ||
      !same(normalized.definedEnvironments, definedEnvironments) || normalized.targetEnvironment !== undefined ||
      !isRecord(normalized.assets) || !Array.isArray(normalized.d1_databases)) {
    fail("normalized config changed source/target environment identity");
  }
  const reread = await stableFile(root, configPath);
  if (digest(reread) !== generatedConfigPin.sha256 || reread.byteLength !== generatedConfigPin.byte_length) {
    fail("generated config changed while Wrangler normalized it");
  }
  const expected = structuredClone(normalized);
  // Installed plugin processNormalizedWorkerConfig, index.mjs:64354-64364.
  // No unlisted key is omitted: all account/resource/routes/defaults remain compared.
  for (const key of ["alias", "base_dir", "find_additional_modules", "minify", "no_bundle",
    "preserve_file_names", "site", "tsconfig", "build", "define"]) delete expected[key];
  // Installed plugin getOutputConfig, index.mjs:85560-85592.
  const outputDirectory = path.resolve(root, WORKER);
  const sourceDirectory = path.dirname(configPath);
  expected.main = "index.js";
  expected.no_bundle = true;
  expected.rules = [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }];
  expected.assets = { ...expected.assets, directory: slash(path.relative(outputDirectory, path.resolve(root, CLIENT))) };
  expected.d1_databases = expected.d1_databases.map((database) => {
    const from = database.migrations_dir ?? "migrations";
    const to = slash(path.relative(outputDirectory, path.resolve(sourceDirectory, from)) || ".");
    let pattern;
    if (database.migrations_pattern !== undefined) {
      const normalizedFrom = path.posix.normalize(slash(from));
      const normalizedPattern = path.posix.normalize(slash(database.migrations_pattern));
      const suffix = normalizedFrom === "." ? normalizedPattern : path.posix.relative(normalizedFrom, normalizedPattern);
      pattern = slash(path.posix.normalize(to === "." ? suffix : to + "/" + suffix));
    }
    return { ...database, migrations_dir: to, migrations_pattern: pattern };
  });
  // Installed output-config plugin omits only an empty unsafe object (85547).
  if (isRecord(expected.unsafe) && Object.keys(expected.unsafe).length === 0) expected.unsafe = undefined;
  // Match the plugin's JSON serialization of undefined defaults without omitting unknown JSON fields.
  const serializedExpected = JSON.parse(JSON.stringify(expected));
  if (!same(serializedExpected, emitted)) fail("emitted normalized runtime/account/resource/routes configuration drift");
}
async function inventory(root, directory, totals) {
  const absolute = path.resolve(root, directory);
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) fail("invalid output directory");
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (++totals.entries > MAX_FILES * 2) fail("output inventory exceeds entry bound");
    const relative = directory + "/" + entry.name;
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...await inventory(root, relative, totals));
    else {
      const bytes = await stableFile(root, relativeFile(root, relative), 32 * 1024 * 1024);
      totals.bytes += bytes.byteLength;
      if (++totals.files > MAX_FILES || totals.bytes > MAX_TOTAL_BYTES) fail("output inventory exceeds byte/file bound");
      files.push({ path: relative, byte_length: bytes.byteLength, sha256: digest(bytes) });
    }
  }
  return files;
}
function records(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) fail("invalid " + label + " inventory");
  const seen = new Set();
  for (const record of value) {
    if (!isRecord(record) || Object.keys(record).length !== 3 || typeof record.path !== "string" ||
        !Number.isSafeInteger(record.byte_length) || record.byte_length < 0 || !SHA256.test(record.sha256 ?? "") ||
        seen.has(record.path)) fail("invalid or duplicate " + label + " record");
    seen.add(record.path);
  }
  return [...value].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length > MAX_FILES || value.some((item) => typeof item !== "string")) {
    fail("invalid observed graph " + label);
  }
  return value;
}
function platformImport(id) { return isBuiltin(id) || ["cloudflare:workers", "cloudflare:sockets", "cloudflare:email", "cloudflare:workflows"].includes(id); }
function moduleInputPath(root, id) {
  if (id.startsWith("\0") || id.startsWith("virtual:") || platformImport(id) ||
      id === "builtin:esm-external-require-path") return null;
  const filename = id.split("?")[0];
  if (!path.isAbsolute(filename)) fail("unclassified module id in observed graph: " + id);
  const absolute = path.resolve(filename);
  if (!inside(root, absolute)) fail("observed module escaped captured repository: " + id);
  return slash(path.relative(root, absolute));
}
function validateObservedWorkerGraph(root, graph, inputs, outputs) {
  if (!isRecord(graph) || graph.schemaVersion !== 1 || graph.environment !== "eliotr_core" ||
      graph.producer?.plugin !== "eliotr-owner-worker-graph" || graph.producer?.hook !== "generateBundle" ||
      typeof graph.root !== "string" || path.resolve(graph.root) !== path.resolve(root, "apps/eliotr-web") ||
      !isRecord(graph.output) || graph.output.isWrite !== true || graph.output.format !== "es" ||
      typeof graph.output.outDir !== "string" ||
      path.resolve(graph.root, graph.output.outDir) !== path.resolve(root, WORKER) ||
      !Array.isArray(graph.modules) || graph.modules.length === 0 || graph.modules.length > MAX_FILES ||
      !Array.isArray(graph.chunks) || graph.chunks.length === 0 || graph.chunks.length > MAX_FILES) {
    fail("invalid genuine Worker graph observation");
  }
  const observed = new Map();
  const custody = new Set(inputs.map((input) => input.path));
  const physicalInputs = new Set();
  for (const module of graph.modules) {
    if (!isRecord(module) || typeof module.id !== "string" || observed.has(module.id) || typeof module.isEntry !== "boolean") {
      fail("invalid or duplicate observed module");
    }
    stringArray(module.importedIds, "module imports");
    stringArray(module.dynamicallyImportedIds, "module dynamic imports");
    observed.set(module.id, module);
    const physical = moduleInputPath(root, module.id);
    if (physical !== null) {
      if (!custody.has(physical)) fail("observed Worker input is absent from local custody inventory: " + physical);
      physicalInputs.add(physical);
    }
  }
  if (!physicalInputs.has("apps/eliotr-core/src/index.ts")) fail("observed Worker graph omits canonical Core source");
  const absent = [...new Set([...observed.values()].flatMap((module) =>
    [...module.importedIds, ...module.dynamicallyImportedIds].filter((id) => !observed.has(id))))].sort();
  if (!same(absent, [...stringArray(graph.dependencyIdsAbsentFromModuleGraph, "absent dependency ids")].sort())) {
    fail("observed module dependency inventory is inconsistent");
  }
  // Absence alone never establishes externality. Only known platform imports are allowed.
  if (absent.some((id) => !platformImport(id))) fail("unclassified dependencies absent from observed module graph");
  const chunks = new Map();
  const workerFiles = new Set(outputs.filter((record) => record.path.startsWith(WORKER + "/"))
    .map((record) => record.path.slice(WORKER.length + 1)));
  for (const chunk of graph.chunks) {
    if (!isRecord(chunk) || typeof chunk.fileName !== "string" || chunks.has(chunk.fileName) ||
        !chunk.fileName.endsWith(".js") || !workerFiles.has(chunk.fileName) ||
        typeof chunk.isEntry !== "boolean" || typeof chunk.isDynamicEntry !== "boolean") fail("invalid observed chunk");
    relativeFile(root, WORKER + "/" + chunk.fileName);
    if (chunk.facadeModuleId !== null && (typeof chunk.facadeModuleId !== "string" || !observed.has(chunk.facadeModuleId))) {
      fail("entry facade is absent from observed module graph");
    }
    // Rolldown's emitted runtime is created after getModuleIds() observation.
    // Admit only its exact output-only identity, with no entry facade or dynamic entry.
    if (stringArray(chunk.moduleIds, "chunk modules").some((id) => !observed.has(id) &&
        (id !== "\0rolldown/runtime.js" || chunk.facadeModuleId !== null || chunk.isEntry || chunk.isDynamicEntry ||
          !Array.isArray(chunk.renderedModules) || !chunk.renderedModules.some(module => module.id === id)))) {
      fail("chunk contains unobserved modules");
    }
    stringArray(chunk.imports, "chunk imports");
    stringArray(chunk.dynamicImports, "chunk dynamic imports");
    chunks.set(chunk.fileName, chunk);
  }
  const entries = [...chunks.values()].filter((chunk) => chunk.isEntry);
  if (entries.length !== 1 || entries[0].fileName !== "index.js") fail("observed graph does not select the prepared index.js entry");
  function importedChunk(from, specifier) {
    if (platformImport(specifier)) return null;
    // Rollup records emitted file names; relative specifiers are relative to the importer.
    const target = specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)) : specifier;
    if (!chunks.has(target)) fail("observed output import is not a prepared chunk: " + specifier);
    return target;
  }
  const reachable = new Set();
  function visit(name) {
    if (reachable.has(name)) return;
    reachable.add(name);
    const chunk = chunks.get(name);
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      const target = importedChunk(name, imported);
      if (target !== null) visit(target);
    }
  }
  visit("index.js");
  if (reachable.size !== chunks.size) fail("prepared Worker contains chunks outside observed entry/import closure");
  const assets = stringArray(graph.assetFileNames, "asset file names");
  const expectedFiles = new Set([...chunks.keys(), ...assets, "wrangler.json", "owner-worker-graph.json"]);
  for (const asset of assets) relativeFile(root, WORKER + "/" + asset);
  if (expectedFiles.size !== workerFiles.size || [...expectedFiles].some((name) => !workerFiles.has(name))) {
    fail("Worker inventory differs from observed chunks/assets and explicit metadata");
  }
  return { producer: graph.producer, chunk_count: chunks.size, module_count: observed.size,
    entry_import_closure: "PASS", dependency_ids_absent_from_module_graph: absent,
    scope: "VITE_GENERATE_BUNDLE_OBSERVATION" };
}

/** Local custody inventory binds the separate genuine Vite observation; it is not compiler evidence. */
async function verifyPreparedBudget(root, payload, graphBytes, graph, manifest, context) {
  if (payload.signature_scope !== CUSTODY_SCOPE || payload.observed_graph?.path !== WORKER_GRAPH ||
      payload.observed_graph.sha256 !== digest(graphBytes)) fail("observed graph or local custody scope changed");
  const sourceInputs = new Set();
  const virtualInputs = new Set();
  for (const chunk of graph.chunks) {
    if (!Array.isArray(chunk.renderedModules)) fail("observed graph lacks rendered source inputs");
    for (const module of chunk.renderedModules) {
      if (!isRecord(module) || typeof module.id !== "string") fail("invalid rendered source observation");
      const id = module.id;
      if (id.includes("\0") || id.startsWith("virtual:") || id.startsWith("cloudflare:") ||
          id === "builtin:esm-external-require-path") {
        virtualInputs.add(id);
        continue;
      }
      const filename = id.split("?")[0];
      if (!path.isAbsolute(filename)) fail("unclassified rendered source input");
      const actual = await realpath(filename);
      if (!inside(root, actual)) fail("rendered source escaped sealed repository");
      const relative = slash(path.relative(root, actual));
      const pin = manifest.inputs.find((input) => input.path === relative);
      if (!pin) fail("rendered source missing from captured inputs: " + relative);
      const bytes = await stableFile(root, actual, 32 * 1024 * 1024);
      if (bytes.byteLength !== pin.byte_length || digest(bytes) !== pin.sha256) fail("stale rendered source: " + relative);
      sourceInputs.add(relative);
    }
  }
  if (!sourceInputs.has("apps/eliotr-core/src/index.ts") ||
      !same([...sourceInputs].sort(), payload.observed_graph.rendered_source_inputs) ||
      !same([...virtualInputs].sort(), payload.observed_graph.virtual_inputs) ||
      payload.observed_graph.scope !== "Compiler module observation; virtual module internals are not source-byte attestation") {
    fail("signed source declaration differs from observed compiler graph");
  }
  const budget = payload.budget;
  if (!isRecord(budget) || budget.state !== "PASS" || budget.worker_limit !== WORKER_GZIP_BUDGET_BYTES ||
      budget.client_limit !== OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES || !SHA256.test(budget.native_log_sha256 ?? "") ||
      !Number.isFinite(Date.parse(context.startedAt))) fail("invalid prepared budget/freshness proof");
  const nativeBytes = await stableFile(root, path.resolve(root, NATIVE_LOG), 32 * 1024 * 1024);
  if (digest(nativeBytes) !== budget.native_log_sha256) fail("native no-bundle measurement log changed");
  const nativeLog = new TextDecoder("utf-8", { fatal: true }).decode(nativeBytes);
  const reports = [...nativeLog.matchAll(/Total Upload:\s*([\d.]+)\s*(B|KiB|MiB)\s*\/\s*gzip:\s*([\d.]+)\s*(B|KiB|MiB)/gu)];
  if (reports.length !== 1 || !/--dry-run:\s*exiting now\./u.test(nativeLog)) fail("missing/ambiguous native prepared budget measurement");
  const units = { B: 1, KiB: 1024, MiB: 1024 * 1024 };
  const upperBytes = Math.ceil((Number(reports[0][3]) + 0.005) * units[reports[0][4]]);
  if (!Number.isSafeInteger(upperBytes) || upperBytes !== budget.worker_gzip_upper_bytes || upperBytes > WORKER_GZIP_BUDGET_BYTES) {
    fail("prepared Worker gzip measurement drift or threshold failure");
  }
  const startupObservations = await readOwnerWebStartup({ root, evidence: payload.startup?.evidence,
    ...ownerWebStartupBindings({ sourceCommit: manifest.git_head, inputManifestSha256: manifest.sha256,
      generatedConfigSha256: payload.generated_config_sha256, outputs: payload.outputs }) });
  const client = await inspectWebBuild(root, context.startedAt, { startupObservations });
  if (client.status !== "PASS" || client.threshold?.gzipBytes !== OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES ||
      !Number.isSafeInteger(client.metric?.gzipBytes) || client.metric.gzipBytes > OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES ||
      !same(client, budget.client)) fail("prepared client budget no longer matches actual emitted graph");
  return { ...budget, native_log: { path: NATIVE_LOG, sha256: digest(nativeBytes), byte_length: nativeBytes.byteLength } };
}

async function verifyNativeRoutes(root, payload, manifest, generatedConfigPin, outputs) {
  const evidence = payload.native_routes?.evidence;
  if (payload.native_routes?.state !== "PASS" ||
      payload.native_routes?.scope !== "LOCAL_PREPARED_WORKER_ROUTE_DENIAL_AND_STATIC_BYTES_ONLY" ||
      !isRecord(evidence) || !/^\.eliotr-state\/owner-web-native-routes-[a-f0-9-]{36}\.json$/u.test(evidence.path ?? "") ||
      !Number.isSafeInteger(evidence.byte_length) || evidence.byte_length < 1 || evidence.byte_length > MAX_OBJECT_BYTES ||
      !SHA256.test(evidence.sha256 ?? "")) fail("missing genuine prepared native route evidence");
  const bytes = await stableFile(root, relativeFile(root, evidence.path));
  if (bytes.byteLength !== evidence.byte_length || digest(bytes) !== evidence.sha256) fail("native route evidence changed");
  const receipt = parsed(bytes, "native route evidence");
  const entry = outputs.find(item => item.path === WORKER + "/index.js");
  const emitted = outputs.find(item => item.path === WORKER + "/wrangler.json");
  const pins = receipt.pins;
  if (receipt.protocol !== "eliotr.owner-web-native-routes.v1" || receipt.state !== "PASS" ||
      receipt.scope !== payload.native_routes.scope || receipt.source_head !== manifest.git_head ||
      receipt.wrangler_version !== "4.143.1" || receipt.failure !== null ||
      receipt.process?.local !== true || receipt.process.no_bundle !== true ||
      receipt.process.ready_from_owned_process !== true || receipt.process.shutdown_confirmed !== true ||
      !isRecord(pins) || !same(pins.generated_config, { path: CONFIG, byte_length: generatedConfigPin.byte_length, sha256: generatedConfigPin.sha256 }) ||
      !same(pins.entrypoint, entry) || !same(pins.emitted_config, emitted)) fail("native route evidence does not bind this prepared graph");
  const expected = [["/agents", false, 404], ["/agents/research-session/probe", false, 401],
    ["/agents/research-session/probe", true, 401], ["/sw.js", false, 200], ["/agent-inbox/", false, 200]];
  if (!Array.isArray(receipt.routes) || receipt.routes.length !== expected.length || expected.some(([route, upgrade, status], index) => {
    const observed = receipt.routes[index];
    return observed.path !== route || observed.upgrade !== upgrade || observed.status !== status || observed.state !== "PASS";
  })) fail("prepared native route checks are incomplete");
  return { ...payload.native_routes, source_head: receipt.source_head, checks: receipt.routes.length };
}

export async function attestOwnerWebDeployment({ root, manifest, generatedConfigPin, context }) {
  root = path.resolve(root);
  assertManifest(root, manifest);
  const configBytes = await stableFile(root, path.resolve(root, CONFIG));
  if (digest(configBytes) !== generatedConfigPin.sha256 || configBytes.byteLength !== generatedConfigPin.byte_length) {
    fail("generated config changed after pin");
  }
  const proofBytes = await stableFile(root, path.resolve(root, PROOF));
  const proof = parsed(proofBytes, "signed build input manifest");
  if (!isRecord(proof) || Object.keys(proof).length !== 2 || !isRecord(proof.payload) ||
      !SHA256.test(proof.signature ?? "")) fail("unsigned or malformed local build input manifest");
  const signature = createHmac("sha256", context.key).update(json(proof.payload)).digest();
  if (!timingSafeEqual(signature, Buffer.from(proof.signature, "hex"))) fail("invalid local build manifest signature");
  const payload = proof.payload;
  if (payload.protocol !== "eliotr.owner-web-build-inputs.v1" || payload.asset_profile !== "owner-web" ||
      payload.nonce !== context.nonce || payload.input_manifest_sha256 !== manifest.sha256 ||
      payload.generated_config_sha256 !== generatedConfigPin.sha256) fail("stale or wrong-profile build manifest");
  const inputs = records(payload.inputs, "Vite input");
  if (manifest.inputs.some((input) => input.path === CONFIG)) {
    fail("generated CONFIG must be pinned separately from captured inputs");
  }
  if (generatedConfigPin.path !== CONFIG) fail("generated CONFIG pin has the wrong path");
  const expectedInputs = records([
    ...manifest.inputs.map(({ path, byte_length, sha256 }) => ({ path, byte_length, sha256 })),
    { path: CONFIG, byte_length: generatedConfigPin.byte_length, sha256: generatedConfigPin.sha256 },
  ], "captured and generated input");
  if (!same(inputs, expectedInputs)) fail("custody inventory omits or changes captured/generated inputs");
  let inputBytes = 0;
  for (const input of inputs) {
    const known = input.path === CONFIG ? generatedConfigPin : manifest.inputs.find((item) => item.path === input.path);
    if (!known || known.byte_length !== input.byte_length || known.sha256 !== input.sha256) {
      fail("Vite graph input was not captured before gates: " + input.path);
    }
    const bytes = await stableFile(root, relativeFile(root, input.path), 32 * 1024 * 1024);
    if (bytes.byteLength !== input.byte_length || digest(bytes) !== input.sha256) fail("Vite input changed: " + input.path);
    inputBytes += bytes.byteLength;
    if (inputBytes > MAX_TOTAL_BYTES) fail("Vite inputs exceed byte bound");
  }
  for (const required of ["apps/eliotr-core/src/index.ts", "apps/eliotr-web/index.html", "apps/eliotr-web/vite.integrated.config.ts"]) {
    if (!inputs.some((item) => item.path === required)) fail("missing required combined build input: " + required);
  }
  const totals = { entries: 0, files: 0, bytes: 0 };
  const outputs = records([...await inventory(root, CLIENT, totals), ...await inventory(root, WORKER, totals)], "emitted output");
  if (!same(outputs, records(payload.outputs, "signed output"))) fail("emitted files differ from signed combined graph");
  const graphBytes = await stableFile(root, path.resolve(root, WORKER_GRAPH));
  const graph = parsed(graphBytes, "observed Worker graph");
  const graphObservation = validateObservedWorkerGraph(root, graph, inputs, outputs);
  const preparedBudget = await verifyPreparedBudget(root, payload, graphBytes, graph, manifest, context);
  const nativeRoutes = await verifyNativeRoutes(root, payload, manifest, generatedConfigPin, outputs);
  const emittedConfigBytes = await stableFile(root, path.resolve(root, WORKER, "wrangler.json"));
  await assertEmittedConfig(root, parsed(emittedConfigBytes, "emitted config"), generatedConfigPin);
  const body = { protocol: "eliotr.owner-web-deployment-bundle.v1", scope: "BOUNDED_LOCAL_INTEGRITY", root,
    manifest_sha256: manifest.sha256, generated_config: generatedConfigPin,
    outdir: WORKER, entrypoint: path.resolve(root, WORKER, "index.js"), deployment_config: path.resolve(root, WORKER, "wrangler.json"),
    inputs, outputs, prepared_budget: preparedBudget, native_routes: nativeRoutes, worker_graph: { path: WORKER_GRAPH, sha256: digest(graphBytes),
      byte_length: graphBytes.byteLength, ...graphObservation },
    input_proof: { kind: "SIGNED_LOCAL_CUSTODY_INVENTORY", path: PROOF,
      sha256: digest(proofBytes), byte_length: proofBytes.byteLength, nonce: context.nonce } };
  return Object.freeze({ ...body, sha256: digest(json(body)) });
}
export async function requireUnchangedOwnerWebDeployment({ root, manifest, attestation, context }) {
  const current = await attestOwnerWebDeployment({ root, manifest, generatedConfigPin: attestation.generated_config, context });
  if (current.sha256 !== attestation.sha256) fail("prepared Vite graph changed after attestation");
}

export function validateOwnerWebSchemaMaterialization(manifest, bundle, source, result) {
  const sourceConfig = parsed(source.bytes, "schema source config");
  if (digest(source.bytes) !== source.pin.sha256 || source.bytes.byteLength !== source.pin.byte_length ||
      sourceConfig.assets?.directory !== "../eliotr-pwa/dist") fail("invalid original schema config pin");
  const expected = structuredClone(sourceConfig);
  expected.assets.directory = "../eliotr-web/dist/client";
  if (!same(expected, source.normalizedConfig)) fail("schema-to-deployment transition changes more than assets");
  const expectedManifest = result?.expectedManifest;
  const provenance = result?.provenance;
  const supported = provenance?.protocol === SUPPORTED_SCHEMA_PROVENANCE_PROTOCOL;
  const nativeRepresentation = supported || provenance?.protocol === DEPLOYMENT_SCHEMA_MANIFEST_NATIVE_PROVENANCE_PROTOCOL;
  if (supported) validateSupportedSchemaRepresentation(expectedManifest?.representation);
  const manifestKeys = ["protocol", "streams", ...(supported ? ["representation"] : [])];
  if (!isRecord(expectedManifest) || Object.keys(expectedManifest).length !== manifestKeys.length ||
      manifestKeys.some(key => !Object.hasOwn(expectedManifest, key))) fail("invalid schema manifest fields");
  const provenanceKeys = ["protocol", "scope", "exclusions", "generated_config", "streams",
    "expected_manifest_sha256", "expected_manifest_byte_length", ...(nativeRepresentation ? ["migration_representation"] : [])];
  if (!isRecord(provenance) || Object.keys(provenance).length !== provenanceKeys.length ||
      provenanceKeys.some(key => !Object.hasOwn(provenance, key))) fail("invalid schema provenance fields");
  if (expectedManifest?.protocol !== (supported ? SUPPORTED_SCHEMA_MANIFEST_PROTOCOL : DEPLOYMENT_SCHEMA_MANIFEST_PROTOCOL) ||
      (!nativeRepresentation && provenance?.protocol !== DEPLOYMENT_SCHEMA_MANIFEST_PROVENANCE_PROTOCOL) ||
      provenance.scope !== DEPLOYMENT_SCHEMA_SCOPE || !same(provenance.exclusions, DEPLOYMENT_SCHEMA_EXCLUSIONS) ||
      !same(provenance.generated_config, { path: CONFIG, sha256: source.pin.sha256, byte_length: source.pin.byte_length }) ||
      digest(json(expectedManifest)) !== provenance.expected_manifest_sha256 ||
      json(expectedManifest).byteLength !== provenance.expected_manifest_byte_length ||
      expectedManifest.streams?.length !== 2 || provenance.streams?.length !== 2 ||
      bundle.manifest_sha256 !== manifest.sha256) fail("invalid preserved schema materialization provenance");
  const accountIds = new Set();
  const capturedMigrations = new Map();
  for (const [index, binding] of ["CORE_DB", "SEARCH_DB"].entries()) {
    const database = sourceConfig.d1_databases.find((item) => item.binding === binding);
    const stream = expectedManifest.streams[index];
    const origin = provenance.streams[index];
    const folder = binding === "CORE_DB" ? "core" : "search";
    const migrations = manifest.inputs.filter((item) => item.path.startsWith("infra/d1/" + folder + "/migrations/") && item.path.endsWith(".sql"))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const entries = migrations.map((item) => ({ name: path.posix.basename(item.path), sha256: item.sha256 }));
    capturedMigrations.set(binding, migrations.map(item => ({ name: path.posix.basename(item.path),
      sha256: item.sha256, byte_length: item.byte_length })));
    if (!database || stream.binding !== binding || origin.binding !== binding ||
        stream.database_id !== database.database_id || origin.database_id !== database.database_id ||
        stream.database_name !== database.database_name || origin.database_name !== database.database_name ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(stream.account_id ?? "") || origin.account_id !== stream.account_id ||
        !same(entries, origin.migration_entries) || migrations.length === 0 ||
        origin.total_sql_bytes !== migrations.reduce((sum, item) => sum + item.byte_length, 0) ||
        digest(json(entries)) !== stream.migration_bundle_sha256 || stream.migration_bundle_sha256 !== origin.migration_bundle_sha256 ||
        stream.objects.length !== origin.object_count || deploymentSchemaCatalogueSha256(stream.objects) !== origin.catalogue_sha256) {
      fail("schema catalogue/migration identity differs from captured inputs");
    }
    if (supported) projectSupportedDeploymentSchema(stream.objects, expectedManifest.representation);
    accountIds.add(stream.account_id);
  }
  if (accountIds.size !== 1) fail("schema account differs between Core and Search");
  if (supported && provenance.migration_representation?.intent?.protocol !== "eliotr.cloudflare-d1-migration-intent.v5") fail("supported schema requires v5 intent");
  if (!supported && provenance.migration_representation?.intent?.protocol === "eliotr.cloudflare-d1-migration-intent.v5") fail("v5 cannot downgrade schema provenance");
  if (nativeRepresentation) {
    validateDeploymentNativeSchemaProvenance({ root: manifest.root,
      representation: provenance.migration_representation, sourceStreams: provenance.streams,
      capturedMigrations, generatedConfigPin: source.pin });
  }
}

/** Owner-web evidence has its own truthful protocol; legacy metafile evidence is untouched. */
export async function persistOwnerWebDeploymentEvidence({ root, manifest, bundle, generatedConfigPin,
  schemaManifestResult, schemaSource, context }) {
  await requireUnchangedOwnerWebDeployment({ root, manifest, attestation: bundle, context });
  validateOwnerWebSchemaMaterialization(manifest, bundle, schemaSource, schemaManifestResult);
  const directory = path.resolve(root, ".eliotr-state", "deployment-build-evidence-" + randomUUID());
  await mkdir(directory, { mode: 0o700 });
  if (await realpath(directory) !== directory) fail("evidence directory traverses a symlink");
  async function persist(name, value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
    if (bytes.byteLength > MAX_OBJECT_BYTES) fail("evidence object exceeds byte bound");
    const absolute = path.resolve(directory, name);
    await writeFile(absolute, bytes, { flag: "wx", mode: 0o600 });
    if (!(await stableFile(root, absolute)).equals(bytes)) fail("persisted evidence changed");
    return { path: slash(path.relative(root, absolute)), file_sha256: digest(bytes), byte_length: bytes.byteLength };
  }
  const proofBytes = await stableFile(root, path.resolve(root, PROOF));
  const generatedBytes = await stableFile(root, path.resolve(root, CONFIG));
  return { protocol: "eliotr.owner-web-deployment-build-evidence.v1", scope: "BOUNDED_LOCAL_INTEGRITY",
    source_head: manifest.git_head, persisted_directory: slash(path.relative(root, directory)),
    input_manifest: await persist("deployment-build-inputs.json", manifest),
    bundle_attestation: await persist("owner-web-deployment-bundle.json", bundle),
    signed_local_input_manifest: await persist("owner-web-inputs.json", proofBytes),
    generated_config: { ...await persist("wrangler.deploy.json", generatedBytes), pin: generatedConfigPin },
    application_schema: { scope: DEPLOYMENT_SCHEMA_SCOPE, exclusions: [...DEPLOYMENT_SCHEMA_EXCLUSIONS],
      expected_manifest: await persist("deployment-application-schema-manifest.json", schemaManifestResult.expectedManifest),
      provenance: await persist("deployment-application-schema-provenance.json", schemaManifestResult.provenance),
      materialization_config: { ...await persist("schema-materialization-config.json", schemaSource.bytes), pin: schemaSource.pin },
      deployment_config_pin: generatedConfigPin, transition: "ASSETS_DIRECTORY_ONLY" } };
}
