import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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

export function executeLocal(args, { cwd = ROOT, env = localEnvironment(), capture = false } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, env, shell: false, timeout: 180_000,
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) {
    // Do not reflect subprocess output: a user-supplied .dev.vars may contain credentials.
    throw new Error(`Local command failed (${result.error?.code ?? result.status ?? "unknown"}); no remote deploy was requested`);
  }
  return result.stdout ?? "";
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
