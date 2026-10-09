import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export const DEPLOYMENT_BUILD_INPUT_PROTOCOL = "eliotr.deployment-build-inputs.v1";
export const DEPLOYMENT_BUILD_INPUT_LIMITS = Object.freeze({
  files: 8192,
  bytes: 64 * 1024 * 1024,
  metafileBytes: 16 * 1024 * 1024,
  artifactBytes: 32 * 1024 * 1024,
  artifactFiles: 8,
});

const REQUIRED_ROOT_INPUTS = Object.freeze([
  "eslint.config.mjs",
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
]);
const REQUIRED_CORE_INPUTS = Object.freeze([
  "apps/eliotr-core/package.json",
  "apps/eliotr-core/tsconfig.json",
  "apps/eliotr-core/wrangler.jsonc",
]);
const REQUIRED_PWA_INPUTS = Object.freeze([
  "apps/eliotr-pwa/astro.config.mjs",
  "apps/eliotr-pwa/package.json",
  "apps/eliotr-pwa/tsconfig.json",
  "apps/eliotr-pwa/vite.config.ts",
]);
const REQUIRED_DEPLOYMENT_SCRIPTS = Object.freeze([
  "scripts/check-boundaries.mjs",
  "scripts/check-budgets.mjs",
  "scripts/check-launch-code.mjs",
  "scripts/deploy-cloudflare.mjs",
  "scripts/generate-cloudflare-types.mjs",
  "scripts/lib/deployment-build-evidence.mjs",
  "scripts/provision-ai-gateways.mjs",
  "scripts/provision-ai-search.mjs",
  "scripts/provision-cloudflare-access.mjs",
  "scripts/provision-cloudflare-core.mjs",
  "scripts/test-boundary-negative.mjs",
]);
const INPUT_DIRECTORIES = Object.freeze([
  "apps/eliotr-core/src",
  "apps/eliotr-pwa/src",
  "apps/eliotr-pwa/public",
  "apps/eliotr-pwa/scripts",
  "infra/d1/core/migrations",
  "infra/d1/search/migrations",
]);
const EXCLUDED_GENERATED_INPUTS = new Set([
  "apps/eliotr-core/src/worker-configuration.d.ts",
  "apps/eliotr-pwa/public/agent-inbox/app.js",
  "apps/eliotr-pwa/public/agent-inbox/app.css",
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".astro", ".git", ".wrangler", "coverage", "dist", "dist-types", "node_modules",
]);
const ALLOWED_EXTERNAL_IMPORTS = new Set(["cloudflare:workers", "cloudflare:workflows"]);
const DEPLOYMENT_OUTDIR_PATTERN = /^\.eliotr-state\/deployment-worker-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function slash(value) {
  return value.split(path.sep).join("/");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
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

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: null, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Deployment build-input seal could not inspect Git (${result.error?.message ?? result.status})`);
  }
  return result.stdout;
}

function readGitHead(root) {
  const output = runGit(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/u.test(output)) throw new Error("Deployment build-input seal found an invalid Git HEAD");
  return output;
}

function readCommittedPaths(root) {
  const output = runGit(root, ["ls-tree", "-r", "--full-tree", "-z", "--name-only", "HEAD"]);
  return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

async function readRegularInput(root, relativePath, committedPaths, records, totals, kind = "repository") {
  const normalized = slash(relativePath);
  if (records.has(normalized)) return;
  if (kind === "repository" && !committedPaths.has(normalized)) {
    throw new Error(`Untracked deployment build input is refused: ${normalized}`);
  }
  const absolute = path.resolve(root, normalized);
  if (!inside(root, absolute)) throw new Error(`Deployment build input escaped the repository: ${normalized}`);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Deployment build input is not a regular file: ${normalized}`);
  const actual = await realpath(absolute);
  if (!inside(root, actual) || (kind === "repository" && actual !== absolute)) {
    throw new Error(`Deployment build input traverses a symlink or escapes the repository: ${normalized}`);
  }
  const bytes = await readFile(absolute);
  totals.files += 1;
  totals.bytes += bytes.byteLength;
  if (totals.files > DEPLOYMENT_BUILD_INPUT_LIMITS.files || totals.bytes > DEPLOYMENT_BUILD_INPUT_LIMITS.bytes) {
    throw new Error("Deployment build-input seal exceeded its file or byte bound");
  }
  records.set(normalized, { path: normalized, kind, byte_length: bytes.byteLength, sha256: digest(bytes) });
}

