import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureDeploymentBuildInputs, requireUnchangedDeploymentBuildInputs } from "./deployment-build-inputs.mjs";
import { inspectWebBuild, OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES, WORKER_GZIP_BUDGET_BYTES } from "./emitted-build-budget-evidence.mjs";
import { observeOwnerWebStartup, ownerWebStartupBindings } from "./deployment-owner-web-startup.mjs";
import { assertOwnerWebNativeRoutes } from "./deployment-owner-web-native.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const slash = value => value.split(path.sep).join("/");
const fail = message => { throw new Error("Owner-web build: " + message); };

/** frame-ancestors is enforced by the response header, never an HTML meta tag. */
export function normalizeInboxDocumentPolicy(html, headers) {
  const policy = "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'none'; font-src 'none'; manifest-src 'none'; worker-src 'none'";
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + policy + '">';
  const headerPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-elem 'self'; style-src-attr 'none'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'self'";
  const declarations = headers.split("\n").filter(line => /^\s+Content-Security-Policy:/iu.test(line));
  if (html.split(meta).length !== 2 || !headers.startsWith("/*\n") ||
      declarations.length !== 1 || declarations[0].trim() !== "Content-Security-Policy: " + headerPolicy ||
      /^\s+!\s*Content-Security-Policy\b/imu.test(headers)) {
    fail("inbox document/header policy delivery differs from the closed profile");
  }
  return html.replace(meta, '<meta http-equiv="Content-Security-Policy" content="' +
    policy.replace("; frame-ancestors 'none'", "") + '">');
}

async function inventory(root, prefix) {
  const records = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("symbolic output link");
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        records.push({ path: slash(path.relative(root, absolute)), byte_length: bytes.length, sha256: hash(bytes) });
      } else fail("unsupported output entry");
    }
  }
  await walk(path.resolve(root, prefix));
  return records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Build once, measure the same emitted graph, and retain an online legacy rollback. */
