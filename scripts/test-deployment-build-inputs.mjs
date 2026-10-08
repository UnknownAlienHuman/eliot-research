import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attestDeploymentBundle,
  captureDeploymentBuildInputs,
  pinGeneratedDeploymentConfig,
  requireUnchangedDeploymentBuildInputs,
  requireUnchangedDeploymentBundle,
} from "./lib/deployment-build-inputs.mjs";

const FIXTURE_ROOT = path.resolve(os.tmpdir());
const FIXTURE_PREFIX = "eliotr-build-inputs-";
const SCRIPT_ENTRYPOINTS = [
  "scripts/check-boundaries.mjs", "scripts/check-budgets.mjs", "scripts/check-launch-code.mjs",
  "scripts/deploy-cloudflare.mjs", "scripts/generate-cloudflare-types.mjs", "scripts/provision-ai-gateways.mjs", "scripts/provision-ai-search.mjs",
  "scripts/lib/deployment-build-evidence.mjs",
  "scripts/provision-cloudflare-access.mjs", "scripts/provision-cloudflare-core.mjs",
  "scripts/test-boundary-negative.mjs",
];

async function put(root, relative, value) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value);
  return target;
}

async function fixture() {
  const root = await mkdtemp(path.join(FIXTURE_ROOT, FIXTURE_PREFIX));
  const files = {
    ".npmrc": "engine-strict=true\n",
    "eslint.config.mjs": "export default [];\n",
    "package.json": JSON.stringify({ packageManager: "pnpm@11.23.0", devDependencies: { wrangler: "4.143.1" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "tsconfig.base.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "tsconfig.json": JSON.stringify({ files: [] }),
    "apps/eliotr-core/package.json": JSON.stringify({ name: "@eliotr/core", dependencies: { zod: "4.4.3" } }),
    "apps/eliotr-core/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src/**/*.ts"] }),
    "apps/eliotr-core/wrangler.jsonc": JSON.stringify({ name: "eliotr-core", main: "src/index.ts", assets: { directory: "../eliotr-pwa/dist" } }),
    "apps/eliotr-core/src/index.ts": "export default { fetch() { return new Response('ok'); } };\n",
    "apps/eliotr-core/src/worker-configuration.d.ts": "// generated; excluded\n",
    "apps/eliotr-pwa/astro.config.mjs": "export default {};\n",
    "apps/eliotr-pwa/package.json": JSON.stringify({ name: "@eliotr/pwa", dependencies: { "markdown-it": "15.0.2" } }),
    "apps/eliotr-pwa/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src/**/*.ts"] }),
    "apps/eliotr-pwa/vite.config.ts": "export default {};\n",
    "apps/eliotr-pwa/src/main.ts": "export const ready = true;\n",
    "apps/eliotr-pwa/scripts/build-agent-inbox.mjs": "// fixture build input\n",
    "apps/eliotr-pwa/public/manifest.webmanifest": "{}\n",
    "apps/eliotr-pwa/public/sw.js": "self.addEventListener('fetch', () => {});\n",
    "apps/eliotr-pwa/public/agent-inbox/app.js": "// generated; excluded\n",
    "apps/eliotr-pwa/public/agent-inbox/app.css": "/* generated; excluded */\n",
    "packages/contracts/package.json": JSON.stringify({ name: "@eliotr/contracts", exports: { ".": "./src/index.ts" } }),
    "packages/contracts/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
    "packages/contracts/src/index.ts": "export type Contract = string;\n",
    "apps/eliotr-core/node_modules/zod/package.json": JSON.stringify({ name: "zod", version: "4.4.3" }),
    "apps/eliotr-core/node_modules/zod/index.js": "exports.z = true;\n",
    "apps/eliotr-pwa/node_modules/markdown-it/package.json": JSON.stringify({ name: "markdown-it", version: "15.0.2", dependencies: { entities: "1.2.0" } }),
    "apps/eliotr-pwa/node_modules/markdown-it/index.js": "module.exports = function MarkdownIt() {};\n",
    "apps/eliotr-pwa/node_modules/markdown-it/node_modules/entities/package.json": JSON.stringify({ name: "entities", version: "1.2.0" }),
    "apps/eliotr-pwa/node_modules/markdown-it/node_modules/entities/index.js": "exports.decode = (x) => x;\n",
    "node_modules/wrangler/package.json": JSON.stringify({ name: "wrangler", version: "4.143.1" }),
    "node_modules/.pnpm/lock.yaml": "lockfileVersion: '9.0'\n",
    "node_modules/.modules.yaml": "packageManager: pnpm@11.23.0\n",
  };
  for (const [relative, value] of Object.entries(files)) await put(root, relative, value);
  for (const relative of SCRIPT_ENTRYPOINTS) await put(root, relative, "// fixture deploy/gate script\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  return root;
}

async function removeFixture(root) {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== FIXTURE_ROOT || !path.basename(absolute).startsWith(FIXTURE_PREFIX)) {
    throw new Error("Refusing to remove a fixture directory outside its task-specific OS temp prefix");
  }
  await rm(absolute, { recursive: true, force: true });
}

