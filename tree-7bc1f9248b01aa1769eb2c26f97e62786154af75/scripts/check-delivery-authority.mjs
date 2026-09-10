import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const root = process.argv[2] ?? resolve(import.meta.dirname, "../infra/d1/core/migrations");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
for (const name of [
  "0001_initial.sql",
  "0002_execution_coordination.sql",
  "0003_delivery_inbox_payload_digest.sql",
  "0004_outbox_delivery_fence.sql",
  "0009_federation_authority.sql",
]) db.exec(readFileSync(resolve(root, name), "utf8"));
assert.equal(db.prepare("SELECT value FROM schema_state WHERE key = 'schema_generation'").get().value, "core-v4-delivery-fenced");
const tableStrictness = new Map(db.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]));
assert.equal(tableStrictness.get("operation_execution_lease"), 1);
assert.equal(tableStrictness.get("delivery_inbox"), 1);
assert.equal(tableStrictness.get("federation_reference_manifest"), 1);
assert.equal(tableStrictness.get("federation_job"), 1);
const digest = "a".repeat(64);
const invalidDigest = `${"a".repeat(63)}z`;
const createdAt = "2026-08-30T00:00:00.000Z";
db.prepare("INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref,created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run("intent-1",1,"PROJECTION","principal-1","projection-1","source-revision-1","policy-1",createdAt);
db.prepare("INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,payload_sha256,state,attempts,next_attempt_at,lease_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,'PENDING',0,0,0,?,?)")
  .run("outbox-1","intent-1",1,"source.revision.admitted","source-revision-1",digest,createdAt,createdAt);
assert.throws(() => db.prepare("INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,payload_sha256,state,attempts,next_attempt_at,lease_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,'PENDING',0,0,0,?,?)")
  .run("outbox-invalid","intent-1",1,"source.revision.admitted","source-revision-1",invalidDigest,createdAt,createdAt));
const first = db.prepare("UPDATE outbox SET state='LEASED', attempts=attempts+1, lease_owner=?, lease_generation=lease_generation+1, lease_until=? WHERE outbox_id=? AND state='PENDING' RETURNING lease_generation, attempts")
  .get("dispatcher-a",20000,"outbox-1");
assert.deepEqual({...first},{lease_generation:1,attempts:1});
assert.equal(db.prepare("UPDATE outbox SET lease_owner=?, lease_generation=lease_generation+1 WHERE outbox_id=? AND state='PENDING' RETURNING lease_generation").get("dispatcher-b","outbox-1"), undefined);
assert.equal(db.prepare("UPDATE outbox SET state='SENT' WHERE outbox_id=? AND lease_owner=? AND lease_generation=? RETURNING outbox_id").get("outbox-1","dispatcher-b",1), undefined);
const messageInsert = db.prepare("INSERT INTO delivery_inbox(message_id,idempotency_key,topic,payload_ref,payload_sha256,state,attempt,lease_owner,lease_generation,lease_until,first_seen_at,updated_at) VALUES (?,?,?,?,?,'PROCESSING',1,?,1,?,?,?)");
messageInsert.run("outbox-1:1","projection-1","source.revision.admitted","source-revision-1",digest,"consumer-a",20000,10000,10000);
assert.throws(() => messageInsert.run("outbox-invalid-digest","projection-invalid","source.revision.admitted","source-revision-1",invalidDigest,"consumer-a",20000,10000,10000));
assert.throws(() => messageInsert.run("outbox-1:2","projection-1","source.revision.admitted","source-revision-1","b".repeat(64),"consumer-b",30000,20000,20000));
const leaseInsert = db.prepare("INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state,created_at,updated_at) VALUES (?,?,?,1,?,1,'LEASED',?,?)");
leaseInsert.run("projection-accept-1","PROJECTION_ACCEPT","consumer-a",20000,10000,10000);
assert.equal(db.prepare("UPDATE operation_execution_lease SET state='COMPLETED' WHERE operation_id=? AND lease_owner=? AND lease_generation=? RETURNING operation_id").get("projection-accept-1","consumer-b",1), undefined);
assert.throws(() => {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("intent-rollback",1,"PROJECTION","principal-1","projection-rollback","source-revision-2","policy-1",createdAt);
    db.prepare("INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,payload_sha256,state,attempts,next_attempt_at,lease_generation,created_at,updated_at) VALUES (?,?,?,?,?,?,'PENDING',0,0,0,?,?)")
      .run("outbox-rollback","intent-rollback",1,"source.revision.admitted","source-revision-2",invalidDigest,createdAt,createdAt);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM operation_intent WHERE intent_id='intent-rollback'").get().count,0);

const manifest = {
  manifest_ref: { id: "manifest-1", revision: 1 },
  scope_snapshot_ref: { id: "scope-1", revision: 1 },
  client_fence_ref: "fence-1",
  expires_at: "2026-09-01T00:00:00.000Z",
  manifest_digest: "b".repeat(64),
};
const manifestInsert = db.prepare(
  "INSERT INTO federation_reference_manifest(manifest_id,revision,manifest_json," +
  "manifest_digest,scope_snapshot_id,scope_snapshot_revision,client_fence_ref," +
  "expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
);
manifestInsert.run(
  "manifest-1", 1, JSON.stringify(manifest), manifest.manifest_digest,
  "scope-1", 1, "fence-1", manifest.expires_at, createdAt,
);
assert.throws(() => manifestInsert.run(
  "manifest-invalid", 1,
  JSON.stringify({ ...manifest, manifest_ref: { id: "another-id", revision: 1 } }),
  manifest.manifest_digest, "scope-1", 1, "fence-1", manifest.expires_at, createdAt,
), /CHECK constraint failed/u, "manifest columns cannot diverge from canonical identity");
const federationRequest = {
  protocol: "eliotr.federation.v1",
  exchange_id: "exchange-1",
  idempotency_key: "idempotency-1",
  requester_principal_ref: "client-1",
  bridge_generation: "bridge-1",
  client_fence_ref: "fence-1",
};
const federationStatus = {
  exchange_id: "exchange-1",
  idempotency_key: "idempotency-1",
  job_id: "job-1",
  attempt: 1,
  transport_state: "ACCEPTED",
  completion_disposition: null,
  completed_obligation_refs: [],
  partial_bundle_refs: [],
  open_research_debt_refs: [],
};
const federationInsert = db.prepare(
  "INSERT INTO federation_job(job_id,exchange_id,idempotency_key,request_digest," +
  "request_json,requester_principal_ref,requester_credential_generation," +
  "server_principal_ref,server_credential_generation,bridge_generation,client_fence_ref," +
  "allowed_manifest_id,allowed_manifest_revision,origin_trace_id,attempt,transport_state," +
  "status_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'ACCEPTED',?,?,?)",
);
federationInsert.run(
  "job-1", "exchange-1", "idempotency-1", digest, JSON.stringify(federationRequest),
  "client-1", "client-credential-1", "server-1", "server-credential-1", "bridge-1",
  "fence-1", "manifest-1", 1, "trace-1", JSON.stringify(federationStatus),
  createdAt, createdAt,
);
assert.throws(() => federationInsert.run(
  "job-2", "exchange-1", "idempotency-1", "c".repeat(64),
  JSON.stringify(federationRequest), "client-1", "client-credential-1", "server-1",
  "server-credential-1", "bridge-1", "fence-1", "manifest-1", 1, "trace-2",
  JSON.stringify({ ...federationStatus, job_id: "job-2" }), createdAt, createdAt,
), /UNIQUE constraint failed/u, "federation idempotency identity cannot reserve a second job");
assert.throws(() => federationInsert.run(
  "job-invalid-digest", "exchange-2", "idempotency-2", invalidDigest,
  JSON.stringify({ ...federationRequest, exchange_id: "exchange-2", idempotency_key: "idempotency-2" }),
  "client-1", "client-credential-1", "server-1", "server-credential-1", "bridge-1",
  "fence-1", "manifest-1", 1, "trace-3",
  JSON.stringify({ ...federationStatus, exchange_id: "exchange-2", idempotency_key: "idempotency-2", job_id: "job-invalid-digest" }),
  createdAt, createdAt,
), /CHECK constraint failed/u, "federation request digest must be lowercase SHA-256");

console.log("delivery and federation authority migration fixture: PASS");