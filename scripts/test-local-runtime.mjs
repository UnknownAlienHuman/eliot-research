import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { devArguments, localConfig, localEnvironment, localPaths, prepareLocal, ROOT, signalLocalProcess, wranglerArgs } from "./lib/local-launch.mjs";

const canonical = JSON.parse(await readFile(resolve(ROOT, "apps/eliotr-core/wrangler.jsonc"), "utf8"));
const injected = { ...canonical, account_id: "forbidden-account", routes: [{ pattern: "production.example" }],
  services: [{ binding: "REMOTE", service: "production" }], vars: { API_TOKEN: "secret" },
  d1_databases: canonical.d1_databases.map((db) => ({ ...db, remote: true, database_id: "forbidden-id" })),
  r2_buckets: canonical.r2_buckets.map((bucket) => ({ ...bucket, remote: true })) };
const config = localConfig(injected);
assert.equal(config.main, resolve(ROOT, "apps/eliotr-core/src/index.ts"));
assert.equal(config.assets.directory, resolve(ROOT, "apps/eliotr-pwa/dist"));
for (const key of ["account_id", "services", "routes", "triggers", "ai_search_namespaces", "env"]) assert.equal(config[key], undefined);
assert.ok(!JSON.stringify(config).includes("forbidden"));
assert.ok(!JSON.stringify(config).includes("secret"));
assert.ok(!JSON.stringify(config).includes('"remote":true'));
assert.ok(config.queues.producers.every((producer) => producer.queue.endsWith("-local")));
assert.ok(config.d1_databases.every((db) => db.database_name.endsWith("-local")));
assert.throws(() => localConfig({ ...canonical, main: "another-worker.ts" }));
assert.throws(() => localConfig({ ...canonical, d1_databases: [canonical.d1_databases[0], canonical.d1_databases[0]] }));
const env = localEnvironment({ PATH: "path", SystemRoot: "windows", CLOUDFLARE_API_TOKEN: "secret",
  CF_API_KEY: "secret", WRANGLER_ENV: "production", ELIOTR_CONFIRM_LIVE_DEPLOY: "1", ACCESS_AUDIENCE: "production" });
assert.equal(env.PATH, "path"); assert.equal(env.SystemRoot, "windows");
assert.ok(!JSON.stringify(env).includes("secret")); assert.ok(!JSON.stringify(env).includes("production"));
assert.equal(env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
const paths = localPaths(resolve(tmpdir(), "eliotr local # % 日本語"));
assert.ok(devArguments(paths).includes("127.0.0.1"));
assert.ok(devArguments(paths).includes("--local"));
assert.ok(!devArguments(paths).includes("--remote"));
assert.ok(wranglerArgs(paths, ["d1", "migrations", "apply", "CORE_DB"]).includes(paths.persist));
for (const port of [0, -1, 65536, NaN, 1.5, "8787"]) assert.throws(() => devArguments(paths, port));

const directory = await mkdtemp(resolve(tmpdir(), "eliotr-prepare-"));
try {
  const vars = resolve(directory, ".dev.vars");
  await writeFile(vars, 'ACCESS_AUDIENCE="retain-local-settings"\n');
  const calls = [];
  const prepared = await prepareLocal({ stateDirectory: directory, log: () => {}, execute: (args, options) => calls.push({ args, options }) });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.cwd, resolve(ROOT, "apps/eliotr-pwa"));
  assert.deepEqual(calls.slice(1).map(({ args }) => args.slice(1, 5)), [
    ["d1", "migrations", "apply", "CORE_DB"], ["d1", "migrations", "apply", "SEARCH_DB"]]);
  for (const { args } of calls.slice(1)) assert.ok(args.includes(prepared.persist) && args.includes("--local") && !args.includes("--remote"));
  assert.equal(await readFile(vars, "utf8"), 'ACCESS_AUDIENCE="retain-local-settings"\n');
  const first = await readFile(prepared.config, "utf8");
  await prepareLocal({ stateDirectory: directory, log: () => {}, execute: () => {} });
  assert.equal(await readFile(prepared.config, "utf8"), first);
  const failures = [];
  await assert.rejects(prepareLocal({ stateDirectory: directory, log: () => {}, execute: (args) => {
    failures.push(args); throw new Error("injected build failure");
  } }));
  assert.equal(failures.length, 1, "failed PWA build must not start migrations");
  await writeFile(vars, 'AI_GATEWAY_REASONING_URL="https://production.example"\n');
  await assert.rejects(prepareLocal({ stateDirectory: directory, log: () => {},
    execute: () => assert.fail("unsafe local settings cannot start a subprocess") }), /provider\/deployment/u);
  await writeFile(vars, 'ACCESS_AUDIENCE="one"\nACCESS_AUDIENCE="two"\n');
  await assert.rejects(prepareLocal({ stateDirectory: directory, log: () => {}, execute: () => assert.fail() }));
  const fresh = resolve(directory, "fresh"); await mkdir(fresh);
  await prepareLocal({ stateDirectory: fresh, log: () => {}, execute: () => {} });
  assert.equal(await readFile(resolve(fresh, ".dev.vars"), "utf8"), "");
} finally { await rm(directory, { recursive: true, force: true }); }

const child = { pid: 12345, exitCode: null, signalCode: null,
  kill: () => assert.fail("Windows must terminate the owned tree, not only its wrapper") };
const signals = [];
signalLocalProcess(child, "SIGTERM", { platform: "win32", execute: (command, args, options) => {
  signals.push({ command, args, options }); return { status: 0 };
} });
assert.deepEqual(signals[0].args, ["/PID", "12345", "/T", "/F"]);
assert.equal(signals[0].command, "taskkill.exe");
assert.equal(signals[0].options.shell, false);
assert.equal(signals[0].options.timeout, 5000);
for (const fields of [{ exitCode: 0 }, { signalCode: "SIGTERM" }, { pid: undefined }, { pid: -1 }]) {
  signalLocalProcess({ ...child, ...fields }, "SIGTERM", { platform: "win32", execute: () => assert.fail("Never target an exited or invalid PID") });
}
assert.throws(() => signalLocalProcess(child, "SIGTERM", { platform: "win32", execute: () => ({ status: 1 }) }), /shutdown failed/u);
let delivered;
signalLocalProcess({ ...child, kill: (signal) => { delivered = signal; } }, "SIGTERM", { platform: "linux" });
assert.equal(delivered, "SIGTERM");
console.log("Owned-process shutdown: PASS (exact Windows PID/tree, no exited PID reuse, POSIX signal)");

console.log("Local runtime isolation, complete migration command ordering and idempotent preparation: PASS");
