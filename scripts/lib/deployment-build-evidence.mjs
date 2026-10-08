import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEPLOYMENT_BUILD_EVIDENCE_PROTOCOL = "eliotr.deployment-build-evidence.v1";
export const DEPLOYMENT_BUILD_EVIDENCE_SCOPE = "BOUNDED_LOCAL_INTEGRITY";

const MAX_PERSISTED_OBJECT_BYTES = 16 * 1024 * 1024;
const EVIDENCE_DIRECTORY_PATTERN = /^\.eliotr-state\/deployment-build-evidence-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKER_DIRECTORY_PATTERN = /^\.eliotr-state\/deployment-worker-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GENERATED_CONFIG_PATH = "apps/eliotr-core/wrangler.deploy.jsonc";

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
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.byteLength > MAX_PERSISTED_OBJECT_BYTES) throw new Error("Build evidence object exceeds its private byte bound");
  await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
  const persisted = await readStableFile(root, absolutePath, `Persisted ${fileName}`);
  if (!persisted.equals(bytes)) throw new Error(`Persisted ${fileName} changed during readback`);
  return Object.freeze({ path: slash(path.relative(root, absolutePath)), file_sha256: digest(persisted) });
}

export async function persistDeploymentBuildEvidence({ root = process.cwd(), manifest, bundle, generatedConfigPin } = {}) {
  const absoluteRoot = path.resolve(root);
  await assertDirectory(absoluteRoot, absoluteRoot, "Deployment build root");
  assertManifest(absoluteRoot, manifest);
  assertGeneratedConfigPin(absoluteRoot, generatedConfigPin);
  const { absoluteEntrypoint, entrypointBytes } = await assertWorkerBundle(
    absoluteRoot, manifest, bundle, generatedConfigPin);

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
  return freezeDeep({
    protocol: DEPLOYMENT_BUILD_EVIDENCE_PROTOCOL,
    scope: DEPLOYMENT_BUILD_EVIDENCE_SCOPE,
    source_head: manifest.git_head,
    persisted_directory: relativeEvidenceDirectory,
    input_manifest: { path: persistedManifest.path, file_sha256: persistedManifest.file_sha256, manifest_sha256: manifest.sha256 },
    bundle_attestation: { path: persistedBundle.path, file_sha256: persistedBundle.file_sha256, attestation_sha256: bundle.sha256 },
    entrypoint: { path: slash(path.relative(absoluteRoot, absoluteEntrypoint)), raw_sha256: digest(entrypointBytes), byte_length: entrypointBytes.byteLength },
    generated_config: { path: generatedConfigPin.path, sha256: generatedConfigPin.sha256, byte_length: generatedConfigPin.byte_length },
  });
}
