import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readdir, readFile, mkdir, lstat, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync, backup } from "node:sqlite";
import { CORE, localEnvironment, executeLocalAsync } from "../../../scripts/lib/local-launch.mjs";
import { bindChromiumSafeListener } from "../../../scripts/lib/local-owner-bridge.mjs";

function within(parent, child) {
  const part = relative(resolve(parent), resolve(child));
  assert.ok(part && !part.startsWith("..") && !isAbsolute(part), "Fixture path escaped its owned root");
}
async function files(root) {
  const out = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name); within(root, path);
      assert.equal((await lstat(path)).isSymbolicLink(), false, "Snapshot paths cannot be symlinks");
      if (entry.isDirectory()) await visit(path); else if (entry.isFile()) out.push(path);
      assert.ok(out.length <= 4000, "Native fixture storage exceeded the bounded snapshot");
    }
  }
  await visit(root); return out;
}
async function nativeRoot(before, publicationRef) {
  const roots = (await readdir(tmpdir())).filter((name) => name.startsWith("miniflare-") && !before.has(name));
  const found = [];
  for (const name of roots) {
    const root = resolve(tmpdir(), name);
    for (const path of (await files(root)).filter((file) => file.endsWith(".sqlite") && file.includes("d1"))) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='artifact_publication_receipt'").get() &&
            db.prepare("SELECT 1 FROM artifact_publication_receipt WHERE publication_ref=?").get(publicationRef)) found.push(root);
      } finally { db.close(); }
    }
  }
  assert.equal(found.length, 1, "Snapshot must identify exactly one actual native accepted fixture");
  return found[0];
}
async function snapshotStorage(source, paths) {
  const inventory = [];
  for (const resource of ["d1", "r2"]) {
    const resourceRoot = resolve(source, resource);
    for (const file of await files(resourceRoot)) {
      if (file.endsWith("-wal") || file.endsWith("-shm")) continue;
      const part = relative(resourceRoot, file);
      const target = resolve(paths.persist, "v3", resource, part); within(paths.directory, target);
      await mkdir(dirname(target), { recursive: true });
      if (file.endsWith(".sqlite")) {
        const database = new DatabaseSync(file, { readOnly: true });
        try { await backup(database, target); } finally { database.close(); }
        const saved = new DatabaseSync(target, { readOnly: true });
        try { assert.equal(saved.prepare("PRAGMA quick_check").get().quick_check, "ok"); } finally { saved.close(); }
      } else {
        await copyFile(file, target);
        const bytes = await readFile(target);
        inventory.push({ resource, path: part, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }
  assert.ok(inventory.some((item) => item.resource === "r2"), "Actual R2 blobs must be saved");
  return inventory;
}

// This transports a completed native fixture's actual SQLite databases and R2
// blobs. No authority row is manufactured, no trigger disabled, no HTTP result
// intercepted. The native runtime stays idle/alive until coherent backups finish.
export async function prepareOwnerArtifactSnapshot(paths, identity) {
  const require = createRequire(import.meta.url);
  const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const before = new Set(await readdir(tmpdir()));
  let resolveSnapshot; let rejectSnapshot;
  const snapshot = new Promise((yes, no) => { resolveSnapshot = yes; rejectSnapshot = no; });
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/snapshot");
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 1024 * 1024); chunks.push(chunk); }
      const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(manifest.protocol, "eliotr.owner-artifact-native-snapshot.v1");
      assert.deepEqual(manifest.principal, { ...identity, client_class: "owner_pwa" });
      assert.equal(manifest.publication.revision.status, "ACCEPTED"); assert.equal(manifest.model_calls, 2);
      const source = await nativeRoot(before, manifest.publication.receipt.publication_ref);
      manifest.storage = await snapshotStorage(source, paths);
      const config = JSON.parse(await readFile(paths.config, "utf8"));
      for (const database of config.d1_databases) database.database_name = manifest.native_databases[database.binding];
      for (const bucket of config.r2_buckets) bucket.bucket_name = manifest.native_buckets[bucket.binding];
      assert.equal(config.vars.DEPLOYMENT_GENERATION, identity.deployment_generation);
      await writeFile(paths.config, JSON.stringify(config, null, 2) + "\n");
      await writeFile(resolve(paths.directory, "accepted-artifact-fixture.json"), JSON.stringify(manifest, null, 2) + "\n");
      response.writeHead(200); response.end("SNAPSHOT_SAVED"); resolveSnapshot(manifest);
    } catch (error) { response.writeHead(500); response.end("SNAPSHOT_FAILED"); rejectSnapshot(error); }
  });
  await bindChromiumSafeListener((port) => new Promise((yes, no) => {
    server.once("error", no); server.listen(port, "127.0.0.1", () => { server.removeListener("error", no); yes({ server, port: server.address().port }); });
  }));
  const address = server.address();
  const run = executeLocalAsync([vitest, "run", "test/artifact-owner-browser-fixture.test.ts", "--reporter=verbose", "--maxWorkers=1"], {
    cwd: CORE, capture: true, timeoutMs: 180_000, env: { ...localEnvironment(),
      ELIOTR_OWNER_ARTIFACT_FIXTURE: JSON.stringify({ ...identity, collector_url: `http://127.0.0.1:${address.port}/snapshot` }) },
  });
  // Observe native failure even if it never reaches the collector.
  const completion = run.catch((error) => { rejectSnapshot(error); throw error; });
  try {
    const manifest = await snapshot;
    await completion;
    return manifest;
  } finally { await completion.catch(() => {}); await new Promise((yes) => server.close(yes)); }
}
