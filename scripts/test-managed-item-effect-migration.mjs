import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../", import.meta.url);
const migration = await readFile(
  new URL("infra/d1/core/migrations/0128_managed_item_effects.sql", root),
  "utf8",
);
const db = new DatabaseSync(":memory:");
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE job (job_id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE projection_generation (
    source_revision_ref TEXT NOT NULL,
    projection_generation TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES job(job_id),
    PRIMARY KEY (source_revision_ref, projection_generation)
  ) STRICT;
  CREATE TABLE operation_intent (
    intent_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (intent_id, revision)
  ) STRICT;
  CREATE TABLE operation_attempt (
    attempt_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    FOREIGN KEY (intent_id, intent_revision)
      REFERENCES operation_intent(intent_id, revision)
  ) STRICT;
  CREATE TABLE operation_execution_lease (operation_id TEXT PRIMARY KEY) STRICT;
`);
db.exec(migration);

db.prepare("INSERT INTO job(job_id) VALUES(?)").run("job-1");
db.prepare("INSERT INTO projection_generation(source_revision_ref,projection_generation,job_id) VALUES(?,?,?)")
  .run("source-1", "projection-1", "job-1");
db.prepare("INSERT INTO operation_intent(intent_id,revision) VALUES(?,?)").run("intent-1", 1);
db.prepare("INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision) VALUES(?,?,?)")
  .run("attempt-1", "intent-1", 1);
db.prepare("INSERT INTO operation_execution_lease(operation_id) VALUES(?)").run("operation-1");

const sectionHash = "a".repeat(64);
const documentHash = "b".repeat(64);
const readbackHash = "c".repeat(64);
const columns = [
  "source_revision_ref", "projection_generation", "job_id", "item_key", "desired_index",
  "normalized_start_byte", "normalized_end_byte",
  "intent_id", "intent_revision", "attempt_id", "execution_operation_id",
  "dispatch_lease_generation", "managed_instance_id", "managed_generation", "provider_source",
  "provider_key", "section_content_sha256", "document_sha256", "document_size_bytes",
  "metadata_json", "state", "provider_item_id", "readback_receipt_json", "readback_sha256",
  "created_at", "updated_at",
];
const insert = db.prepare(`
  INSERT INTO projection_managed_item_effect (${columns.join(",")})
  VALUES (${columns.map(() => "?").join(",")})
`);
const metadata = () => ({
  source_revision_ref: "source-1",
  canonical_section_id: "section-1",
  projection_generation: "managed-1",
  instruction_taint: "UNTAINTED",
  content_sha256: sectionHash,
});
const item = (key, index, overrides = {}) => {
  const { extraMetadata, ...rowOverrides } = overrides;
  const providerItemId = `provider-${key}`;
  const state = rowOverrides.state ?? "INTENT";
  const size = 32;
  const receipt = {
    item_key: key,
    provider_item_id: providerItemId,
    provider_key: `${key}.md`,
    file_size: size,
    chunks_count: 1,
    content_sha256: documentHash,
    readback_sha256: readbackHash,
  };
  const fields = metadata();
  if (extraMetadata) Object.assign(fields, extraMetadata);
  const row = {
    source_revision_ref: "source-1",
    projection_generation: "projection-1",
    job_id: "job-1",
    item_key: key,
    desired_index: index,
    normalized_start_byte: index * 10,
    normalized_end_byte: index * 10 + 1,
    intent_id: "intent-1",
    intent_revision: 1,
    attempt_id: "attempt-1",
    execution_operation_id: "operation-1",
    dispatch_lease_generation: state === "INTENT" ? null : 1,
    managed_instance_id: "instance-1",
    managed_generation: "managed-1",
    provider_source: "builtin",
    provider_key: `${key}.md`,
    section_content_sha256: sectionHash,
    document_sha256: documentHash,
    document_size_bytes: size,
    metadata_json: JSON.stringify(fields),
    state,
    provider_item_id: state === "READBACK_VERIFIED" ? providerItemId : null,
    readback_receipt_json: state === "READBACK_VERIFIED" ? JSON.stringify(receipt) : null,
    readback_sha256: state === "READBACK_VERIFIED" ? readbackHash : null,
    created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T00:00:00.000Z",
    ...rowOverrides,
  };
  return columns.map((column) => row[column]);
};
const reject = (values, name) => {
  assert.throws(() => insert.run(...values), /CHECK constraint failed/u, name);
};

assert.doesNotThrow(() => insert.run(...item("valid-intent", 0)), "exact five-field metadata is accepted");
reject(item("missing-metadata", 1, { metadata_json: "{}" }), "missing metadata fields are rejected");
reject(
  item("sixth-metadata-field", 2, { extraMetadata: { undeclared: "value" } }),
  "a sixth metadata field is rejected",
);
reject(
  item("invalid-span", 6, { normalized_start_byte: 8, normalized_end_byte: 7 }),
  "invalid normalized spans are rejected",
);
assert.doesNotThrow(
  () => insert.run(...item("valid-readback", 3, { state: "READBACK_VERIFIED" })),
  "an exact readback receipt is accepted",
);
reject(
  item("missing-receipt-fields", 4, { state: "READBACK_VERIFIED", readback_receipt_json: "{}" }),
  "missing readback receipt fields are rejected",
);
reject(
  item("null-check-bypass", 5, {
    state: "READBACK_VERIFIED",
    metadata_json: "{}",
    readback_receipt_json: "{}",
  }),
  "missing metadata and receipt fields cannot pass the combined readback checks",
);

assert.equal(
  db.prepare("SELECT COUNT(*) AS count FROM projection_managed_item_effect").get().count,
  2,
);
assert.throws(
  () => db.prepare(
    "UPDATE projection_managed_item_effect SET normalized_start_byte = 9 WHERE item_key = ?",
  ).run("valid-intent"),
  /PROJECTION_MANAGED_ITEM_IMMUTABLE/u,
  "normalized spans remain immutable after intent admission",
);
db.close();
console.log("managed-item migration native schema fixture: PASS (exact metadata, span checks, readback JSON, immutable intent)");
