import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const core = new DatabaseSync(":memory:");
const search = new DatabaseSync(":memory:");
core.exec("PRAGMA foreign_keys = ON");
search.exec("PRAGMA foreign_keys = ON");

for (const name of [
  "0001_initial.sql",
  "0002_execution_coordination.sql",
  "0003_delivery_inbox_payload_digest.sql",
  "0004_outbox_delivery_fence.sql",
  "0005_ingest_admission.sql",
  "0006_projection_execution.sql",
]) {
  core.exec(readFileSync(resolve(root, "infra/d1/core/migrations", name), "utf8"));
}
for (const name of ["0001_initial.sql", "0002_projection_generations.sql"]) {
  search.exec(readFileSync(resolve(root, "infra/d1/search/migrations", name), "utf8"));
}

assert.equal(
  core.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").get().value,
  "core-v6-projection-execution",
);
assert.equal(
  search.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").get().value,
  "search-v2-projection-generations",
);
const coreStrict = new Map(
  core.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]),
);
const searchStrict = new Map(
  search.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]),
);
for (const table of ["projection_generation", "projection_terminal_guard"]) {
  assert.equal(coreStrict.get(table), 1, `${table} must be STRICT`);
}
for (const table of [
  "projection_span",
  "projection_generation_receipt",
  "projection_activation_guard",
]) {
  assert.equal(searchStrict.get(table), 1, `${table} must be STRICT`);
}
assert.equal(
  core.prepare(
    "SELECT COUNT(*) AS count FROM pragma_table_info('source_readiness') " +
    "WHERE name='receipt_ref'",
  ).get().count,
  1,
);

const now = "2026-08-31T18:15:00.000Z";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const projection = "projection-g1";
const d1Receipt = "d1-receipt-1";

search.prepare(
  "INSERT INTO projection_generation_receipt(source_revision_ref,projection_generation,state," +
  "item_count,item_set_digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
).run("revision-1", projection, "BUILDING", 1, digestC, now, now);
search.prepare(
  "INSERT INTO projection_item(item_key,source_revision_ref,canonical_section_id," +
  "project_membership_ids_json,source_class,title,heading_path,document_context_header," +
  "section_text,normalized_offset_map_ref,content_sha256,instruction_taint," +
  "projection_generation,active,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)",
).run(
  "item-1", "revision-1", "section-1", "[]", "document", "Source", '["Heading"]',
  "Source / Heading", "text", "normalized-bytes:0:4", digestA, "DATA_ONLY",
  projection, now,
);
search.prepare(
  "INSERT INTO section_fts(item_key,title,heading_path,document_context_header,section_text) " +
  "VALUES (?,?,?,?,?)",
).run("item-1", "Source", "Heading", "Source / Heading", "text");
search.prepare(
  "INSERT INTO projection_span(item_key,source_revision_ref,normalized_start_byte," +
  "normalized_end_byte,precision_kind,projection_generation) VALUES (?,?,?,?,?,?)",
).run("item-1", "revision-1", 0, 4, "normalized_bytes", projection);

assert.throws(() => {
  search.exec("BEGIN IMMEDIATE");
  try {
    search.prepare(
      "UPDATE projection_item SET active=1,updated_at=? " +
      "WHERE source_revision_ref=? AND projection_generation=?",
    ).run(now, "revision-1", projection);
    search.prepare(
      "UPDATE projection_generation_receipt SET state='READY',readback_digest=?," +
      "receipt_ref=?,updated_at=? WHERE source_revision_ref=? AND projection_generation=?",
    ).run(digestC, d1Receipt, now, "revision-1", projection);
    search.prepare(
      "INSERT INTO projection_activation_guard(source_revision_ref,projection_generation," +
      "receipt_ref,readback_digest,item_count,verified,created_at) " +
      "SELECT ?,?,?,?,?,CASE WHEN (SELECT COUNT(*) FROM projection_item " +
      "WHERE source_revision_ref=? AND projection_generation=? AND active=1)=? " +
      "THEN 1 ELSE NULL END,?",
    ).run(
      "revision-1", projection, d1Receipt, digestC, 1,
      "revision-1", projection, 2, now,
    );
    search.exec("COMMIT");
  } catch (error) {
    search.exec("ROLLBACK");
    throw error;
  }
});
assert.equal(
  search.prepare("SELECT COUNT(*) AS count FROM projection_item WHERE active=1").get().count,
  0,
  "failed activation guard must roll back item visibility",
);
assert.equal(
  search.prepare(
    "SELECT state FROM projection_generation_receipt " +
    "WHERE source_revision_ref='revision-1' AND projection_generation=?",
  ).get(projection).state,
  "BUILDING",
);

