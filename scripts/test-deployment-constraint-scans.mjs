import assert from "node:assert/strict";
import { assertConstraintScanCoverage, readConstraintScanPreconditions,
  validConstraintScanBounds, validConstraintScanObservations } from "./lib/deployment-constraint-scans.mjs";

const bounds = [{ table_name: "fixture_target", max_rows: 2, validation_count: 3 }];
assert.equal(validConstraintScanBounds(bounds), true);
for (const change of [[], [{ ...bounds[0], table_name: 'target"; DELETE FROM target' }],
  [{ ...bounds[0], max_rows: 1001 }], [{ ...bounds[0], validation_count: 0 }], [bounds[0], bounds[0]]]) {
  assert.throws(() => assertConstraintScanCoverage([{ table_name: "fixture_target", validation_count: 3 }], change));
}
const input = { apiBase: "https://api.cloudflare.com/client/v4" };
const intent = { account_id: "fixture-account", database: { database_id: "fixture-database" },
  risk_review: { constraint_scan_bounds: bounds } };
const headers = { Authorization: "Bearer fixture-token", "Content-Type": "application/json" };
const now = () => Date.parse("2026-10-11T18:40:00.000Z");
for (const n of [0, 2, 3]) {
  let called = 0;
  const result = await readConstraintScanPreconditions(input, intent, headers, { now, fetchImpl: async (url, init) => {
    called += 1;
    assert.equal(init.method, "POST");
    assert.equal(new URL(url).pathname, "/client/v4/accounts/fixture-account/d1/database/fixture-database/query");
    assert.deepEqual(JSON.parse(init.body), { sql: 'SELECT COUNT(*) AS n FROM (SELECT 1 FROM "fixture_target" LIMIT 3)', params: [] });
    return Response.json({ success: true, result: [{ success: true, results: [{ n }], meta: { changed_db: false, rows_written: 0 } }] });
  } });
  assert.equal(called, 1);
  assert.equal(result.state, n === 3 ? "EXCEEDED" : "PASS");
  assert.equal(validConstraintScanObservations(result.observations, bounds), true);
  assert.equal(validConstraintScanObservations(result.observations, bounds, { required: true }), n !== 3);
}
for (const bad of [{ n: -1 }, { n: 4 }, { n: 1.5 }, { n: "1" }, { n: 1, extra: true }, null]) {
  const result = await readConstraintScanPreconditions(input, intent, headers, { now, fetchImpl: async () =>
    Response.json({ success: true, result: [{ success: true, results: [bad], meta: { changed_db: false, rows_written: 0 } }] }) });
  assert.equal(result.state, "UNAVAILABLE");
}
const controller = new globalThis.AbortController();
controller.abort();
const cancelled = await readConstraintScanPreconditions(input, intent, headers, { now, signal: controller.signal,
  fetchImpl: () => { throw new Error("Cancelled read must not contact the API"); } });
assert.equal(cancelled.state, "UNAVAILABLE");
assert.equal(validConstraintScanObservations([], bounds, { required: true }), false);
console.log("CHECK scan preflight: endpoint/body/row boundary/cancellation/strict readback and receipt coverage: PASS");
