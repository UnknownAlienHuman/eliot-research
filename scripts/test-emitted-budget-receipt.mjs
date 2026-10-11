// Focused emitted-budget receipt verification. All files and Wrangler output
// below are temporary deterministic fixtures; this script performs no build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { admitStartupObservation } from "./lib/emitted-route-membership.mjs";
import {
  compareReceiptArtifacts,
  inspectPwaBuild,
  inspectWebBuild,
  inspectWorkerBuild,
  OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
  RECEIPT_PROTOCOL,
  validateReceipt,
  WORKER_GZIP_BUDGET_BYTES,
} from "./lib/emitted-build-budget-evidence.mjs";

const BUILD_COMMANDS = {
  combined: "pnpm build:pwa && pnpm --filter @eliotr/core deploy:dry-run",
  emitted: "node scripts/check-emitted-budgets.mjs",
  emittedCheck: "node scripts/check-emitted-budgets.mjs --check-only",
  pwa: "node scripts/build-agent-inbox.mjs && astro build",
  worker: "wrangler deploy --dry-run --minify --outdir dist",
  types: "node ../../scripts/generate-cloudflare-types.mjs",
};
const ENVIRONMENT_PROFILE = "local dry-run; top-level Wrangler config; no --remote; no explicit target environment";
const SOURCE_DIAGNOSTIC_POLICY = "separate maintainability diagnostics; not runtime metrics";

let cases = 0;
const FOCUSED_NEGATIVE_FLAG = "--only-native-wasm-path-negative";
const FOCUSED_NEGATIVE_CASE = "Wasm gzip replay and symlink/path inputs fail closed";
const runnerArguments = process.argv.slice(2);
if (runnerArguments.some((argument) => ![FOCUSED_NEGATIVE_FLAG, "--only-owner-web"].includes(argument))) {
  throw new Error("Unknown receipt test option");
}
const runOnlyFocusedNegative = runnerArguments.includes(FOCUSED_NEGATIVE_FLAG);

async function check(name, action) {
  if (runOnlyFocusedNegative && name !== FOCUSED_NEGATIVE_CASE) return;
  if (runnerArguments.includes("--only-owner-web") && !name.startsWith("Owner-web")) return;
  await action();
  cases += 1;
  console.log(`Emitted budget receipt: ${name}: PASS`);
}

