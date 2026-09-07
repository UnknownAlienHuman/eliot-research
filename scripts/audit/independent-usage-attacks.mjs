import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// This harness was originally run from outside the audited repository; it is retained
// here as evidence. Every attack imports production modules in a fresh Node process
// after the preload has poisoned globals, and uses only in-memory fetch stubs.
// Target modules live on agent/cloudflare-browser-auth-profile-20260906; point
// ELIOTR_AUDIT_REPO at a checkout of that branch, or run from it. See README.md.
const repo = process.env.ELIOTR_AUDIT_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const providerUrl = pathToFileURL(path.join(repo, "scripts/lib/cloudflare-usage-providers.mjs")).href;
const ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRONG = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BEARER = "fictional-bearer-for-independent-audit";

function child(preload, body) {
  const source = [
    `process.env.CF_AUDIT_STAGE="eval";`,
    `const ACCOUNT=${JSON.stringify(ACCOUNT)}; const WRONG=${JSON.stringify(WRONG)}; const BEARER=${JSON.stringify(BEARER)};`,
    `const P=await import(process.env.CF_PROVIDER_URL);`,
    `const auditCollect=async (endpoint,fetchImpl)=>{const p=P.createPaginatedInventoryProvider({group:"independent",endpoint,fetchImpl});try{const out=await p.collect({accountId:ACCOUNT,bearer:BEARER,now:1});return "allow="+out.inventory.length;}catch(e){return "deny="+(e?.reason??"UNtyped");}};`,
    `const response=(body)=>({status:200,json:async()=>body});`,
    body,
  ].join("\n");
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(fileURLToPath(import.meta.url)).href, "--input-type=module", "--eval", source], {
    env: { ...process.env, CF_AUDIT_PRELOAD: preload, CF_PROVIDER_URL: providerUrl },
    encoding: "utf8",
    timeout: 60000,
  });
  return { ...r, output: `${r.stdout}${r.stderr}` };
}

function expectPass(label, preload, body, needle) {
  const r = child(preload, body);
  assert.equal(r.status, 0, `${label}: child exit ${r.status}\n${r.output}`);
  assert.match(r.output, needle, `${label}: missing output\n${r.output}`);
  console.log(`PASS ${label}: ${r.output.trim()}`);
}

function expectDeny(label, preload, body, reason) {
  const r = child(preload, body);
  assert.equal(r.status, 0, `${label}: child exit ${r.status}\n${r.output}`);
  assert.match(r.output, new RegExp(`deny=${reason}`), `${label}: expected deny\n${r.output}`);
  console.log(`PASS ${label}: ${r.output.trim()}`);
}

if (process.env.CF_AUDIT_PRELOAD !== undefined && process.env.CF_AUDIT_STAGE !== "eval" && process.env.CF_AUDIT_PRELOAD === "keys-proto") {
  // Forge own-looking response fields by poisoning the intrinsic that the
  // provider uses to enumerate keys, then satisfy every identity check from
  // inherited Object.prototype values.
  Object.prototype.success = true;
  Object.prototype.result = [{ }];
  Object.prototype.result_info = { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 };
  Object.prototype.id = "forged-inherited-id";
  const realKeys = Object.keys;
  Object.keys = () => ["success", "result", "result_info", "id", "page", "per_page", "total_pages", "count", "total_count"];
  void realKeys;
} else if (process.env.CF_AUDIT_PRELOAD !== undefined && process.env.CF_AUDIT_STAGE !== "eval" && process.env.CF_AUDIT_PRELOAD === "url-constructor") {
  // The endpoint handed to the provider is WRONG, but a poisoned URL
  // constructor makes structural account binding observe ACCOUNT.
  globalThis.URL = function URL() { return { pathname: `/client/v4/accounts/${ACCOUNT}/r2/buckets` }; };
} else if (process.env.CF_AUDIT_PRELOAD !== undefined && process.env.CF_AUDIT_STAGE !== "eval" && process.env.CF_AUDIT_PRELOAD === "array-static") {
  // Return a non-array object carrying a forged array marker. Production code
  // trusts Array.isArray, so this turns a wrong API shape into an accepted row.
  const real = Array.isArray;
  Array.isArray = (v) => v !== null && typeof v === "object" && v.__auditArray === true ? true : real(v);
} else if (process.env.CF_AUDIT_PRELOAD !== undefined && process.env.CF_AUDIT_STAGE !== "eval" && process.env.CF_AUDIT_PRELOAD === "number-static") {
  Number.isInteger = () => true;
} else if (process.env.CF_AUDIT_PRELOAD !== undefined && process.env.CF_AUDIT_STAGE !== "eval" && process.env.CF_AUDIT_PRELOAD === "array-index") {
  Object.prototype.length = 1;
  Object.prototype[0] = { id: "inherited-row" };
}

