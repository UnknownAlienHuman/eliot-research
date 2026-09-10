// Fresh-process billing-specific attack. Originally run from outside the repository;
// retained here as evidence. The response is {} and every accepted field comes only
// from Object.prototype. Target modules live on agent/cloudflare-browser-auth-profile-20260906;
// point ELIOTR_AUDIT_REPO at a checkout of that branch, or run from it. See README.md.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
const account = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const now = Date.parse("2026-09-06T12:00:00.000Z");
Object.prototype.success = true;
Object.prototype.result = [{
  BillingAccountId: account,
  x_BillableMetricId: "m",
  x_BillableMetricName: "n",
  ConsumedUnit: "u",
  ConsumedQuantity: 1,
  ChargePeriodStart: "2026-09-01T00:00:00.000Z",
  ChargePeriodEnd: "2026-09-06T00:00:00.000Z",
}];
const repo = process.env.ELIOTR_AUDIT_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
const { createBillableUsageProvider } = await import(pathToFileURL(path.join(repo, "scripts/lib/cloudflare-usage-billable.mjs")).href);
const provider = createBillableUsageProvider({
  covers: ["workers_requests"],
  endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
  fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
  metricMap: { "m:n:u": "workers_requests" },
  expectedWindow: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
});
try {
  const out = await provider.collect({ accountId: account, bearer: "fictional-independent-billing-bearer", now });
  console.log(`billing=ALLOW ${JSON.stringify(out.values)}`);
} catch (error) {
  console.log(`billing=DENY ${error?.reason ?? "UNtyped"}`);
}