async function walkRepositoryInputs(root, relativeDirectory, committedPaths, records, totals) {
  const absolute = path.resolve(root, relativeDirectory);
  const directoryInfo = await lstat(absolute);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Deployment build-input directory is not a real directory: ${relativeDirectory}`);
  }
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      await walkRepositoryInputs(root, relativePath, committedPaths, records, totals);
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`Symlink in deployment build inputs is refused: ${relativePath}`);
    if (!entry.isFile() || EXCLUDED_GENERATED_INPUTS.has(slash(relativePath)) || entry.name.endsWith(".tsbuildinfo")) continue;
    await readRegularInput(root, relativePath, committedPaths, records, totals);
  }
}

function localModuleSpecifiers(source, filePath) {
  const output = new Set();
  const importsWithFrom = /(?:^|\n)\s*(?:import|export)\s+[\s\S]*?\s+from\s*["']([^"']+)["']/gu;
  const sideEffectImports = /(?:^|\n)\s*import\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(importsWithFrom)) if (match[1].startsWith(".")) output.add(match[1]);
  for (const match of source.matchAll(sideEffectImports)) if (match[1].startsWith(".")) output.add(match[1]);
  const dynamicImports = /\bimport\s*\(([^)]*)\)/gu;
  for (const match of source.matchAll(dynamicImports)) {
    const literal = /^\s*(["'])([^"']+)\1\s*$/u.exec(match[1]);
    if (!literal) throw new Error(`Deployment script has an unbounded dynamic import: ${filePath}`);
    if (literal[2].startsWith(".")) output.add(literal[2]);
  }
  const localRequires = /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(localRequires)) output.add(match[1]);
  return [...output].sort();
}

async function resolveRepositoryModule(root, importer, specifier) {
  const base = path.resolve(path.dirname(path.resolve(root, importer)), specifier);
  const candidates = [base, ...[".mjs", ".js", ".cjs", ".json", ".jsonc", ".ts"].map((extension) => `${base}${extension}`),
    ...["index.mjs", "index.js", "index.cjs"].map((name) => path.join(base, name))];
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (info.isFile()) {
        if (!inside(root, candidate)) throw new Error(`Deployment script import escaped the repository: ${specifier}`);
        return slash(path.relative(root, candidate));
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  throw new Error(`Deployment script import could not be resolved: ${importer} -> ${specifier}`);
}

async function captureDeploymentScriptGraph(root, committedPaths, records, totals) {
  const visited = new Set();
  async function visit(relativePath) {
    const normalized = slash(relativePath);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    await readRegularInput(root, normalized, committedPaths, records, totals);
    const source = await readFile(path.resolve(root, normalized), "utf8");
    for (const specifier of localModuleSpecifiers(source, normalized)) {
      await visit(await resolveRepositoryModule(root, normalized, specifier));
    }
  }
  for (const entrypoint of REQUIRED_DEPLOYMENT_SCRIPTS) await visit(entrypoint);
}

async function walkInstalledFiles(root, absoluteDirectory, records, totals) {
  const directoryInfo = await lstat(absoluteDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Installed build dependency is not a real directory: ${absoluteDirectory}`);
  }
  const output = [];
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    const absolute = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      output.push(...await walkInstalledFiles(root, absolute, records, totals));
      continue;
    }
    if (entry.isSymbolicLink()) throw new Error(`Symlink in installed deployment dependency is refused: ${absolute}`);
    if (!entry.isFile()) throw new Error(`Unsupported installed deployment dependency entry: ${absolute}`);
    output.push(await recordInstalledFile(root, absolute, records, totals));
  }
  return output;
}

