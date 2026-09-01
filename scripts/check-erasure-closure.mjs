import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const core = new DatabaseSync(":memory:");
const search = new DatabaseSync(":memory:");
core.exec("PRAGMA foreign_keys = ON");
search.exec("PRAGMA foreign_keys = ON");
for (const name of readdirSync(resolve(root, "infra/d1/core/migrations"))
  .filter((value) => /^\d+_.*\.sql$/u.test(value)).sort()) {
  core.exec(readFileSync(resolve(root, "infra/d1/core/migrations", name), "utf8"));
}
for (const name of readdirSync(resolve(root, "infra/d1/search/migrations"))
  .filter((value) => /^\d+_.*\.sql$/u.test(value)).sort()) {
  search.exec(readFileSync(resolve(root, "infra/d1/search/migrations", name), "utf8"));
}
assert.equal(core.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").get().value,
  "core-v8-erasure-closure");
assert.equal(search.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").get().value,
  "search-v3-erasure-invalidation");
const strict = new Map(core.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]));
for (const table of [
  "erasure_execution", "erasure_dependency_registry", "erasure_hold", "erasure_target",
  "erasure_stage_receipt", "erasure_dependent_invalidation", "backup_purge_obligation",
  "erasure_terminal_guard",
]) assert.equal(strict.get(table), 1, `${table} must be STRICT`);

const now = "2026-09-01T02:00:00.000Z";
const nextReview = "2026-09-08T02:00:00.000Z";
const sha = (value) => value.repeat(64);
const requestJson = JSON.stringify({
  admitted_at: now,
  deadline: nextReview,
  erasure_ref: { id: "erase-blocked", revision: 1 },
  exact_subject_refs: ["source-revision:revision-1"],
  legal_basis_ref: "delete-request-1",
  protocol: "erc.privacy.erasure.v1",
  requested_by_principal_ref: "privacy-officer-1",
  required_locations: ["BackupRestorePath", "CanonicalPayload"],
});

core.prepare(
  "INSERT INTO backup_epoch(backup_epoch_id,core_export_ref,search_projection_manifest_ref," +
  "evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision," +
  "verification_state,created_at,verified_at) VALUES (?,?,?,?,?,?,0,'VERIFIED',?,?)",
).run("backup-1", "core-export-1", "search-manifest-1", "evidence-manifest-1",
  "work-manifest-1", "offsite-copy-1", now, now);
core.prepare(
  "INSERT INTO erasure_case(erasure_id,revision,state,exact_subject_refs_json," +
  "requested_locations_json,completed_locations_json,blocked_locations_json," +
  "legal_basis_ref,deadline,created_at,updated_at) VALUES " +
  "(?,1,'INVALIDATE_DEPENDENTS',?,?,'[]','[]',?,?,?,?)",
).run("erase-blocked", '["source-revision:revision-1"]',
  '["BackupRestorePath","CanonicalPayload"]', "delete-request-1", nextReview, now, now);
core.prepare(
  "INSERT INTO erasure_execution(erasure_id,revision,request_json,request_sha256,state," +
  "lease_owner,lease_generation,lease_until,closure_digest,created_at,updated_at) VALUES " +
  "(?,1,?,?,'INVALIDATE_DEPENDENTS','worker-1',1,9999999999999,?,?,?)",
).run("erase-blocked", requestJson, sha("a"), sha("b"), now, now);
const insertTarget = core.prepare(
  "INSERT INTO erasure_target(erasure_id,erasure_revision,target_id,target_kind," +
  "exact_subject_ref,location,canonical_ref,identity_digest,state,updated_at) " +
  "VALUES ('erase-blocked',1,?,'OBJECT','source-revision:revision-1',?,?,?,?,?)",
);
insertTarget.run("target-core", "CanonicalPayload", "d1-core:source-revision:revision-1",
  sha("c"), "ABSENT", now);
insertTarget.run("target-backup", "BackupRestorePath", "backup:backup-1",
  sha("d"), "BLOCKED", now);
core.prepare(
  "INSERT INTO erasure_hold(hold_ref,exact_subject_ref,location,canonical_ref," +
  "policy_or_hold_ref,next_review_at,state,created_at) VALUES " +
  "('hold-1','source-revision:revision-1','BackupRestorePath','backup:backup-1'," +
  "'backup-lock-1',?,'ACTIVE',?)",
).run(nextReview, now);
core.prepare(
  "INSERT INTO erasure_stage_receipt(erasure_id,erasure_revision,stage,lease_generation," +
  "receipt_ref,payload_digest,created_at) VALUES " +
  "('erase-blocked',1,'INVALIDATE_DEPENDENTS',1,'invalidate-1',?,?)",
).run(sha("e"), now);
const ledgerBlocked = core.prepare(
  "INSERT INTO purge_ledger(erasure_id,non_revealing_subject_digest,disposition," +
  "receipt_ref,created_at) VALUES ('erase-blocked',?,'BLOCKED','ledger-blocked',?) " +
  "RETURNING ledger_revision",
).get(sha("f"), now).ledger_revision;

assert.throws(() => core.prepare(
  "INSERT INTO erasure_terminal_guard(erasure_id,erasure_revision,closure_digest," +
  "requested_locations_json,completed_locations_json,blocked_locations_json,terminal_state," +
  "receipt_sha256,purge_ledger_revision,verified,created_at) VALUES " +
  "('erase-blocked',1,?,?,?,'[]','COMPLETE',?,?,1,?)",
).run(sha("b"), '["BackupRestorePath","CanonicalPayload"]', '["CanonicalPayload"]',
  sha("0"), ledgerBlocked, now), /CHECK constraint failed/u,
"a subset purge must not satisfy the COMPLETE terminal guard");

