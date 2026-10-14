// Intrinsic-independence attacks: fresh-process subprocess forgeries with
// poison applied BEFORE the provider import via --import preload (this file
// acts as its own preload when LUNA_PRELOAD is set), stub fetchImpl, and no
// network. Each child denies fail-closed (or preserves real rows for the
// iterator forgery); a legitimate multi-page control stays authoritative.
// Run with: node scripts/test-cloudflare-usage-intrinsic-independence.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const LUNA_ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LUNA_WRONG = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LUNA_BEARER = "fictional-bearer-for-tests-only";

if (process.env.LUNA_PRELOAD === "luna1-set") {
  const FIELDS = ["page", "per_page", "count", "total_count", "total_pages"];
  const origHas = Set.prototype.has;
  const origAdd = Set.prototype.add;
  Set.prototype.has = function (v) {
    for (let i = 0; i < FIELDS.length; i += 1) { if (v === FIELDS[i]) return false; }
    return origHas.call(this, v);
  };
  Set.prototype.add = function (v) {
    for (let i = 0; i < FIELDS.length; i += 1) { if (v === FIELDS[i]) return this; }
    return origAdd.call(this, v);
  };
} else if (process.env.LUNA_PRELOAD === "luna2-proto") {
  Object.prototype.success = true;
  Object.prototype.result = [{ id: "forged-via-proto" }];
  Object.prototype.result_info = { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 };
} else if (process.env.LUNA_PRELOAD === "luna3-iterator") {
  const realIter = Array.prototype[Symbol.iterator];
  const forged = [{ id: "forged-row" }];
  Array.prototype[Symbol.iterator] = function () {
    if (this.length === 1 && this[0] !== null && typeof this[0] === "object" && this[0].id === "real-row-1") return realIter.call(forged);
    return realIter.call(this);
  };
} else if (process.env.LUNA_PRELOAD === "luna4-filter") {
  Array.prototype.filter = function () { return ["accounts", LUNA_ACCOUNT]; };
}

const SELF_URL = import.meta.url;
const PROVIDER_URL = new URL("./lib/cloudflare-usage-providers.mjs", import.meta.url).href;

function childAiWalk({ perPage, pages, tag, expect }) {
  return "const P = await import(process.env.LUNA_PROVIDER_URL);\n"
    + "const ACCOUNT = " + JSON.stringify(LUNA_ACCOUNT) + ";\n"
    + "const PER_PAGE = " + perPage + ";\n"
    + "const PAGES = " + JSON.stringify(pages) + ";\n"
    + "const fetchImpl = async (url) => {\n"
    + "  const page = Number(new URL(url).searchParams.get(\"page\") || \"1\");\n"
    + "  let body = null;\n"
    + "  for (let i = 0; i < PAGES.length; i += 1) { if (PAGES[i].page === page) body = PAGES[i].body; }\n"
    + "  if (body === null) { console.error(" + JSON.stringify("CHILD " + tag + " no stub page ") + " + page); process.exit(1); }\n"
    + "  return { status: 200, json: async () => body };\n"
    + "};\n"
    + "const provider = P.createAiSearchInventoryProvider({ perPage: PER_PAGE, endpoint: (a, p, pp) => \"https://api.cloudflare.com/client/v4/accounts/\" + a + \"/ai-search/instances?page=\" + p + \"&per_page=\" + pp, fetchImpl });\n"
    + "let out = null;\n"
    + "let reason = null;\n"
    + "try { out = await provider.collect({ accountId: ACCOUNT, bearer: " + JSON.stringify(LUNA_BEARER) + ", now: 1 }); }\n"
    + "catch (e) { reason = (e && typeof e.reason === \"string\") ? e.reason : \"NO_REASON\"; }\n"
    + expect + "\n"
    + "console.log(" + JSON.stringify("CHILD " + tag + " PASS") + ");\n";
}

const EXPECT_DENY_PARTIAL = "if (reason !== \"PARTIAL_PAGINATION\") { console.error(\"expected PARTIAL_PAGINATION got \" + reason); process.exit(1); }";
const EXPECT_DENY_HTTP = "if (reason !== \"HTTP_ERROR\") { console.error(\"expected HTTP_ERROR got \" + reason); process.exit(1); }";
const EXPECT_MISMATCH = "if (reason !== \"ACCOUNT_MISMATCH\") { console.error(\"expected ACCOUNT_MISMATCH got \" + reason); process.exit(1); }";
const EXPECT_REAL_ROWS = "if (reason !== null) { console.error(\"expected success got \" + reason); process.exit(1); }\n"
  + "if (out.values.ai_search_instances !== 1) { console.error(\"bad count\"); process.exit(1); }\n"
  + "if (out.inventory.length !== 1 || out.inventory[0].id !== \"real-row-1\") { console.error(\"forged row present\"); process.exit(1); }\n"
  + "if (out.receiptMeta.authoritative !== true) { console.error(\"lost authority\"); process.exit(1); }";
const EXPECT_CONTROL = "if (reason !== null) { console.error(\"expected success got \" + reason); process.exit(1); }\n"
  + "if (out.values.ai_search_instances !== 3) { console.error(\"bad count\"); process.exit(1); }\n"
  + "if (out.inventory.length !== 3 || out.inventory[0].id !== \"one\" || out.inventory[1].id !== \"two\" || out.inventory[2].id !== \"three\") { console.error(\"bad rows\"); process.exit(1); }\n"
  + "if (out.receiptMeta.authoritative !== true || out.coverage.fullAccount !== true) { console.error(\"lost authority\"); process.exit(1); }";

