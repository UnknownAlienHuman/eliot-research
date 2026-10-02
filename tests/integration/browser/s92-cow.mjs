/**
 * S92 92.5 — COW (copy-on-write) review / publish / history / verified export.
 *
 * Named scenario functions in the existing browser-harness style
 * (tests/integration/browser/owner-e2e.mjs, library.spec.ts): each run()
 * returns { state, detail? } with harness state discipline:
 *   PASS            — real assertion held against the real system code
 *   FAIL            — assertion failure, with reason
 *   NOT_EXECUTED    — a required credential, environment or scenario fixture is unavailable
 *   BLOCKED         — a required product/build prerequisite is unmet (e.g. producer not implemented)
 *
 * Real entry points driven (never stubbed):
 *   - scripts/lib/local-launch.mjs      (localConfig, localEnvironment, localPaths)
 *   - packages/cloudflare-artifacts/dist (compiled verification + draft reader)
 *   - packages/research/src/artifact-compiler.ts (change-review contract)
 *
 * The compiled @eliotr/* dist modules are loaded through a resolve hook that
 * maps bare "@eliotr/<pkg>" specifiers to "<repo>/packages/<pkg>/dist/index.js".
 * This is module resolution only — the loaded code is the real compiled system.
 * (The hook is load-bearing: the dist files themselves import @eliotr/* bare
 * specifiers, so without it Node resolves them to .ts sources that cannot load.)
 * A staleness guard refuses to test dist older than its src.
 *
 * Model policy (D1): local default AI_GATEWAY_REASONING_URL is
 * https://example.invalid/local-disabled; there is NO local fake model gateway.
 * These scenarios prove configuration/readiness/fail-closed paths and NEVER
 * invent model output.
 */
/* global URL: readonly, process: readonly, console: readonly, Buffer: readonly */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

// ---------------------------------------------------------------------------
// Real-module loading: @eliotr/* -> compiled dist (resolution only, no stubs)
// The hook also resolves the dist files' own bare @eliotr/* imports.
// ---------------------------------------------------------------------------
const DIST_MAP = {};
for (const pkg of readdirSync(resolve(REPO, "packages"))) {
  const index = resolve(REPO, "packages", pkg, "dist", "index.js");
  if (existsSync(index)) DIST_MAP[`@eliotr/${pkg}`] = index;
}
register(
  `data:text/javascript,${encodeURIComponent(
    `import { pathToFileURL } from "node:url"; export async function resolve(specifier, context, next) { const map = ${JSON.stringify(DIST_MAP)}; ` +
      `if (Object.hasOwn(map, specifier)) return { url: pathToFileURL(map[specifier]).href, shortCircuit: true }; ` +
      `return next(specifier, context); }`,
  )}`,
);

const ARTIFACTS_DIST = resolve(REPO, "packages/cloudflare-artifacts/dist");
const verificationModule = () => import(pathToFileURL(resolve(ARTIFACTS_DIST, "artifact-draft-verification.js")).href);
const readerModule = () => import(pathToFileURL(resolve(ARTIFACTS_DIST, "artifact-draft-reader.js")).href);

/** Refuse to test compiled output older than its source. */
function assertDistCurrent(distFile, srcFile) {
  const distTime = statSync(distFile).mtimeMs;
  const srcTime = statSync(srcFile).mtimeMs;
  assert.ok(
    distTime >= srcTime,
    `stale dist: ${distFile} older than ${srcFile}; run pnpm build before trusting these scenarios`,
  );
}

