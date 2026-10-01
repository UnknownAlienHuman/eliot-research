import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDeploymentAssetManifest, verifyDeploymentAssets } from "./lib/deployment-assets.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "eliotr-deployment-assets-"));
const dist = path.join(root, "apps", "eliotr-pwa", "dist");
const coreConfig = { assets: { directory: "../eliotr-pwa/dist" } };

try {
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await mkdir(path.join(dist, "nested"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<!doctype html><main>home</main>");
  await writeFile(path.join(dist, "assets", "app.js"), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(dist, "nested", "index.html"), "nested home");
  await writeFile(path.join(dist, "_headers"), "/assets/*\n  Cache-Control: public");
  await writeFile(path.join(dist, "_redirects"), "/old /new 301");

  const manifest = await readDeploymentAssetManifest(coreConfig, { root });
  assert.deepEqual(await readDeploymentAssetManifest(coreConfig, { root }), manifest);
  assert.equal(manifest.protocol, "eliotr.cloudflare-assets-manifest.v1");
  assert.equal(manifest.state, "LOCAL_ONLY");
  assert.equal(manifest.directory, "apps/eliotr-pwa/dist");
  assert.deepEqual(manifest.excluded_routing_files, ["_headers", "_redirects"]);
  assert.deepEqual(manifest.files.map(({ path: assetPath }) => assetPath), [
    "assets/app.js", "index.html", "nested/index.html",
  ]);
  assert.equal(manifest.manifest_sha256, digestManifestForTest(manifest));

  await assert.rejects(
    readDeploymentAssetManifest({ assets: { directory: "../../outside" } }, { root }),
    /pinned PWA output/,
  );

  let requests = 0;
  const noCookie = await verifyDeploymentAssets(manifest, { origin: "https://staging.example" }, {
    fetchImpl: async () => { requests += 1; throw new Error("should not run"); },
  });
  assert.deepEqual(noCookie, { state: "NOT_EXECUTED", reason: "access_cookie_missing" });
  assert.equal(requests, 0);

  const expected = new Map();
  for (const file of manifest.files) {
    expected.set(routeFor(file.path), await readFile(path.join(dist, ...file.path.split("/"))));
  }
  const success = await verifyDeploymentAssets(manifest, {
    origin: "https://staging.example", cookie: "verified-access-cookie",
  }, {
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "manual");
      assert.equal(options.cache, "no-store");
      assert.equal(options.headers.Cookie, "CF_Authorization=verified-access-cookie");
      assert.equal(url.origin, "https://staging.example");
      assert.equal(expected.has(url.pathname), true);
      return new globalThis.Response(expected.get(url.pathname), { status: 200 });
    },
  });
  assert.equal(success.state, "PASS");
  assert.equal(success.results.length, 3);
  assert.deepEqual(success.results.map(({ path: assetPath }) => assetPath), manifest.files.map(({ path: assetPath }) => assetPath));
  assert.equal(requests, 3);

  await assertReadbackFails(manifest, async () => new globalThis.Response("private reflected body", { status: 307,
    headers: { Location: "https://elsewhere.example/" } }), "unexpected HTTP response", "private reflected body");
  await assertReadbackFails(manifest, async () => new globalThis.Response("private fallback HTML", { status: 404,
    headers: { "Content-Type": "text/html" } }), "unexpected HTTP response", "private fallback HTML");
  await assertReadbackFails(manifest, async () => new globalThis.Response("<html>SPA fallback</html>", { status: 200,
    headers: { "Content-Type": "text/html" } }), "network or stream error");
  await assertReadbackFails(manifest, async (url) => {
    const expectedBytes = expected.get(url.pathname);
    const wrong = Buffer.from(expectedBytes);
    wrong[0] ^= 0xff;
    return new globalThis.Response(wrong, { status: 200 });
  }, "content mismatch");
  await assertReadbackFails(manifest, async (url) => new globalThis.Response(
    Buffer.alloc(expected.get(url.pathname).byteLength + 1, 1), { status: 200 }), "network or stream error");

  await assert.rejects(verifyDeploymentAssets({ ...manifest, files: [
    ...manifest.files, { ...manifest.files[0] },
  ] }, { origin: "https://staging.example", cookie: "secret" }, {
    fetchImpl: async () => { throw new Error("must not run"); },
  }), /duplicate paths|digest or order/);

  await assert.rejects(verifyDeploymentAssets(manifest, {
    origin: "https://staging.example", cookie: "secret",
  }, {
    timeoutMs: 25,
    fetchImpl: async () => new globalThis.Response(new globalThis.ReadableStream({
      pull() { return new Promise(() => {}); },
    }), { status: 200 }),
  }), /exceeded its deadline/);

  const symlinkRoot = path.join(root, "apps", "eliotr-pwa", "symlink-dist");
  await symlink(dist, symlinkRoot, "junction");
  await assert.rejects(readDeploymentAssetManifest({ assets: { directory: "../eliotr-pwa/symlink-dist" } }, { root }),
    /pinned PWA output/);
  const movedDist = path.join(root, "apps", "eliotr-pwa", "moved-dist");
  await rm(symlinkRoot, { recursive: true, force: true });
  await rename(dist, movedDist);
  await symlink(movedDist, dist, "junction");
  await assert.rejects(readDeploymentAssetManifest(coreConfig, { root }), /symbolic link|not a regular directory/);
  await rm(dist, { recursive: true, force: true });
  await rename(movedDist, dist);
  await symlink(path.join(dist, "assets"), path.join(dist, "linked-assets"), "junction");
  await assert.rejects(readDeploymentAssetManifest(coreConfig, { root }), /symbolic link|non-regular entry/);

  console.log("deployment asset manifest/readback tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function assertReadbackFails(manifest, responseFactory, message, secret) {
  let requestsMade = 0;
  await assert.rejects(verifyDeploymentAssets(manifest, {
    origin: "https://staging.example", cookie: "secret-cookie",
  }, {
    fetchImpl: async (url) => {
      requestsMade += 1;
      return responseFactory(url);
    },
  }), (error) => {
    assert.match(error.message, new RegExp(message));
    assert.equal(error.message.includes("secret-cookie"), false);
    if (secret) assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(requestsMade, 1);
}

function routeFor(filePath) {
  if (filePath === "index.html") return "/";
  if (filePath.endsWith("/index.html")) return `/${filePath.slice(0, -"index.html".length)}`;
  if (filePath.endsWith(".html")) return `/${filePath.slice(0, -".html".length)}`;
  return `/${filePath}`;
}

function digestManifestForTest(manifest) {
  const canonical = JSON.stringify({
    protocol: manifest.protocol,
    directory: manifest.directory,
    excluded_routing_files: manifest.excluded_routing_files,
    files: manifest.files.map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
