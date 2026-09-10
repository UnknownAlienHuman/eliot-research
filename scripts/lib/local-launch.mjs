import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROMIUM_UNSAFE_PORTS } from "./local-owner-bridge.mjs";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CORE = resolve(ROOT, "apps/eliotr-core");
const require = createRequire(import.meta.url);
export const WRANGLER = resolve(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
const pwaRequire = createRequire(resolve(ROOT, "apps/eliotr-pwa/package.json"));
const ASTRO = resolve(dirname(pwaRequire.resolve("astro/package.json")), "bin/astro.mjs");

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

export function executeLocal(args, { cwd = ROOT, env = localEnvironment(), capture = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, env, shell: false, timeout: 180_000,
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) {
    const raw = capture ? `${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
    const diagnostic = capture ? classifyLocalFailure(result.stdout ?? "", result.stderr ?? "") : "";
    const redacted = raw.replaceAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED_JWT]")
      .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED_KEY]").slice(0, 1000);
    const suffix = diagnostic ? ` [${diagnostic}]` : "";
    const error = new Error(`Local command failed (${result.error?.code ?? result.status ?? "unknown"}); no remote deploy was requested${suffix}${redacted.trim() ? ` :: ${redacted.trim()}` : ""}`);
    error.cause = { code: result.error?.code ?? result.status ?? "unknown", diagnostic,
      stdout: String(result.stdout ?? "").slice(0, 4096), stderr: String(result.stderr ?? "").slice(0, 4096) };
    throw error;
  }
  return result.stdout ?? "";
}

function localCommandFailure({ error, status, signal, stdout = "", stderr = "", capture, diagnosticOverride } = {}) {
  const raw = capture ? `${stdout}\n${stderr}` : "";
  const diagnostic = diagnosticOverride ?? (capture ? classifyLocalFailure(stdout, stderr) : "");
  const code = error?.code ?? (signal ? `signal:${signal}` : status ?? "unknown");
  const redacted = raw.replaceAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[REDACTED_JWT]")
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED_KEY]").slice(0, 1000);
  const suffix = diagnostic ? ` [${diagnostic}]` : "";
  const failure = new Error(`Local command failed (${code}); no remote deploy was requested${suffix}${redacted.trim() ? ` :: ${redacted.trim()}` : ""}`);
  failure.cause = { code, diagnostic, stdout: String(stdout).slice(0, 4096), stderr: String(stderr).slice(0, 4096) };
  return failure;
}

function waitForAsyncChildClose(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("close", done);
  });
}

async function terminateAsyncChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* Already exited. */ }
        finish();
      }, 5000);
      let killer;
      try {
        killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          shell: false, windowsHide: true, stdio: "ignore",
        });
      } catch {
        try { child.kill(); } catch { /* Already exited. */ }
        finish();
        return;
      }
      killer.once("error", () => {
        try { child.kill(); } catch { /* Already exited. */ }
        finish();
      });
      killer.once("close", finish);
    });
    await waitForAsyncChildClose(child);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* Already exited. */ }
      await waitForAsyncChildClose(child);
    }
    return;
  }
  try { child.kill("SIGTERM"); } catch { /* Already exited. */ }
  await waitForAsyncChildClose(child);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    await waitForAsyncChildClose(child);
  }
}

/** Async counterpart for long local CLI work. The sync API above remains for existing callers. */
export function executeLocalAsync(args, { cwd = ROOT, env = localEnvironment(), capture = false, timeoutMs = 180_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000) {
    throw new RangeError("Local command timeout must be a positive integer no greater than 180000ms");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd, env, shell: false, windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    const stdoutChunks = []; const stderrChunks = [];
    let totalBytes = 0; let overflow = false; let timedOut = false; let spawnError;
    let terminated = false;
    const append = (target, chunk) => {
      if (!capture || overflow) return target;
      if (totalBytes + chunk.byteLength > 8 * 1024 * 1024) {
        overflow = true;
        requestTermination();
        return;
      }
      target.push(chunk);
      totalBytes += chunk.byteLength;
    };
    const requestTermination = () => {
      if (terminated) return;
      terminated = true;
      void terminateAsyncChild(child).catch(() => {});
    };
    if (capture) {
      child.stdout.on("data", (chunk) => { append(stdoutChunks, chunk); });
      child.stderr.on("data", (chunk) => { append(stderrChunks, chunk); });
    }
    child.once("error", (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null || terminated) return;
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (spawnError || status !== 0 || overflow || timedOut) {
        reject(localCommandFailure({ error: spawnError ?? (overflow ? { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } : timedOut ? { code: "ETIMEDOUT" } : undefined),
          status, signal, stdout, stderr, capture, diagnosticOverride: overflow || timedOut ? "" : undefined }));
        return;
      }
      resolve(capture ? stdout : "");
    });
  });
}

const TRANSIENT_D1_PATTERNS = [
  /SQLITE_BUSY/i, /SQLITE_LOCKED/i, /database is locked/i, /database is busy/i,
  /database table is locked/i, /database schema is locked/i, /resource busy or locked/i,
  /miniflare.*lock/i, /lock.*miniflare/i, /cannot start a transaction within a transaction/i,
  /\bEBUSY\b/, /\bEPERM\b/, /\bETIMEDOUT\b/, /\bEAGAIN\b/,
];
const FAIL_CLOSED_D1_PATTERNS = [
  /LOCAL_NAMESPACE_CONFLICT/, /LOCAL_NAMESPACE_SETTLEMENT_UNCERTAIN/, /LOCAL_NAMESPACE_INPUT_INVALID/,
  /LOCAL_NAMESPACE_PROFILE_UNSUPPORTED/, /LOCAL_NAMESPACE_EXISTING_LINEAGE/, /LOCAL_NAMESPACE_OWNER_REQUIRED/,
  /LOCAL_NAMESPACE_READBACK_INVALID/, /LOCAL_POLICY_CONFLICT/, /LOCAL_POLICY_SETTLEMENT_UNCERTAIN/,
  /no such table/i, /no such column/i, /syntax error/i,
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
  const text = `${error?.message ?? error}\n${error?.cause?.stdout ?? ""}\n${error?.cause?.stderr ?? ""}`;
  if (FAIL_CLOSED_D1_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT_D1_PATTERNS.some((pattern) => pattern.test(text));
}
function sleepSync(milliseconds) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
  catch { /* Bounded backoff only. */ }
}
export function executeLocalD1WithRetry(args, { execute = executeLocal, attempts = 6, deadlineMs = 15000, delayMs = 250 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return execute(args, { capture: true }); }
    catch (error) {
      lastError = error;
      if (!isTransientLocalD1Error(error) || attempt >= attempts || Date.now() + delayMs > deadline) throw error;
      sleepSync(delayMs);
    }
  }
  throw lastError;
}

export async function executeLocalD1WithRetryAsync(args, { execute = executeLocalAsync, attempts = 6, deadlineMs = 15000, delayMs = 250 } = {}) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      if (lastError) throw lastError;
      throw new Error("Local D1 command deadline expired");
    }
    try { return await execute(args, { capture: true, timeoutMs: Math.min(180_000, remainingMs) }); }
    catch (error) {
      lastError = error;
      if (!isTransientLocalD1Error(error) || attempt >= attempts || Date.now() + delayMs > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export async function resolveLocalBrowserExecutable({ environment = process.env } = {}) {
  const override = environment.ELIOTR_BROWSER_EXECUTABLE;
  if (typeof override === "string" && override.length > 0) { await access(override); return override; }
  const candidates = process.platform === "win32"
    ? [resolve(environment.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
      resolve(environment["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
      ...(environment.LOCALAPPDATA ? [resolve(environment.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")] : []),
      resolve(environment.PROGRAMFILES ?? "C:\\Program Files", "Chromium/Application/chrome.exe")]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* Try next fixed path. */ } }
  throw new Error("Chromium/Chrome executable not found at OS standard paths; set ELIOTR_BROWSER_EXECUTABLE to the installed executable");
}

const HARNESS_MARKER = ".eliotr-owner-e2e.json";
export async function writeHarnessMarker(directory, runId, kind) {
  const payload = JSON.stringify({ protocol: "eliotr.owner-e2e.marker.v1", runId, pid: process.pid, kind, createdAt: new Date().toISOString() });
  await writeFile(resolve(directory, HARNESS_MARKER), `${payload}\n`, { mode: 0o600 });
  return payload;
}
function resolvedTempRoot() { return resolve(tmpdir()); }
export async function assertHarnessOwned(directory, runId) {
  const resolved = resolve(directory); const root = resolvedTempRoot();
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error("Harness-owned path escapes the OS temp root");
  const marker = JSON.parse(await readFile(resolve(resolved, HARNESS_MARKER), "utf8"));
  if (marker?.protocol !== "eliotr.owner-e2e.marker.v1" || marker?.runId !== runId) throw new Error("Harness-owned path marker mismatch; refusing to delete");
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
  execute([ASTRO, "build"], { cwd: resolve(ROOT, "apps/eliotr-pwa") });
  for (const binding of ["CORE_DB", "SEARCH_DB"]) {
    execute(wranglerArgs(paths, ["d1", "migrations", "apply", binding]));
  }
  log("Local PWA and both D1 migration streams prepared. Providers are disabled; Access authentication is unchanged.");
  return { ...paths, generation: config.vars.DEPLOYMENT_GENERATION, config_sha256: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
}

export function devArguments(paths, port = 8787, { testScheduled = false } = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Local port must be an integer in [1024, 65535]");
  if (CHROMIUM_UNSAFE_PORTS.has(port)) throw new Error(`Local port ${port} is Chromium-unsafe (ERR_UNSAFE_PORT); refusing to bind`);
  if (typeof testScheduled !== "boolean") throw new Error("testScheduled must be a boolean");
  return wranglerArgs(paths, ["dev", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", "0", "--show-interactive-dev-session", "false",
    ...(testScheduled ? ["--test-scheduled"] : [])]);
}