async function removeFixture(root) {
  const temporaryRoot = resolve(tmpdir());
  const fixtureRoot = resolve(root);
  if (dirname(fixtureRoot) !== temporaryRoot ||
      !basename(fixtureRoot).startsWith("eliot-emitted-budget-receipt-")) {
    throw new Error("Refusing to remove a path outside the emitted-receipt test fixture directory");
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}

function deterministicBytes(length) {
  const result = Buffer.allocUnsafe(length);
  let state = 0x4f1bbcdc;
  for (let index = 0; index < result.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}


// Synthetic fixture only. This exercises receipt integrity and is never evidence
// that a browser, Worker or production profile executed.
async function fixtureStartupObservations(root, distPath, entries) {
  const bytesByPath = new Map();
  const walk = async (relativePath = "") => {
    for (const entry of await readdir(join(root, distPath, relativePath), { withFileTypes: true })) {
      const name = relativePath ? relativePath + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(name);
      else bytesByPath.set(name, await readFile(join(root, distPath, name)));
    }
  };
  await walk();
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const artifacts = [...bytesByPath].map(([path, bytes]) => ({ path, rawBytes: bytes.length, sha256: hash(bytes) }));
  const epoch = Date.now();
  const result = new Map();
  for (const [htmlPath, scripts] of entries) {
    const route = htmlPath === "index.html" ? "/research" : "/agent-inbox/";
    const rows = [htmlPath, ...scripts].map((artifact, index) => ({
      id: index + 1, origin: "http://127.0.0.1:4630", pathname: index ? "/" + artifact : route,
      method: "GET", resource_type: index ? "script" : "document", query_bytes: 0,
      query_sha256: hash(Buffer.alloc(0)), state: "FINISHED", status: 200,
      started_epoch_ms: epoch + 1, finished_epoch_ms: epoch + 2, completed_by_boundary: true,
      service_worker_request: false, from_service_worker: false, artifact,
      artifact_matches: true, response_role: "PINNED_STATIC_ASSET",
      decoded_body_bytes: bytesByPath.get(artifact).length, body_sha256: hash(bytesByPath.get(artifact)),
    }));
    const observation = {
      protocol: "eliotr.actual-owner-startup-observation.v1", status: "BOUNDED_ACTUAL_RESEARCH_STARTUP_OBSERVED",
      source_commit: "a".repeat(40), build_sha256: "b".repeat(64), artifact_readback_sha256: "c".repeat(64),
      origin: "http://127.0.0.1:4630", route, profile: "SYNTHETIC_RECEIPT_NEGATIVE_FIXTURE", boundary: "fixture-ready",
      started_at: new Date(epoch).toISOString(), finished_at: new Date(epoch + 10).toISOString(), boundary_epoch_ms: epoch + 5,
      requests: structuredClone(rows), requests_at_boundary: rows, observer_errors: [],
      browser_errors: { page_error_count: 0, console_error_count: 0 },
      context: { fresh: true, storage_state_loaded: false, http_cache: "DISABLED_BY_ROUTE_INTERCEPTION" },
      page_state: { service_worker_controller: null }, service_workers_at_boundary: [],
    };
    const bytes = Buffer.from(JSON.stringify(observation));
    result.set(htmlPath, admitStartupObservation(bytes, { observationSha256: hash(bytes),
      sourceCommit: observation.source_commit, buildSha256: observation.build_sha256,
      artifactReadbackSha256: observation.artifact_readback_sha256, route, profile: observation.profile,
      boundary: observation.boundary, htmlPath, artifacts }));
  }
  return result;
}

async function createReceiptFixture({ largeWorker = false, wasm = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "eliot-emitted-budget-receipt-"));
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const workerDist = join(root, "apps/eliotr-core/dist");
  const pwaDist = join(root, "apps/eliotr-pwa/dist");
  await Promise.all([
    mkdir(workerDist, { recursive: true }),
    mkdir(join(pwaDist, "assets"), { recursive: true }),
    mkdir(join(pwaDist, "agent-inbox"), { recursive: true }),
  ]);

  const entry = largeWorker
    ? deterministicBytes(WORKER_GZIP_BUDGET_BYTES + 128 * 1024)
    : Buffer.from("export default { fetch() { return new Response('fixture'); } };\n");
  const wasmBytes = wasm ? deterministicBytes(32 * 1024) : null;
  const sourceMap = JSON.stringify({
    version: 3,
    file: "index.js",
    sources: ["../src/worker.ts"],
    sourcesContent: ["export default { fetch() { return new Response('fixture'); } };"],
    names: [],
    mappings: "",
  });
  await Promise.all([
    writeFile(join(workerDist, "index.js"), entry),
    writeFile(join(workerDist, "index.js.map"), sourceMap),
    writeFile(join(pwaDist, "index.html"),
      '<!doctype html><script type="module" src="/assets/owner.js"></script>'),
    writeFile(join(pwaDist, "assets/owner.js"), "console.log('owner fixture');\n"),
    writeFile(join(pwaDist, "agent-inbox/index.html"),
      '<!doctype html><script type="module" src="./app.js"></script>'),
    writeFile(join(pwaDist, "agent-inbox/app.js"), "console.log('inbox fixture');\n"),
    ...(wasmBytes ? [writeFile(join(workerDist, "runtime.wasm"), wasmBytes)] : []),
  ]);

  const nativeModules = wasmBytes ? [wasmBytes, entry] : [entry];
  const nativeGzipBytes = gzipSync(Buffer.concat(nativeModules)).byteLength;
  const nativeRawBytes = nativeModules.reduce((sum, moduleBytes) => sum + moduleBytes.byteLength, 0);
  const wranglerOutput = [
    "wrangler 4.143.1",
    `Total Upload: ${nativeRawBytes} B / gzip: ${nativeGzipBytes} B`,
    "--dry-run: exiting now.",
  ].join("\n");
  const options = { startupObservations: await fixtureStartupObservations(root, "apps/eliotr-pwa/dist", [
    ["index.html", ["assets/owner.js"]], ["agent-inbox/index.html", ["agent-inbox/app.js"]],
  ]) };
  const [worker, pwa] = await Promise.all([
    inspectWorkerBuild(root, startedAt, wranglerOutput),
    inspectPwaBuild(root, startedAt, options),
  ]);

  const inputDigests = { "apps/eliotr-core/wrangler.jsonc": "c".repeat(64) };
  const buildInputDigestSha256 = createHash("sha256")
    .update(JSON.stringify(inputDigests))
    .digest("hex");
  const currentIdentity = {
    commit: "a".repeat(40),
    dirty: false,
    dirtyEntryCount: 0,
    dirtyDigest: "b".repeat(64),
    lockfileSha256: "d".repeat(64),
    buildInputDigests: inputDigests,
    buildInputDigestSha256,
    fingerprint: "e".repeat(64),
  };
  const finishedAt = new Date().toISOString();
  const receipt = {
    protocol: RECEIPT_PROTOCOL,
    createdAt: finishedAt,
    status: worker.status === "FAIL" || pwa.status === "FAIL" ? "FAIL" : "PASS",
    source: {
      commit: currentIdentity.commit,
      commitAfterBuild: currentIdentity.commit,
      dirty: false,
      dirtyAfterBuild: false,
      dirtyEntryCount: 0,
      dirtyDigest: currentIdentity.dirtyDigest,
      fingerprintBeforeBuild: currentIdentity.fingerprint,
      fingerprintAfterBuild: currentIdentity.fingerprint,
      stableDuringBuild: true,
      lockfileSha256: currentIdentity.lockfileSha256,
      buildInputDigestSha256,
      buildInputDigestSha256After: buildInputDigestSha256,
    },
    build: {
      command: "pnpm cf:dry-run",
      attempted: true,
      commandStatus: 0,
      startedAt,
      finishedAt,
      environmentProfile: ENVIRONMENT_PROFILE,
      commands: BUILD_COMMANDS,
      toolVersions: {
        node: "v22.0.0-fixture",
        pnpm: "10.0.0-fixture",
        wrangler: "4.143.1",
        astro: "5.0.0-fixture",
        vite: "6.0.0-fixture",
      },
      inputDigests,
      inputDigestsAfter: inputDigests,
    },
    thresholds: {
      workerGzipBytes: WORKER_GZIP_BUDGET_BYTES,
      ownerWebInitialJavaScriptGzipBytes: OWNER_WEB_INITIAL_GZIP_BUDGET_BYTES,
      sourceLineAndByteBudgets: SOURCE_DIAGNOSTIC_POLICY,
    },
    worker,
    pwa,
    artifacts: [...worker.artifactFiles, ...pwa.artifactFiles],
    issues: [...worker.issues, ...pwa.issues],
  };
  return { root, currentIdentity, receipt, worker, pwa, options };
}

await check("complete writer-shaped PASS is recomputed from fixture artifacts", async () => {
  const fixture = await createReceiptFixture();
  try {
    assert.equal(fixture.worker.status, "PASS");
    assert.equal(fixture.pwa.status, "PASS");
    assert.equal((await validateReceipt(fixture.root, fixture.receipt, fixture.currentIdentity)).status,
      "NOT_MEASURED", "persisted budget JSON cannot reconstruct startup admission");
    assert.deepEqual(await validateReceipt(fixture.root, fixture.receipt, fixture.currentIdentity, fixture.options), {
      status: "PASS",
      issues: [],
    });
  } finally {
    await removeFixture(fixture.root);
  }
});

await check("forged PASS without complete contours or artifact membership is NOT_MEASURED", async () => {
  const fixture = await createReceiptFixture();
  try {
    const missingWorker = structuredClone(fixture.receipt);
    delete missingWorker.worker;
    assert.equal((await validateReceipt(fixture.root, missingWorker, fixture.currentIdentity, fixture.options)).status,
      "NOT_MEASURED");

    const missingPwa = structuredClone(fixture.receipt);
    delete missingPwa.pwa;
    assert.equal((await validateReceipt(fixture.root, missingPwa, fixture.currentIdentity, fixture.options)).status,
      "NOT_MEASURED");

    const missingArtifact = structuredClone(fixture.receipt);
    missingArtifact.artifacts.pop();
    assert.equal((await validateReceipt(fixture.root, missingArtifact, fixture.currentIdentity, fixture.options)).status,
      "NOT_MEASURED");

    const forgedMetric = structuredClone(fixture.receipt);
    forgedMetric.pwa.initialOwnerWebJavaScript.gzipBytes = Number.POSITIVE_INFINITY;
    assert.equal((await validateReceipt(fixture.root, forgedMetric, fixture.currentIdentity, fixture.options)).status,
      "NOT_MEASURED");

    const changedLimit = structuredClone(fixture.receipt);
    changedLimit.thresholds.workerGzipBytes += 1;
    assert.equal((await validateReceipt(fixture.root, changedLimit, fixture.currentIdentity, fixture.options)).status,
      "NOT_MEASURED");
  } finally {
    await removeFixture(fixture.root);
  }
});

await check("legitimate NOT_MEASURED receipt remains NOT_MEASURED", async () => {
  const fixture = await createReceiptFixture();
  try {
    const unmeasured = {
      protocol: RECEIPT_PROTOCOL,
      status: "NOT_MEASURED",
      source: { fingerprintAfterBuild: fixture.currentIdentity.fingerprint },
      artifacts: [],
    };
    assert.equal((await validateReceipt(fixture.root, unmeasured, fixture.currentIdentity, fixture.options)).status,
      "NOT_MEASURED");
  } finally {
    await removeFixture(fixture.root);
  }
});

await check("complete measured FAIL remains FAIL and cannot be relabeled PASS", async () => {
  const fixture = await createReceiptFixture({ largeWorker: true });
  try {
    assert.ok(fixture.worker.metric.gzipBytes > WORKER_GZIP_BUDGET_BYTES,
      "fixture Worker gzip must exceed the fixed release threshold");
    assert.equal(fixture.worker.status, "FAIL");
    assert.equal(fixture.pwa.status, "PASS");
    assert.deepEqual(await validateReceipt(fixture.root, fixture.receipt, fixture.currentIdentity, fixture.options), {
      status: "FAIL",
      issues: [],
    });

    const forgedPass = structuredClone(fixture.receipt);
    forgedPass.status = "PASS";
    assert.equal((await validateReceipt(fixture.root, forgedPass, fixture.currentIdentity, fixture.options)).status,
      "NOT_MEASURED");
  } finally {
    await removeFixture(fixture.root);
  }
});

await check(FOCUSED_NEGATIVE_CASE, async () => {
  const wasmFixture = await createReceiptFixture({ wasm: true });
  try {
    assert.equal(wasmFixture.receipt.status, "PASS");
    assert.equal((await validateReceipt(
      wasmFixture.root,
      wasmFixture.receipt,
      wasmFixture.currentIdentity,
      wasmFixture.options,
    )).status, "PASS", "the fresh in-process native Wrangler measurement remains usable");

    const forgedReplay = structuredClone(wasmFixture.receipt);
    forgedReplay.worker.metric.gzipBytes = 1;
    forgedReplay.worker.metric.gzipReported = "1 B";
    forgedReplay.worker.metric.gzipPrecisionBytes = 0.5;
    forgedReplay.worker.metric.gzipRoundingIntervalBytes = {
      lowerInclusive: 0.5,
      upperInclusive: 1.5,
    };
    assert.equal(forgedReplay.worker.status, "PASS");
    assert.equal((await validateReceipt(
      wasmFixture.root,
      forgedReplay,
      wasmFixture.currentIdentity,
      wasmFixture.options,
    )).status, "NOT_MEASURED", "persisted multipart gzip cannot be lowered and replayed as PASS");
  } finally {
    await removeFixture(wasmFixture.root);
  }

  const pathFixture = await createReceiptFixture();
  const outsideDirectory = join(dirname(pathFixture.root), basename(pathFixture.root) + "-outside");
  try {
    const traversalReceipt = structuredClone(pathFixture.receipt);
    traversalReceipt.artifacts[0].path = "../../outside-artifact.js";
    assert.equal((await validateReceipt(
      pathFixture.root,
      traversalReceipt,
      pathFixture.currentIdentity,
      pathFixture.options,
    )).status, "NOT_MEASURED", "receipt paths must match the computed artifact manifest before reads");

    await mkdir(outsideDirectory, { recursive: true });
    const outsideBytes = Buffer.from("outside the repository artifact root\n");
    const outsideFile = join(outsideDirectory, "escaped.js");
    await writeFile(outsideFile, outsideBytes);
    const linkPath = join(pathFixture.root, "apps/eliotr-core/dist/receipt-escape");
    await symlink(outsideDirectory, linkPath, process.platform === "win32" ? "junction" : "dir");

    const escapedArtifact = {
      path: "apps/eliotr-core/dist/receipt-escape/escaped.js",
      sha256: createHash("sha256").update(outsideBytes).digest("hex"),
      rawBytes: outsideBytes.byteLength,
    };
    const escapedReceipt = structuredClone(pathFixture.receipt);
    escapedReceipt.artifacts.push(escapedArtifact);
    assert.equal((await compareReceiptArtifacts(
      pathFixture.root,
      escapedReceipt,
      pathFixture.receipt.artifacts,
    )).status, "NOT_MEASURED", "an artifact outside the computed membership is rejected before opening it");
    assert.equal((await compareReceiptArtifacts(
      pathFixture.root,
      escapedReceipt,
      [...pathFixture.receipt.artifacts, escapedArtifact],
    )).status, "NOT_MEASURED", "realpath-safe checks reject a linked artifact even if listed as expected");
  } finally {
    await removeFixture(pathFixture.root);
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

await check("Owner-web requires observed initial bytes and fails missing/inline/escaping inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "eliot-emitted-budget-receipt-"));
  const dist = join(root, "apps/eliotr-web/dist/client");
  try {
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), '<script type="module" src="/assets/main.js"></script>');
    await writeFile(join(dist, "assets/main.js"), 'import "./shared.js"; export const open = () => import("./lazy.js");');
    await writeFile(join(dist, "assets/shared.js"), 'export const title = "Research";');
    await writeFile(join(dist, "assets/lazy.js"), 'export const large = "' + "abcdef".repeat(10000) + '";');
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const options = { startupObservations: await fixtureStartupObservations(root, "apps/eliotr-web/dist/client", [
      ["index.html", ["assets/main.js", "assets/shared.js"]],
    ]) };
    assert.equal((await inspectWebBuild(root, startedAt)).status, "NOT_MEASURED");
    const result = await inspectWebBuild(root, startedAt, options);
    assert.equal(result.status, "PASS");
    assert.deepEqual(result.referencedJavaScript, ["assets/main.js", "assets/shared.js"]);
    assert.equal(result.artifactFiles.length, 4, "lazy files remain digest-bound even outside initial load");
    await writeFile(join(dist, "index.html"), '<script type="module" src="/assets/missing.js"></script>');
    assert.equal((await inspectWebBuild(root, startedAt, options)).status, "NOT_MEASURED");
    await writeFile(join(dist, "index.html"), '<script type="module" src="/assets/main.js"></script><script>window.bad=true;</script>');
    assert.equal((await inspectWebBuild(root, startedAt, options)).status, "NOT_MEASURED");
    await writeFile(join(dist, "index.html"), '<script type="module" src="/assets/main.js"></script>');
    await writeFile(join(dist, "assets/main.js"), 'import "../../../../private.js";');
    assert.equal((await inspectWebBuild(root, startedAt, options)).status, "NOT_MEASURED");
    const identity = { fingerprint: "current" };
    const candidate = { protocol: RECEIPT_PROTOCOL, graph: "owner-web", status: "PASS", source: { fingerprintAfterBuild: "current" } };
    assert.equal((await validateReceipt(root, candidate, identity)).status, "NOT_MEASURED", "candidate never satisfies legacy deployment receipt");
  } finally { await removeFixture(root); }
});

console.log(`Emitted budget receipt: ${cases}/${cases} focused cases passed`);
