import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CORE = resolve(ROOT, "apps/eliotr-core");
const require = createRequire(import.meta.url);
export const WRANGLER = resolve(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
const VITE = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");

export function localEnvironment(environment = process.env) {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(?:CLOUDFLARE|CF_|WRANGLER|ELIOTR_|ACCESS_|AI_GATEWAY_|MCP_|GOOGLE_)/iu.test(key)));
  return { ...env, CI: "true", WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" };
}

export function localConfig(canonical, root = ROOT) {
  if (canonical.name !== "eliotr-core" || canonical.main !== "src/index.ts" ||
      !canonical.assets || !Array.isArray(canonical.d1_databases) ||
      canonical.d1_databases.length !== 2 || canonical.r2_buckets?.length !== 2) {
    throw new Error("Unsupported canonical Worker configuration; local profile must be reviewed");
  }
  const core = resolve(root, "apps/eliotr-core");
  const databases = ["CORE_DB", "SEARCH_DB"].map((binding) => {
    const matches = canonical.d1_databases.filter((db) => db.binding === binding);
    if (matches.length !== 1) throw new Error("Ambiguous local D1 binding");
    const db = matches[0];
    return { binding, database_name: `${db.database_name}-local`,
      migrations_dir: resolve(core, db.migrations_dir) };
  });
  // Construct an allowlisted profile: account IDs, services, remote bindings, routes,
  // provider tokens and scheduled triggers never propagate from the deployment config.
  return {
    name: "eliotr-core-local", main: resolve(core, canonical.main),
    compatibility_date: canonical.compatibility_date,
    ...(canonical.compatibility_flags ? { compatibility_flags: canonical.compatibility_flags } : {}),
    workers_dev: false, preview_urls: false, minify: true,
    assets: { ...canonical.assets, directory: resolve(core, canonical.assets.directory) },
    vars: { ENVIRONMENT: "development", DEPLOYMENT_GENERATION: "local-development",
      ACCESS_TEAM_DOMAIN: "https://replace-me.cloudflareaccess.com", ACCESS_AUDIENCE: "replace-me",
      ACCESS_SERVICE_PRINCIPALS: "", MCP_HOSTNAME: "mcp.local.invalid",
      MCP_ACCESS_TEAM_DOMAIN: "https://replace-me.cloudflareaccess.com", MCP_ACCESS_AUDIENCE: "replace-me",
      MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "replace-me.access", GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
      AI_GATEWAY_REASONING_URL: "https://example.invalid/local-disabled",
      AI_GATEWAY_RETRIEVAL_URL: "https://example.invalid/local-disabled" },
    d1_databases: databases,
    r2_buckets: canonical.r2_buckets.map(({ binding, bucket_name }) => ({ binding, bucket_name: `${bucket_name}-local` })),
    durable_objects: canonical.durable_objects, exports: canonical.exports,
    workflows: canonical.workflows?.map(({ binding, name, class_name }) => ({ binding, name: `${name}-local`, class_name })),
    queues: { producers: canonical.queues.producers.map(({ binding, queue }) => ({ binding, queue: `${queue}-local` })),
      consumers: canonical.queues.consumers.map(({ queue, dead_letter_queue, ...options }) => ({
        ...options, queue: `${queue}-local`, dead_letter_queue: `${dead_letter_queue}-local` })) },
    analytics_engine_datasets: canonical.analytics_engine_datasets.map(({ binding, dataset }) => ({ binding, dataset: `${dataset}_local` })),
  };
}

export async function validateLocalVars(path) {
  if ((await stat(path)).size > 8192) throw new Error("Local Access settings exceed 8192 bytes");
  const allowed = new Set(["ACCESS_TEAM_DOMAIN", "ACCESS_AUDIENCE", "ACCESS_SERVICE_PRINCIPALS"]);
  const seen = new Set();
  for (const raw of (await readFile(path, "utf8")).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_]+)="([^"\\\r\n]*)"$/u.exec(line);
    if (!match || !allowed.has(match[1]) || seen.has(match[1]) || /[\u0000-\u001f\u007f]/u.test(match[2])) {
      throw new Error('Local .dev.vars permits only unique ACCESS_* settings in KEY="value" form; provider/deployment settings are forbidden');
    }
    seen.add(match[1]);
  }
}

export function localPaths(stateDirectory = resolve(ROOT, ".eliotr-state/local")) {
  const directory = resolve(stateDirectory);
  return { directory, config: resolve(directory, "wrangler.json"), persist: resolve(directory, "state") };
}

export function wranglerArgs(paths, command) {
  return [WRANGLER, ...command, "--config", paths.config, "--persist-to", paths.persist, "--local"];
}

