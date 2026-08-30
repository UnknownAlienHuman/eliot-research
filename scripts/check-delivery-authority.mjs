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
]) {
  db.exec(readFileSync(resolve(root, name), "utf8"));
}

assert.equal(
  db.prepare("SELECT value FROM schema_state WHERE key = 'schema_generation'").get().value,
  "core-v4-delivery-fenced",
);
const outboxColumns = new Set(db.prepare("PRAGMA table_info(outbox)").all().map((row) => row.name));
assert(outboxColumns.has("payload_sha256"));
assert(outboxColumns.has("lease_generation"));
const inboxColumns = new Set(db.prepare("PRAGMA table_info(delivery_inbox)").all().map((row) => row.name));
assert(inboxColumns.has("payload_sha256"));

const digest = "a".repeat(64);
const createdAt = "2026-08-30T00:00:00.000Z";
db.prepare(
  "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref,created_at) " +
  "VALUES (?,?,?,?,?,?,?,?)",
).run("intent-1", 1, "PROJECTION", "principal-1", "projection-1", "source-revision-1", "policy-1", createdAt);
db.prepare(
  "INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,payload_sha256,state,attempts,next_attempt_at,lease_generation,created_at,updated_at) " +
  "VALUES (?,?,?,?,?,?,'PENDING',0,0,0,?,?)",
).run("outbox-1", "intent-1", 1, "source.revision.admitted", "source-revision-1", digest, createdAt, createdAt);

const first = db.prepare(
  "UPDATE outbox SET state='LEASED', attempts=attempts+1, lease_owner=?, lease_generation=lease_generation+1, lease_until=? " +
  "WHERE outbox_id=? AND state='PENDING' RETURNING lease_generation, attempts",
).get("dispatcher-a", 20_000, "outbox-1");
assert.deepEqual({ ...first }, { lease_generation: 1, attempts: 1 });
const competing = db.prepare(
  "UPDATE outbox SET lease_owner=?, lease_generation=lease_generation+1 WHERE outbox_id=? AND state='PENDING' RETURNING lease_generation",
).get("dispatcher-b", "outbox-1");
assert.equal(competing, undefined);
const staleSettlement = db.prepare(
  "UPDATE outbox SET state='SENT' WHERE outbox_id=? AND lease_owner=? AND lease_generation=? RETURNING outbox_id",
).get("outbox-1", "dispatcher-b", 1);
assert.equal(staleSettlement, undefined);

const messageInsert = db.prepare(
  "INSERT INTO delivery_inbox(message_id,idempotency_key,topic,payload_ref,payload_sha256,state,attempt,lease_owner,lease_generation,lease_until,first_seen_at,updated_at) " +
  "VALUES (?,?,?,?,?,'PROCESSING',1,?,1,?,?,?)",
);
messageInsert.run("outbox-1:1", "projection-1", "source.revision.admitted", "source-revision-1", digest, "consumer-a", 20_000, 10_000, 10_000);
assert.throws(() => messageInsert.run(
  "outbox-1:2", "projection-1", "source.revision.admitted", "source-revision-1", "b".repeat(64), "consumer-b", 30_000, 20_000, 20_000,
));

const leaseInsert = db.prepare(
  "INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state,created_at,updated_at) " +
  "VALUES (?,?,?,1,?,1,'LEASED',?,?)",
);
leaseInsert.run("projection-accept-1", "PROJECTION_ACCEPT", "consumer-a", 20_000, 10_000, 10_000);
const fenced = db.prepare(
  "UPDATE operation_execution_lease SET state='COMPLETED' WHERE operation_id=? AND lease_owner=? AND lease_generation=? RETURNING operation_id",
).get("projection-accept-1", "consumer-b", 1);
assert.equal(fenced, undefined);

assert.throws(() => {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref,created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("intent-rollback", 1, "PROJECTION", "principal-1", "projection-rollback", "source-revision-2", "policy-1", createdAt);
    db.prepare(
      "INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,payload_sha256,state,attempts,next_attempt_at,lease_generation,created_at,updated_at) " +
      "VALUES (?,?,?,?,?,?,'PENDING',0,0,0,?,?)",
    ).run("outbox-rollback", "intent-rollback", 1, "source.revision.admitted", "source-revision-2", "not-a-digest", createdAt, createdAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});
assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM operation_intent WHERE intent_id='intent-rollback'").get().count,
  0,
);

console.log("delivery authority migration fixture: PASS");
