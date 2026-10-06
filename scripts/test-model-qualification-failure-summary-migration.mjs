import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../", import.meta.url);
const [probeMigration, dispatchMigration, summaryMigration] = await Promise.all([
  readFile(new URL("infra/d1/core/migrations/0054_model_route_qualification.sql", root), "utf8"),
  readFile(new URL("infra/d1/core/migrations/0055_model_route_qualification_dispatch.sql", root), "utf8"),
  readFile(new URL("infra/d1/core/migrations/0122_model_qualification_failure_summary.sql", root), "utf8"),
]);
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
db.exec(probeMigration);
db.exec(dispatchMigration);
db.exec(summaryMigration);

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const digest = (value) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
const sha = "a".repeat(64);
const claim = { key: "probe-failure", input: sha, claim: "claim-failure" };
db.prepare("INSERT INTO model_route_qualification_probe(probe_idempotency_key,probe_input_sha256,claim_ref,started_at) VALUES(?,?,?,?)")
  .run(claim.key, claim.input, claim.claim, "2026-10-06T00:00:00.000Z");
db.prepare("INSERT INTO model_route_qualification_dispatch(probe_idempotency_key,probe_input_sha256,claim_ref,state,observation_sha256,observation_json,started_at,completed_at) VALUES(?,?,?,'STARTED',NULL,NULL,?,NULL)")
  .run(claim.key, claim.input, claim.claim, "2026-10-06T00:00:01.000Z");

const fields = {
  protocol: "eliotr.model-route-qualification-failure-summary.v1",
  phase: "MODEL_GATEWAY_EXECUTION",
  probe_idempotency_key: claim.key,
  probe_input_sha256: claim.input,
  claim_ref: claim.claim,
  failure_code: "MODEL_GATEWAY_RESPONSE_INVALID",
  safe_response_reason: "BODY_JSON_INVALID",
  transport_failure_reason: null,
  observed_http_status: null,
};
const summary = {
  key: claim.key,
  input: claim.input,
  claim: claim.claim,
  phase: fields.phase,
  failure_code: fields.failure_code,
  safe_response_reason: fields.safe_response_reason,
  transport_failure_reason: fields.transport_failure_reason,
  observed_http_status: fields.observed_http_status,
  summary_sha256: digest(fields),
};
db.prepare("INSERT INTO model_route_qualification_failure_summary(probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256) VALUES(?,?,?,?,?,?,?,?,?)")
  .run(summary.key, summary.input, summary.claim, summary.phase, summary.failure_code, summary.safe_response_reason,
    summary.transport_failure_reason, summary.observed_http_status, summary.summary_sha256);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM model_route_qualification_failure_summary").get().count, 1);
assert.match(db.prepare("SELECT observed_at FROM model_route_qualification_failure_summary").get().observed_at, /^2026-/u);

assert.throws(() => db.prepare("UPDATE model_route_qualification_dispatch SET state='COMPLETED',observation_sha256=?,observation_json=?,completed_at=? WHERE probe_idempotency_key=?")
  .run(sha, "{}", "2026-10-06T00:00:02.000Z", claim.key), /FAILURE_SUMMARY_EXISTS/u);
assert.throws(() => db.prepare("UPDATE model_route_qualification_failure_summary SET failure_code='MODEL_GATEWAY_TRANSPORT_FAILED' WHERE probe_idempotency_key=?").run(claim.key), /IMMUTABLE/u);
assert.throws(() => db.prepare("DELETE FROM model_route_qualification_failure_summary WHERE probe_idempotency_key=?").run(claim.key), /IMMUTABLE/u);
assert.throws(() => db.prepare("INSERT INTO model_route_qualification_failure_summary(probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256) VALUES(?,?,?,?,?,?,?,?,?)")
  .run("missing-dispatch", sha, "claim-missing", fields.phase, fields.failure_code, fields.safe_response_reason, null, null, summary.summary_sha256), /IDENTITY_INVALID/u);

const successfulKey = "probe-success";
db.prepare("INSERT INTO model_route_qualification_probe(probe_idempotency_key,probe_input_sha256,claim_ref,started_at) VALUES(?,?,?,?)")
  .run(successfulKey, sha, "claim-success", "2026-10-06T00:00:00.000Z");
db.prepare("INSERT INTO model_route_qualification_dispatch(probe_idempotency_key,probe_input_sha256,claim_ref,state,observation_sha256,observation_json,started_at,completed_at) VALUES(?,?,?,'STARTED',NULL,NULL,?,NULL)")
  .run(successfulKey, sha, "claim-success", "2026-10-06T00:00:01.000Z");
db.prepare("UPDATE model_route_qualification_dispatch SET state='COMPLETED',observation_sha256=?,observation_json=?,completed_at=? WHERE probe_idempotency_key=?")
  .run(sha, "{}", "2026-10-06T00:00:02.000Z", successfulKey);
assert.equal(db.prepare("SELECT state FROM model_route_qualification_dispatch WHERE probe_idempotency_key=?").get(successfulKey).state, "COMPLETED");

const policyKey = "probe-policy";
db.prepare("INSERT INTO model_route_qualification_probe(probe_idempotency_key,probe_input_sha256,claim_ref,started_at) VALUES(?,?,?,?)")
  .run(policyKey, sha, "claim-policy", "2026-10-06T00:00:00.000Z");
db.prepare("INSERT INTO model_route_qualification_dispatch(probe_idempotency_key,probe_input_sha256,claim_ref,state,observation_sha256,observation_json,started_at,completed_at) VALUES(?,?,?,'STARTED',NULL,NULL,?,NULL)")
  .run(policyKey, sha, "claim-policy", "2026-10-06T00:00:01.000Z");
const policyFields = {
  protocol: fields.protocol,
  phase: fields.phase,
  probe_idempotency_key: policyKey,
  probe_input_sha256: sha,
  claim_ref: "claim-policy",
  failure_code: "MODEL_GATEWAY_POLICY_REJECTED",
  safe_response_reason: null,
  transport_failure_reason: null,
  observed_http_status: null,
};
db.prepare("INSERT INTO model_route_qualification_failure_summary(probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256) VALUES(?,?,?,?,?,?,?,?,?)")
  .run(policyKey, sha, "claim-policy", policyFields.phase, policyFields.failure_code, null, null, null, digest(policyFields));
assert.throws(() => db.prepare("INSERT INTO model_route_qualification_failure_summary(probe_idempotency_key,probe_input_sha256,claim_ref,phase,failure_code,safe_response_reason,transport_failure_reason,observed_http_status,summary_sha256) VALUES(?,?,?,?,?,?,?,?,?)")
  .run(policyKey, sha, "claim-policy", policyFields.phase, policyFields.failure_code, "UNCLASSIFIED", null, null, digest({ ...policyFields, safe_response_reason: "UNCLASSIFIED" })), /REASON_INVALID/u);

db.close();
console.log("model qualification failure-summary migration: PASS (exact identity, immutable STARTED fence, D1 time, successful flow)");
