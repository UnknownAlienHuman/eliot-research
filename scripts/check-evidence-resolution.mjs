import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrations = process.argv[2] ?? resolve(import.meta.dirname, "../infra/d1/core/migrations");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");
for (const name of readdirSync(migrations).filter((name) => /^\d+_.*\.sql$/u.test(name)).sort()) {
  db.exec(readFileSync(resolve(migrations, name), "utf8"));
}
assert.equal(
  db.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").get().value,
  "core-v8-erasure-closure",
);
const strict = new Map(db.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]));
for (const table of [
  "scope_access_grant",
  "evidence_handle_identity",
  "evidence_resolution_receipt",
  "evidence_resolution_guard",
  "citation_resolution_receipt",
  "citation_resolution_guard",
  "evidence_handle_invalidation",
]) assert.equal(strict.get(table), 1, `${table} must be STRICT`);

const now = "2026-08-31T22:00:00.000Z";
const expires = "2026-09-01T22:00:00.000Z";
const sha = (value) => value.repeat(64);

db.prepare(
  "INSERT INTO scope_snapshot(snapshot_id,revision,resolved_scope_expression_json," +
  "participant_generations_json,member_source_revision_refs_json,source_owner_generations_json," +
  "policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref," +
  "snapshot_digest,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "scope-1", 1, '{"kind":"SELECTED_SOURCES","source_ids":["source-1"]}',
  '{"library":"generation-1"}', '["revision-1"]',
  '{"revision-1":"owner-generation-1"}', "policy-1", sha("b"), 1,
  "credential-1", sha("c"), now, expires,
);
db.prepare(
  "INSERT INTO scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class," +
  "credential_generation,policy_authority_ref,allowed_use_json,disclosure_ceiling," +
  "authorization_receipt_ref,state,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "scope-1", 1, "principal-1", "owner_pwa", "credential-1", "policy-1",
  '["research"]', "private", "authorization-1", "ACTIVE", expires, now,
);
db.prepare(
  "INSERT INTO source(source_id,source_namespace_id,source_owner_system_id," +
  "source_owner_generation,ownership_mode,kind,title,default_storage_policy," +
  "default_residency_profile_id,source_class,license_policy_ref," +
  "default_retention_policy_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "source-1", "namespace-1", "owner-1", "owner-generation-1", "immutable_import",
  "text/markdown", "Source", "storage-1", "residency-1", "document", "license-1",
  "retention-1", now,
);
db.prepare(
  "INSERT INTO source_revision(source_revision_ref,source_id,source_owner_generation," +
  "content_sha256,object_residency_key_digest,normalized_artifact_ref,captured_at," +
  "parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref," +
  "admitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
).run(
  "revision-1", "source-1", "owner-generation-1", sha("a"), sha("d"),
  "artifact-1", now, "parser-1", "standard", "LIVE", "current_confirmed", "view-1", now,
);