function pageBody(result, resultInfo) {
  return { success: true, result, result_info: resultInfo };
}

const SCENARIOS = [
  {
    tag: "luna1-set",
    name: "poisoned Set.prototype.has/add cannot hide per_page disappearance",
    preload: "luna1-set",
    code: childAiWalk({
      perPage: 2,
      tag: "luna1-set",
      pages: [
        { page: 1, body: pageBody([{ id: "one" }], { page: 1, per_page: 2, total_count: 3, total_pages: 2, count: 1 }) },
        { page: 2, body: pageBody([{ id: "two" }, { id: "three" }], { page: 2, total_pages: 2, total_count: 3, count: 2 }) },
      ],
      expect: EXPECT_DENY_PARTIAL,
    }),
  },
  {
    tag: "luna2-proto",
    name: "polluted Object.prototype cannot fabricate success/result",
    preload: "luna2-proto",
    code: "const P = await import(process.env.LUNA_PROVIDER_URL);\n"
      + "const provider = P.createAiSearchInventoryProvider({ endpoint: (a, p, pp) => \"https://api.cloudflare.com/client/v4/accounts/\" + a + \"/ai-search/instances?page=\" + p + \"&per_page=\" + pp, fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });\n"
      + "let reason = null;\n"
      + "try { await provider.collect({ accountId: " + JSON.stringify(LUNA_ACCOUNT) + ", bearer: " + JSON.stringify(LUNA_BEARER) + ", now: 1 }); }\n"
      + "catch (e) { reason = (e && typeof e.reason === \"string\") ? e.reason : \"NO_REASON\"; }\n"
      + EXPECT_DENY_HTTP + "\n"
      + "console.log(" + JSON.stringify("CHILD luna2-proto PASS") + ");\n",
  },
  {
    tag: "luna3-iterator",
    name: "poisoned Array iterator cannot substitute rows",
    preload: "luna3-iterator",
    code: childAiWalk({
      perPage: 100,
      tag: "luna3-iterator",
      pages: [
        { page: 1, body: pageBody([{ id: "real-row-1" }], { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 }) },
      ],
      expect: EXPECT_REAL_ROWS,
    }),
  },
  {
    tag: "luna4-filter",
    name: "poisoned Array.filter cannot launder wrong-account URLs",
    preload: "luna4-filter",
    code: "const P = await import(process.env.LUNA_PROVIDER_URL);\n"
      + "const ACCOUNT = " + JSON.stringify(LUNA_ACCOUNT) + ";\n"
      + "const WRONG = " + JSON.stringify(LUNA_WRONG) + ";\n"
      + "let direct = null;\n"
      + "try { P.assertAccountUrl(\"https://api.cloudflare.com/client/v4/accounts/\" + WRONG + \"/r2/buckets?page=1\", ACCOUNT, \"r2-test\", \"page 1\"); }\n"
      + "catch (e) { direct = (e && typeof e.reason === \"string\") ? e.reason : \"NO_REASON\"; }\n"
      + "if (direct !== \"ACCOUNT_MISMATCH\") { console.error(\"direct expected ACCOUNT_MISMATCH got \" + direct); process.exit(1); }\n"
      + "const provider = P.createPaginatedInventoryProvider({ group: \"r2-test\", covers: [], endpoint: () => \"https://api.cloudflare.com/client/v4/accounts/\" + WRONG + \"/r2/buckets?page=1\", fetchImpl: async () => ({ status: 200, json: async () => ({ success: true, result: [], result_info: { page: 1, per_page: 100, total_pages: 1, count: 0, total_count: 0 } }) }) });\n"
      + "let reason = null;\n"
      + "try { await provider.collect({ accountId: ACCOUNT, bearer: " + JSON.stringify(LUNA_BEARER) + ", now: 1 }); }\n"
      + "catch (e) { reason = (e && typeof e.reason === \"string\") ? e.reason : \"NO_REASON\"; }\n"
      + EXPECT_MISMATCH + "\n"
      + "console.log(" + JSON.stringify("CHILD luna4-filter PASS") + ");\n",
  },
  {
    tag: "control",
    name: "legitimate multi-page walk stays authoritative",
    preload: "",
    code: childAiWalk({
      perPage: 2,
      tag: "control",
      pages: [
        { page: 1, body: pageBody([{ id: "one" }], { page: 1, per_page: 2, total_count: 3, total_pages: 2, count: 1 }) },
        { page: 2, body: pageBody([{ id: "two" }, { id: "three" }], { page: 2, per_page: 2, total_pages: 2, total_count: 3, count: 2 }) },
      ],
      expect: EXPECT_CONTROL,
    }),
  },
];

if (process.env.LUNA_CHILD === undefined) {
  let cases = 0;
  for (let i = 0; i < SCENARIOS.length; i += 1) {
    const scenario = SCENARIOS[i];
    const result = spawnSync(process.execPath, ["--import", SELF_URL, "--input-type=module", "--eval", scenario.code], {
      env: { ...process.env, LUNA_CHILD: "1", LUNA_PRELOAD: scenario.preload, LUNA_PROVIDER_URL: PROVIDER_URL },
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(result.status, 0, scenario.tag + " child exit " + result.status + " stderr: " + result.stderr);
    assert.ok(result.stdout.includes("CHILD " + scenario.tag + " PASS"), scenario.tag + " missing PASS marker: " + result.stdout + result.stderr);
    cases += 1;
    console.log("Intrinsic independence: " + scenario.name + ": PASS");
  }
  console.log("Intrinsic independence: " + cases + " groups passed; live Cloudflare NOT_EXECUTED");
}
