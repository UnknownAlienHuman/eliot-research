import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrations = process.argv[2] ?? resolve(import.meta.dirname, "../infra/d1/core/migrations");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
for (const name of [
  "0001_initial.sql",
  "0002_execution_coordination.sql",
  "0003_delivery_inbox_payload_digest.sql",
  "0004_outbox_delivery_fence.sql",
  "0005_ingest_admission.sql",
]) db.exec(readFileSync(resolve(migrations, name), "utf8"));

const generation = db.prepare(
  "SELECT value FROM schema_state WHERE key = 'schema_generation'",
).get().value;
assert.equal(generation, "core-v5-ingest-admission");
const strictTables = new Map(
  db.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]),
);
for (const name of [
  "source_admission_policy",
  "bundle_ingest_operation",
  "source_acquisition_candidate",
  "qualification_report",
  "source_admission_decision",
  "bundle_ingest_commit_guard",
]) assert.equal(strictTables.get(name), 1, `${name} must be STRICT`);

const now = "2026-08-31T00:00:00.000Z";
const expires = "2026-09-01T00:00:00.000Z";
const digest = "a".repeat(64);
const residencyDigest = "b".repeat(64);
const inputFingerprint = "c".repeat(64);
const policyDigest = "d".repeat(64);
const receiptDigest = "e".repeat(64);
const decisionDigest = "f".repeat(64);
const reportDigest = `0${"1".repeat(63)}`;
const manifest = JSON.stringify({ protocol: "eliotr.normalized.v1" });
const residency = JSON.stringify({ content_digest: { algorithm: "sha256", digest } });
const policySnapshot = JSON.stringify({ source_namespace_id: "namespace-1", revision: 1 });
const fileHashes = JSON.stringify({
  "content.md": digest,
  "manifest.json": "2".repeat(64),
  "hashes.sha256": "3".repeat(64),
});
const decision = JSON.stringify({ decision: "ADMITTED", source_revision_ref: "revision-1" });
const report = JSON.stringify({ overall: "QUALIFIED", source_revision_ref: "revision-1" });
const bundleReceipt = JSON.stringify({
  operation_id: "ingest-1",
  source_revision_ref: "revision-1",
  decision: "ADMITTED",
});

