import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { runOwnerWebNativeDryRun, verifyOwnerWebNativeDryRun } from "./lib/emitted-owner-native-dry-run.mjs";

const temporary = mkdtempSync(resolve(tmpdir(), "eliotr-native-preflight-"));
assert.equal(dirname(temporary), resolve(tmpdir()));
const roots = [];
const cases = [
  ["generated build hook", config => { config.build = { command: "forbidden" }; }],
  ["source build hook", (_config, source) => { source.build = { command: "forbidden" }; }],
  ["test source build hook", (_config, source) => { source.env = { test: { build: { command: "forbidden" } } }; }],
  ["remote binding", config => { config.d1_databases[0].remote = true; }],
  ["production identity", config => { config.name = "eliotr-core"; }],
  ["foreign assets", config => { config.assets.directory = "../../outside"; }],
  ["foreign config", config => { config.configPath = resolve(temporary, "outside.json"); }],
  ["foreign user config", config => { config.userConfigPath = resolve(temporary, "outside.json"); }],
  ["unknown hooks", config => { config.hooks = {}; }],
  ["unqualified resource", config => { config.d1_databases[0].database_name = "production"; }],
];

function write(root, path, content) {
  const filename = resolve(root, path);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content);
}

function fixture(label) {
  const root = resolve(temporary, String(roots.length));
  roots.push(root);
  const sourcePath = resolve(root, "apps/eliotr-core/wrangler.jsonc");
  const config = { configPath: sourcePath, targetEnvironment: "test", name: "eliotr-core-test", main: "index.js",
    assets: { directory: "../client", binding: "ASSETS", not_found_handling: "single-page-application",
      run_worker_first: ["/healthz", "/mcp", "/agent-inbox", "/agent-inbox/*", "/agents", "/agents/*", "/api/*", "/federation/*", "/oauth/*"] },
    vars: { DEPLOYMENT_GENERATION: "test-generation", AI_GATEWAY_REASONING_URL: "https://example.invalid/reasoning",
      AI_GATEWAY_RETRIEVAL_URL: "https://example.invalid/retrieval" },
    durable_objects: { bindings: [{ name: "RESEARCH_SESSION", class_name: "ResearchSession" }] },
    d1_databases: [{ binding: "CORE_DB", database_name: "eliotr-core-test" }], r2_buckets: [], workflows: [] };
  const marker = resolve(root, "CHILD_RAN");
  // This executable is a tripwire only. Every case must refuse before launching it.
  write(root, "node_modules/wrangler/package.json", JSON.stringify({ name: "wrangler", version: "4.143.1" }));
  write(root, "node_modules/wrangler/bin/wrangler.js", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "forbidden");`);
  write(root, "node_modules/wrangler/wrangler-dist/cli.js", "// preflight tripwire fixture\n");
  write(root, "apps/eliotr-web/dist/eliotr_core/index.js", "export default {};\n");
  write(root, "apps/eliotr-web/dist/client/index.html", "<!doctype html>\n");
  return { root, source: {}, config, marker, label };
}

async function refused(value) {
  write(value.root, "apps/eliotr-core/wrangler.jsonc", JSON.stringify(value.source));
  write(value.root, "apps/eliotr-web/dist/eliotr_core/wrangler.json", JSON.stringify(value.config));
  const result = await runOwnerWebNativeDryRun(value.root);
  assert.equal(result.status, null, value.label);
  assert.equal(result.error?.code, "NATIVE_PREFLIGHT_REJECTED", value.label);
  assert.equal(result.token, null, value.label);
  assert.equal(result.output, "", value.label);
  assert.throws(() => readFileSync(value.marker), { code: "ENOENT" }, "Rejected config must not execute a child");
}

try {
  for (const [label, mutate] of cases) {
    const value = fixture(label);
    mutate(value.config, value.source);
    await refused(value);
  }
  const linked = fixture("linked Worker module directory");
  write(linked.root, "outside/extra.js", "export const outside = true;\n");
  symlinkSync(resolve(linked.root, "outside"), resolve(linked.root, "apps/eliotr-web/dist/eliotr_core/linked"),
    process.platform === "win32" ? "junction" : "dir");
  await refused(linked);
  const output = fixture("linked output directory");
  mkdirSync(resolve(output.root, "outside"));
  mkdirSync(resolve(output.root, ".eliotr-state"));
  symlinkSync(resolve(output.root, "outside"), resolve(output.root, ".eliotr-state/frontend-owner-dry-run"),
    process.platform === "win32" ? "junction" : "dir");
  await refused(output);
  const unsupported = fixture("unsupported Wrangler version");
  write(unsupported.root, "node_modules/wrangler/package.json", JSON.stringify({ name: "wrangler", version: "5.0.0" }));
  await refused(unsupported);
  for (const token of [undefined, {}, Object.freeze({}), JSON.parse("{}")]) {
    assert.equal(verifyOwnerWebNativeDryRun(token, temporary, [], "wrangler 4.143.1"), false);
  }
  console.log("Native preflight: PASS (13 refusals before child; no JSON capability; no Wrangler/native/build/provider call).");
} finally {
  // Exact freshly created temporary checkout; all child tripwires remained unrun.
  rmSync(temporary, { recursive: true, force: false });
}