if (process.env.CF_AUDIT_PRELOAD !== undefined && process.env.CF_AUDIT_STAGE === "eval") {
  const P = await import(process.env.CF_PROVIDER_URL);
  const page = (result, info = { page: 1, per_page: 100, total_pages: 1, count: result.length, total_count: result.length }) => ({ success: true, result, result_info: info });
  const collect = async (endpoint, fetchImpl) => {
    const p = P.createPaginatedInventoryProvider({ group: "independent", endpoint, fetchImpl });
    try { const out = await p.collect({ accountId: ACCOUNT, bearer: BEARER, now: 1 }); return `allow=${out.inventory.length}`; }
    catch (e) { return `deny=${e?.reason ?? "UNtyped"}`; }
  };
  if (process.env.CF_AUDIT_PRELOAD === "keys-proto") {
    console.log(await collect(() => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets?page=1`, async () => ({ status: 200, json: async () => ({}) })));
  } else if (process.env.CF_AUDIT_PRELOAD === "url-constructor") {
    console.log(await collect(() => `https://api.cloudflare.com/client/v4/accounts/${WRONG}/r2/buckets?page=1`, async () => ({ status: 200, json: async () => page([{ id: "wrong-account-row" }]) })));
  } else if (process.env.CF_AUDIT_PRELOAD === "array-static") {
    const forgedResult = { __auditArray: true, length: 1, 0: { id: "wrong-shape" } };
    console.log(await collect(() => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets?page=1`, async () => ({ status: 200, json: async () => ({ success: true, result: forgedResult, result_info: { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 } }) })));
  } else if (process.env.CF_AUDIT_PRELOAD === "number-static") {
    console.log(await collect(() => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets?page=1`, async () => ({ status: 200, json: async () => page([{ id: "one" }], { page: "forged", per_page: "forged", total_pages: "forged", count: "forged", total_count: "forged" }) })));
  } else if (process.env.CF_AUDIT_PRELOAD === "array-index") {
    console.log(await collect(() => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets?page=1`, async () => ({ status: 200, json: async () => ({ success: true, result: { }, result_info: { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 } }) })));
  }
  // Let stdout flush naturally; the eval process terminates after this block.
}

if (process.env.CF_AUDIT_PRELOAD === undefined) {
expectPass("Object.keys + inherited own-looking fields forge acceptance", "keys-proto", `console.log(await auditCollect(()=>"https://api.cloudflare.com/client/v4/accounts/"+ACCOUNT+"/r2/buckets?page=1",async()=>({status:200,json:async()=>({})})));`, /allow=1/u);
expectPass("URL constructor poisoning bypasses account binding", "url-constructor", `console.log(await auditCollect(()=>"https://api.cloudflare.com/client/v4/accounts/"+WRONG+"/r2/buckets?page=1",()=>response({success:true,result:[{id:"wrong-account-row"}],result_info:{page:1,per_page:100,total_pages:1,count:1,total_count:1}})));`, /allow=1/u);
expectPass("Array.isArray poisoning accepts non-array API shape", "array-static", `const forged={__auditArray:true,length:1,0:{id:"wrong-shape"}}; console.log(await auditCollect(()=>"https://api.cloudflare.com/client/v4/accounts/"+ACCOUNT+"/r2/buckets?page=1",()=>response({success:true,result:forged,result_info:{page:1,per_page:100,total_pages:1,count:1,total_count:1}})));`, /allow=1/u);
expectDeny("Number.isInteger poisoning cannot admit non-integer pagination", "number-static", `console.log(await auditCollect(()=>"https://api.cloudflare.com/client/v4/accounts/"+ACCOUNT+"/r2/buckets?page=1",()=>response({success:true,result:[{id:"one"}],result_info:{page:"forged",per_page:"forged",total_pages:"forged",count:"forged",total_count:"forged"}})));`, "MALFORMED");

// Native URL/parser path-boundary cases: these must all be rejected.
const P = await import(providerUrl);
for (const [label, url] of [
  ["query-only account", `https://api.cloudflare.com/client/v4/r2/buckets?account_id=${ACCOUNT}`],
  ["double accounts", `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/accounts/${ACCOUNT}/r2/buckets`],
  ["encoded accounts segment", `https://api.cloudflare.com/client/v4/%61ccounts/${ACCOUNT}/r2/buckets`],
  ["wrong account", `https://api.cloudflare.com/client/v4/accounts/${WRONG}/r2/buckets`],
  ["encoded slash account", "https://api.cloudflare.com/client/v4/accounts/a%2Fb/r2/buckets"],
]) {
  let reason = "none";
  try { P.assertAccountUrl(url, ACCOUNT, "independent", label); } catch (e) { reason = e?.reason ?? "untyped"; }
  assert.equal(reason, "ACCOUNT_MISMATCH", `${label}: ${reason}`);
  console.log(`PASS ${label}: deny=${reason}`);
}

// Duplicate identity rows are currently accepted by the provider and inflate
// the authoritative inventory count. This is an independent counterexample.
const duplicate = P.createAiSearchInventoryProvider({
  endpoint: (a, p, pp) => `https://api.cloudflare.com/client/v4/accounts/${a}/ai-search/instances?page=${p}&per_page=${pp}`,
  fetchImpl: async () => ({ status: 200, json: async () => ({ success: true, result: [{ id: "same" }, { id: "same" }], result_info: { page: 1, per_page: 100, total_pages: 1, count: 2, total_count: 2 } }) }),
});
const duplicateOut = await duplicate.collect({ accountId: ACCOUNT, bearer: BEARER, now: 1 });
assert.equal(duplicateOut.values.ai_search_instances, 2);
console.log(`COUNTEREXAMPLE duplicate identity admitted: ai_search_instances=${duplicateOut.values.ai_search_instances}`);

// Independent secret/receipt check: success output and failure message must
// not contain bearer or response payload.
const secret = "Bearer-secret-independent";
const secretProvider = P.createPaginatedInventoryProvider({
  group: "secret-check",
  endpoint: (a) => `https://api.cloudflare.com/client/v4/accounts/${a}/r2/buckets?page=1`,
  fetchImpl: async () => ({ status: 200, json: async () => ({ success: false, secret, payload: "PRIVATE_PAYLOAD" }) }),
});
try { await secretProvider.collect({ accountId: ACCOUNT, bearer: secret, now: 1 }); } catch (e) {
  const text = `${e.message} ${JSON.stringify(e)}`;
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("PRIVATE_PAYLOAD"), false);
  console.log("PASS secret/receipt metadata does not leak bearer or payload");
}

console.log("Independent attack harness complete");
}
