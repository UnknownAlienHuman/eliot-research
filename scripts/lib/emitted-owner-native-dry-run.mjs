import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

const measurements = new WeakMap();
const workerPrefix = "apps/eliotr-web/dist/eliotr_core";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const modulePath = name => /\.(?:m?js|wasm)$/u.test(name);
const routes = ["/healthz", "/mcp", "/agent-inbox", "/agent-inbox/*", "/agents", "/agents/*", "/api/*", "/federation/*", "/oauth/*"];
const samePath = (left, right) => process.platform === "win32"
  ? left.toLowerCase() === right.toLowerCase() : left === right;

function regularPath(root, filename, directory = false) {
  const absolute = resolve(root, filename), local = relative(root, absolute);
  if (!local || local.split(sep)[0] === ".." || isAbsolute(local)) throw new Error("Native artifact escapes its root");
  let cursor = root;
  for (const part of local.split(sep)) {
    cursor = resolve(cursor, part);
    const entry = lstatSync(cursor);
    if (entry.isSymbolicLink() || (cursor !== absolute && !entry.isDirectory())) {
      throw new Error("Native artifact traverses a non-directory or symbolic link");
    }
  }
  const entry = lstatSync(absolute);
  if (directory ? !entry.isDirectory() : !entry.isFile()) throw new Error("Native artifact is not a regular entry");
  if (!samePath(realpathSync(absolute), absolute)) throw new Error("Native artifact resolves outside its declared path");
  return absolute;
}

function hasRemote(value) {
  return value !== null && typeof value === "object" && Object.entries(value).some(([key, child]) =>
    (key === "remote" && child !== false && child !== undefined) || hasRemote(child));
}

function rejectBuildHooks(config) {
  if ((config.build && Object.keys(config.build).length) || config.hooks !== undefined) {
    throw new Error("Custom build hooks are outside the native dry-run");
  }
}

function checkOutputDirectory(root) {
  const parts = [".eliotr-state", "frontend-owner-dry-run"];
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try { regularPath(root, cursor, true); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
  }
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const filename = resolve(directory, name), entry = lstatSync(filename);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(regularPath(root, filename, true));
      else regularPath(root, filename);
    }
  };
  walk(cursor);
}

function readJsonConfig(root, filename) {
  const bytes = readFileSync(regularPath(root, filename));
  try { return JSON.parse(bytes.toString("utf8")); }
  catch {
    const ts = createRequire(resolve(root, "package.json"))("typescript");
    const parsed = ts.parseConfigFileTextToJson(filename, bytes.toString("utf8"));
    if (parsed.error) throw new Error("Native source configuration cannot be parsed");
    return parsed.config;
  }
}

function readCandidate(repositoryRoot) {
  const root = resolve(repositoryRoot);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() ||
      !samePath(realpathSync(root), root)) throw new Error("Native root is not a canonical directory");
  const manifest = [];
  const walk = prefix => {
    const directory = regularPath(root, prefix, true);
    for (const name of readdirSync(directory).sort()) {
      const filename = prefix + "/" + name;
      const entry = lstatSync(resolve(root, filename));
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(filename);
      else {
        const bytes = readFileSync(regularPath(root, filename));
        manifest.push({ path: filename, sha256: digest(bytes), rawBytes: bytes.length });
      }
    }
  };
  walk(workerPrefix);
  const configPath = workerPrefix + "/wrangler.json";
  const config = readJsonConfig(root, configPath);
  rejectBuildHooks(config);
  const sourceConfig = readJsonConfig(root, "apps/eliotr-core/wrangler.jsonc");
  rejectBuildHooks(sourceConfig);
  rejectBuildHooks(sourceConfig.env?.test ?? {});
  if (hasRemote(config) || config.targetEnvironment !== "test" || config.name !== "eliotr-core-test" ||
      config.main !== "index.js" || typeof config.configPath !== "string" ||
      !samePath(resolve(config.configPath), resolve(root, "apps/eliotr-core/wrangler.jsonc")) ||
      (config.userConfigPath !== undefined && !samePath(resolve(config.userConfigPath), resolve(root, "apps/eliotr-core/wrangler.jsonc"))) ||
      config.assets?.directory !== "../client" || config.assets?.binding !== "ASSETS" ||
      config.assets?.not_found_handling !== "single-page-application" ||
      !isDeepStrictEqual(config.assets?.run_worker_first, routes) ||
      config.vars?.DEPLOYMENT_GENERATION !== "test-generation" ||
      config.vars?.AI_GATEWAY_REASONING_URL !== "https://example.invalid/reasoning" ||
      config.vars?.AI_GATEWAY_RETRIEVAL_URL !== "https://example.invalid/retrieval") {
    throw new Error("Native candidate changes the existing test/config/assets identity");
  }
  regularPath(root, "apps/eliotr-web/dist/client", true);
  checkOutputDirectory(root);
  for (const key of ["d1_databases", "r2_buckets", "workflows"]) for (const binding of config[key] ?? []) {
    const name = binding.database_name ?? binding.bucket_name ?? binding.name;
    if (typeof name !== "string" || !name.endsWith("-test") || binding.database_id) {
      throw new Error("Native candidate has an unqualified resource binding");
    }
  }
  if (!isDeepStrictEqual(config.durable_objects?.bindings, [{ name: "RESEARCH_SESSION", class_name: "ResearchSession" }])) {
    throw new Error("Native candidate changes the ResearchSession binding");
  }
  const artifacts = manifest.filter(row => modulePath(row.path) || row.path === configPath);
  if (!artifacts.some(row => row.path === workerPrefix + "/index.js")) throw new Error("Native Worker entry is missing");
  const toolPaths = ["node_modules/wrangler/package.json", "node_modules/wrangler/bin/wrangler.js", "node_modules/wrangler/wrangler-dist/cli.js"];
  const tools = toolPaths.map(filename => ({ path: filename, sha256: digest(readFileSync(resolve(root, filename))) }));
  const version = JSON.parse(readFileSync(resolve(root, toolPaths[0]), "utf8"));
  if (version.name !== "wrangler" || !/^4\.\d+\.\d+$/u.test(version.version)) throw new Error("Installed Wrangler is unsupported");
  return { root, manifest, artifacts, tools, version: version.version,
    sourceConfigSha256: digest(readFileSync(regularPath(root, "apps/eliotr-core/wrangler.jsonc"))) };
}

