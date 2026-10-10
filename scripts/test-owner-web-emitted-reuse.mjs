import assert from "node:assert/strict";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectRetainedOwnerWebReuse,
  RETAINED_OWNER_WEB_REUSE_PATHS,
} from "./lib/emitted-owner-web-reuse.mjs";
import {
  inspectWebBuild,
  validateReceipt,
} from "./lib/emitted-build-budget-evidence.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUALIFIED_TREE = "896c7ebe9be393d6aa9059c1b316447f99ee6002";
const CURRENT_TREE_AT_AUDIT = "deb41e50855a30a011e1c89b2ff673c3568f7259";
let cases = 0;

async function createEvidenceFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "eliot-owner-web-emitted-reuse-"));
  const evidenceRoot = join(fixtureRoot, "workspace");
  for (const relativePath of [RETAINED_OWNER_WEB_REUSE_PATHS.staticBuild, RETAINED_OWNER_WEB_REUSE_PATHS.equivalence]) {
    const source = resolve(REPO_ROOT, relativePath);
    const target = resolve(evidenceRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await cp(
    resolve(REPO_ROOT, RETAINED_OWNER_WEB_REUSE_PATHS.distRoot),
    resolve(evidenceRoot, RETAINED_OWNER_WEB_REUSE_PATHS.distRoot),
    { recursive: true },
  );
  return { fixtureRoot, evidenceRoot };
}

async function removeFixture(fixtureRoot) {
  const temporaryRoot = resolve(tmpdir());
  const resolved = resolve(fixtureRoot);
  if (dirname(resolved) !== temporaryRoot || !basename(resolved).startsWith("eliot-owner-web-emitted-reuse-")) {
    throw new Error("Refusing to remove a path outside the owner-web reuse test fixture directory");
  }
  await rm(resolved, { recursive: true, force: true });
}

async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Owner-web emitted reuse: ${name}: PASS`);
}

await check("retained bytes bind to the cited tree and remain a Worker-incomplete subreceipt", async () => {
  const fixture = await createEvidenceFixture();
  try {
    const receipt = await inspectRetainedOwnerWebReuse(fixture.evidenceRoot, QUALIFIED_TREE, { gitRoot: REPO_ROOT });
    assert.equal(receipt.protocol, "eliotr.emitted-build-budget-receipt.v1");
    assert.equal(receipt.graph, "owner-web");
    assert.equal(receipt.status, "NOT_MEASURED", "the missing Worker measurement keeps the full receipt closed");
    assert.equal(receipt.worker.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.status, "NOT_MEASURED", "retained bytes cannot promote the full owner-web graph");
    assert.equal(receipt.source.stableDuringBuild, null);
    assert.equal(receipt.source.wholeBuildInputStability, "UNPROVEN");
    assert.equal(receipt.source.listedInputEquivalence, "LISTED_INPUT_EQUIVALENCE");
    assert.equal(receipt.source.selectedSourceTreeMatchesListedInputs, true);
    assert.equal(receipt.source.fingerprintBeforeBuild, null);
    assert.equal(receipt.source.fingerprintAfterBuild, null);
    assert.equal(receipt.ownerWeb.closureEvidence.fullGraphStatus, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.closureEvidence.manifestUsedAsClosureAuthority, false);
    assert.equal(
      receipt.ownerWeb.closureEvidence.referencedJavaScriptSemantics,
      "HTML entry roots plus recursive static imports only; dynamic imports are excluded",
    );
    assert.deepEqual(
      receipt.ownerWeb.closureEvidence.unresolvedLoadEdges,
      receipt.ownerWeb.moduleGraph.flatMap((module) => (module.unresolved ?? []).map((edge) => ({ path: module.path, edge }))),
    );
    assert.ok(receipt.ownerWeb.issues.includes("Whole-build input stability is unproven by listed-input equivalence"));
    assert.ok(receipt.issues.includes("No current-source Worker build or native Wrangler measurement was supplied"));
    assert.equal(receipt.ownerWeb.initialOwnerWebJavaScript.gzipBytes, 1766);
    assert.equal(receipt.ownerWeb.initialOwnerWebJavaScript.unit, "bytes");
    assert.equal(receipt.ownerWeb.sharedInitialJavaScript.gzipBytes, 0);
    assert.equal(receipt.ownerWeb.sharedInitialJavaScript.unit, "bytes");
    assert.equal(receipt.ownerWeb.lazyJavaScript.gzipBytes, 236820);
    assert.equal(receipt.ownerWeb.lazyJavaScript.unit, "bytes");
    assert.equal(receipt.ownerWeb.agentInboxJavaScript.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.allDistJavaScript.gzipBytes, 238586);
    assert.equal(receipt.ownerWeb.allDistJavaScript.status, "MEASURED");
    assert.equal(receipt.ownerWeb.allDistJavaScript.unit, "bytes");
    assert.equal(receipt.ownerWeb.allAssets.length, 9);
    assert.ok(receipt.ownerWeb.allAssets.every((asset) => asset.status === "MEASURED" && asset.unit === "bytes"));
    assert.equal(receipt.ownerWeb.viteManifest.sha256, "987c1633516dac6b7bd61ab54b31d4f211ae0ca882138d1966da4cee42a38c20");
    assert.deepEqual(
      receipt.ownerWeb.referencedJavaScript,
      receipt.ownerWeb.initialOwnerWebJavaScript.resources.map((resource) => resource.path),
      "the established referencedJavaScript field remains the initial static-import closure only",
    );
    const defaultInspection = await inspectWebBuild(fixture.evidenceRoot, "2026-10-10T07:36:38.433Z", {
      artifactRoot: RETAINED_OWNER_WEB_REUSE_PATHS.distRoot,
      checkMtimeFreshness: false,
    });
    assert.equal(defaultInspection.routes[0].initialJavaScript.gzipBytes, 1766);
    assert.deepEqual(defaultInspection.referencedJavaScript, receipt.ownerWeb.referencedJavaScript);
    assert.equal(Object.hasOwn(defaultInspection, "lazyJavaScript"), false);
    assert.equal(Object.hasOwn(defaultInspection, "allAssets"), false);
    const combined = await validateReceipt(fixture.evidenceRoot, receipt, { fingerprint: "irrelevant-to-subreceipt" });
    assert.equal(combined.status, "NOT_MEASURED", "the combined receipt validator rejects the owner-web-only subreceipt");
  } finally {
    await removeFixture(fixture.fixtureRoot);
  }
});

await check("current-tree source drift preserves its reason and hard NOT_MEASURED status", async () => {
  const fixture = await createEvidenceFixture();
  try {
    const receipt = await inspectRetainedOwnerWebReuse(fixture.evidenceRoot, CURRENT_TREE_AT_AUDIT, { gitRoot: REPO_ROOT });
    assert.equal(receipt.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.status, "NOT_MEASURED");
    assert.equal(receipt.source.stableDuringBuild, null, "listed blobs do not prove whole-build stability");
    assert.equal(receipt.source.wholeBuildInputStability, "UNPROVEN");
    assert.equal(receipt.source.selectedSourceTreeMatchesListedInputs, false);
    assert.deepEqual(receipt.source.sourceInputMismatches.map((item) => item.path), [
      "packages/ui/src/primitives/primitives.css",
    ]);
    assert.ok(receipt.issues.some((issue) => issue.startsWith("Freshness: STALE against source tree")));
    assert.ok(receipt.ownerWeb.issues.some((issue) => issue.startsWith("Freshness: STALE against source tree")));
  } finally {
    await removeFixture(fixture.fixtureRoot);
  }
});

await check("opaque reachable dynamic imports stay unresolved and outside the initial static closure", async () => {
  const fixture = await createEvidenceFixture();
  try {
    const entry = resolve(fixture.evidenceRoot, RETAINED_OWNER_WEB_REUSE_PATHS.distRoot, "assets/index-DwiDn0eZ.js");
    const bytes = await readFile(entry);
    await writeFile(entry, Buffer.concat([bytes, Buffer.from("\nimport(e.module);\n")]));
    const report = await inspectWebBuild(fixture.evidenceRoot, "2026-10-10T07:36:38.433Z", {
      artifactRoot: RETAINED_OWNER_WEB_REUSE_PATHS.distRoot,
      checkMtimeFreshness: false,
      includeHidden: true,
    });
    assert.equal(report.status, "NOT_MEASURED");
    assert.ok(report.issues.includes("Candidate module contains an unresolved load edge: assets/index-DwiDn0eZ.js"));
    assert.deepEqual(report.referencedJavaScript, ["assets/index-DwiDn0eZ.js"]);

    const receipt = await inspectRetainedOwnerWebReuse(fixture.evidenceRoot, QUALIFIED_TREE, { gitRoot: REPO_ROOT });
    assert.equal(receipt.ownerWeb.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.inspectionStatus, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.initialOwnerWebJavaScript.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.lazyJavaScript.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.allDistJavaScript.status, "MEASURED");
    assert.equal(receipt.ownerWeb.closureEvidence.fullGraphStatus, "NOT_MEASURED");
    assert.deepEqual(receipt.ownerWeb.closureEvidence.unresolvedLoadEdges, [
      { path: "assets/index-DwiDn0eZ.js", edge: "dynamic import" },
    ]);
    const unresolvedIssue = "Candidate module contains an unresolved load edge: assets/index-DwiDn0eZ.js";
    assert.ok(receipt.ownerWeb.issues.includes(unresolvedIssue));
    assert.ok(receipt.issues.includes(unresolvedIssue));
    assert.deepEqual(receipt.ownerWeb.referencedJavaScript, ["assets/index-DwiDn0eZ.js"]);
  } finally {
    await removeFixture(fixture.fixtureRoot);
  }
});

await check("missing retained output cannot be measured", async () => {
  const fixture = await createEvidenceFixture();
  try {
    await rm(resolve(fixture.evidenceRoot, RETAINED_OWNER_WEB_REUSE_PATHS.distRoot, "assets/index-DwiDn0eZ.js"));
    const receipt = await inspectRetainedOwnerWebReuse(fixture.evidenceRoot, QUALIFIED_TREE, { gitRoot: REPO_ROOT });
    assert.equal(receipt.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.status, "NOT_MEASURED");
    assert.ok(receipt.issues.some((issue) => issue.includes("Retained artifacts are NOT_MEASURED")));
    assert.ok(receipt.ownerWeb.issues.some((issue) => issue.includes("Retained artifacts are NOT_MEASURED")));
  } finally {
    await removeFixture(fixture.fixtureRoot);
  }
});

await check("tampered retained output is stale and cannot pass", async () => {
  const fixture = await createEvidenceFixture();
  try {
    const asset = resolve(fixture.evidenceRoot, RETAINED_OWNER_WEB_REUSE_PATHS.distRoot, "assets/bootstrap-CiMz0wdY.js");
    const bytes = await readFile(asset);
    await writeFile(asset, Buffer.concat([bytes, Buffer.from("\n// tampered evidence\n")]));
    const receipt = await inspectRetainedOwnerWebReuse(fixture.evidenceRoot, QUALIFIED_TREE, { gitRoot: REPO_ROOT });
    assert.equal(receipt.status, "NOT_MEASURED");
    assert.equal(receipt.ownerWeb.status, "NOT_MEASURED");
    assert.ok(receipt.issues.some((issue) => issue.startsWith("Freshness: STALE retained artifact digest changed")));
    assert.ok(receipt.ownerWeb.issues.some((issue) => issue.startsWith("Freshness: STALE retained artifact digest changed")));
  } finally {
    await removeFixture(fixture.fixtureRoot);
  }
});

console.log(`Owner-web emitted reuse: ${cases}/${cases} focused cases passed`);
