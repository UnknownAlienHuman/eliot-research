import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = resolve(root, "apps/eliotr-core");

/** Local bindings only. Provider access and real Access authentication are never bypassed. */
export function localConfiguration(canonical) {
  if (canonical?.name !== "eliotr-core" || canonical.main !== "src/index.ts" ||
      canonical.d1_databases?.length !== 2 || canonical.r2_buckets?.length !== 2) throw new Error("Invalid canonical Worker configuration");
  const config = structuredClone(canonical);
  for (const key of ["env", "routes", "route", "account_id", "ai", "ai_search_namespaces", "services", "triggers", "dispatch_namespaces"]) delete config[key];
  config.workers_dev = false; config.preview_urls = false;
  config.vars = { ...config.vars, ENVIRONMENT: "development", DEPLOYMENT_GENERATION: "local-development",
    AI_GATEWAY_REASONING_URL: "https://example.invalid/reasoning-disabled",
    AI_GATEWAY_RETRIEVAL_URL: "https://example.invalid/retrieval-disabled" };
  config.d1_databases = config.d1_databases.map(({ binding, database_name, migrations_dir }) => ({ binding, database_name, migrations_dir }));
  config.r2_buckets = config.r2_buckets.map(({ binding, bucket_name }) => ({ binding, bucket_name }));
  config.durable_objects.bindings = config.durable_objects.bindings.map(({ name, class_name }) => ({ name, class_name }));
  config.dev = { ip: "127.0.0.1", port: 8787, local_protocol: "http" };
  return config;
}
export function localCommands({ dev = false } = {}) {
  const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
  const persist = resolve(root, ".eliotr-state/local");
  const configuration = ["--config", "wrangler.local.jsonc", "--persist-to", persist];
  return [
    { cwd: resolve(root, "apps/eliotr-pwa"), args: [resolve(root, "node_modules/vite/bin/vite.js"), "build"] },
    ...["CORE_DB", "SEARCH_DB"].map((binding) => ({ cwd: core,
      args: [wrangler, "d1", "migrations", "apply", binding, "--local", ...configuration] })),
    ...(dev ? [{ cwd: core, args: [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", "8787", ...configuration] }] : []),
  ];
}
export async function prepareLocalRuntime({ dev = false } = {}) {
  const config = localConfiguration(JSON.parse(await readFile(resolve(core, "wrangler.jsonc"), "utf8")));
  await mkdir(resolve(root, ".eliotr-state/local"), { recursive: true });
  await writeFile(resolve(core, "wrangler.local.jsonc"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: dev ? "false" : "true" };
  // Do not inherit an environment selector, a token or a deployment confirmation into local preparation.
  for (const name of ["CLOUDFLARE_ENV", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID",
    "ELIOTR_CONFIRM_LIVE_DEPLOY"]) delete env[name];
  for (const command of localCommands({ dev })) {
    const result = spawnSync(process.execPath, command.args, { cwd: command.cwd, env, stdio: "inherit", shell: false });
    if (result.error || result.status !== 0) throw new Error(`Local ${command.args[1]} failed (exit ${result.status ?? "unknown"})`);
  }
  if (!dev) console.log("Local PWA and both D1 schemas prepared. No remote provisioning or auth bypass. Use local:dev to start the Worker.");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--prepare", "--dev"].includes(args[0])) throw new Error("Use --prepare or --dev; arbitrary Wrangler flags are not accepted");
  await prepareLocalRuntime({ dev: args[0] === "--dev" }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