search.exec("BEGIN IMMEDIATE");
try {
  search.prepare(
    "UPDATE projection_item SET active=1,updated_at=? " +
    "WHERE source_revision_ref=? AND projection_generation=?",
  ).run(now, "revision-1", projection);
  for (const channel of ["exact", "lexical"]) {
    search.prepare(
      "INSERT INTO projection_watermark(channel,projection_generation,source_revision_ref," +
      "projected_item_count,state,readback_receipt_ref,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(channel, projection, "revision-1", 1, "READY", d1Receipt, now);
  }
  search.prepare(
    "UPDATE projection_generation_receipt SET state='READY',readback_digest=?," +
    "receipt_ref=?,updated_at=? WHERE source_revision_ref=? AND projection_generation=?",
  ).run(digestC, d1Receipt, now, "revision-1", projection);
  search.prepare(
    "INSERT INTO projection_activation_guard(source_revision_ref,projection_generation," +
    "receipt_ref,readback_digest,item_count,verified,created_at) " +
    "SELECT ?,?,?,?,?,CASE WHEN " +
    "(SELECT COUNT(*) FROM projection_item WHERE source_revision_ref=? " +
    "AND projection_generation=? AND active=1)=1 " +
    "AND (SELECT COUNT(*) FROM projection_span WHERE source_revision_ref=? " +
    "AND projection_generation=?)=1 " +
    "AND EXISTS (SELECT 1 FROM projection_generation_receipt WHERE " +
    "source_revision_ref=? AND projection_generation=? AND state='READY' " +
    "AND receipt_ref=? AND readback_digest=?) THEN 1 ELSE NULL END,?",
  ).run(
    "revision-1", projection, d1Receipt, digestC, 1,
    "revision-1", projection, "revision-1", projection,
    "revision-1", projection, d1Receipt, digestC, now,
  );
  search.exec("COMMIT");
} catch (error) {
  search.exec("ROLLBACK");
  throw error;
}
assert.deepEqual(
  { ...search.prepare(
    "SELECT state,item_count,item_set_digest,readback_digest,receipt_ref " +
    "FROM projection_generation_receipt WHERE source_revision_ref='revision-1' " +
    "AND projection_generation=?",
  ).get(projection) },
  {
    state: "READY",
    item_count: 1,
    item_set_digest: digestC,
    readback_digest: digestC,
    receipt_ref: d1Receipt,
  },
);
assert.deepEqual(
  { ...search.prepare(
    "SELECT receipt_ref,readback_digest,item_count,verified " +
    "FROM projection_activation_guard WHERE source_revision_ref='revision-1' " +
    "AND projection_generation=?",
  ).get(projection) },
  {
    receipt_ref: d1Receipt,
    readback_digest: digestC,
    item_count: 1,
    verified: 1,
  },
);

core.prepare(
  "INSERT INTO source_namespace_ownership(source_namespace_id,ownership_record_revision," +
  "owner_system_id,owner_incarnation_ref,source_owner_generation," +
  "source_admission_policy_revision,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
).run(
  "namespace-1", 1, "owner-1", "incarnation-1", "owner-generation-1",
  1, "ACTIVE", now,
);
core.prepare(
  "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id," +
  "source_owner_generation,ownership_mode,kind,title,default_storage_policy," +
  "default_residency_profile_id,source_class,license_policy_ref," +
  "default_retention_policy_id,head_rev,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "source-1", "namespace-1", "owner-1", "owner-generation-1", "immutable_import",
  "text/markdown", "Source", "storage-1", "residency-1", "document", "license-1",
  "retention-1", "revision-1", now,
);
core.prepare(
  "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation," +
  "content_sha256,object_residency_key_digest,normalized_artifact_ref,captured_at," +
  "quality_state,purge_state,currentness_state,source_view_ref,admitted_at) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "revision-1", "source-1", "owner-generation-1", digestA, digestB,
  "normalized/manifest.json", now, "standard", "LIVE", "current_confirmed", "view-1", now,
);
core.prepare(
  "INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref," +
  "idempotency_key,payload_ref,policy_decision_ref,created_at) VALUES (?,?,?,?,?,?,?,?)",
).run("intent-1", 1, "PROJECTION", "principal-1", "projection-1", "revision-1", "decision-1", now);
core.prepare(
  "INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number," +
  "state,checkpoint_ref,started_at) VALUES (?,?,?,?,?,?,?)",
).run("attempt-1", "intent-1", 1, 1, "CHECKPOINTED", "job:job-1", now);
core.prepare(
  "INSERT INTO job(job_id,intent_id,intent_revision,state,current_stage,created_at,updated_at) " +
  "VALUES (?,?,?,?,?,?,?)",
).run("job-1", "intent-1", 1, "ACCEPTED", "PROJECTION_QUEUED", now, now);
core.prepare(
  "INSERT INTO projection_generation(source_revision_ref,projection_generation,job_id," +
  "source_owner_generation,content_sha256,object_residency_key_digest,projector_profile," +
  "state,item_count,item_set_digest,work_manifest_ref,work_manifest_sha256," +
  "reason_codes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'MATERIALIZED',?,?,?,?,?,?,?)",
).run(
  "revision-1", projection, "job-1", "owner-generation-1", digestA, digestB,
  "structural-markdown-v1", 1, digestC, "projection/manifest.json", digestC,
  "[]", now, now,
);

const terminalReceipt = "receipt-projection-terminal-1";
const terminalRef = `receipt:${terminalReceipt}:1`;
const outputRefs = JSON.stringify(["job-1", `projection-generation:${projection}`]);
const readbackRefs = JSON.stringify([
  "projection/manifest.json",
  d1Receipt,
  "managed-receipt-1",
]);

function writeTerminalAttempt(expectedSemanticReceipt) {
  core.prepare(
    "UPDATE projection_generation SET state='COMPLETED',d1_search_receipt_ref=?," +
    "d1_search_readback_digest=?,semantic_instance_id=?,semantic_generation=?," +
    "semantic_receipt_ref=?,semantic_readback_digest=?,updated_at=? " +
    "WHERE source_revision_ref='revision-1' AND projection_generation=?",
  ).run(
    d1Receipt, digestC, "private-prose-g1", "g1-qwen3-2026-08-28",
    "managed-receipt-1", digestA, now, projection,
  );
  for (const [channel, generation, receipt] of [
    ["exact_ready", projection, d1Receipt],
    ["lexical_ready", projection, d1Receipt],
    ["semantic_ready", "g1-qwen3-2026-08-28", "managed-receipt-1"],
  ]) {
    core.prepare(
      "INSERT INTO source_readiness(source_revision_ref,channel,state,generation," +
      "reason_codes_json,receipt_ref,updated_at) VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(source_revision_ref,channel) DO UPDATE SET state=excluded.state," +
      "generation=excluded.generation,reason_codes_json=excluded.reason_codes_json," +
      "receipt_ref=excluded.receipt_ref,updated_at=excluded.updated_at",
    ).run("revision-1", channel, "ready", generation, "[]", receipt, now);
  }
  core.prepare(
    "UPDATE operation_attempt SET state='SUCCEEDED',ended_at=? WHERE attempt_id='attempt-1'",
  ).run(now);
  core.prepare(
    "INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,attempt_id," +
    "outcome,output_refs_json,readback_receipt_refs_json,reconciliation_required," +
    "reason_codes_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    terminalReceipt, 1, "intent-1", 1, "attempt-1", "SUCCEEDED",
    outputRefs, readbackRefs, 0, "[]", now,
  );
  core.prepare(
    "UPDATE job SET state='COMPLETED',current_stage='PROJECTION_COMPLETE'," +
    "terminal_receipt_ref=?,updated_at=? WHERE job_id='job-1'",
  ).run(terminalRef, now);
  core.prepare(
    "INSERT INTO projection_terminal_guard(source_revision_ref,projection_generation,job_id," +
    "terminal_receipt_id,terminal_receipt_revision,outcome,verified,created_at) " +
    "SELECT 'revision-1',?,'job-1',?,1,'SUCCEEDED',CASE WHEN " +
    "EXISTS (SELECT 1 FROM source_readiness WHERE source_revision_ref='revision-1' " +
    "AND channel='semantic_ready' AND state='ready' AND receipt_ref=?) " +
    "AND EXISTS (SELECT 1 FROM job WHERE job_id='job-1' AND state='COMPLETED' " +
    "AND terminal_receipt_ref=?) THEN 1 ELSE NULL END,?",
  ).run(projection, terminalReceipt, expectedSemanticReceipt, terminalRef, now);
}

assert.throws(() => {
  core.exec("BEGIN IMMEDIATE");
  try {
    writeTerminalAttempt("wrong-managed-receipt");
    core.exec("COMMIT");
  } catch (error) {
    core.exec("ROLLBACK");
    throw error;
  }
});
assert.equal(
  core.prepare(
    "SELECT state FROM projection_generation WHERE source_revision_ref='revision-1' " +
    "AND projection_generation=?",
  ).get(projection).state,
  "MATERIALIZED",
  "failed terminal guard must roll back generation completion",
);
assert.equal(
  core.prepare("SELECT state FROM job WHERE job_id='job-1'").get().state,
  "ACCEPTED",
);

core.exec("BEGIN IMMEDIATE");
try {
  writeTerminalAttempt("managed-receipt-1");
  core.exec("COMMIT");
} catch (error) {
  core.exec("ROLLBACK");
  throw error;
}
assert.deepEqual(
  { ...core.prepare(
    "SELECT state,current_stage,terminal_receipt_ref FROM job WHERE job_id='job-1'",
  ).get() },
  {
    state: "COMPLETED",
    current_stage: "PROJECTION_COMPLETE",
    terminal_receipt_ref: terminalRef,
  },
);
assert.equal(
  core.prepare(
    "SELECT verified FROM projection_terminal_guard WHERE source_revision_ref='revision-1' " +
    "AND projection_generation=?",
  ).get(projection).verified,
  1,
);
assert.equal(
  core.prepare(
    "SELECT COUNT(*) AS count FROM source_readiness WHERE source_revision_ref='revision-1' " +
    "AND state='ready' AND receipt_ref IS NOT NULL",
  ).get().count,
  3,
);
console.log("projection execution migrations, activation and terminal guards: PASS");