core.prepare(
  "INSERT INTO erasure_terminal_guard(erasure_id,erasure_revision,closure_digest," +
  "requested_locations_json,completed_locations_json,blocked_locations_json,terminal_state," +
  "receipt_sha256,purge_ledger_revision,verified,created_at) VALUES " +
  "('erase-blocked',1,?,?,?,?,'BLOCKED',?,?,1,?)",
).run(sha("b"), '["BackupRestorePath","CanonicalPayload"]', '["CanonicalPayload"]',
  '[{"location":"BackupRestorePath","next_review_at":"2026-09-08T02:00:00.000Z","policy_or_hold_ref":"backup-lock-1"}]',
  sha("1"), ledgerBlocked, now);
assert.equal(core.prepare(
  "SELECT terminal_state FROM erasure_terminal_guard WHERE erasure_id='erase-blocked'",
).get().terminal_state, "BLOCKED");

const ledgerRow = core.prepare(
  "SELECT non_revealing_subject_digest,receipt_ref FROM purge_ledger WHERE ledger_revision=?",
).get(ledgerBlocked);
assert.equal(ledgerRow.non_revealing_subject_digest, sha("f"));
assert.equal(JSON.stringify(ledgerRow).includes("revision-1"), false,
  "purge ledger must not retain the deleted subject ref");

core.prepare(
  "INSERT INTO erasure_case(erasure_id,revision,state,exact_subject_refs_json," +
  "requested_locations_json,completed_locations_json,blocked_locations_json," +
  "legal_basis_ref,deadline,created_at,updated_at) VALUES " +
  "('erase-complete',1,'INVALIDATE_DEPENDENTS','[\"source-revision:revision-2\"]'," +
  "'[\"CanonicalPayload\"]','[]','[]','delete-request-2',?,?,?)",
).run(nextReview, now, now);
core.prepare(
  "INSERT INTO erasure_execution(erasure_id,revision,request_json,request_sha256,state," +
  "closure_digest,created_at,updated_at) VALUES " +
  "('erase-complete',1,'{}',?,'INVALIDATE_DEPENDENTS',?,?,?)",
).run(sha("2"), sha("3"), now, now);
core.prepare(
  "INSERT INTO erasure_target(erasure_id,erasure_revision,target_id,target_kind," +
  "exact_subject_ref,location,canonical_ref,identity_digest,state,updated_at) VALUES " +
  "('erase-complete',1,'target-complete','OBJECT','source-revision:revision-2'," +
  "'CanonicalPayload','d1-core:source-revision:revision-2',?,'ABSENT',?)",
).run(sha("4"), now);
core.prepare(
  "INSERT INTO erasure_stage_receipt(erasure_id,erasure_revision,stage,lease_generation," +
  "receipt_ref,payload_digest,created_at) VALUES " +
  "('erase-complete',1,'INVALIDATE_DEPENDENTS',1,'invalidate-2',?,?)",
).run(sha("5"), now);
const ledgerComplete = core.prepare(
  "INSERT INTO purge_ledger(erasure_id,non_revealing_subject_digest,disposition," +
  "receipt_ref,created_at) VALUES ('erase-complete',?,'COMPLETE','ledger-complete',?) " +
  "RETURNING ledger_revision",
).get(sha("6"), now).ledger_revision;
core.prepare(
  "INSERT INTO erasure_terminal_guard(erasure_id,erasure_revision,closure_digest," +
  "requested_locations_json,completed_locations_json,blocked_locations_json,terminal_state," +
  "receipt_sha256,purge_ledger_revision,verified,created_at) VALUES " +
  "('erase-complete',1,?,'[\"CanonicalPayload\"]','[\"CanonicalPayload\"]','[]'," +
  "'COMPLETE',?,?,CASE WHEN (SELECT COUNT(*) FROM erasure_target WHERE " +
  "erasure_id='erase-complete' AND state<>'ABSENT')=0 THEN 1 ELSE 0 END,?)",
).run(sha("3"), sha("7"), ledgerComplete, now);
assert.equal(core.prepare(
  "SELECT verified FROM erasure_terminal_guard WHERE erasure_id='erase-complete'",
).get().verified, 1);

search.prepare(
  "INSERT INTO projection_generation_receipt(source_revision_ref,projection_generation,state," +
  "item_count,item_set_digest,readback_digest,receipt_ref,created_at,updated_at) VALUES " +
  "('revision-3','generation-1','READY',1,?,?,'projection-ready-1',?,?)",
).run(sha("8"), sha("8"), now, now);
search.prepare(
  "INSERT INTO projection_item(item_key,source_revision_ref,canonical_section_id," +
  "project_membership_ids_json,source_class,title,heading_path,document_context_header," +
  "section_text,normalized_offset_map_ref,content_sha256,instruction_taint," +
  "projection_generation,active,updated_at) VALUES " +
  "('item-1','revision-3','section-1','[]','document','Title','[]','Title','secret'," +
  "'normalized-bytes:0:6',?,'DATA_ONLY','generation-1',1,?)",
).run(sha("9"), now);
search.prepare("DELETE FROM projection_item WHERE item_key='item-1'").run();
search.prepare(
  "INSERT INTO erasure_search_receipt(erasure_id,erasure_revision,target_id," +
  "source_revision_ref,projection_generation,deleted_item_count,remaining_item_count," +
  "absence_verified,receipt_ref,receipt_digest,created_at) VALUES " +
  "('erase-complete',1,'search-target','revision-3','generation-1',1,0,1," +
  "'search-absence-1',?,?)",
).run(sha("a"), now);
assert.equal(search.prepare(
  "SELECT remaining_item_count FROM erasure_search_receipt WHERE target_id='search-target'",
).get().remaining_item_count, 0);

console.log("erasure closure, blocked-backup and exact terminal guards: PASS");
