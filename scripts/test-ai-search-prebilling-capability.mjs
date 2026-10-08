import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isUsageAdmissionCapability } from "./lib/cloudflare-usage-admission.mjs";
import {
  AI_SEARCH_PREBILLING_CUTOFF_MS,
  assertAiSearchPrebillingManifest,
  consumeAiSearchPrebillingMetadataPost,
  consumeBoundPrebillingAllowance,
  evaluateAiSearchPrebillingClock,
  issueAiSearchPrebillingMetadataCapability,
  planAiSearchPrebillingMetadataPosts,
  validateCompleteAiSearchListPages,
} from "./lib/cloudflare-ai-search-prebilling-capability.mjs";

let cases = 0;
function check(label, run) {
  run();
  cases += 1;
  console.log(`PASS ${label}`);
}

async function checkAsync(label, run) {
  await run();
  cases += 1;
  console.log(`PASS ${label}`);
}

const ACCOUNT = "a".repeat(32);
const NOW = Date.parse("2026-10-30T12:00:00.000Z");

function manifestFixture() {
  return {
    protocol: "eliotr.ai-search-generation.v1",
    namespace: "eliotr",
    generation: "g2-qwen3-2026-09-03",
    instances: ["private-prose-g2", "private-literal-g2", "wiki-g2", "artifact-g2", "web-capture-g2"].map((id) => ({
      id,
      create: { id, embedding_model: "@cf/test/embedding", index_method: { keyword: true } },
    })),
  };
}

function completePage(result, page = 1, total = result.length, totalPages = undefined, perPage = 100) {
  const resultInfo = { page, per_page: perPage, count: result.length, total_count: total };
  if (totalPages !== undefined) resultInfo.total_pages = totalPages;
  return {
    success: true,
    result,
    result_info: resultInfo,
  };
}

function inventory(namespaceRows = [{ name: "default" }], instancesByNamespace = new Map([[
  "default", [],
]])) {
  return { namespaceRows, instancesByNamespace };
}

check("complete pagination accepts Cloudflare's actual namespace envelope without synthetic ids", () => {
  const actualNamespacePage = {
    success: true,
    result: [{
      name: "default",
      description: null,
      created_at: "2026-09-06T03:38:30.000Z",
      public_endpoint_id: null,
      public_endpoint_params: null,
    }],
    result_info: { page: 1, per_page: 100, count: 1, total_count: 1 },
  };
  assert.deepEqual(validateCompleteAiSearchListPages([actualNamespacePage], {
    identityFields: ["name"], label: "namespace",
  }), actualNamespacePage.result);
});

check("complete pagination accepts ordered full coverage and coherent empty responses", () => {
  const rows = [
    completePage([{ id: "a" }, { id: "b" }], 1, 3, undefined, 2),
    completePage([{ id: "c" }], 2, 3, undefined, 2),
  ];
  assert.deepEqual(validateCompleteAiSearchListPages(rows, { perPage: 2, identityFields: ["id"] }), [
    { id: "a" }, { id: "b" }, { id: "c" },
  ]);
  assert.deepEqual(validateCompleteAiSearchListPages([
    completePage([], 1, 0),
  ]), []);
  assert.deepEqual(validateCompleteAiSearchListPages([
    completePage([{ id: "a" }, { id: "b" }], 1, 3, 2, 2),
    completePage([{ id: "c" }], 2, 3, 2, 2),
  ], { perPage: 2, identityFields: ["id"] }), [{ id: "a" }, { id: "b" }, { id: "c" }]);
});

