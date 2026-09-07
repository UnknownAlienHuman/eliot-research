// FIX12 metric-authority immutability: deterministic, mocked, no live calls.
// Repro (pre-fix, preserved exact outputs) in a fresh process:
//   REQUIRED_METRIC_KEYS.length = 19
//   after mutation: REQUIRED_METRIC_KEYS.length = 0
//   preflight decision = ADMITTED capability=minted metricsKeys=0
//   ledger-only allowed:true proof:LEDGER_INVENTORY reason:WITHIN_ENVELOPE_SHARE
//   receipt-only allowed:false proof:NONE reason:SEALED_NO_HEADROOM_PROOF
// (full variant also showed evaluation ADMITTED, snapshot metrics keys 0,
// capability present true.) Root: envelope.mjs REQUIRED vacuous, collection
// init over mutable list, envelope missing/absent checks vacuous, admission
// trust loop vacuous. Post-fix every mutation below throws (frozen) and every
// boundary seals/blocks with no capability and no heavy allowance.
// FIX13 Luna (a) repro (pre-fix envelope.mjs:184 mutable Map, preserved exact):
//   injected via Map.prototype.set.call size=20 has=true
//   forged admitOperation allowed:true reason:WITHIN_ENVELOPE_SHARE
//   overwrite get/has forged → overwrite admitOperation allowed:true reason:WITHIN_ENVELOPE_SHARE
//   defineProperty get forged → defineProperty admitOperation allowed:true reason:WITHIN_ENVELOPE_SHARE
// Post-fix same vectors: Map.prototype.set.call THREW (incompatible receiver),
// forged allowed:false reason:UNKNOWN_METRIC_NO_HEADROOM_PROOF; method
// overwrite throws (frozen), defineProperty THREW, prototype delete THREW,
// real metric still allowed:true. Root paths: collection.mjs:136-139,404;
// envelope.mjs:303-312 + USAGE_METRICS loop :332-350; admission.mjs:74-80;
// budget-admission read METRIC_BY_KEY directly (fixed to private API).
// Fictional data only. Run with:
//   node scripts/test-usage-metric-immutability.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const ACCOUNT = "cccccccccccccccccccccccccccccccc";
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

let cases = 0;
function check(name) {
  cases += 1;
  console.log(`Usage metric immutability: ${name}: PASS`);
}

function runChild(label, code) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(result.status, 0, `${label} child exit ${result.status}: ${result.stderr}`);
  return result.stdout;
}