db.prepare(
  "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision," +
  "owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision," +
  "status,created_at) VALUES (?,?,?,?,?,?,?,?)",
).run("namespace-1", 1, "owner-1", "incarnation-1", "owner-generation-1", 1, "ACTIVE", now);
db.prepare(
  "INSERT INTO source_admission_policy(source_namespace_id,revision," +
  "authorized_principal_refs_json,allowed_ownership_modes_json,source_class,assurance_ceiling," +
  "instruction_taint,allowed_effects,allowed_use_json,disclosure_ceiling,license_policy_ref," +
  "default_storage_policy,default_residency_profile_id,default_retention_policy_id," +
  "minimum_quality_state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "namespace-1", 1, '["principal-1"]', '["immutable_import"]', "document", "QUALIFIED",
  "DATA_ONLY", "READ_ONLY", '["research"]', "private", "license-1", "storage-1",
  "residency-1", "retention-1", "standard", now,
);
db.prepare(
  "INSERT INTO bundle_ingest_operation(operation_id,principal_ref," +
  "origin_authentication_receipt_ref,idempotency_key,input_fingerprint,manifest_sha256," +
  "manifest_json,file_hashes_json,total_bytes,source_namespace_id,owner_system_id," +
  "source_owner_generation,source_revision_ref,source_id,expected_head_revision_ref," +
  "residency_key_json,residency_key_digest,policy_revision,policy_snapshot_json," +
  "policy_snapshot_sha256,candidate_id,staging_session_ref,qualification_report_ref," +
  "decision_receipt_ref,state,created_at,updated_at,expires_at) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "ingest-1", "principal-1", "credential-v1", "idem-1", inputFingerprint, digest,
  manifest, fileHashes, 42, "namespace-1", "owner-1", "owner-generation-1",
  "revision-1", "source-1", null, residency, residencyDigest, 1, policySnapshot,
  policyDigest, "candidate-1", "session-1", "qualification-1:1", "decision-1",
  "AUTHORIZED", now, now, expires,
);
db.prepare(
  "INSERT INTO source_acquisition_candidate(candidate_id,revision,operation_id," +
  "observed_locator_identifier_or_upload_ref,proposer_principal_ref,proposed_source_class," +
  "purpose,requested_scope_expression_json,untrusted_metadata_json,staging_object_ref," +
  "policy_refs_json,state,effect_ceiling,created_at,expires_at) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "candidate-1", 1, "ingest-1", "normalized-upload:revision-1", "principal-1",
  "document", "research", "{}", "{}", "session-1", '["source-policy:namespace-1:1"]',
  "CAPTURED", "NO_EXTERNAL_EFFECT", now, expires,
);
db.prepare(
  "INSERT INTO qualification_report(report_id,revision,operation_id,source_revision_ref," +
  "parser_profile_generation,checks_json,overall,exact_precision_ceiling,warnings_json," +
  "report_json,report_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "qualification-1", 1, "ingest-1", "revision-1", "parser-1", "[]", "QUALIFIED",
  "line", "[]", report, reportDigest, now,
);
db.prepare(
  "INSERT INTO source_admission_decision(decision_receipt_ref,operation_id," +
  "source_namespace_id,owner_system_id,source_owner_generation,source_revision_ref," +
  "origin_authentication_receipt_ref,source_class,assurance_ceiling,instruction_taint," +
  "allowed_effects,object_residency_key_digest,allowed_use_json,disclosure_ceiling," +
  "license_policy_ref,decision,reason_codes_json,decision_json,decision_sha256,created_at) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "decision-1", "ingest-1", "namespace-1", "owner-1", "owner-generation-1",
  "revision-1", "credential-v1", "document", "QUALIFIED", "DATA_ONLY", "READ_ONLY",
  residencyDigest, '["research"]', "private", "license-1", "ADMITTED", "[]",
  decision, decisionDigest, now,
);

assert.throws(() => db.prepare(
  "INSERT INTO bundle_ingest_operation(operation_id,principal_ref," +
  "origin_authentication_receipt_ref,idempotency_key,input_fingerprint,manifest_sha256," +
  "manifest_json,file_hashes_json,total_bytes,source_namespace_id,owner_system_id," +
  "source_owner_generation,source_revision_ref,source_id,residency_key_json," +
  "residency_key_digest,policy_revision,policy_snapshot_json,policy_snapshot_sha256," +
  "candidate_id,state,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "ingest-conflict", "principal-1", "credential-v1", "idem-1", "9".repeat(64), digest,
  manifest, fileHashes, 42, "namespace-1", "owner-1", "owner-generation-1",
  "revision-conflict", "source-conflict", residency, residencyDigest, 1, policySnapshot,
  policyDigest, "candidate-conflict", "PREPARING", now, now, expires,
));

function insertSourceAuthority() {
  db.prepare(
    "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id," +
    "source_owner_generation,ownership_mode,kind,title,default_storage_policy," +
    "default_residency_profile_id,source_class,license_policy_ref," +
    "default_retention_policy_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "source-1", "namespace-1", "owner-1", "owner-generation-1", "immutable_import",
    "text/markdown", "source.md", "storage-1", "residency-1", "document",
    "license-1", "retention-1", now,
  );
  db.prepare(
    "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation," +
    "content_sha256,object_residency_key_digest,normalized_artifact_ref,captured_at," +
    "parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref," +
    "admitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "revision-1", "source-1", "owner-generation-1", digest, residencyDigest,
    "manifest-ref-1", now, "parser-1", "standard", "LIVE", "current_confirmed",
    "view-1", now,
  );
  db.prepare("UPDATE source SET head_rev='revision-1' WHERE source_id='source-1'").run();
}