db.exec("BEGIN IMMEDIATE");
try {
  db.prepare(
    "INSERT INTO evidence_handle(handle_id,revision,source_namespace_id,source_owner_generation," +
    "source_revision_ref,scope_snapshot_id,scope_snapshot_revision,anchor_json,excerpt_sha256," +
    "excerpt_byte_length,object_residency_key_digest,source_assurance_ceiling," +
    "materializer_assurance_ceiling,terminal_state,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "evidence-1", 1, "namespace-1", "owner-generation-1", "revision-1", "scope-1", 1,
    '{"end":5,"kind":"normalized_byte_range","start":0}', sha("e"), 5, sha("d"),
    "QUALIFIED", "EXACT", "LIVE", now, expires,
  );
  db.prepare(
    "INSERT INTO evidence_handle_identity(identity_digest,handle_id,handle_revision,created_at) " +
    "VALUES (?,?,?,?)",
  ).run(sha("f"), "evidence-1", 1, now);
  db.prepare(
    "INSERT INTO evidence_resolution_receipt(receipt_id,revision,handle_id,handle_revision," +
    "source_revision_ref,scope_snapshot_id,scope_snapshot_revision,authorization_receipt_ref," +
    "normalized_object_ref,normalized_object_ref_digest,source_revision_content_sha256," +
    "source_object_size,scope_snapshot_digest,anchor_digest,excerpt_sha256,excerpt_byte_length," +
    "source_owner_generation,purge_state,terminal_state,receipt_json,receipt_sha256,resolved_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "resolution-1", 1, "evidence-1", 1, "revision-1", "scope-1", 1,
    "authorization-1", "normalized/object", sha("1"), sha("a"), 100, sha("c"),
    sha("2"), sha("e"), 5, "owner-generation-1", "LIVE", "LIVE", "{}", sha("3"), now,
  );
  assert.throws(() => db.prepare(
    "INSERT INTO evidence_resolution_guard(handle_id,handle_revision,receipt_id," +
    "receipt_revision,identity_digest,verified,created_at) VALUES (?,?,?,?,?,?,?)",
  ).run("evidence-1", 1, "resolution-1", 1, sha("f"), null, now));
  db.exec("ROLLBACK");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM evidence_handle").get().count, 0);

// A valid guard and terminal invalidation are both durable and referentially closed.
db.exec("BEGIN IMMEDIATE");
try {
  db.prepare(
    "INSERT INTO evidence_handle(handle_id,revision,source_namespace_id,source_owner_generation," +
    "source_revision_ref,scope_snapshot_id,scope_snapshot_revision,anchor_json,excerpt_sha256," +
    "excerpt_byte_length,object_residency_key_digest,source_assurance_ceiling," +
    "materializer_assurance_ceiling,terminal_state,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "evidence-1", 1, "namespace-1", "owner-generation-1", "revision-1", "scope-1", 1,
    '{"end":5,"kind":"normalized_byte_range","start":0}', sha("e"), 5, sha("d"),
    "QUALIFIED", "EXACT", "LIVE", now, expires,
  );
  db.prepare(
    "INSERT INTO evidence_handle_identity(identity_digest,handle_id,handle_revision,created_at) " +
    "VALUES (?,?,?,?)",
  ).run(sha("f"), "evidence-1", 1, now);
  db.prepare(
    "INSERT INTO evidence_resolution_receipt(receipt_id,revision,handle_id,handle_revision," +
    "source_revision_ref,scope_snapshot_id,scope_snapshot_revision,authorization_receipt_ref," +
    "normalized_object_ref,normalized_object_ref_digest,source_revision_content_sha256," +
    "source_object_size,scope_snapshot_digest,anchor_digest,excerpt_sha256,excerpt_byte_length," +
    "source_owner_generation,purge_state,terminal_state,receipt_json,receipt_sha256,resolved_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "resolution-1", 1, "evidence-1", 1, "revision-1", "scope-1", 1,
    "authorization-1", "normalized/object", sha("1"), sha("a"), 100, sha("c"),
    sha("2"), sha("e"), 5, "owner-generation-1", "LIVE", "LIVE", "{}", sha("3"), now,
  );
  db.prepare(
    "INSERT INTO evidence_resolution_guard(handle_id,handle_revision,receipt_id," +
    "receipt_revision,identity_digest,verified,created_at) VALUES (?,?,?,?,?,?,?)",
  ).run("evidence-1", 1, "resolution-1", 1, sha("f"), 1, now);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
assert.equal(db.prepare("SELECT verified FROM evidence_resolution_guard").get().verified, 1);
db.prepare(
  "INSERT INTO evidence_handle_invalidation(invalidation_ref,handle_id,handle_revision," +
  "terminal_state,reason_code,observed_at) VALUES (?,?,?,?,?,?)",
).run("invalidation-1", "evidence-1", 1, "REDACTED", "PURGE_REQUESTED", now);
db.prepare(
  "UPDATE evidence_handle SET terminal_state='REDACTED',invalidation_ref='invalidation-1' " +
  "WHERE handle_id='evidence-1' AND revision=1 AND terminal_state='LIVE'",
).run();
assert.deepEqual(
  { ...db.prepare("SELECT terminal_state,invalidation_ref FROM evidence_handle").get() },
  { terminal_state: "REDACTED", invalidation_ref: "invalidation-1" },
);
console.log("evidence resolution migration and guard fixture: PASS");