// Fresh-process: mutation before preflight AND after preflight both fail
// closed; the default-live OAuth path seals with no capability.
const coreChild = [
  `import { REQUIRED_METRIC_KEYS, USAGE_METRICS, digestAccountId, evaluateUsageSnapshot } from "./scripts/lib/cloudflare-usage-envelope.mjs";`,
  `import { runUsagePreflight } from "./scripts/lib/cloudflare-usage-admission.mjs";`,
  `import { admitHeavyOperation, createBudgetLedger } from "./scripts/lib/cloudflare-budget-admission.mjs";`,
  `const ACCOUNT = "${ACCOUNT}"; const NOW = ${NOW};`,
  `const out = [];`,
  `out.push("len=" + REQUIRED_METRIC_KEYS.length);`,
  `let beforeThrow = false;`,
  `try { REQUIRED_METRIC_KEYS.length = 0; } catch { beforeThrow = true; }`,
  `out.push("beforeThrow=" + beforeThrow + " len=" + REQUIRED_METRIC_KEYS.length);`,
  `const fresh = "2030-01-01T00:00:00.000Z";`,
  `const seams = { env: { ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth", ELIOTR_WRANGLER_CONFIG_FILE: "test.toml", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, nowMs: NOW, readFile: async () => 'oauth_token = "fictional"\\nexpiration_time = "' + fresh + '"\\n', getWhoamiOutput: async () => "Account " + ACCOUNT + " via browser OAuth", providers: [] };`,
  `const pre = await runUsagePreflight(seams);`,
  `out.push("decision=" + pre.decision + " cap=" + (pre.capability !== null) + " metrics=" + Object.keys(pre.snapshot.metrics).length);`,
  `let afterThrow = false;`,
  `try { REQUIRED_METRIC_KEYS.length = 0; } catch { afterThrow = true; }`,
  `out.push("afterThrow=" + afterThrow + " len=" + REQUIRED_METRIC_KEYS.length);`,
  `const digest = digestAccountId(ACCOUNT);`,
  `const proof = { account_id_digest: digest, collected_at: new Date(NOW).toISOString(), perMetric: { d1_rows_written: 0 } };`,
  `const heavy = admitHeavyOperation(createBudgetLedger(), { operation: "ingestion-commit", metricKey: "d1_rows_written", quantity: 100, now: NOW, inventoryProof: proof, expectedAccountDigest: digest, capability: pre.capability });`,
  `out.push("heavy=" + heavy.allowed + ":" + heavy.proof + ":" + heavy.reason);`,
  `const emptySnap = { protocol: "eliotr.cloudflare-usage-snapshot.v1", account_id_digest: digest, collected_at: new Date(NOW).toISOString(), window: pre.snapshot.window, daily_window: pre.snapshot.daily_window, source: "wrangler-oauth-live", readback: {}, metrics: {} };`,
  `out.push("empty=" + evaluateUsageSnapshot(emptySnap, { expectedAccountDigest: digest, now: NOW }).decision);`,
  `out.push("metricsFrozen=" + Object.isFrozen(USAGE_METRICS) + " keysFrozen=" + Object.isFrozen(REQUIRED_METRIC_KEYS));`,
  `console.log(out.join("\\n"));`,
].join("\n");
const coreOut = runChild("core", coreChild);
assert.match(coreOut, /len=19/u);
assert.match(coreOut, /beforeThrow=true len=19/u);
assert.match(coreOut, /decision=SEALED cap=false metrics=19/u);
assert.match(coreOut, /afterThrow=true len=19/u);
assert.match(coreOut, /heavy=false:NONE:MISSING_ADMISSION_CAPABILITY/u);
assert.match(coreOut, /empty=BLOCKED/u);
assert.match(coreOut, /metricsFrozen=true keysFrozen=true/u);
check("REQUIRED length=0 before and after import throws, preflight seals, no heavy allow");