function reportOnly(output) {
  const clean = output.replace(/\u001B\[[0-9;]*m/gu, ""), lines = [];
  for (const match of clean.matchAll(/wrangler\s+(\d+\.\d+\.\d+)(?:[^\d]|$)/giu)) lines.push("wrangler " + match[1]);
  for (const match of clean.matchAll(/Total Upload:\s*([0-9]+(?:\.[0-9]+)?\s*(?:B|KiB|MiB|GiB))\s*\/\s*gzip:\s*([0-9]+(?:\.[0-9]+)?\s*(?:B|KiB|MiB|GiB))/giu)) {
    lines.push("Total Upload: " + match[1] + " / gzip: " + match[2]);
  }
  for (const match of clean.matchAll(/Read\s+(\d+)\s+files from the assets directory/giu)) lines.push("Read " + match[1] + " files from the assets directory");
  if (/--dry-run:\s*exiting now\./iu.test(clean)) lines.push("--dry-run: exiting now.");
  return lines.join("\n");
}

export async function runOwnerWebNativeDryRun(repositoryRoot) {
  let before;
  try { before = readCandidate(repositoryRoot); }
  catch { return { status: null, signal: null, error: { code: "NATIVE_PREFLIGHT_REJECTED" }, output: "", token: null }; }
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  for (const key of ["CLOUDFLARE_ENV", "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "NODE_OPTIONS", "NODE_PATH"]) delete env[key];
  const args = [resolve(before.root, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--dry-run", "--no-bundle",
    "--config", resolve(before.root, workerPrefix, "wrangler.json"), "--outdir", resolve(before.root, ".eliotr-state/frontend-owner-dry-run")];
  const result = await new Promise(done => {
    execFile(process.execPath, args, { cwd: before.root, env, encoding: "utf8", timeout: 120000,
      maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      done({ status: error ? typeof error.code === "number" ? error.code : null : 0,
        signal: error?.signal ?? null, error: error ? { code: error.code ?? "NATIVE_CHILD_FAILED" } : null,
        output: reportOnly((stdout ?? "") + "\n" + (stderr ?? "")), token: null });
    });
  });
  if (result.status !== 0 || result.error || result.signal) return result;
  try {
    const after = readCandidate(repositoryRoot);
    if (!isDeepStrictEqual(before, after)) throw new Error("Native input bytes changed during the child");
    const { parseWranglerBundleReport } = await import("./emitted-build-budget-evidence.mjs");
    const report = parseWranglerBundleReport(result.output);
    const total = before.artifacts.filter(row => modulePath(row.path)).reduce((sum, row) => sum + row.rawBytes, 0);
    if (report.status !== "MEASURED" || report.version !== before.version ||
        Math.abs(report.raw.bytes - total) > report.raw.precisionBytes) throw new Error("Native report does not bind the complete module payload");
    const token = Object.freeze({});
    measurements.set(token, { candidate: before, output: result.output });
    result.token = token;
  } catch { result.error = { code: "NATIVE_MEASUREMENT_REJECTED" }; }
  return result;
}

export function verifyOwnerWebNativeDryRun(token, repositoryRoot, artifactFiles, output) {
  const admitted = token && measurements.get(token);
  if (!admitted || output !== admitted.output || !Array.isArray(artifactFiles)) return false;
  try {
    const current = readCandidate(repositoryRoot);
    const artifacts = artifactFiles.filter(row => modulePath(row?.path ?? "") || row?.path === workerPrefix + "/wrangler.json")
      .map(row => ({ path: row.path, sha256: row.sha256, rawBytes: row.rawBytes })).sort((a, b) => a.path.localeCompare(b.path));
    const expected = [...current.artifacts].sort((a, b) => a.path.localeCompare(b.path));
    return isDeepStrictEqual(current, admitted.candidate) && isDeepStrictEqual(artifacts, expected);
  } catch { return false; }
}