export async function buildOwnerWebDeploymentGraph({ root, environment, execute }) {
  root = path.resolve(root);
  const manifest = await captureDeploymentBuildInputs({ root, assetProfile: "owner-web" });
  if (manifest.sha256 !== environment.ELIOTR_OWNER_WEB_CAPTURED_INPUTS_SHA256) fail("captured source seal changed");
  const config = path.resolve(root, "apps/eliotr-core/wrangler.deploy.jsonc");
  const configBytes = await readFile(config);
  if (hash(configBytes) !== environment.ELIOTR_OWNER_WEB_DEPLOY_CONFIG_SHA256) fail("generated config pin changed");
  const buildEnvironment = { ...environment };
  delete buildEnvironment.CLOUDFLARE_ENV;
  delete buildEnvironment.VITE_ELIOTR_FIXTURE;
  const node = (script, args, cwd = root) => execute(process.execPath, [path.resolve(root, script), ...args], cwd, buildEnvironment);
  const startedAt = new Date().toISOString();

  node("apps/eliotr-pwa/scripts/build-agent-inbox.mjs", []);
  node("apps/eliotr-pwa/node_modules/astro/bin/astro.mjs", ["build"], path.resolve(root, "apps/eliotr-pwa"));
  const pwa = path.resolve(root, "apps/eliotr-pwa/dist");
  const webPublic = path.resolve(root, "apps/eliotr-web/public");
  // The rollback cannot reinstall the historical cache/fetch worker.
  await cp(path.join(webPublic, "sw.js"), path.join(pwa, "sw.js"));
  await cp(path.join(webPublic, "_headers"), path.join(pwa, "_headers"));
  const inboxDocument = path.join(pwa, "agent-inbox/index.html");
  await writeFile(inboxDocument, normalizeInboxDocumentPolicy(await readFile(inboxDocument, "utf8"),
    (await readFile(path.join(pwa, "_headers"), "utf8")).replaceAll("\r\n", "\n")));
  const legacyOutputs = await inventory(root, "apps/eliotr-pwa/dist");
  const rollbackDirectory = path.resolve(root, ".eliotr-state", "owner-web-rollback-" + randomUUID());
  await mkdir(rollbackDirectory);
  await cp(pwa, path.join(rollbackDirectory, "client"), { recursive: true });
  const legacySource = await readFile(path.resolve(root, "apps/eliotr-pwa/src/main.ts"), "utf8");
  if (/serviceWorker\s*\.\s*register\s*\(/u.test(legacySource)) fail("legacy rollback still registers a worker");
  await writeFile(path.join(rollbackDirectory, "receipt.json"), JSON.stringify({
    protocol: "eliotr.retirement-safe-legacy-rollback.v1", source_head: manifest.git_head,
    state: "BUILT_LOCAL_ONLY", no_registration: true, outputs: legacyOutputs,
    tombstone_sha256: hash(await readFile(path.join(pwa, "sw.js"))),
    deployment: "Requires the same guarded prepared Worker graph and runtime/schema checks",
  }, null, 2) + "\n");

  node("node_modules/vite/bin/vite.js", ["build", "--config", "vite.integrated.config.ts"], path.resolve(root, "apps/eliotr-web"));
  const client = path.resolve(root, "apps/eliotr-web/dist/client");
  await cp(path.join(pwa, "agent-inbox"), path.join(client, "agent-inbox"), { recursive: true });
  const workerPrefix = "apps/eliotr-web/dist/eliotr_core";
  const observedBytes = await readFile(path.resolve(root, workerPrefix, "owner-worker-graph.json"));
  const observed = JSON.parse(observedBytes);
  if (observed.producer?.hook !== "generateBundle" || observed.environment !== "eliotr_core" ||
      !Array.isArray(observed.modules) || !Array.isArray(observed.chunks)) fail("missing observed compiler graph");
  // Real rendered source inputs must belong to the captured source/runtime inventory.
  const observedSourceInputs = new Set();
  const virtualInputs = [];
  for (const id of new Set(observed.chunks.flatMap(chunk => chunk.renderedModules.map(module => module.id)))) {
    if (id.includes("\0") || id.startsWith("virtual:") || id.startsWith("cloudflare:") ||
        id === "builtin:esm-external-require-path") { virtualInputs.push(id); continue; }
    const filename = id.split("?")[0];
    if (!path.isAbsolute(filename)) fail("unclassified compiler module " + id);
    const actual = await realpath(filename);
    const relative = slash(path.relative(root, actual));
    if (relative.startsWith("../") || !manifest.inputs.some(input => input.path === relative)) fail("unsealed rendered source " + relative);
    observedSourceInputs.add(relative);
  }
  if (!observedSourceInputs.has("apps/eliotr-core/src/index.ts")) fail("canonical Core entry absent from compiler graph");
  const outputs = [...await inventory(root, "apps/eliotr-web/dist/client"), ...await inventory(root, workerPrefix)]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const file of outputs.filter(file => file.path.startsWith("apps/eliotr-web/dist/client/") && /\.js$/u.test(file.path))) {
    const body = await readFile(path.resolve(root, file.path), "utf8");
    if (/FixtureWorkspace|synthetic-owner|Orbit Synthetic/u.test(body)) fail("development fixture leaked into emitted client");
  }
  const startup = await observeOwnerWebStartup({ root, environment: buildEnvironment,
    ...ownerWebStartupBindings({ sourceCommit: manifest.git_head, inputManifestSha256: manifest.sha256,
      generatedConfigSha256: hash(configBytes), outputs }) });
  const webBudget = await inspectWebBuild(root, startedAt, { startupObservations: startup.startupObservations });
  if (webBudget.status !== "PASS") fail("client emitted budget failed: " + webBudget.issues.join(", "));
  const native = spawnSync(process.execPath, [path.resolve(root, "node_modules/wrangler/bin/wrangler.js"),
    "deploy", "--dry-run", "--no-bundle", "--config", path.resolve(root, workerPrefix, "wrangler.json"),
    "--outdir", path.resolve(root, ".eliotr-state/owner-web-native-" + randomUUID())], {
    cwd: root, env: buildEnvironment, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000, windowsHide: true,
  });
  const log = (native.stdout ?? "") + "\n" + (native.stderr ?? "");
  await writeFile(path.resolve(root, "apps/eliotr-web/dist/owner-web-native.log"), log);
  const match = /Total Upload:\s*([\d.]+)\s*(B|KiB|MiB)\s*\/\s*gzip:\s*([\d.]+)\s*(B|KiB|MiB)/u.exec(log);
  const multipliers = { B: 1, KiB: 1024, MiB: 1024 * 1024 };
  if (native.error || native.status !== 0 || !match || !/--dry-run:\s*exiting now\./u.test(log)) fail("native prepared Worker dry-run failed");
  const workerGzipUpperBytes = Math.ceil((Number(match[3]) + 0.005) * multipliers[match[4]]);
  if (workerGzipUpperBytes > WORKER_GZIP_BUDGET_BYTES) fail("Worker gzip exceeds emitted budget");
  const nativeRoutes = await assertOwnerWebNativeRoutes({ root, environment: buildEnvironment });
  await requireUnchangedDeploymentBuildInputs({ root, manifest, assetProfile: "owner-web" });
  const payload = {
    protocol: "eliotr.owner-web-build-inputs.v1", asset_profile: "owner-web",
    nonce: environment.ELIOTR_OWNER_WEB_BUILD_NONCE, input_manifest_sha256: manifest.sha256,
    generated_config_sha256: hash(configBytes), inputs: [...manifest.inputs.map(({ path, byte_length, sha256 }) => ({ path, byte_length, sha256 })),
      { path: "apps/eliotr-core/wrangler.deploy.jsonc", byte_length: configBytes.length, sha256: hash(configBytes) }],
    outputs, observed_graph: { path: workerPrefix + "/owner-worker-graph.json", sha256: hash(observedBytes),
      rendered_source_inputs: [...observedSourceInputs].sort(), virtual_inputs: virtualInputs.sort(), scope: "Compiler module observation; virtual module internals are not source-byte attestation" },
    budget: { state: "PASS", worker_gzip_upper_bytes: workerGzipUpperBytes, worker_limit: WORKER_GZIP_BUDGET_BYTES,
      client: webBudget, client_limit: OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES, native_log_sha256: hash(Buffer.from(log)) },
    rollback: slash(path.relative(root, rollbackDirectory)),
    startup: { evidence: startup.evidence, scope: startup.scope },
    native_routes: nativeRoutes,
    signature_scope: "Local custody of the observed inventory; not independent compiler attestation",
  };
  const signature = createHmac("sha256", environment.ELIOTR_OWNER_WEB_INPUT_MANIFEST_KEY).update(JSON.stringify(payload)).digest("hex");
  await writeFile(path.resolve(root, "apps/eliotr-web/dist/owner-web-inputs.json"), JSON.stringify({ payload, signature }) + "\n");
  console.log(JSON.stringify({ owner_web_build: "PASS", worker_gzip_upper_bytes: workerGzipUpperBytes,
    client_gzip_bytes: webBudget.metric.gzipBytes, rollback: payload.rollback, compiler_graph: payload.observed_graph.path }));
}