assert.throws(() => {
  db.exec("BEGIN IMMEDIATE");
  try {
    insertSourceAuthority();
    db.prepare(
      "INSERT INTO bundle_ingest_commit_guard(operation_id,source_revision_ref," +
      "ingest_receipt_id,ingest_receipt_revision,projection_intent_id," +
      "projection_intent_revision,outbox_id,verified,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "ingest-1", "revision-1", "missing-receipt", 1, "missing-projection", 1,
      "missing-outbox", null, now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
});
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source WHERE source_id='source-1'").get().count, 0);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_revision WHERE source_revision_ref='revision-1'").get().count, 0);

const ingestIntent = "intent-ingest-1";
const ingestAttempt = "attempt-ingest-1";
const ingestReceipt = "receipt-ingest-1";
const projectionIntent = "intent-projection-1";
const outbox = "outbox-projection-1";
db.exec("BEGIN IMMEDIATE");
try {
  insertSourceAuthority();
  for (const channel of ["captured", "normalized"]) {
    db.prepare(
      "INSERT INTO source_readiness(source_revision_ref,channel,state,reason_codes_json,updated_at) " +
      "VALUES (?,?,?,?,?)",
    ).run("revision-1", channel, "ready", "[]", now);
  }
  db.prepare(
    "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref," +
    "idempotency_key,payload_ref,policy_decision_ref,created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(ingestIntent, 1, "INGEST", "principal-1", "idem-ingest-1", "ingest-1", "decision-1", now);
  db.prepare(
    "INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,state," +
    "started_at,ended_at) VALUES (?,?,?,?,?,?,?)",
  ).run(ingestAttempt, ingestIntent, 1, 1, "SUCCEEDED", now, now);
  db.prepare(
    "INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,attempt_id," +
    "outcome,output_refs_json,readback_receipt_refs_json,reconciliation_required," +
    "reason_codes_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ingestReceipt, 1, ingestIntent, 1, ingestAttempt, "SUCCEEDED",
    '["ingest-1","revision-1"]', '["decision-1","promotion-1"]', 0, "[]", now,
  );
  db.prepare(
    "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref," +
    "idempotency_key,payload_ref,policy_decision_ref,created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    projectionIntent, 1, "PROJECTION", "principal-1", "idem-projection-1",
    "revision-1", "decision-1", now,
  );
  db.prepare(
    "INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,payload_sha256," +
    "state,attempts,next_attempt_at,lease_generation,created_at,updated_at) " +
    "VALUES (?,?,?,?,?,?,'PENDING',0,0,0,?,?)",
  ).run(outbox, projectionIntent, 1, "source.revision.admitted", "revision-1", digest, now, now);
  db.prepare(
    "UPDATE bundle_ingest_operation SET state='COMMITTED',promotion_receipt_ref='promotion-1'," +
    "bundle_receipt_json=?,bundle_receipt_sha256=?,updated_at=? WHERE operation_id='ingest-1'",
  ).run(bundleReceipt, receiptDigest, now);
  db.prepare(
    "INSERT INTO bundle_ingest_commit_guard(operation_id,source_revision_ref," +
    "ingest_receipt_id,ingest_receipt_revision,projection_intent_id," +
    "projection_intent_revision,outbox_id,verified,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "ingest-1", "revision-1", ingestReceipt, 1, projectionIntent, 1, outbox, 1, now,
  );
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

assert.deepEqual(
  { ...db.prepare("SELECT head_rev FROM source WHERE source_id='source-1'").get() },
  { head_rev: "revision-1" },
);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_readiness WHERE source_revision_ref='revision-1' AND state='ready'").get().count, 2);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE outbox_id=? AND state='PENDING'").get(outbox).count, 1);
assert.equal(db.prepare("SELECT verified FROM bundle_ingest_commit_guard WHERE operation_id='ingest-1'").get().verified, 1);
console.log("ingest admission migration and guarded transaction fixture: PASS");