async function withFixture(run) {
  const root = await fixture();
  try { await run(root); }
  finally { await removeFixture(root); }
}

async function generatedConfig(root) {
  return put(root, "apps/eliotr-core/wrangler.deploy.jsonc",
    JSON.stringify({ name: "eliotr-core", main: "src/index.ts", assets: { directory: "../eliotr-pwa/dist" }, vars: { DEPLOYMENT_GENERATION: "candidate" } }));
}

function outputDirectory(root) {
  return path.join(root, ".eliotr-state", "deployment-worker-12345678-1234-4234-8234-123456789abc");
}

async function emitBundle(root) {
  const outdir = outputDirectory(root);
  const entry = path.join(outdir, "index.js");
  const metafilePath = path.join(outdir, "bundle-meta.json");
  await put(root, ".eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc/index.js", "export default { fetch() {} };\n");
  await put(root, ".eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc/index.js.map", "{}\n");
  await put(root, ".eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc/README.md", "fixture output\n");
  const meta = {
    inputs: { "src/index.ts": { bytes: Buffer.byteLength(await readFile(path.join(root, "apps/eliotr-core/src/index.ts"))), imports: [] } },
    outputs: {
      "../../.eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc/index.js": {
        bytes: Buffer.byteLength(await readFile(entry)), entryPoint: "src/index.ts", imports: [],
      },
      "../../.eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc/index.js.map": { bytes: 3, imports: [] },
    },
  };
  await writeFile(metafilePath, JSON.stringify(meta));
  return { outdir, metafilePath };
}

test("captures exact source and runtime inputs while excluding generated source outputs", async () => {
  await withFixture(async (root) => {
    const manifest = await captureDeploymentBuildInputs({ root });
    const paths = new Set(manifest.inputs.map((item) => item.path));
    assert.ok(paths.has("apps/eliotr-core/src/index.ts"));
    assert.ok(paths.has("apps/eliotr-pwa/public/sw.js"));
    assert.ok(paths.has("apps/eliotr-pwa/scripts/build-agent-inbox.mjs"));
    assert.ok(paths.has("apps/eliotr-pwa/node_modules/markdown-it/node_modules/entities/index.js"));
    assert.ok(paths.has("apps/eliotr-core/node_modules/zod/index.js"));
    assert.ok(!paths.has("apps/eliotr-core/src/worker-configuration.d.ts"));
    assert.ok(!paths.has("apps/eliotr-pwa/public/agent-inbox/app.js"));
    assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.inputs));
    assert.equal(manifest.sha256.length, 64);
    await assert.doesNotReject(() => requireUnchangedDeploymentBuildInputs({ root, manifest }));
    await writeFile(path.join(root, "apps/eliotr-core/src/index.ts"), "export default { fetch() { return new Response('drift'); } };\n");
    await assert.rejects(() => requireUnchangedDeploymentBuildInputs({ root, manifest }), /changed after their initial seal/u);
  });
});

test("rejects a stale installed Wrangler against the exact workspace pin", async () => {
  await withFixture(async (root) => {
    await put(root, "node_modules/wrangler/package.json", JSON.stringify({ name: "wrangler", version: "4.127.1" }));
    await assert.rejects(
      () => captureDeploymentBuildInputs({ root }),
      /requires the exact installed wrangler@4\.143\.1/u,
    );
  });
});

test("rejects ignored untracked source and transitive deploy-script imports", async () => {
  await withFixture(async (root) => {
    await put(root, ".gitignore", "apps/eliotr-core/src/ignored.ts\nscripts/lib/ignored.mjs\n");
    await put(root, "apps/eliotr-core/src/ignored.ts", "export {};\n");
    await assert.rejects(() => captureDeploymentBuildInputs({ root }), /Untracked deployment build input is refused: apps\/eliotr-core\/src\/ignored\.ts/u);
  });
  await withFixture(async (root) => {
    await writeFile(path.join(root, "apps/eliotr-core/src/worker-configuration.d.ts"), "// excluded generated file\n");
    await put(root, ".gitignore", "scripts/lib/ignored.mjs\n");
    await put(root, "scripts/deploy-cloudflare.mjs", "import './lib/ignored.mjs';\n");
    await put(root, "scripts/lib/ignored.mjs", "export const changed = true;\n");
    await assert.rejects(() => captureDeploymentBuildInputs({ root }), /Untracked deployment build input is refused: scripts\/lib\/ignored\.mjs/u);
  });
});

