import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { persistDeploymentBuildEvidence } from "./lib/deployment-build-evidence.mjs";
import { pinGeneratedDeploymentConfig } from "./lib/deployment-build-inputs.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const CORE_ASSETS = JSON.parse(await readFile(new URL("../apps/eliotr-core/wrangler.jsonc", import.meta.url), "utf8")).assets;
const temporaryRoot = resolve(tmpdir());
const temporaryPrefix = "eliot-deployment-build-evidence-";
const temporaryDirectory = await mkdtemp(join(temporaryRoot, temporaryPrefix));
const resolvedTemporaryDirectory = resolve(temporaryDirectory);
if (resolvedTemporaryDirectory === temporaryRoot || dirname(resolvedTemporaryDirectory) !== temporaryRoot ||
    !basename(resolvedTemporaryDirectory).startsWith(temporaryPrefix)) {
  throw new Error("Refusing to use an unexpected build-evidence fixture path");
}

try {
  const root = resolvedTemporaryDirectory;
  await mkdir(join(root, ".eliotr-state"));
  await mkdir(join(root, ".eliotr-state", "deployment-worker-12345678-1234-4234-8234-123456789abc"));
  await mkdir(join(root, "apps", "eliotr-core"), { recursive: true });
  const generatedConfigPath = join(root, "apps", "eliotr-core", "wrangler.deploy.jsonc");
  const generatedConfigBytes = Buffer.from(`${JSON.stringify({ name: "eliotr-core", main: "src/index.ts", assets: CORE_ASSETS })}\n`);
  await writeFile(generatedConfigPath, generatedConfigBytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(root, "apps", "eliotr-core", "wrangler.jsonc"), generatedConfigBytes, { flag: "wx", mode: 0o600 });
  const generatedConfigPin = await pinGeneratedDeploymentConfig({ root, path: generatedConfigPath });
  const manifestBody = {
    protocol: "eliotr.deployment-build-inputs.v1",
    root,
    git_head: "a".repeat(40),
    profile: { worker_main: "apps/eliotr-core/src/index.ts", generated_worker_config: generatedConfigPin.path },
    inputs: [],
  };
  const manifest = { ...manifestBody, sha256: digest(JSON.stringify(manifestBody)) };
  const outdir = ".eliotr-state/deployment-worker-12345678-1234-4234-8234-123456789abc";
  const entrypoint = join(root, outdir, "index.js");
  const entrypointBytes = Buffer.from("export default {};\n");
  await writeFile(entrypoint, entrypointBytes, { flag: "wx", mode: 0o600 });
  const entrypointSha256 = digest(entrypointBytes);
  const bundleBody = {
    protocol: "eliotr.deployment-worker-bundle.v1",
    root,
    manifest_sha256: manifest.sha256,
    generated_config: generatedConfigPin,
    outdir,
    entrypoint,
    entrypoint_sha256: entrypointSha256,
    bundle_bytes: entrypointBytes.byteLength,
    metafile: { path: `${outdir}/bundle-meta.json`, sha256: "b".repeat(64), byte_length: 0 },
    inputs: [],
    outputs: [{ path: "index.js", kind: "worker-entrypoint", sha256: entrypointSha256, byte_length: entrypointBytes.byteLength }],
  };
  const bundle = { ...bundleBody, sha256: digest(JSON.stringify(bundleBody)) };

  const evidence = await persistDeploymentBuildEvidence({ root, manifest, bundle, generatedConfigPin });
  assert.equal(evidence.scope, "BOUNDED_LOCAL_INTEGRITY");
  assert.equal(evidence.source_head, manifest.git_head);
  assert.equal(digest(await readFile(resolve(root, evidence.input_manifest.path))), evidence.input_manifest.file_sha256);
  assert.equal(digest(await readFile(resolve(root, evidence.bundle_attestation.path))), evidence.bundle_attestation.file_sha256);
  const stateEntriesBeforeTamper = (await readdir(join(root, ".eliotr-state"))).sort();
  await writeFile(entrypoint, Buffer.from("tampered-after-attestation\n"));
  await assert.rejects(
    persistDeploymentBuildEvidence({ root, manifest, bundle, generatedConfigPin }),
    /Worker bundle entrypoint changed after final deployment readback/u,
  );
  assert.deepEqual((await readdir(join(root, ".eliotr-state"))).sort(), stateEntriesBeforeTamper);
  console.log("Deployment build evidence negative integrity fixture: PASS");
} finally {
  await rm(resolvedTemporaryDirectory, { recursive: true, force: true });
}