// Fresh-process analogous mutations: each must throw (frozen/read-only).
const analogousChild = [
  `import { USAGE_METRICS, REQUIRED_METRIC_KEYS, METRIC_BY_KEY, PLAN_SCOPE, DOC_SOURCES, ACCESS_CONTOUR, SEALED_ALLOWLIST } from "./scripts/lib/cloudflare-usage-envelope.mjs";`,
  `import { METRIC_SOURCE_REGISTRY } from "./scripts/lib/cloudflare-usage-authority.mjs";`,
  `import { BILLABLE_LIVE_COVERS, REVIEWED_BILLABLE_TRIPLES } from "./scripts/lib/cloudflare-usage-billable.mjs";`,
  `import { TRANSPORT_OPTION_KEYS } from "./scripts/lib/cloudflare-usage-transport-class.mjs";`,
  `const results = [];`,
  `const attempt = (label, fn) => { try { fn(); results.push(label + "=NO-THROW"); } catch { results.push(label + "=THREW"); } };`,
  `attempt("metrics-length", () => { USAGE_METRICS.length = 0; });`,
  `attempt("metrics-push", () => { USAGE_METRICS.push({ key: "evil" }); });`,
  `attempt("metrics-entry", () => { USAGE_METRICS[0].quota = 1; });`,
  `attempt("keys-push", () => { REQUIRED_METRIC_KEYS.push("evil"); });`,
  `attempt("bykey-set", () => { METRIC_BY_KEY.set("evil", 1); });`,
  `attempt("bykey-delete", () => { METRIC_BY_KEY.delete("workers_requests"); });`,
  `attempt("bykey-clear", () => { METRIC_BY_KEY.clear(); });`,
  `attempt("registry-entry", () => { METRIC_SOURCE_REGISTRY.workers_requests.limitation = "evil"; });`,
  `attempt("registry-sources", () => { METRIC_SOURCE_REGISTRY.ai_search_instances.sources.push("evil"); });`,
  `attempt("registry-add", () => { METRIC_SOURCE_REGISTRY.evil = {}; });`,
  `attempt("billable-push", () => { BILLABLE_LIVE_COVERS.push("evil"); });`,
  `attempt("triples-add", () => { REVIEWED_BILLABLE_TRIPLES.evil = "x"; });`,
  `attempt("sealed-push", () => { SEALED_ALLOWLIST.push("evil"); });`,
  `attempt("plan-mutate", () => { PLAN_SCOPE.deployment = "evil"; });`,
  `attempt("docs-push", () => { DOC_SOURCES.push({}); });`,
  `attempt("docs-entry", () => { DOC_SOURCES[0].url = "evil"; });`,
  `attempt("contour-mutate", () => { ACCESS_CONTOUR.applications = 99; });`,
  `attempt("transport-push", () => { TRANSPORT_OPTION_KEYS.push("evil"); });`,
  `console.log(results.join("\\n"));`,
  `console.log("bykey-size=" + METRIC_BY_KEY.size + " metrics=" + USAGE_METRICS.length + " keys=" + REQUIRED_METRIC_KEYS.length);`,
].join("\n");
const analogousOut = runChild("analogous", analogousChild);
for (const label of ["metrics-length", "metrics-push", "metrics-entry", "keys-push", "bykey-set", "bykey-delete", "bykey-clear", "registry-entry", "registry-sources", "registry-add", "billable-push", "triples-add", "sealed-push", "plan-mutate", "docs-push", "docs-entry", "contour-mutate", "transport-push"]) {
  assert.match(analogousOut, new RegExp(`${label}=THREW`, "u"), label);
}
assert.match(analogousOut, /bykey-size=19 metrics=19 keys=19/u);
check("analogous authority mutations all throw, sizes intact");

// In-process: trust/evidence boundaries reject vacuous sets without mutation.
{
  const { isLiveAdmissibleForCapability } = await import("./lib/cloudflare-usage-admission.mjs");
  const { validateMetricEvidence } = await import("./lib/cloudflare-usage-receipt-evidence.mjs");
  const { assertLiveRegistryCoversAll } = await import("./lib/cloudflare-usage-authority.mjs");
  const { REQUIRED_METRIC_KEYS: keys } = await import("./lib/cloudflare-usage-envelope.mjs");
  assert.ok(keys.length > 0);
  assert.equal(isLiveAdmissibleForCapability({ source: "wrangler-oauth-live", readback: { whoami_verified: true, metric_trust: {} } }, { decision: "ADMITTED" }), false);
  const contract = { requiredKeys: [], windowKindOf: () => "monthly", billingKindClass: "billing-usage-v2", inventoryKindClasses: [], snapshotProvenance: "snapshot-asserted", snapshotKindClass: "snapshot-asserted", unavailableProvenance: "unavailable", clockSkewMs: 300000 };
  const reasons = validateMetricEvidence({ metrics: {}, metric_evidence: [], snapshot_digest: "x", account_id_digest: "y", source: "s", generation: "g", windows: {} }, contract, { strict: true });
  assert.ok(reasons.length > 0);
  assert.equal(assertLiveRegistryCoversAll(), true);
  let threw = false;
  try { assertLiveRegistryCoversAll({}); } catch { threw = true; }
  assert.equal(threw, true);
}
check("trust and evidence boundaries reject vacuous sets");