check("partial, inconsistent, duplicate, and malformed inventory pagination denies", () => {
  const page1 = completePage([{ id: "a" }], 1, 2, undefined, 1);
  assert.throws(() => validateCompleteAiSearchListPages([page1], { perPage: 1 }), /partial/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    page1,
    completePage([{ id: "b" }], 2, 3, undefined, 1),
  ], { perPage: 1 }), /pagination changed/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    completePage([{ id: "same" }, { id: "same" }]),
  ]), /duplicate id/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    completePage([{ id: "a" }], 1, 3, 2, 2),
    completePage([{ id: "b" }], 2, 3, 2, 2),
  ], { perPage: 2 }), /short or oversized/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    completePage([{ id: "a" }], 1, 3, undefined, 2),
    completePage([{ id: "b" }, { id: "c" }], 2, 3, undefined, 2),
  ], { perPage: 2 }), /short or oversized/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    completePage([{ id: "a" }, { id: "b" }], 1, 3, undefined, 2),
    completePage([{ id: "c" }], 2, 3, 2, 2),
  ], { perPage: 2 }), /pagination changed/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    { ...completePage([{ id: "a" }]), result_info: { page: 1, per_page: 100, count: 1, total_count: 101, total_pages: 1 } },
  ]), /contradict/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    { ...completePage([]), result_info: { page: 1, per_page: 100, count: 0, total_count: 1, total_pages: 1 } },
  ]), /partial|short/u);
  assert.throws(() => validateCompleteAiSearchListPages([
    completePage([{ name: "same" }, { name: "same" }]),
  ], { identityFields: ["name"], label: "namespace" }), /duplicate name/u);
});

check("trusted clock requires fresh server Date evidence, bounded skew, and prebilling expiry", () => {
  const observations = [{ serverDateMs: NOW, observedLocalMs: NOW }];
  const expires = evaluateAiSearchPrebillingClock({ localNowMs: NOW, observations });
  assert.equal(expires, NOW + 30_000);
  assert.ok(expires < AI_SEARCH_PREBILLING_CUTOFF_MS);
  assert.throws(() => evaluateAiSearchPrebillingClock({ localNowMs: NOW, observations: [] }), /date evidence/u);
  assert.throws(() => evaluateAiSearchPrebillingClock({ localNowMs: NOW, observations: [
    { serverDateMs: NOW - 121_000, observedLocalMs: NOW },
  ] }), /clock-skew/u);
  assert.throws(() => evaluateAiSearchPrebillingClock({ localNowMs: NOW, observations: [
    { serverDateMs: NOW - 1, observedLocalMs: NOW - 121_000 },
  ] }), /stale/u);
  const justBeforeCutoff = AI_SEARCH_PREBILLING_CUTOFF_MS - 1;
  assert.equal(evaluateAiSearchPrebillingClock({ localNowMs: justBeforeCutoff, observations: [
    { serverDateMs: justBeforeCutoff, observedLocalMs: justBeforeCutoff },
  ] }), AI_SEARCH_PREBILLING_CUTOFF_MS);
  assert.throws(() => evaluateAiSearchPrebillingClock({ localNowMs: AI_SEARCH_PREBILLING_CUTOFF_MS,
    observations: [{ serverDateMs: AI_SEARCH_PREBILLING_CUTOFF_MS, observedLocalMs: AI_SEARCH_PREBILLING_CUTOFF_MS }] }), /expired/u);
});

check("plan binds the exact namespace and five empty manifest bodies to a fresh full inventory", () => {
  const manifest = manifestFixture();
  const source = JSON.stringify(manifest);
  const plan = planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest,
    manifestSource: source,
    ...inventory(),
  });
  assert.equal(plan.posts.length, 6);
  assert.deepEqual(plan.posts.map(({ method }) => method), Array(6).fill("POST"));
  assert.equal(plan.posts[0].path, `/accounts/${ACCOUNT}/ai-search/namespaces`);
  assert.deepEqual(plan.posts[0].body, {
    name: "eliotr",
    description: "Eliot Research private managed retrieval namespace",
  });
  assert.equal(plan.posts.slice(1).every((post) => post.path === `/accounts/${ACCOUNT}/ai-search/namespaces/eliotr/instances`), true);
  assert.equal(plan.posts.slice(1).every((post) => !Object.hasOwn(post.body, "source") && !Object.hasOwn(post.body, "items")), true);
  assert.equal(plan.manifestDigest.length, 64);
  assert.equal(plan.inventoryDigest.length, 64);
});

check("checked-in manifest matches the approved fixed metadata identity set", () => {
  const source = readFileSync(fileURLToPath(new URL("../infra/ai-search/instances.json", import.meta.url)), "utf8");
  const manifest = JSON.parse(source);
  const plan = planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest,
    manifestSource: source,
    ...inventory(),
  });
  assert.equal(plan.posts.length, 6);
  assert.equal(plan.manifestDigest.length, 64);
});