/** Missing build output is an unmet prerequisite, not a test failure. */
function distBlocked(name, distFile) {
  if (!existsSync(distFile)) {
    return {
      state: "BLOCKED",
      detail: `${name}: ${distFile} not built; run pnpm build, then re-execute`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared fixture: a v1 draft-verification record (semantic audit NOT_EXECUTED,
// so no model output is needed or invented — matches D1 local policy).
// ---------------------------------------------------------------------------
const H64 = "a".repeat(64);
const vref = (id) => ({ id, revision: 1 });

function makeV1Record() {
  return {
    schema: "eliotr.research.draft-verification.v1",
    semantic_verification: "NOT_EXECUTED",
    source_readback: "AUTHORITATIVE_RESOLVED",
    operation_id: "s92-cow-fixture-op-1",
    investigation_ref: vref("s92-cow-investigation"),
    output_sha256: H64,
    freeze_ref: vref("s92-cow-freeze"),
    freeze_sha256: H64,
    manifest_ref: vref("s92-cow-manifest"),
    manifest_sha256: H64,
    evidence_pack_ref: vref("s92-cow-evidence-pack"),
    trace_ref: vref("s92-cow-trace"),
    cited_evidence: [
      {
        handle_ref: vref("s92-cow-handle-1"),
        excerpt_sha256: H64,
        source_revision_content_sha256: H64,
        scope_snapshot_digest: H64,
        authorization_receipt_ref: `receipt-${"b".repeat(8)}`,
        credential_generation: "credential-1",
      },
    ],
    section_sha256: H64,
  };
}

function failResult(name, error) {
  return {
    state: "FAIL",
    detail: `${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — verified export: receipt bytes carry verifiable identity.
// encode -> verification-<sha256> ref bound to bytes; decode round-trips the
// record; re-encode is byte-identical (deterministic export).
// ---------------------------------------------------------------------------
async function runVerifiedExportIdentity() {
  const name = "s92-cow-verified-export-identity";
  try {
    const distFile = resolve(ARTIFACTS_DIST, "artifact-draft-verification.js");
    const blocked = distBlocked(name, distFile);
    if (blocked) return blocked;
    assertDistCurrent(distFile, resolve(REPO, "packages/cloudflare-artifacts/src/artifact-draft-verification.ts"));
    const mod = await verificationModule();
    const encoded = await mod.encodeArtifactDraftVerification(makeV1Record());
    assert.equal(
      encoded.verification_receipt_ref,
      `verification-${encoded.sha256}`,
      "receipt ref must be verification-<sha256-of-bytes>",
    );
    const decoded = await mod.decodeArtifactDraftVerification(encoded.bytes, encoded.verification_receipt_ref);
    assert.deepEqual(decoded.record, encoded.record, "decode must round-trip the exact record");
    assert.equal(decoded.verification_receipt_ref, encoded.verification_receipt_ref);
    const reencoded = await mod.encodeArtifactDraftVerification(decoded.record);
    assert.ok(
      Buffer.from(reencoded.bytes).equals(Buffer.from(encoded.bytes)),
      "export must be deterministic: re-encode yields identical bytes",
    );
    assert.equal(encoded.record.semantic_verification, "NOT_EXECUTED", "v1 carries no model output");
    return { state: "PASS", detail: `${name}: ref=${encoded.verification_receipt_ref.slice(0, 32)}… round-trip + deterministic` };
  } catch (error) {
    return failResult(name, error);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — verified export, negative: tampered bytes and a mismatched ref
// must be rejected with ARTIFACT_DRAFT_VERIFICATION_CORRUPT (fail closed).
// ---------------------------------------------------------------------------
async function runVerifiedExportTamper() {
  const name = "s92-cow-verified-export-tamper";
  try {
    const distFile = resolve(ARTIFACTS_DIST, "artifact-draft-verification.js");
    const blocked = distBlocked(name, distFile);
    if (blocked) return blocked;
    const mod = await verificationModule();
    const encoded = await mod.encodeArtifactDraftVerification(makeV1Record());
    const tampered = new Uint8Array(encoded.bytes);
    tampered[tampered.length - 2] ^= 0x01;
    await assert.rejects(mod.decodeArtifactDraftVerification(tampered), (error) =>
      error?.code === "ARTIFACT_DRAFT_VERIFICATION_CORRUPT",
      "tampered receipt bytes must be rejected",
    );
    await assert.rejects(
      mod.decodeArtifactDraftVerification(encoded.bytes, `verification-${"0".repeat(64)}`),
      (error) => error?.code === "ARTIFACT_DRAFT_VERIFICATION_CORRUPT",
      "mismatched receipt ref must be rejected",
    );
    await assert.rejects(mod.decodeArtifactDraftVerification(new Uint8Array(0)), (error) =>
      error?.code === "ARTIFACT_DRAFT_VERIFICATION_CORRUPT",
      "empty receipt must be rejected",
    );
    return { state: "PASS", detail: `${name}: tamper/ref/empty negatives all rejected fail-closed` };
  } catch (error) {
    return failResult(name, error);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — change-review flow entry point

async function runChangeReviewEntryPoint() {
  const name = "s92-cow-change-review-entry-point";
  try {
    const contractPath = resolve(REPO, "packages/research/src/artifact-compiler.ts");
    const contract = await readFile(contractPath, "utf8");
    assert.match(
      contract,
      /reviseSection\(artifactRef:\s*VersionedRef,\s*sectionId:\s*string,\s*expectedArtifactRevision:\s*number\)/u,
      "ArtifactCompiler must declare the COW change-review entry point reviseSection",
    );
    const hits = [];
    const roots = [resolve(REPO, "packages"), resolve(REPO, "apps/eliotr-core/src")];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
          walk(path);
        } else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts")) {
          const text = readFileSync(path, "utf8");
          if (/reviseSection\s*\(/.test(text) && path !== contractPath) hits.push(path);
        }
      }
    };
    for (const root of roots) walk(root);
    if (hits.length > 0) {
      return { state: "PASS", detail: `${name}: reviseSection implemented in ${hits.join(", ")}` };
    }
    return {
      state: "BLOCKED",
      detail: `${name}: reviseSection is declared in packages/research/src/artifact-compiler.ts but has no implementation; the COW section-tree change-review producer is not implemented (registry: accepted-artifact/COW remain open)`,
    };
  } catch (error) {
    return failResult(name, error);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 — publication: an ACCEPTED publication requires an executable
// authorized publish/readback, not a source-wiring assertion. This wrapper has
// no admitted V2 draft/current owner session or bound D1/R2 fixture, so its
// outcome remains separate from the existing native and browser proof paths.
// ---------------------------------------------------------------------------
async function runPublicationAccepted() {
  const name = "s92-cow-publication-accepted";
  return {
    state: "NOT_EXECUTED",
    detail: `${name}: this wrapper has no admitted V2 draft/current owner session or bound D1/R2 fixture, so it does not execute publication/readback; related actual evidence remains in apps/eliotr-core/test/artifact-owner-loop-http.test.ts and tests/integration/browser/owner-e2e.mjs --owner-artifact. Source presence alone is not publication proof, and those separate results are not promoted here.`,
  };
}

// ---------------------------------------------------------------------------
// Scenario 5 — history readback: the draft reader exposes immutable historical
// reads (readArtifactDraft / readArtifactDraftSection). This wrapper has no
// D1/R2 fixture binding or exact artifact reference, so a local profile alone
// cannot prove the readback.
// ---------------------------------------------------------------------------
async function runHistoryReadback() {
  const name = "s92-cow-history-readback";
  try {
    const distFile = resolve(ARTIFACTS_DIST, "artifact-draft-reader.js");
    const blocked = distBlocked(name, distFile);
    if (blocked) return blocked;
    assertDistCurrent(distFile, resolve(REPO, "packages/cloudflare-artifacts/src/artifact-draft-reader.ts"));
    const mod = await readerModule();
    assert.equal(typeof mod.readArtifactDraft, "function", "historical draft read entry point must exist");
    assert.equal(typeof mod.readArtifactDraftSection, "function", "historical section read entry point must exist");
    const { localPaths } = await import(pathToFileURL(resolve(REPO, "scripts/lib/local-launch.mjs")).href);
    const paths = localPaths();
    const profileState = existsSync(paths.directory)
      ? `local profile state is present at ${paths.directory}`
      : `no local profile state is present at ${paths.directory}`;
    return {
      state: "NOT_EXECUTED",
      detail: `${name}: ${profileState}, but this scenario has no D1/R2 fixture binding or exact artifact reference and does not call readArtifactDraft/readArtifactDraftSection; historical readback remains unexecuted`,
    };
  } catch (error) {
    return failResult(name, error);
  }
}

// ---------------------------------------------------------------------------
// Scenario 6 — model policy (D1): local config pins the model gateway to the
// disabled sentinel and localEnvironment strips AI_GATEWAY_* overrides, so a
// dirty parent env can never silently enable a real gateway.
// ---------------------------------------------------------------------------
async function runModelPolicyD1() {
  const name = "s92-cow-model-policy-d1";
  try {
    const launch = await import(pathToFileURL(resolve(REPO, "scripts/lib/local-launch.mjs")).href);
    const wranglerJsonc = await readFile(resolve(REPO, "apps/eliotr-core/wrangler.jsonc"), "utf8");
    const config = launch.localConfig(JSON.parse(wranglerJsonc));
    const SENTINEL = "https://example.invalid/local-disabled";
    assert.equal(config.vars.AI_GATEWAY_REASONING_URL, SENTINEL, "reasoning gateway must be the disabled sentinel");
    assert.equal(config.vars.AI_GATEWAY_RETRIEVAL_URL, SENTINEL, "retrieval gateway must be the disabled sentinel");
    assert.equal(new URL(SENTINEL).hostname, "example.invalid", "sentinel must be unroutable");
    const scrubbed = launch.localEnvironment({ ...process.env, AI_GATEWAY_REASONING_URL: "https://real-gateway.example/x" });
    assert.ok(!("AI_GATEWAY_REASONING_URL" in scrubbed), "AI_GATEWAY_* must be stripped from the local env");
    return { state: "PASS", detail: `${name}: gateway pinned to disabled sentinel; parent-env overrides stripped` };
  } catch (error) {
    return failResult(name, error);
  }
}

// ---------------------------------------------------------------------------
// Scenario 7 — live model responses are NOT_EXECUTED: D1(b) (real gateway
// override) is an explicit runtime configuration and applicable execution authorization; this scenario guards that no live
// model call is attempted and no model output is invented meanwhile.
// ---------------------------------------------------------------------------
async function runLiveModelPending() {
  const name = "s92-cow-live-model-pending";
  try {
    const launch = await import(pathToFileURL(resolve(REPO, "scripts/lib/local-launch.mjs")).href);
    const wranglerJsonc = await readFile(resolve(REPO, "apps/eliotr-core/wrangler.jsonc"), "utf8");
    const config = launch.localConfig(JSON.parse(wranglerJsonc));
    assert.equal(
      config.vars.AI_GATEWAY_REASONING_URL,
      "https://example.invalid/local-disabled",
      "live model assertions must not run while the gateway is the disabled sentinel",
    );
    return {
      state: "NOT_EXECUTED",
      detail: `${name}: live model response assertions require current approved gateway configuration and execution authorization (real AI_GATEWAY_REASONING_URL override via local-launch override or deployed Worker + ELIOTR_MODEL_GATEWAY_TOKEN secret); no model output invented`,
    };
  } catch (error) {
    return failResult(name, error);
  }
}

export const SCENARIOS = [
  { name: "s92-cow-verified-export-identity", run: runVerifiedExportIdentity },
  { name: "s92-cow-verified-export-tamper", run: runVerifiedExportTamper },
  { name: "s92-cow-change-review-entry-point", run: runChangeReviewEntryPoint },
  { name: "s92-cow-publication-accepted", run: runPublicationAccepted },
  { name: "s92-cow-history-readback", run: runHistoryReadback },
  { name: "s92-cow-model-policy-d1", run: runModelPolicyD1 },
  { name: "s92-cow-live-model-pending", run: runLiveModelPending },
];

// Allow direct execution: node tests/integration/browser/s92-cow.mjs
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = 0;
  for (const scenario of SCENARIOS) {
    const result = await scenario.run();
    console.log(`${result.state}\t${scenario.name}${result.detail ? `\t${result.detail}` : ""}`);
    if (result.state === "FAIL") failed += 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}