function redactLocalDiagnostic(text) {
  return text
    .replaceAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED_JWT]")
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED_KEY]")
    .replaceAll(/"d"\s*:\s*"[A-Za-z0-9_-]{10,}"/gu, '"d":"[REDACTED]"')
    .slice(0, 1000);
}

export function executeLocal(args, { cwd = ROOT, env = localEnvironment(), capture = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, env, shell: false, timeout: 180_000,
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) {
    // Bounded redacted snippet only: never reflect full output because a
    // user-supplied .dev.vars may contain credentials. JWT/key material is
    // redacted above; the snippet exists so transient SQLite locks can be
    // classified instead of hidden behind a bare status code.
    const raw = capture ? `${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    const diagnostic = capture ? classifyLocalFailure(result.stdout ?? "", result.stderr ?? "") : "";
    const snippet = capture && raw.trim() ? ` :: ${redactLocalDiagnostic(raw.trim())}` : "";
    const suffix = diagnostic ? ` [${diagnostic}]` : "";
    const error = new Error(`Local command failed (${result.error?.code ?? result.status ?? "unknown"}); no remote deploy was requested${suffix}${snippet}`);
    error.cause = { code: result.error?.code ?? result.status ?? "unknown", diagnostic,
      stdout: redactLocalDiagnostic(result.stdout ?? ""), stderr: redactLocalDiagnostic(result.stderr ?? "") };
    throw error;
  }
  return result.stdout ?? "";
}

// Documented transient SQLite/process locks only. Schema, authority, data and
// config errors are fail-closed and must never retry with a new generation.
// D1 CLI shares SQLite files with a running `wrangler dev` Worker (Miniflare)
// on the same persist dir; on Windows an overlapping CLI can also surface as
// EBUSY/EPERM on the SQLite/WAL files. Bare EBUSY/EPERM is retryable here
// because this classifier is only consulted for D1 CLI failures.
const TRANSIENT_D1_PATTERNS = [
  /SQLITE_BUSY/i,
  /SQLITE_LOCKED/i,
  /database is locked/i,
  /database is busy/i,
  /database table is locked/i,
  /database schema is locked/i,
  /resource busy or locked/i,
  /miniflare.*lock/i,
  /lock.*miniflare/i,
  /cannot start a transaction within a transaction/i,
  /\bEBUSY\b/,
  /\bEPERM\b/,
  /\bETIMEDOUT\b/,
  /\bEAGAIN\b/,
];

const FAIL_CLOSED_D1_PATTERNS = [
  /LOCAL_NAMESPACE_CONFLICT/,
  /LOCAL_NAMESPACE_SETTLEMENT_UNCERTAIN/,
  /LOCAL_NAMESPACE_INPUT_INVALID/,
  /LOCAL_NAMESPACE_PROFILE_UNSUPPORTED/,
  /LOCAL_NAMESPACE_EXISTING_LINEAGE/,
  /LOCAL_NAMESPACE_OWNER_REQUIRED/,
  /LOCAL_NAMESPACE_READBACK_INVALID/,
  /LOCAL_POLICY_CONFLICT/,
  /LOCAL_POLICY_SETTLEMENT_UNCERTAIN/,
  /no such table/i,
  /no such column/i,
  /syntax error/i,
];

function classifyLocalFailure(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.slice(0, 4096);
  if (FAIL_CLOSED_D1_PATTERNS.some((pattern) => pattern.test(text))) return "FAIL_CLOSED";
  if (TRANSIENT_D1_PATTERNS.some((pattern) => pattern.test(text))) return "TRANSIENT_D1_LOCK";
  return "";
}

export function isTransientLocalD1Error(error) {
  if (!error) return false;
  const diagnostic = error?.cause?.diagnostic;
  if (diagnostic === "TRANSIENT_D1_LOCK") return true;
  if (diagnostic === "FAIL_CLOSED") return false;
  const text = `${error?.message ?? error}\n${error?.cause?.code ?? ""}\n${error?.cause?.stdout ?? ""}\n${error?.cause?.stderr ?? ""}\n${error?.stderr ?? ""}\n${error?.stdout ?? ""}`;
  if (FAIL_CLOSED_D1_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT_D1_PATTERNS.some((pattern) => pattern.test(text));
}

function sleepSync(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch { /* Bounded backoff only; ignore timer failure. */ }
}

// Bounded retry for documented transient D1 locks only. Strict deadline,
// fixed backoff, no new generation, fail-closed for schema/authority/data errors.
export function executeLocalD1WithRetry(args, { execute = executeLocal, attempts = 6, deadlineMs = 15000, delayMs = 250 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return execute(args, { capture: true });
    } catch (error) {
      lastError = error;
      if (!isTransientLocalD1Error(error)) throw error;
      if (attempt >= attempts || Date.now() + delayMs > deadline) throw error;
      sleepSync(delayMs);
    }
  }
  throw lastError;
}

// Deterministic Chromium/Chrome discovery. Explicit ELIOTR_BROWSER_EXECUTABLE
// wins; otherwise only fixed OS standard paths are probed (no registry,
// network or PATH probing, no arbitrary executables). Throws clearly when absent.
export async function resolveLocalBrowserExecutable({ environment = process.env } = {}) {
  const override = environment.ELIOTR_BROWSER_EXECUTABLE;
  if (typeof override === "string" && override.length > 0) {
    await access(override);
    return override;
  }
  const candidates = [];
  if (process.platform === "win32") {
    const localAppData = environment.LOCALAPPDATA ?? "";
    const programFiles = environment.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = environment["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    candidates.push(
      resolve(programFiles, "Google/Chrome/Application/chrome.exe"),
      resolve(programFilesX86, "Google/Chrome/Application/chrome.exe"),
      ...(localAppData ? [resolve(localAppData, "Google/Chrome/Application/chrome.exe")] : []),
      resolve(programFiles, "Chromium/Application/chrome.exe"),
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  }
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next fixed path. */ }
  }
  throw new Error("Chromium/Chrome executable not found at OS standard paths; set ELIOTR_BROWSER_EXECUTABLE to the installed executable");
}

const HARNESS_MARKER = ".eliotr-owner-e2e.json";

export async function writeHarnessMarker(directory, runId, kind) {
  const payload = JSON.stringify({ protocol: "eliotr.owner-e2e.marker.v1", runId, pid: process.pid, kind,
    createdAt: new Date().toISOString() });
  await writeFile(resolve(directory, HARNESS_MARKER), `${payload}\n`, { mode: 0o600 });
  return payload;
}

function resolvedTempRoot() {
  return resolve(tmpdir());
}

export async function assertHarnessOwned(directory, runId) {
  const resolved = resolve(directory);
  const root = resolvedTempRoot();
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error("Harness-owned path escapes the OS temp root");
  }
  const raw = await readFile(resolve(resolved, HARNESS_MARKER), "utf8");
  const marker = JSON.parse(raw);
  if (marker?.protocol !== "eliotr.owner-e2e.marker.v1" || marker?.runId !== runId) {
    throw new Error("Harness-owned path marker mismatch; refusing to delete");
  }
  return resolved;
}

export async function removeHarnessOwned(directory, runId) {
  const resolved = await assertHarnessOwned(directory, runId);
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Stop only this launcher-owned process tree, never all Node/Workerd processes. */
export function signalLocalProcess(child, signal = "SIGTERM", {
  platform = process.platform, execute = spawnSync,
} = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== "win32") { child.kill(signal); return; }
  // Windows kill(SIGTERM) terminates only the wrapper; its CLI/Workerd descendants
  // otherwise retain SQLite/observability locks after the wrapper's close event.
  const result = execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false, windowsHide: true, stdio: "ignore", timeout: 5000,
  });
  if (result.error || result.status !== 0) throw new Error("Local Worker process-tree shutdown failed");
}

export async function prepareLocal({ stateDirectory, execute = executeLocal, log = console.log } = {}) {
  const paths = localPaths(stateDirectory);
  const bytes = await readFile(resolve(CORE, "wrangler.jsonc"), "utf8");
  const config = localConfig(JSON.parse(bytes));
  config.vars.DEPLOYMENT_GENERATION = `local-${createHash("sha256").update(paths.directory).digest("hex").slice(0, 16)}`;
  await mkdir(paths.directory, { recursive: true });
  // An empty local-only vars file prevents accidentally loading a parent .env.
  // Existing local Access settings are never overwritten.
  try { await writeFile(resolve(paths.directory, ".dev.vars"), "", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  await validateLocalVars(resolve(paths.directory, ".dev.vars"));
  const temporary = `${paths.config}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.config);
  execute([VITE, "build"], { cwd: resolve(ROOT, "apps/eliotr-pwa") });
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    execute(wranglerArgs(paths, ["d1", "migrations", "apply", binding]));
  }
  log("Local PWA and both D1 migration streams prepared. Providers are disabled; Access authentication is unchanged.");
  return { ...paths, generation: config.vars.DEPLOYMENT_GENERATION, config_sha256: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
}

export function devArguments(paths, port = 8787) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Local port must be an integer in [1024, 65535]");
  return wranglerArgs(paths, ["dev", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", "0", "--show-interactive-dev-session", "false"]);
}