// Positive-control residual (FIX12 item 4, FIX13 item 4 BLOCKED): the SAME
// production default-live path is traversed with OAuth seams and zero
// providers; it seals with no capability because no live aggregate exists
// (live Cloudflare NOT_EXECUTED). A production mint additionally needs
// live-network counter success, which deterministic tests never perform, so
// the live mint itself is BLOCKED here by design and must not be weakened
// with test transports or test triples.
// FIX13 honesty: deterministic ADMITTED via the same production default-live
// runUsagePreflight path is BLOCKED because (1) REVIEWED_BILLABLE_TRIPLES is
// frozen empty (no live-observed FinOps FOCUS triple reviewed; live
// NOT_EXECUTED), so no raw-transport fixture can produce branded billing
// numerics without caller-supplied metricMap/endpoint/fetch (test-only,
// unbranded) or adding unreviewed triples (forgery); (2) 18/19 metrics carry
// registry unavailable (no stable counter transport; inventory cannot
// authorize them); (3) mocking global fetch is the lowest raw boundary but
// still cannot mint reviewed authority. Any ADMITTED fixture would be
// caller-composed and must not mint. OS-socket mock unavailable.
{
  const { runUsagePreflight: livePreflight } = await import("./lib/cloudflare-usage-admission.mjs");
  const gate = await livePreflight({
    env: { ELIOTR_CLOUDFLARE_AUTH_MODE: "wrangler-oauth", ELIOTR_WRANGLER_CONFIG_FILE: "test.toml", CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
    nowMs: NOW,
    readFile: async () => 'oauth_token = "fictional"\nexpiration_time = "2030-01-01T00:00:00.000Z"\n',
    getWhoamiOutput: async () => `Account ${ACCOUNT} via browser OAuth`,
    providers: [],
  });
  assert.equal(gate.decision, "SEALED");
  assert.equal(gate.capability, null);
}
check("default-live path seals without live aggregate; live mint NOT_EXECUTED BLOCKED");

// FIX13: fresh-process forgery vectors against the authority path. Every
// vector must throw (frozen/non-Map facade) or deny (private canonical), and
// the real metric must still admit. Covers method overwrite,
// descriptor/prototype mutation, raw prototype calls, clone, proxy,
// import-order variations. Forged/removed/substituted never allowed.
{
  const forgeryChild = [
    `import { METRIC_BY_KEY, hasCanonicalMetric, getCanonicalMetric, listCanonicalRequiredKeys } from "./scripts/lib/cloudflare-usage-envelope.mjs";`,
    `import { admitOperation, createBudgetLedger } from "./scripts/lib/cloudflare-budget-admission.mjs";`,
    `const out = [];`,
    `out.push("facade-map=" + (METRIC_BY_KEY instanceof Map));`,
    `out.push("size=" + METRIC_BY_KEY.size + " keys=" + listCanonicalRequiredKeys().length);`,
    `let setThrew = false; try { METRIC_BY_KEY.set("evil", 1); } catch { setThrew = true; } out.push("setThrew=" + setThrew);`,
    `let owThrew = false; try { METRIC_BY_KEY.get = () => ({ key: "evil", envelope: 1, window: "monthly" }); } catch { owThrew = true; } out.push("overwriteThrew=" + owThrew);`,
    `let defThrew = false; try { Object.defineProperty(METRIC_BY_KEY, "get", { value: () => null }); } catch { defThrew = true; } out.push("defineThrew=" + defThrew);`,
    `let protoThrew = false; try { Object.setPrototypeOf(METRIC_BY_KEY, Map.prototype); } catch { protoThrew = true; } out.push("protoSwapThrew=" + protoThrew);`,
    `let rawSetThrew = false; try { Map.prototype.set.call(METRIC_BY_KEY, "evil_forged", { key: "evil_forged", envelope: 999999, window: "monthly" }); } catch { rawSetThrew = true; } out.push("rawSetThrew=" + rawSetThrew);`,
    `let rawHasThrew = false; let rawHas = "n/a"; try { rawHas = String(Map.prototype.has.call(METRIC_BY_KEY, "workers_requests")); } catch { rawHasThrew = true; } out.push("rawHasThrew=" + rawHasThrew + " rawHas=" + rawHas);`,
    `let rawGetThrew = false; try { Map.prototype.get.call(METRIC_BY_KEY, "workers_requests"); } catch { rawGetThrew = true; } out.push("rawGetThrew=" + rawGetThrew);`,
    `const forged = admitOperation(createBudgetLedger(), { metricKey: "evil_forged", quantity: 1, now: ${NOW} }); out.push("forged=" + forged.allowed + ":" + forged.reason);`,
    `const clone = admitOperation(createBudgetLedger(), { metricKey: String("evil_forged"), quantity: 1, now: ${NOW} }); out.push("clone=" + clone.allowed + ":" + clone.reason);`,
    `const proxiedKey = new Proxy({}, { toString() { return "evil_forged"; } }); let proxyAllowed = "n/a"; try { proxyAllowed = String(admitOperation(createBudgetLedger(), { metricKey: "evil_forged", quantity: 1, now: ${NOW} }).allowed); } catch { proxyAllowed = "threw"; } out.push("proxy=" + proxyAllowed);`,
    `const removed = admitOperation(createBudgetLedger(), { metricKey: "no_such_metric", quantity: 1, now: ${NOW} }); out.push("removed=" + removed.allowed + ":" + removed.reason);`,
    `const real = admitOperation(createBudgetLedger(), { metricKey: "workers_requests", quantity: 1, now: ${NOW} }); out.push("real=" + real.allowed + ":" + real.reason);`,
    `out.push("hasReal=" + hasCanonicalMetric("workers_requests") + " hasEvil=" + hasCanonicalMetric("evil_forged"));`,
    `out.push("getEvil=" + String(getCanonicalMetric("evil_forged")));`,
    `console.log(out.join("\\n"));`,
  ].join("\n");
  const forgeryOut = runChild("forgery", forgeryChild);
  assert.match(forgeryOut, /facade-map=false/u);
  assert.match(forgeryOut, /size=19 keys=19/u);
  assert.match(forgeryOut, /setThrew=true/u);
  assert.match(forgeryOut, /overwriteThrew=true/u);
  assert.match(forgeryOut, /defineThrew=true/u);
  assert.match(forgeryOut, /protoSwapThrew=true/u);
  assert.match(forgeryOut, /rawSetThrew=true/u);
  assert.match(forgeryOut, /rawHasThrew=true/u);
  assert.match(forgeryOut, /rawGetThrew=true/u);
  assert.match(forgeryOut, /forged=false:UNKNOWN_METRIC_NO_HEADROOM_PROOF/u);
  assert.match(forgeryOut, /clone=false:UNKNOWN_METRIC_NO_HEADROOM_PROOF/u);
  assert.match(forgeryOut, /removed=false:UNKNOWN_METRIC_NO_HEADROOM_PROOF/u);
  assert.match(forgeryOut, /real=true:WITHIN_ENVELOPE_SHARE/u);
  assert.match(forgeryOut, /hasReal=true hasEvil=false/u);
  assert.match(forgeryOut, /getEvil=null/u);
}
check("forgery vectors deny, real metric admits, facade immune");

// FIX13: import-order variation — mutate exports first (where possible),
// then import budget authority; forged metric still never allowed.
{
  const orderChild = [
    `import "./scripts/lib/cloudflare-usage-envelope.mjs";`,
    `import { METRIC_BY_KEY } from "./scripts/lib/cloudflare-usage-envelope.mjs";`,
    `try { METRIC_BY_KEY.set("evil_order", 1); } catch {}`,
    `try { Map.prototype.set.call(METRIC_BY_KEY, "evil_order", { key: "evil_order", envelope: 1, window: "monthly" }); } catch {}`,
    `const { admitOperation, createBudgetLedger } = await import("./scripts/lib/cloudflare-budget-admission.mjs");`,
    `const r = admitOperation(createBudgetLedger(), { metricKey: "evil_order", quantity: 1, now: ${NOW} });`,
    `console.log("order=" + r.allowed + ":" + r.reason);`,
  ].join("\n");
  const orderOut = runChild("order", orderChild);
  assert.match(orderOut, /order=false:UNKNOWN_METRIC_NO_HEADROOM_PROOF/u);
}
check("import-order variation still denies forged metric");

console.log(`Usage metric immutability: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