async function resolveInstalledPackage(root, fromDirectory, packageName) {
  let entrypoint;
  try {
    entrypoint = createRequire(path.join(fromDirectory, "package.json")).resolve(packageName);
  } catch (error) {
    throw new Error(`Installed runtime dependency could not be resolved (${packageName}): ${error.message}`, { cause: error });
  }
  const actualEntrypoint = await realpath(entrypoint);
  if (!inside(root, actualEntrypoint)) throw new Error(`Installed runtime dependency resolves outside the repository: ${packageName}`);
  let directory = path.dirname(actualEntrypoint);
  while (inside(root, directory)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (metadata.name === packageName) return { root: directory, metadata };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Installed runtime dependency has no matching package metadata: ${packageName}`);
}

async function captureRuntimePackageClosure(root, ownerDirectory, packageName, expectedVersion,
  records, totals, visited = new Map()) {
  const resolved = await resolveInstalledPackage(root, ownerDirectory, packageName);
  const actualRoot = await realpath(resolved.root);
  if (visited.has(actualRoot)) return visited.get(actualRoot);
  const version = resolved.metadata.version;
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(`Installed runtime dependency version drift (${packageName}@${version}; expected ${expectedVersion})`);
  }
  if (visited.size >= 128) throw new Error("Installed runtime dependency closure exceeded its package bound");
  const record = { name: packageName, version, path: slash(path.relative(root, actualRoot)), files: 0 };
  visited.set(actualRoot, record);
  const files = await walkInstalledFiles(root, actualRoot, records, totals);
  record.files = files.length;
  const dependencies = { ...resolved.metadata.dependencies, ...resolved.metadata.optionalDependencies,
    ...resolved.metadata.peerDependencies };
  for (const dependency of Object.keys(dependencies).sort()) {
    const optional = Object.hasOwn(resolved.metadata.optionalDependencies ?? {}, dependency)
      || resolved.metadata.peerDependenciesMeta?.[dependency]?.optional === true;
    try {
      await captureRuntimePackageClosure(root, actualRoot, dependency, null, records, totals, visited);
    } catch (error) {
      if (!optional || !/could not be resolved/u.test(error.message)) throw error;
    }
  }
  return record;
}

async function recordInstalledFile(root, absolute, records, totals) {
  const actual = path.resolve(absolute);
  if (!inside(root, actual)) throw new Error(`Installed deployment dependency escaped the repository: ${absolute}`);
  const relative = slash(path.relative(root, actual));
  await readRegularInput(root, relative, new Set(), records, totals, "installed");
  return records.get(relative);
}

async function readJson(root, relativePath) {
  try {
    return JSON.parse(await readFile(path.resolve(root, relativePath), "utf8"));
  } catch (error) {
    throw new Error(`Deployment build-input seal could not read ${relativePath}: ${error.message}`, { cause: error });
  }
}

function assertPackageVersions(rootPackage, corePackage, wranglerPackage, zodPackage) {
  if (rootPackage.packageManager !== "pnpm@11.23.0") throw new Error("Deployment build-input seal requires the pinned pnpm@11.23.0 package manager");
  if (corePackage.dependencies?.zod !== "4.4.3" || zodPackage.name !== "zod" || zodPackage.version !== "4.4.3") {
    throw new Error("Deployment build-input seal requires the core runtime's exact installed zod@4.4.3");
  }
  if (rootPackage.devDependencies?.wrangler !== "4.143.1" || wranglerPackage.name !== "wrangler" || wranglerPackage.version !== "4.143.1") {
    throw new Error("Deployment build-input seal requires the exact installed wrangler@4.143.1");
  }
}

async function captureInstalledState(root, records, totals, rootPackage, corePackage, pwaPackage) {
  const installedLockPath = path.resolve(root, "node_modules/.pnpm/lock.yaml");
  const installedModulesPath = path.resolve(root, "node_modules/.modules.yaml");
  const installedLock = await readFile(installedLockPath);
  const rootLock = await readFile(path.resolve(root, "pnpm-lock.yaml"));
  if (!installedLock.equals(rootLock)) throw new Error("Installed pnpm lock state does not match the committed workspace lockfile");
  const zodLink = await realpath(path.resolve(root, "apps/eliotr-core/node_modules/zod"));
  const wranglerLink = await realpath(path.resolve(root, "node_modules/wrangler"));
  if (!inside(root, zodLink) || !inside(root, wranglerLink)) throw new Error("Installed deployment dependency resolves outside the repository");
  const zodPackagePath = path.join(zodLink, "package.json");
  const wranglerPackagePath = path.join(wranglerLink, "package.json");
  const zodPackage = JSON.parse(await readFile(zodPackagePath, "utf8"));
  const wranglerPackage = JSON.parse(await readFile(wranglerPackagePath, "utf8"));
  assertPackageVersions(rootPackage, corePackage, wranglerPackage, zodPackage);
  const zodFiles = await walkInstalledFiles(root, zodLink, records, totals);
  const markdownItRange = pwaPackage.dependencies?.["markdown-it"];
  if (markdownItRange !== "15.0.2") throw new Error("Deployment build-input seal requires the pinned PWA markdown-it@15.0.2 runtime dependency");
  const runtimePackages = new Map();
  const coreRuntime = await captureRuntimePackageClosure(root, path.resolve(root, "apps/eliotr-core"), "zod",
    corePackage.dependencies.zod, records, totals, runtimePackages);
  const pwaRuntime = await captureRuntimePackageClosure(root, path.resolve(root, "apps/eliotr-pwa"), "markdown-it",
    markdownItRange, records, totals, runtimePackages);
  await recordInstalledFile(root, installedLockPath, records, totals);
  await recordInstalledFile(root, installedModulesPath, records, totals);
  await recordInstalledFile(root, wranglerPackagePath, records, totals);
  return {
    package_manager: rootPackage.packageManager,
    zod: { version: zodPackage.version, realpath: slash(path.relative(root, zodLink)), files: zodFiles.length },
    runtime_packages: [...runtimePackages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    core_runtime: { name: coreRuntime.name, version: coreRuntime.version },
    pwa_runtime: { name: pwaRuntime.name, version: pwaRuntime.version },
    wrangler: { version: wranglerPackage.version, realpath: slash(path.relative(root, wranglerLink)),
      package_json_sha256: records.get(slash(path.relative(root, wranglerPackagePath))).sha256 },
    pnpm_lock_sha256: digest(rootLock),
    pnpm_modules_sha256: records.get(slash(path.relative(root, installedModulesPath))).sha256,
    build_tooling_limit: "Wrangler/esbuild implementation files are not fully byte-attested; lock state, package metadata, runtime dependency bytes, source inputs, and emitted bundle bytes are pinned.",
  };
}

function manifestBody(manifest) {
  const body = { ...manifest };
  delete body.sha256;
  return body;
}

function validateManifest(root, manifest) {
  if (!manifest || manifest.protocol !== DEPLOYMENT_BUILD_INPUT_PROTOCOL || manifest.root !== root
    || typeof manifest.sha256 !== "string" || digest(Buffer.from(stableJson(manifestBody(manifest)))) !== manifest.sha256) {
    throw new Error("Deployment build-input manifest is invalid or was modified");
  }
}

async function captureManifest(root) {
  const absoluteRoot = path.resolve(root);
  const rootRealpath = await realpath(absoluteRoot);
  if (rootRealpath !== absoluteRoot) throw new Error("Deployment build-input root must not be a symlink");
  const committedPaths = readCommittedPaths(absoluteRoot);
  const records = new Map();
  const totals = { files: 0, bytes: 0 };
  for (const relative of REQUIRED_ROOT_INPUTS) await readRegularInput(absoluteRoot, relative, committedPaths, records, totals);
  for (const relative of [...REQUIRED_CORE_INPUTS, ...REQUIRED_PWA_INPUTS]) {
    await readRegularInput(absoluteRoot, relative, committedPaths, records, totals);
  }
  for (const relativeDirectory of INPUT_DIRECTORIES) {
    await walkRepositoryInputs(absoluteRoot, relativeDirectory, committedPaths, records, totals);
  }
  await captureDeploymentScriptGraph(absoluteRoot, committedPaths, records, totals);
  const packageEntries = await readdir(path.resolve(absoluteRoot, "packages"), { withFileTypes: true });
  if (packageEntries.some((item) => item.isSymbolicLink())) throw new Error("Symlink workspace package entry is refused");
  for (const entry of packageEntries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const base = `packages/${entry.name}`;
    const packageInfo = await lstat(path.resolve(absoluteRoot, base));
    if (packageInfo.isSymbolicLink()) throw new Error(`Symlink workspace package is refused: ${base}`);
    let hasSource = false;
    try {
      const srcInfo = await lstat(path.resolve(absoluteRoot, `${base}/src`));
      if (srcInfo.isSymbolicLink()) throw new Error(`Symlink workspace package source is refused: ${base}/src`);
      hasSource = srcInfo.isDirectory();
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!hasSource) continue;
    await readRegularInput(absoluteRoot, `${base}/package.json`, committedPaths, records, totals);
    for (const config of (await readdir(path.resolve(absoluteRoot, base), { withFileTypes: true }))
      .filter((item) => item.isFile() && /^tsconfig[^/]*\.json$/u.test(item.name))) {
      await readRegularInput(absoluteRoot, `${base}/${config.name}`, committedPaths, records, totals);
    }
    await walkRepositoryInputs(absoluteRoot, `${base}/src`, committedPaths, records, totals);
  }
  const rootPackage = await readJson(absoluteRoot, "package.json");
  const corePackage = await readJson(absoluteRoot, "apps/eliotr-core/package.json");
  const pwaPackage = await readJson(absoluteRoot, "apps/eliotr-pwa/package.json");
  const canonicalConfig = await readJson(absoluteRoot, "apps/eliotr-core/wrangler.jsonc");
  if (canonicalConfig.name !== "eliotr-core" || canonicalConfig.main !== "src/index.ts"
    || canonicalConfig.assets?.directory !== "../eliotr-pwa/dist") {
    throw new Error("Canonical Worker entrypoint or PWA asset directory differs from the pinned build profile");
  }
  const installed = await captureInstalledState(absoluteRoot, records, totals, rootPackage, corePackage, pwaPackage);
  const inputs = [...records.values()].sort((a, b) => a.path.localeCompare(b.path));
  const body = {
    protocol: DEPLOYMENT_BUILD_INPUT_PROTOCOL,
    root: absoluteRoot,
    git_head: readGitHead(absoluteRoot),
    profile: {
      worker_name: canonicalConfig.name,
      worker_config: "apps/eliotr-core/wrangler.jsonc",
      worker_main: "apps/eliotr-core/src/index.ts",
      worker_tsconfig: "apps/eliotr-core/tsconfig.json",
      pwa_tsconfig: "apps/eliotr-pwa/tsconfig.json",
      pwa_assets: "apps/eliotr-pwa/dist",
      generated_worker_config: "apps/eliotr-core/wrangler.deploy.jsonc",
    },
    limits: { ...DEPLOYMENT_BUILD_INPUT_LIMITS, captured_files: totals.files, captured_bytes: totals.bytes },
    installed,
    inputs,
  };
  const manifest = { ...body, sha256: digest(Buffer.from(stableJson(body))) };
  return freezeDeep(manifest);
}

export async function captureDeploymentBuildInputs({ root = process.cwd() } = {}) {
  return captureManifest(root);
}

export async function pinGeneratedDeploymentConfig({ root = process.cwd(), path: configPath } = {}) {
  const absoluteRoot = pathResolveRoot(root);
  const expected = path.resolve(absoluteRoot, "apps/eliotr-core/wrangler.deploy.jsonc");
  const absoluteConfig = path.resolve(absoluteRoot, configPath ?? expected);
  if (absoluteConfig !== expected) throw new Error("Only the provisioner-generated Worker config can be pinned");
  const info = await lstat(absoluteConfig);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Generated deployment config is not a regular file");
  const bytes = await readFile(absoluteConfig);
  let config;
  try { config = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new Error(`Generated deployment config is invalid JSON: ${error.message}`, { cause: error }); }
  if (config.name !== "eliotr-core" || config.main !== "src/index.ts"
    || config.assets?.directory !== "../eliotr-pwa/dist") {
    throw new Error("Generated deployment config changes the pinned Worker entrypoint or assets directory");
  }
  return freezeDeep({ path: slash(path.relative(absoluteRoot, absoluteConfig)),
    sha256: digest(bytes), byte_length: bytes.byteLength, worker_name: config.name,
    worker_main: `apps/eliotr-core/${config.main}`,
    assets_directory: `apps/eliotr-core/${config.assets.directory}` });
}

function pathResolveRoot(root) {
  if (typeof root !== "string" || root.length === 0) throw new Error("Deployment build-input root is required");
  return path.resolve(root);
}

async function verifyConfigPin(root, pin) {
  if (!pin || pin.path !== "apps/eliotr-core/wrangler.deploy.jsonc"
    || !/^[0-9a-f]{64}$/u.test(pin.sha256) || !Number.isSafeInteger(pin.byte_length)) {
    throw new Error("Generated deployment config pin is invalid");
  }
  const absolute = path.resolve(root, pin.path);
  if (!inside(root, absolute)) throw new Error("Generated deployment config path escaped the repository");
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Generated deployment config is no longer a regular file");
  const bytes = await readFile(absolute);
  if (bytes.byteLength !== pin.byte_length || digest(bytes) !== pin.sha256) {
    throw new Error("Generated deployment config changed after its pin was recorded");
  }
}

export async function requireUnchangedDeploymentBuildInputs({ root = process.cwd(), manifest, generatedConfigPin } = {}) {
  const absoluteRoot = pathResolveRoot(root);
  validateManifest(absoluteRoot, manifest);
  const current = await captureManifest(absoluteRoot);
  if (current.sha256 !== manifest.sha256) throw new Error("Deployment build inputs changed after their initial seal");
  if (generatedConfigPin) await verifyConfigPin(absoluteRoot, generatedConfigPin);
  return true;
}

async function assertSafeRegularFile(root, absolutePath, label) {
  if (!inside(root, absolutePath)) throw new Error(`${label} escaped the repository`);
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  const actual = await realpath(absolutePath);
  if (!inside(root, actual)) throw new Error(`${label} resolves outside the repository`);
  return actual;
}

async function enumerateArtifactFiles(root, outdir) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in deployment bundle output is refused: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const actual = await assertSafeRegularFile(root, absolute, "Deployment bundle output");
        files.push({ absolute: actual, path: slash(path.relative(outdir, actual)) });
      } else throw new Error(`Unsupported deployment bundle output: ${absolute}`);
    }
  }
  await walk(outdir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > DEPLOYMENT_BUILD_INPUT_LIMITS.artifactFiles) throw new Error("Deployment bundle has too many output files");
  return files;
}

function normalizeMetaPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("Wrangler metafile contains an invalid path");
  }
  return value.replaceAll("\\", "/");
}

async function resolveMetaInput(root, manifest, inputName) {
  const normalized = normalizeMetaPath(inputName);
  const coreRoot = path.resolve(root, "apps/eliotr-core");
  const lexical = path.isAbsolute(inputName) ? path.resolve(inputName) : path.resolve(coreRoot, inputName);
  let actual;
  try { actual = await assertSafeRegularFile(root, lexical, "Wrangler metafile input"); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new Error(`Wrangler bundle imported an unsealed input: ${normalized}`, { cause: error });
    }
    throw error;
  }
  const relative = slash(path.relative(root, actual));
  const known = manifest.inputs.find((item) => item.path === relative);
  if (known) return { path: relative, byte_length: known.byte_length, sha256: known.sha256, source: known.kind };
  throw new Error(`Wrangler bundle imported an unsealed input: ${normalized}`);
}

function validateImports(imports, description, { inputMetadata = false } = {}) {
  if (!Array.isArray(imports)) throw new Error(`${description} has no valid import list`);
  for (const item of imports) {
    if (!item || typeof item.path !== "string") throw new Error(`${description} contains an invalid import`);
    // esbuild reports its bundled helper runtime as an input-only metadata edge.
    // It must never survive as an external import of the emitted Worker.
    const bundledRuntime = inputMetadata && item.path === "<runtime>"
      && item.kind === "import-statement" && item.external === true;
    if (item.external === true && !bundledRuntime && !ALLOWED_EXTERNAL_IMPORTS.has(item.path)) {
      throw new Error(`Wrangler bundle has an unsupported external import: ${item.path}`);
    }
    if (item.external !== undefined && typeof item.external !== "boolean") throw new Error(`${description} has an invalid external marker`);
  }
}

function artifactDigestBody(attestation) {
  const body = { ...attestation };
  delete body.sha256;
  return body;
}

export async function attestDeploymentBundle({ root = process.cwd(), manifest, outdir, metafilePath,
  generatedConfigPin } = {}) {
  const absoluteRoot = pathResolveRoot(root);
  validateManifest(absoluteRoot, manifest);
  await requireUnchangedDeploymentBuildInputs({ root: absoluteRoot, manifest, generatedConfigPin });
  if (!generatedConfigPin) throw new Error("Deployment bundle attestation requires the generated-config pin");
  const absoluteOutdir = path.resolve(absoluteRoot, outdir ?? "");
  const relativeOutdir = slash(path.relative(absoluteRoot, absoluteOutdir));
  if (!DEPLOYMENT_OUTDIR_PATTERN.test(relativeOutdir)) throw new Error("Wrangler output must use a unique deployment-worker UUID directory");
  const actualOutdir = await realpath(absoluteOutdir);
  if (actualOutdir !== absoluteOutdir || !inside(absoluteRoot, actualOutdir)) throw new Error("Wrangler output directory escaped its pinned path");
  const absoluteMetafile = path.resolve(absoluteRoot, metafilePath ?? path.join(relativeOutdir, "bundle-meta.json"));
  if (!inside(absoluteOutdir, absoluteMetafile)) throw new Error("Wrangler metafile must live inside its dedicated output directory");
  const actualMetaPath = await assertSafeRegularFile(absoluteRoot, absoluteMetafile, "Wrangler metafile");
  const metaBytes = await readFile(actualMetaPath);
  if (metaBytes.byteLength > DEPLOYMENT_BUILD_INPUT_LIMITS.metafileBytes) throw new Error("Wrangler metafile exceeds its byte bound");
  let metafile;
  try { metafile = JSON.parse(metaBytes.toString("utf8")); }
  catch (error) { throw new Error(`Wrangler metafile is invalid JSON: ${error.message}`, { cause: error }); }
  if (!metafile || typeof metafile.inputs !== "object" || Array.isArray(metafile.inputs)
    || typeof metafile.outputs !== "object" || Array.isArray(metafile.outputs)) {
    throw new Error("Wrangler metafile does not contain bounded input and output maps");
  }
  const inputFiles = [];
  for (const [inputName, details] of Object.entries(metafile.inputs).sort(([a], [b]) => a.localeCompare(b))) {
    if (!details || !Number.isSafeInteger(details.bytes) || details.bytes < 0) throw new Error(`Invalid byte count for Wrangler input ${inputName}`);
    validateImports(details.imports, `Wrangler input ${inputName}`, { inputMetadata: true });
    const resolved = await resolveMetaInput(absoluteRoot, manifest, inputName);
    if (details.bytes !== resolved.byte_length) throw new Error(`Wrangler input byte count changed: ${inputName}`);
    inputFiles.push({ ...resolved, metafile_path: normalizeMetaPath(inputName), imports: details.imports
      .filter((item) => item.external === true).map((item) => item.path).sort() });
  }
  if (inputFiles.length === 0) throw new Error("Wrangler metafile contains no Worker inputs");
  const entryOutputs = [];
  const declaredOutputs = new Set();
  for (const [outputName, details] of Object.entries(metafile.outputs).sort(([a], [b]) => a.localeCompare(b))) {
    if (!details || typeof details !== "object") throw new Error(`Invalid Wrangler output metadata: ${outputName}`);
    const normalized = normalizeMetaPath(outputName);
    const absolute = path.isAbsolute(outputName) ? path.resolve(outputName)
      : path.resolve(absoluteRoot, "apps/eliotr-core", outputName);
    const actual = await assertSafeRegularFile(absoluteRoot, absolute, "Wrangler metafile output");
    if (!inside(absoluteOutdir, actual)) throw new Error(`Wrangler output escaped its dedicated directory: ${outputName}`);
    declaredOutputs.add(slash(path.relative(absoluteOutdir, actual)));
    if (details.entryPoint !== undefined) entryOutputs.push({ output: actual, entry_point: details.entryPoint });
    validateImports(details.imports ?? [], `Wrangler output ${normalized}`);
  }
  if (entryOutputs.length !== 1) throw new Error("Worker deployment requires exactly one bundled entrypoint");
  const entry = entryOutputs[0];
  const canonicalMain = "apps/eliotr-core/src/index.ts";
  const entrySource = await resolveMetaInput(absoluteRoot, manifest, entry.entry_point);
  if (entrySource.path !== canonicalMain) throw new Error("Wrangler bundled an entrypoint outside the pinned Worker main");
  const inventory = await enumerateArtifactFiles(absoluteRoot, absoluteOutdir);
  const entryRelative = slash(path.relative(absoluteOutdir, entry.output));
  if (!entryRelative.endsWith(".js")) throw new Error("Bundled Worker entrypoint must be emitted JavaScript");
  const allowedInventory = new Set([entryRelative, "README.md", `${entryRelative}.map`, slash(path.relative(absoluteOutdir, actualMetaPath))]);
  for (const file of inventory) {
    if (!allowedInventory.has(file.path)) throw new Error(`Unexpected Wrangler output file: ${file.path}`);
  }
  if (!inventory.some((file) => file.path === entryRelative)) throw new Error("Wrangler entrypoint is absent from the output directory");
  for (const declared of declaredOutputs) {
    if (!inventory.some((file) => file.path === declared)) throw new Error(`Wrangler output metadata references missing file: ${declared}`);
    if (declared !== entryRelative && declared !== `${entryRelative}.map`) {
      throw new Error(`Unsupported Wrangler emitted module: ${declared}`);
    }
  }
  const files = [];
  let totalBytes = 0;
  for (const file of inventory) {
    const bytes = await readFile(file.absolute);
    totalBytes += bytes.byteLength;
    if (totalBytes > DEPLOYMENT_BUILD_INPUT_LIMITS.artifactBytes) throw new Error("Wrangler output exceeded its artifact byte bound");
    files.push({ path: file.path, byte_length: bytes.byteLength, sha256: digest(bytes),
      kind: file.path === entryRelative ? "worker-entrypoint" : file.path === `${entryRelative}.map` ? "source-map"
        : file.path === "README.md" ? "wrangler-readme" : "metafile" });
  }
  const metafileRelative = slash(path.relative(absoluteOutdir, actualMetaPath));
  const metafileRecord = files.find((item) => item.path === metafileRelative);
  if (!metafileRecord || metafileRecord.sha256 !== digest(metaBytes)) throw new Error("Wrangler metafile changed while being attested");
  const entryRecord = files.find((item) => item.path === entryRelative);
  const body = {
    protocol: "eliotr.deployment-worker-bundle.v1",
    root: absoluteRoot,
    manifest_sha256: manifest.sha256,
    generated_config: generatedConfigPin,
    outdir: relativeOutdir,
    entrypoint: path.resolve(absoluteOutdir, entryRelative),
    entrypoint_sha256: entryRecord.sha256,
    bundle_bytes: entryRecord.byte_length,
    metafile: { path: slash(path.relative(absoluteRoot, actualMetaPath)), sha256: metafileRecord.sha256,
      byte_length: metafileRecord.byte_length },
    inputs: inputFiles,
    outputs: files,
  };
  return freezeDeep({ ...body, sha256: digest(Buffer.from(stableJson(body))) });
}

export async function requireUnchangedDeploymentBundle({ root = process.cwd(), manifest, attestation } = {}) {
  if (!attestation || attestation.protocol !== "eliotr.deployment-worker-bundle.v1"
    || !/^[0-9a-f]{64}$/u.test(attestation.sha256)
    || digest(Buffer.from(stableJson(artifactDigestBody(attestation)))) !== attestation.sha256) {
    throw new Error("Deployment bundle attestation is invalid or was modified");
  }
  if (attestation.manifest_sha256 !== manifest?.sha256) throw new Error("Deployment bundle belongs to a different build-input manifest");
  const current = await attestDeploymentBundle({ root, manifest, outdir: attestation.outdir,
    metafilePath: attestation.metafile.path, generatedConfigPin: attestation.generated_config });
  if (current.sha256 !== attestation.sha256) throw new Error("Deployment bundle, inputs, metafile, or config changed after attestation");
  return true;
}