check("one-use allowance denies route, body, account, method drift and replay", () => {
  const plan = planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest: manifestFixture(),
    manifestSource: JSON.stringify(manifestFixture()),
    ...inventory(),
  });
  const first = plan.posts[0];
  const remaining = new Set(plan.posts.map((post) => post.key));
  const candidate = { method: first.method, path: first.path, body: first.body, accountId: ACCOUNT };
  assert.equal(consumeBoundPrebillingAllowance(remaining, ACCOUNT, candidate), true);
  assert.equal(remaining.size, 5);
  assert.throws(() => consumeBoundPrebillingAllowance(remaining, ACCOUNT, candidate), /remaining exact/u);
  assert.throws(() => consumeBoundPrebillingAllowance(new Set(plan.posts.map((post) => post.key)), ACCOUNT, {
    ...candidate, path: `${first.path}/source`,
  }), /remaining exact/u);
  assert.throws(() => consumeBoundPrebillingAllowance(new Set(plan.posts.map((post) => post.key)), ACCOUNT, {
    ...candidate, body: { ...first.body, source: "r2" },
  }), /remaining exact/u);
  assert.throws(() => consumeBoundPrebillingAllowance(new Set(plan.posts.map((post) => post.key)), ACCOUNT, {
    ...candidate, accountId: "00000000000000000000000000000000",
  }), /remaining exact/u);
  assert.throws(() => consumeBoundPrebillingAllowance(new Set(plan.posts.map((post) => post.key)), ACCOUNT, {
    ...candidate, method: "PUT",
  }), /remaining exact/u);
});

check("existing resources reduce allowances and incomplete or conflicting inventories deny", () => {
  const manifest = manifestFixture();
  const existing = inventory([
    { name: "default" },
    { name: "eliotr" },
  ], new Map([
    ["default", []],
    ["eliotr", [{ id: "private-prose-g2" }, { id: "private-literal-g2" }]],
  ]));
  const plan = planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest,
    manifestSource: JSON.stringify(manifest),
    ...existing,
  });
  assert.equal(plan.posts.length, 3);
  assert.ok(plan.posts.every((post) => post.path.endsWith("/eliotr/instances")));
  assert.throws(() => planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest,
    manifestSource: JSON.stringify(manifest),
    namespaceRows: existing.namespaceRows,
    instancesByNamespace: new Map([["default", []]]),
  }), /partial/u);
  const crowdedNamespaces = Array.from({ length: 100 }, (_, index) => ({ name: `ns-${index}` }));
  const crowdedInstances = new Map(crowdedNamespaces.map(({ name }) => [name, []]));
  assert.throws(() => planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest,
    manifestSource: JSON.stringify(manifest),
    namespaceRows: crowdedNamespaces,
    instancesByNamespace: crowdedInstances,
  }), /namespace metadata limit/u);
});

