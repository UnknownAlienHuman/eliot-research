// Usage admission capability: deterministic, mocked, no live calls.
// FIX11: ADMITTED is necessary but never sufficient for a remote/billable
// mutation. Every deploy, each provisioner apply path, and
// admitHeavyOperation additionally requires the same-process admission
// capability minted ONLY by the fresh default-live collection lifecycle
// (verified browser-OAuth identity plus live collection plus ADMITTED plus
// complete live trust). No structural object, recomputable digest,
// caller-supplied string, source, or test seam mints or presents production
// authority: the mint is a non-exported function in
// lib/cloudflare-usage-admission.mjs, and only read-only predicates are
// exposed. Copies, spreads, clones, Proxies, hand-built objects, and
// persisted-bytes-deserialized objects are new identities and deny.
// Persisted receipts stay tamper-evident informational artifacts.
//
// Fictional data only. Run with:
//   node scripts/test-usage-admission-capability.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REQUIRED_METRIC_KEYS,
  buildAdmissionReceipt,
  computeSnapshotDigest,
  digestAccountId,
  evaluateUsageSnapshot,
  validateAdmissionReceipt,
} from "./lib/cloudflare-usage-envelope.mjs";
import {
  USAGE_SOURCE_LIVE,
  dailyWindowFor,
  monthlyWindowFor,
} from "./lib/cloudflare-usage-collection.mjs";
import {
  isLiveAdmissibleForCapability,
  isUsageAdmissionCapability as isProductionCapability,
  runUsagePreflight,
} from "./lib/cloudflare-usage-admission.mjs";
import {
  admitHeavyOperation,
  createBudgetLedger,
} from "./lib/cloudflare-budget-admission.mjs";
import {
  isUsageAdmissionCapability as isRedirectedCapability,
  runUsagePreflight as standinPreflight,
} from "./test-usage-gate-standin.mjs";
import { deployCloudflare } from "./deploy-cloudflare.mjs";