test("pins only the explicit generated config and catches later mutation", async () => {
  await withFixture(async (root) => {
    const manifest = await captureDeploymentBuildInputs({ root });
    const configPath = await generatedConfig(root);
    const pin = await pinGeneratedDeploymentConfig({ root, path: configPath });
    assert.equal(pin.path, "apps/eliotr-core/wrangler.deploy.jsonc");
    await assert.doesNotReject(() => requireUnchangedDeploymentBuildInputs({ root, manifest, generatedConfigPin: pin }));
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n`);
    await assert.rejects(() => requireUnchangedDeploymentBuildInputs({ root, manifest, generatedConfigPin: pin }), /changed after its pin/u);
    await assert.rejects(() => pinGeneratedDeploymentConfig({ root, path: "apps/eliotr-core/wrangler.jsonc" }), /Only the provisioner-generated/u);
  });
});

test("attests the exact Worker input graph and emitted outputs, then detects any change", async () => {
  await withFixture(async (root) => {
    const manifest = await captureDeploymentBuildInputs({ root });
    await generatedConfig(root);
    const pin = await pinGeneratedDeploymentConfig({ root });
    const { outdir, metafilePath } = await emitBundle(root);
    const attestation = await attestDeploymentBundle({ root, manifest, outdir, metafilePath, generatedConfigPin: pin });
    assert.equal(attestation.manifest_sha256, manifest.sha256);
    assert.equal(attestation.entrypoint, path.join(outdir, "index.js"));
    assert.equal(attestation.bundle_bytes, Buffer.byteLength(await readFile(attestation.entrypoint)));
    assert.equal(attestation.outputs.find((item) => item.path === "README.md").kind, "wrangler-readme");
    assert.equal(attestation.outputs.find((item) => item.path === "index.js.map").kind, "source-map");
    await assert.doesNotReject(() => requireUnchangedDeploymentBundle({ root, manifest, attestation }));
    await writeFile(attestation.entrypoint, "changed bundle\n");
    await assert.rejects(() => requireUnchangedDeploymentBundle({ root, manifest, attestation }), /changed after attestation/u);
  });
});

test("accepts esbuild's bundled input runtime marker but rejects it in emitted imports", async () => {
  await withFixture(async (root) => {
    const manifest = await captureDeploymentBuildInputs({ root });
    await generatedConfig(root);
    const pin = await pinGeneratedDeploymentConfig({ root });
    const bundle = await emitBundle(root);
    const meta = JSON.parse(await readFile(bundle.metafilePath, "utf8"));
    const runtime = { path: "<runtime>", kind: "import-statement", external: true };
    meta.inputs["src/index.ts"].imports = [runtime];
    await writeFile(bundle.metafilePath, JSON.stringify(meta));
    await assert.doesNotReject(() => attestDeploymentBundle({ root, manifest, ...bundle, generatedConfigPin: pin }));
    const output = Object.values(meta.outputs).find((item) => item.entryPoint);
    output.imports = [runtime];
    await writeFile(bundle.metafilePath, JSON.stringify(meta));
    await assert.rejects(() => attestDeploymentBundle({ root, manifest, ...bundle, generatedConfigPin: pin }), /unsupported external import/u);
    output.imports = [];
    meta.inputs["src/index.ts"].imports = [{ ...runtime, kind: "dynamic-import" }];
    await writeFile(bundle.metafilePath, JSON.stringify(meta));
    await assert.rejects(() => attestDeploymentBundle({ root, manifest, ...bundle, generatedConfigPin: pin }), /unsupported external import/u);
  });
});

test("fails closed on an unsealed metafile input, unsupported external, or extra output", async () => {
  await withFixture(async (root) => {
    const manifest = await captureDeploymentBuildInputs({ root });
    await generatedConfig(root);
    const pin = await pinGeneratedDeploymentConfig({ root });
    const bundle = await emitBundle(root);
    const meta = JSON.parse(await readFile(bundle.metafilePath, "utf8"));
    meta.inputs["node_modules/unsealed/index.js"] = { bytes: 1, imports: [] };
    await writeFile(bundle.metafilePath, JSON.stringify(meta));
    await assert.rejects(() => attestDeploymentBundle({ root, manifest, ...bundle, generatedConfigPin: pin }), /unsealed input/u);
  });
  await withFixture(async (root) => {
    const manifest = await captureDeploymentBuildInputs({ root });
    await generatedConfig(root);
    const pin = await pinGeneratedDeploymentConfig({ root });
    const bundle = await emitBundle(root);
    const meta = JSON.parse(await readFile(bundle.metafilePath, "utf8"));
    meta.inputs["src/index.ts"].imports = [{ path: "cloudflare:test", external: true }];
    await writeFile(bundle.metafilePath, JSON.stringify(meta));
    await assert.rejects(() => attestDeploymentBundle({ root, manifest, ...bundle, generatedConfigPin: pin }), /unsupported external import/u);
  });
  await withFixture(async (root) => {
    const manifest = await captureDeploymentBuildInputs({ root });
    await generatedConfig(root);
    const pin = await pinGeneratedDeploymentConfig({ root });
    const bundle = await emitBundle(root);
    await put(root, ".eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc/extra.bin", "unexpected");
    await assert.rejects(() => attestDeploymentBundle({ root, manifest, ...bundle, generatedConfigPin: pin }), /Unexpected Wrangler output file/u);
  });
});

test("refuses repository input symlink escape", async (t) => {
  await withFixture(async (root) => {
    const outside = path.join(root, "outside.ts");
    await writeFile(outside, "export {};\n");
    const link = path.join(root, "apps/eliotr-core/src/escape.ts");
    try { await symlink(outside, link); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`symlink creation is unavailable: ${error.code}`);
      throw error;
    }
    await assert.rejects(() => captureDeploymentBuildInputs({ root }), /Symlink in deployment build inputs/u);
  });
});