check("source ingestion fields, malformed manifests, and forged capabilities cannot authorize", async () => {
  const manifest = manifestFixture();
  const sourceManifest = structuredClone(manifest);
  sourceManifest.instances[0].create.source = { r2_bucket: "foreign" };
  assert.throws(() => planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest: sourceManifest,
    manifestSource: JSON.stringify(sourceManifest),
    ...inventory(),
  }), /empty of source/u);
  const importedManifest = structuredClone(manifest);
  importedManifest.instances[0].create.r2BucketName = "external-import";
  assert.throws(() => planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest: importedManifest,
    manifestSource: JSON.stringify(importedManifest),
    ...inventory(),
  }), /empty of source/u);
  assert.throws(() => planAiSearchPrebillingMetadataPosts({
    accountId: ACCOUNT,
    manifest: { ...manifest, instances: manifest.instances.slice(0, 4) },
    manifestSource: JSON.stringify(manifest),
    ...inventory(),
  }), /fixed five-instance/u);

  const forged = Object.freeze({ protocol: "eliotr.ai-search-prebilling-metadata-capability.v1" });
  assert.equal(issueAiSearchPrebillingMetadataCapability.length, 0);
  assert.equal(isUsageAdmissionCapability(forged), false);
  assert.throws(() => assertAiSearchPrebillingManifest(forged, JSON.stringify(manifest)),
    (error) => error.code === "AI_SEARCH_PREBILLING_ADMISSION_DENIED");
  assert.throws(() => consumeAiSearchPrebillingMetadataPost(forged, {
    method: "POST", path: "/accounts/eliotr/ai-search/namespaces", body: {}, accountId: ACCOUNT,
  }), /forged/u);

  const source = readFileSync(fileURLToPath(new URL("./provision-ai-search.mjs", import.meta.url)), "utf8");
  assert.ok(source.includes("if (!checkOnly && !verifyExisting && !prebillingMetadata)"),
    "the default heavy provisioning path retains the existing usage-admission gate");
  assert.ok(source.indexOf("consumeAiSearchPrebillingMetadataPost(prebillingCapability") < source.indexOf("await fetch(`${apiBase}${path}`"),
    "the exact one-use capability is consumed before every prebilling POST reaches fetch");
  assert.ok(source.includes('method === "GET" && !prebillingGetPaths.has(path)'),
    "prebilling GETs are limited to exact namespace/instance readback paths");
  const namespaceReconcile = source.slice(
    source.indexOf("async function reconcileNamespaceCreate"),
    source.indexOf("async function reconcileInstanceCreate"),
  );
  const instanceReconcile = source.slice(
    source.indexOf("async function reconcileInstanceCreate"),
    source.indexOf("const namespacePath ="),
  );
  assert.match(namespaceReconcile, /request\("GET"/u);
  assert.doesNotMatch(namespaceReconcile, /request\("POST"/u);
  assert.match(instanceReconcile, /request\("GET"/u);
  assert.doesNotMatch(instanceReconcile, /request\("POST"/u);
  assert.match(namespaceReconcile, /assertExactNamespace\(observed, "post-create readback"\)/u);
  assert.match(instanceReconcile, /assertExactInstance\(spec, observed, "post-create readback"\)/u);
  assert.equal((source.match(/if \(error\?\.code === "AI_SEARCH_PREBILLING_ADMISSION_DENIED"\) throw error;/gu) ?? []).length, 2,
    "pre-network capability denials do not enter ambiguous-POST GET reconciliation");

  const nativeIssuer = readFileSync(fileURLToPath(new URL("./lib/cloudflare-ai-search-prebilling-capability.mjs", import.meta.url)), "utf8");
  const nativeAccountCheck = nativeIssuer.slice(
    nativeIssuer.indexOf("async function verifyNativeOAuthAccount"),
    nativeIssuer.indexOf("async function collectNativeInventory"),
  );
  assert.ok(nativeAccountCheck.indexOf('spawnSync("pnpm"') < nativeAccountCheck.indexOf("loadWranglerOAuthCredential({ env, now: Date.now() })"),
    "native capability issuance lets official whoami refresh the Wrangler profile before loading its credential");
  const oauthProvisioning = source.slice(
    source.indexOf("if (authMode === WRANGLER_OAUTH_MODE)"),
    source.indexOf("} else if (!accountId || !token)"),
  );
  assert.ok(oauthProvisioning.indexOf('spawnSync("pnpm"') < oauthProvisioning.indexOf("loadWranglerOAuthCredential({ env: process.env, now: Date.now() })"),
    "the provisioner lets official whoami refresh the Wrangler profile before loading its credential");
});

await checkAsync("production issuer rejects test authority before any native credential or network access", async () => {
  const key = "ELIOTR_TEST_PREBILLING_CAPABILITY";
  const previous = process.env[key];
  process.env[key] = "caller-supplied";
  try {
    await assert.rejects(issueAiSearchPrebillingMetadataCapability(), /test or usage-admission override/u);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

check("read-only and prebilling mode conflict exits before Cloudflare access", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./provision-ai-search.mjs", import.meta.url)),
    "--prebilling-metadata-v1",
    "--check-only",
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be combined with read-only flags/u);
});

console.log(`AI Search prebilling capability: ${cases} focused groups passed; live Cloudflare writes NOT_EXECUTED`);