const ACCOUNT = "cccccccccccccccccccccccccccccccc";
const DIGEST = digestAccountId(ACCOUNT);
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Admission capability: ${name}: PASS`);
}

function baseMetrics() {
  return {
    workers_requests: 100_000, workers_cpu_ms: 200_000,
    d1_storage_bytes: 100 * 1024 * 1024, d1_rows_read: 1_000_000, d1_rows_written: 100_000,
    r2_storage_gb_month: 1, r2_class_a_ops: 10_000, r2_class_b_ops: 100_000,
    queue_ops: 10_000, do_requests: 10_000, do_gb_seconds: 1_000,
    do_sql_reads: 1_000_000, do_sql_writes: 100_000, do_storage_bytes: 100 * 1024 * 1024,
    workers_ai_neurons_per_day: 100, ai_search_instances: 5,
    ai_search_queries_month: 1_000,
    vectorize_queried_dims_month: 1_000_000, vectorize_stored_dims_month: 100_000,
  };
}

function fixtureSnapshot(overrides = {}) {
  return {
    protocol: "eliotr.cloudflare-usage-snapshot.v1",
    account_id_digest: DIGEST,
    collected_at: new Date(NOW - 300_000).toISOString(),
    window: monthlyWindowFor(NOW),
    daily_window: dailyWindowFor(NOW),
    source: "test-fixture",
    readback: { whoami_verified: true },
    metrics: { ...baseMetrics(), ...overrides },
  };
}

// A fully live-family receipt from a fixture snapshot: structurally valid
// (the Luna forgery shape), but minted without any live collection.
function fabricatedLiveFamilyReceipt(source = USAGE_SOURCE_LIVE) {
  const snapshot = { ...fixtureSnapshot(), source, readback: {} };
  const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(evaluation.decision, "ADMITTED");
  const receipt = buildAdmissionReceipt({ evaluation, snapshot, now: NOW, expectedAccountId: ACCOUNT });
  receipt.metric_evidence = receipt.metric_evidence.map((entry) => ({
    ...entry,
    provider_group: "billable-usage",
    provider_kind_class: "billing-usage-v2",
    provenance: "authoritative_billing",
    coverage_full: true,
  }));
  receipt.snapshot_digest = computeSnapshotDigest({
    accountIdDigest: receipt.account_id_digest,
    source: receipt.source,
    generation: receipt.generation,
    windows: receipt.windows,
    metrics: receipt.metrics,
    evidence: receipt.metric_evidence,
  });
  return receipt;
}

function heavyAttempt(receipt, extra = {}) {
  return admitHeavyOperation(createBudgetLedger(), {
    operation: "ingestion-commit",
    metricKey: "d1_rows_written",
    quantity: 100,
    now: NOW,
    receipt,
    expectedAccountDigest: DIGEST,
    ...extra,
  });
}

await check("issuer predicate admits only live-brand plus verified plus full trust", async () => {
  const liveTrust = {};
  for (const key of REQUIRED_METRIC_KEYS) {
    liveTrust[key] = {
      state: "trusted-partial", sources: ["billable-usage"],
      coverage: { accountId: ACCOUNT, fullAccount: true }, gap: null,
      provenance: "authoritative_billing", brand: "billing-usage-v2",
    };
  }
  const liveSnapshot = {
    ...fixtureSnapshot(), source: USAGE_SOURCE_LIVE, readback: { whoami_verified: true, metric_trust: liveTrust },
  };
  const admitted = { decision: "ADMITTED" };
  assert.equal(isLiveAdmissibleForCapability(liveSnapshot, admitted), true);
  // Each corruption below refuses issuance, never mints.
  const corruptions = [
    ["snapshot-asserted trust", () => {
      const trust = structuredClone(liveTrust);
      trust.queue_ops = { state: "unknown-untrusted", sources: [], coverage: null, gap: "x", provenance: "unavailable" };
      return { ...liveSnapshot, readback: { whoami_verified: true, metric_trust: trust } };
    }],
    ["test-only mark", () => {
      const trust = structuredClone(liveTrust);
      trust.queue_ops = { ...trust.queue_ops, state: "test-only", brand: null, testOnly: true };
      return { ...liveSnapshot, readback: { whoami_verified: true, metric_trust: trust } };
    }],
    ["brandless trust", () => {
      const trust = structuredClone(liveTrust);
      trust.queue_ops = { ...trust.queue_ops, brand: null };
      return { ...liveSnapshot, readback: { whoami_verified: true, metric_trust: trust } };
    }],
    ["non-live source", () => ({ ...liveSnapshot, source: "test-fixture" })],
    ["unverified identity", () => ({ ...liveSnapshot, readback: { metric_trust: liveTrust } })],
    ["missing trust", () => ({ ...liveSnapshot, readback: { whoami_verified: true } })],
  ];
  for (const [label, corrupt] of corruptions) {
    assert.equal(isLiveAdmissibleForCapability(corrupt(), admitted), false, label);
  }
  assert.equal(isLiveAdmissibleForCapability(liveSnapshot, { decision: "SEALED" }), false);
  assert.equal(isLiveAdmissibleForCapability(null, admitted), false);
});

await check("fabricated live-family receipt is integrity-only, every gate denies", async () => {
  // Luna bypass (1): hand-built live evidence plus a recomputed digest via
  // the exported helper. Integrity holds (validator-clean) — and that is ALL
  // it proves. No capability exists, so authorization is impossible.
  const receipt = fabricatedLiveFamilyReceipt();
  const integrity = validateAdmissionReceipt(receipt, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.decision, "ADMITTED");
  const denied = heavyAttempt(receipt);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "MISSING_ADMISSION_CAPABILITY");
  // A hand-built capability-shaped object is a new identity and also denies.
  const forgedCap = heavyAttempt(receipt, { capability: Object.freeze({}) });
  assert.equal(forgedCap.allowed, false);
  assert.equal(forgedCap.reason, "MISSING_ADMISSION_CAPABILITY");
  // The deploy mutation gate denies the same shape: an ADMITTED evaluation
  // from a staged fabricated snapshot carries no capability.
  const snapshot = { ...fixtureSnapshot(), source: USAGE_SOURCE_LIVE, readback: {} };
  const calls = [];
  const deploy = deployCloudflare({
    confirmLive: true,
    verifyCode: async () => {},
    environment: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: "secret-token",
      ELIOTR_ENVIRONMENT: "staging",
      ELIOTR_DEPLOYMENT_GENERATION: "git-test",
      ELIOTR_CUSTOM_DOMAIN: "1",
      ELIOTR_ACCESS_HOSTNAME: "research.example.com",
      ELIOTR_OWNER_EMAILS: "owner@example.com",
      ELIOTR_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
      ELIOTR_ACCESS_AUDIENCE: "test-aud",
      ELIOTR_ACCESS_SERVICE_PRINCIPALS: "",
    },
    now: () => NOW,
    log: () => {},
    execute: (command, args) => { calls.push(`${command} ${args.join(" ")}`); },
    read: async () => { throw new Error("must not read"); },
    archive: async () => { calls.push("archive"); },
    save: async () => { calls.push("save"); },
    fetchImpl: async () => { throw new Error("billable must not be invoked"); },
    usageSnapshot: JSON.stringify(snapshot),
  });
  await assert.rejects(deploy, /admission capability/u);
  assert.ok(!calls.includes("archive"), "deploy archived before capability denial");
  assert.ok(!calls.some((call) => call.includes("d1 migrations apply")), "deploy migrated without capability");
  assert.ok(!calls.some((call) => call.startsWith("pnpm exec wrangler deploy ")), "deploy uploaded without capability");
  assert.ok(!calls.includes("save"), "deploy saved without capability");
});

await check("source change plus digest recompute stays unauthenticated", async () => {
  // Luna-adjacent: the attacker changes the source and recomputes a
  // consistent digest with the exported helper. The binding is consistent,
  // so integrity still verifies — but nothing was authenticated, and every
  // gate still denies without the same-process mint.
  const receipt = fabricatedLiveFamilyReceipt();
  receipt.source = "attacker-controlled-source";
  receipt.snapshot_digest = computeSnapshotDigest({
    accountIdDigest: receipt.account_id_digest,
    source: receipt.source,
    generation: receipt.generation,
    windows: receipt.windows,
    metrics: receipt.metrics,
    evidence: receipt.metric_evidence,
  });
  const integrity = validateAdmissionReceipt(receipt, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(integrity.ok, true);
  const denied = heavyAttempt(receipt);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "MISSING_ADMISSION_CAPABILITY");
});

await check("copies of a genuine capability fail identity", async () => {
  // A genuine capability minted by the authorized test issuer in this
  // process (standin module, reachable here only because this test process
  // loaded the test-only standin directly — production never does).
  const staged = JSON.stringify(fixtureSnapshot());
  process.env.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON = staged;
  let genuine;
  try {
    const result = await standinPreflight({
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "static-token" },
      nowMs: NOW,
      providers: [],
    });
    assert.equal(result.decision, "ADMITTED");
    genuine = result.capability;
  } finally {
    delete process.env.ELIOTR_TEST_SPAWN_SNAPSHOT_JSON;
  }
  assert.ok(genuine, "standin must mint a test capability on ADMITTED");
  assert.equal(isRedirectedCapability(genuine), true);
  assert.equal(isProductionCapability(genuine), false);
  // Every structural copy is a new identity and denies under both predicates.
  const copies = [
    ["copy", { ...genuine }],
    ["clone", structuredClone(genuine)],
    ["proxy", new Proxy(genuine, {})],
    ["hand-built", Object.freeze({ testAdmission: true })],
    ["deserialized", JSON.parse(JSON.stringify(genuine))],
  ];
  for (const [label, copy] of copies) {
    assert.equal(isRedirectedCapability(copy), false, label);
    assert.equal(isProductionCapability(copy), false, label);
  }
});

await check("production preflight never mints on snapshot or sealed paths", async () => {
  // Explicit snapshot path: ADMITTED evaluation, capability always null.
  const staged = await runUsagePreflight({
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "static-token" },
    nowMs: NOW,
    providers: [],
    snapshot: JSON.stringify(fixtureSnapshot()),
  });
  assert.equal(staged.decision, "ADMITTED");
  assert.equal(staged.capability, null);
  // Sealed api-token path: no capability either.
  const sealed = await runUsagePreflight({
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "static-token" },
    nowMs: NOW,
    providers: [],
  });
  assert.equal(sealed.decision, "SEALED");
  assert.equal(sealed.capability, null);
});

await check("genuine default-live collection control and trust argument", async () => {
  // Leg 1 — brand on live defaults without touching the network: mere
  // construction with zero transport overrides carries the brand, while any
  // caller-supplied transport stays test-only.
  const { createAiSearchInventoryProvider, isInventoryProvider } = await import("./lib/cloudflare-usage-collection.mjs");
  const { createBillableUsageProvider, isUsageVBillingProvider } = await import("./lib/cloudflare-usage-collection.mjs");
  const { isTestTransportProvider } = await import("./lib/cloudflare-usage-collection.mjs");
  const liveInventory = createAiSearchInventoryProvider({ group: "ai-search-inventory-list", covers: ["ai_search_instances"] });
  const liveBilling = createBillableUsageProvider({ group: "billable-usage", covers: [] });
  assert.equal(isInventoryProvider(liveInventory), true);
  assert.equal(isUsageVBillingProvider(liveBilling), true);
  assert.equal(isTestTransportProvider(liveInventory), false);
  // Leg 2 — OAuth-mode plumbing with an explicit empty provider override
  // reaches the gate, verifies identity, collects with zero counters, and
  // seals with no capability and no network. The production omission path is
  // covered by the default-registry test in test-wrangler-oauth.mjs.
  const fresh = "2030-01-01T00:00:00.000Z";
  const gate = await runUsagePreflight({
    env: { ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth", ELIOTR_WRANGLER_CONFIG_FILE: "test.toml", CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    nowMs: NOW,
    readFile: async () => `oauth_token = "fictional"\nexpiration_time = "${fresh}"\n`,
    getWhoamiOutput: async () => `Account ${ACCOUNT} via browser OAuth`,
    providers: [],
  });
  assert.equal(gate.decision, "SEALED");
  assert.equal(gate.capability, null);
  // Leg 3 — the TEST loader path reaches the test gate (proves gate
  // mechanics end to end): spawned provisioner apply suites cover this with
  // real children; the in-process standin mint above covers the predicate.
  // TRUST ARGUMENT (documented residual): a production capability additionally
  // requires live-network counter success, which deterministic tests never
  // perform (live Cloudflare NOT_EXECUTED). The three legs compose it —
  // brand attaches only to default transports, the verified lifecycle runs
  // (leg 2), the issuer predicate admits only complete live trust, and gate
  // mechanics accept only exact minted identity — while no mint API is
  // exposed anywhere: the issuer predicate above is read-only over
  // caller-supplied structures and mints nothing.
});

await check("persisted receipts never authorize, same-process and fresh-process", async () => {
  const receipt = fabricatedLiveFamilyReceipt();
  const directory = await mkdtemp(join(tmpdir(), "eliotr-capability-test-"));
  try {
    const receiptPath = join(directory, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    // Same process, deserialized bytes (new objects throughout): denied.
    const deserialized = JSON.parse(await readFile(receiptPath, "utf8"));
    const sameProcess = heavyAttempt(deserialized);
    assert.equal(sameProcess.allowed, false);
    assert.equal(sameProcess.reason, "MISSING_ADMISSION_CAPABILITY");
    // Fresh process, deserialized bytes: denied, with and without a
    // hand-built capability-shaped object (identity cannot cross processes).
    const driverPath = join(directory, "child.mjs");
    await writeFile(driverPath, [
      "import { readFile } from \"node:fs/promises\";",
      `import { admitHeavyOperation, createBudgetLedger } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./lib/cloudflare-budget-admission.mjs", import.meta.url))).href)};`,
      `import { digestAccountId } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./lib/cloudflare-usage-envelope.mjs", import.meta.url))).href)};`,
      "const receipt = JSON.parse(await readFile(process.argv[2], \"utf8\"));",
      "const digest = digestAccountId(process.argv[3]);",
      "const now = Number.parseInt(process.argv[4], 10);",
      "const attempt = (capability) => admitHeavyOperation(createBudgetLedger(),",
      "  { operation: \"ingestion-commit\", metricKey: \"d1_rows_written\", quantity: 100, now, receipt, expectedAccountDigest: digest, capability });",
      "console.log(JSON.stringify([attempt(null), attempt(Object.freeze({}))]));",
      "",
    ].join("\n"), "utf8");
    const child = await new Promise((resolveChild) => {
      const proc = spawn(process.execPath, [driverPath, receiptPath, ACCOUNT, String(NOW)], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => { stdout += chunk; });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 30_000);
      proc.on("close", (status) => { clearTimeout(timeout); resolveChild({ status, stdout, stderr }); });
    });
    assert.equal(child.status, 0, `child failed: ${child.stderr}`);
    const [withoutCap, withForgedCap] = JSON.parse(child.stdout);
    assert.equal(withoutCap.allowed, false);
    assert.equal(withoutCap.reason, "MISSING_ADMISSION_CAPABILITY");
    assert.equal(withForgedCap.allowed, false);
    assert.equal(withForgedCap.reason, "MISSING_ADMISSION_CAPABILITY");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

console.log(`Admission capability: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
