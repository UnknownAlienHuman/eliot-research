// Retained audit harness. Target modules live on agent/cloudflare-browser-auth-profile-20260906;
// point ELIOTR_AUDIT_REPO at a checkout of that branch, or run from it. See README.md.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
const repo = process.env.ELIOTR_AUDIT_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const P = await import(pathToFileURL(path.join(repo, "scripts/lib/cloudflare-usage-providers.mjs")).href);
const account = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const endpoint = () => `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets?page=1`;
const base = { status: 200, json: async () => ({ success: true, result: [{ id: "real" }], result_info: { page: 1, total_pages: 1, per_page: 100, count: 1, total_count: 1 } }) };
const throwing = new Proxy(base, { get(target, key, receiver) { if (key === "json") throw new Error("private-response-getter"); return Reflect.get(target, key, receiver); } });
const p1 = P.createPaginatedInventoryProvider({ group: "proxy", endpoint, fetchImpl: async () => throwing });
try { await p1.collect({ accountId: account, bearer: "fictional", now: 1 }); console.log("proxy-getter=ALLOW"); } catch (e) { console.log(`proxy-getter=DENY ${(e?.reason ?? "UNtyped")}`); }
const forgedRow = new Proxy({}, { ownKeys: () => ["id"], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }), get: (target, key) => key === "id" ? "forged-proxy-row" : target[key] });
const p2 = P.createPaginatedInventoryProvider({ group: "proxy-row", endpoint, fetchImpl: async () => ({ status: 200, json: async () => ({ success: true, result: [forgedRow], result_info: { page: 1, total_pages: 1, per_page: 100, count: 1, total_count: 1 } }) }) });
try { const out = await p2.collect({ accountId: account, bearer: "fictional", now: 1 }); console.log(`proxy-row=ALLOW ${out.inventory[0].id}`); } catch (e) { console.log(`proxy-row=DENY ${(e?.reason ?? "UNtyped")}`); }
