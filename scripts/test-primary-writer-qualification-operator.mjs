import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { loadCompiledWorkspaceModule } from "./lib/compiled-workspace-module.mjs";
import { apply, assertPrimaryBucketBinding, reconcile } from "../infra/backup/primary-writer-qualification-operator.mjs";

const now = "2026-10-05T12:00:00.000Z";
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) ?? "null" : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
const digest = async (value) => {
  const bytes = new TextEncoder().encode(value);
  const hash = await webcrypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
const digestSync = (value) => createHash("sha256").update(value, "utf8").digest("hex");

assert.equal(assertPrimaryBucketBinding([{ name: "BACKUP_PARTS_BUCKET", type: "r2_bucket", bucket_name: "primary" }], "primary").bucket_name, "primary");
assert.throws(() => assertPrimaryBucketBinding([{ name: "BACKUP_PARTS_BUCKET", type: "r2_bucket", bucket_name: "other" }], "primary"), /bucket name/u);
assert.throws(() => assertPrimaryBucketBinding([{ name: "BACKUP_PARTS_BUCKET", type: "kv_namespace", bucket_name: "primary" }], "primary"), /type/u);
assert.throws(() => assertPrimaryBucketBinding([{ name: "BACKUP_PARTS_BUCKET", type: "r2_bucket", bucket_name: "primary" }, { name: "BACKUP_PARTS_BUCKET", type: "r2_bucket", bucket_name: "primary" }], "primary"), /exactly one/u);

const shared = await loadCompiledWorkspaceModule("packages/cloudflare-backup/dist/primary-writer-qualification.js");
const intentRef = { id: "backup-intent-fixture", revision: 1 };
const intent = { intent_ref: intentRef, operation_kind: "BACKUP", principal_ref: "operator-fixture", idempotency_key: "fixture-idempotency", payload_ref: "fixture-payload", policy_decision_ref: "fixture-policy", created_at: now };
const attempt = { attempt_id: "backup-attempt-fixture", intent_ref: intentRef, attempt_number: 1, state: "STARTED", started_at: now };
const receipt = { receipt_ref: { id: "backup-receipt-fixture", revision: 1 }, intent_ref: intentRef, attempt_id: attempt.attempt_id, outcome: "ACCEPTED", output_refs: [], readback_receipt_refs: ["fixture-readback"], reconciliation_required: false, reason_codes: [], created_at: now };
const operationRow = {
  operation_ref: "backup-operation-fixture", qualification_ref: "backup-qualification-fixture", qualification_revision: 1,
  intent_ref: intentRef.id, intent_revision: intentRef.revision, intent_json: canonical(intent), intent_sha256: await digest(canonical(intent)),
  attempt_id: attempt.attempt_id, attempt_number: attempt.attempt_number, attempt_json: canonical(attempt), attempt_sha256: await digest(canonical(attempt)),
  receipt_ref: receipt.receipt_ref.id, operation_json: "{}", receipt_json: canonical(receipt), receipt_sha256: await digest(canonical(receipt)),
  readback_receipt_ref: "fixture-readback", readback_sha256: await digest("fixture-worker-readback"), state: "ADMITTED", created_at: now, updated_at: now,
};
await shared.parsePrimaryWriterOperation(operationRow);
await assert.rejects(() => shared.parsePrimaryWriterOperation({ ...operationRow, intent_revision: 2 }), /identity diverges/u);
await assert.rejects(() => shared.parsePrimaryWriterOperation({ ...operationRow, receipt_json: "{}" }), /malformed|invalid/u);

const operatorSource = await readFile(resolve("infra/backup/primary-writer-qualification-operator.mjs"), "utf8");
assert.doesNotMatch(operatorSource, /prepare\([^\n]*,\s*\[/u);
assert.match(operatorSource, /INSERT OR IGNORE INTO backup_primary_writer_operation[\s\S]*?WHERE EXISTS/u);
assert.match(operatorSource, /qualification\/current conditional operation commit/u);

function d1Shim(db) {
  function statement(sql) {
    const prepared = db.prepare(sql);
    const execute = (parameters) => prepared.run(...parameters);
    const read = (parameters) => prepared.get(...parameters) ?? null;
    const list = (parameters) => prepared.all(...parameters);
    const bound = (...parameters) => ({ first: async () => read(parameters), all: async () => ({ results: list(parameters) }), run: async () => { const result = execute(parameters); return { meta: { changes: Number(result.changes) } }; } });
    return { bind: bound, first: async () => read([]), all: async () => ({ results: list([]) }), run: async () => { const result = execute([]); return { meta: { changes: Number(result.changes) } }; } };
  }
  return { prepare: statement };
}

function schema(db) {
  db.exec(`CREATE TABLE backup_primary_writer_qualification (
    qualification_ref TEXT, revision INTEGER, protocol TEXT, mode TEXT, authority_json TEXT, authority_sha256 TEXT,
    owner_admission_ref TEXT, owner_admission_sha256 TEXT, erasure_mode TEXT, producer_claim_count INTEGER,
    producer_claim_digest TEXT, export_cut_count INTEGER, export_cut_digest TEXT, primary_prefix_count INTEGER,
    primary_prefix_digest TEXT, account_id TEXT, worker_name TEXT, deployment_id TEXT, version_id TEXT,
    version_etag TEXT, controller_generation TEXT, source_sha256 TEXT, configuration_sha256 TEXT,
    compiled_artifact_sha256 TEXT, bucket_binding_ref TEXT, bucket_name TEXT, reserved_prefix TEXT,
    bootstrap_zero_d1_ref TEXT, bootstrap_zero_d1_json TEXT, bootstrap_zero_d1_sha256 TEXT,
    reserved_prefix_readback_ref TEXT, reserved_prefix_readback_sha256 TEXT, evidence_digest TEXT, created_at TEXT);
  CREATE TABLE backup_primary_writer_current (
    slot TEXT, qualification_ref TEXT, qualification_revision INTEGER, qualification_sha256 TEXT,
    controller_generation TEXT, state TEXT, updated_at TEXT);
  CREATE TABLE backup_primary_writer_operation (
    operation_ref TEXT, qualification_ref TEXT, qualification_revision INTEGER, intent_ref TEXT,
    intent_revision INTEGER, intent_json TEXT, intent_sha256 TEXT, attempt_id TEXT, attempt_number INTEGER,
    attempt_json TEXT, attempt_sha256 TEXT, receipt_ref TEXT, operation_json TEXT, receipt_json TEXT,
    receipt_sha256 TEXT, readback_receipt_ref TEXT, readback_sha256 TEXT, state TEXT, created_at TEXT, updated_at TEXT);`);
}

function fixture() {
  const digestValue = "a".repeat(64);
  const zero = { protocol: "eliotr.backup-primary-zero-baseline.v1", epoch_count: 0, receipt_count: 0, export_cut_count: 0, erasure_case_count: 0, erasure_execution_count: 0, producer_claim_count: 0, primary_prefix_count: 0, observed_at: now };
  const prefix = { protocol: "eliotr.backup-primary-prefix-readback.v1", bucket_binding_ref: "BACKUP_PARTS_BUCKET", bucket_name: "primary", prefix: "backup-parts/", object_count: 0, inventory_digest: digestValue, observed_at: now };
  const q = { protocol: "eliotr.backup-primary-writer-qualification.v1", qualification_ref: "backup-qualification-fixture", revision: 1, mode: "ISOLATED_NEW_BUCKET", owner_admission_ref: "admission-fixture", owner_admission_sha256: digestValue, erasure_mode: "NO_ACTIVE_ERASURE", producer_claim_count: 0, producer_claim_digest: digestValue, export_cut_count: 0, export_cut_digest: digestValue, primary_prefix_count: 0, primary_prefix_digest: digestValue, cloudflare: { account_id: "account-fixture", worker_name: "worker-fixture", deployment_id: "deployment-fixture", version_id: "version-fixture", version_etag: "etag-fixture", controller_generation: "generation-fixture", source_sha256: digestValue, configuration_sha256: digestValue, compiled_artifact_sha256: digestValue, bucket_binding_ref: "BACKUP_PARTS_BUCKET", bucket_name: "primary", reserved_prefix: "backup-parts/" }, bootstrap_zero_d1: zero, bootstrap_zero_d1_ref: "zero-fixture", reserved_prefix_readback: prefix, reserved_prefix_readback_ref: "prefix-fixture", reserved_prefix_readback_sha256: digestValue, evidence_digest: digestValue, created_at: now };
  const intentRef = { id: "backup-intent-fixture", revision: 1 };
  const intent = { intent_ref: intentRef, operation_kind: "BACKUP", principal_ref: "operator-fixture", idempotency_key: "fixture-idempotency", payload_ref: "fixture-payload", policy_decision_ref: "fixture-policy", created_at: now };
  const attempt = { attempt_id: "backup-attempt-fixture", intent_ref: intentRef, attempt_number: 1, state: "STARTED", started_at: now };
  const receipt = { receipt_ref: { id: "backup-receipt-fixture", revision: 1 }, intent_ref: intentRef, attempt_id: attempt.attempt_id, outcome: "ACCEPTED", output_refs: [], readback_receipt_refs: ["fixture-readback"], reconciliation_required: false, reason_codes: [], created_at: now };
  const operation = { operation_ref: "backup-operation-fixture", qualification_ref: q.qualification_ref, qualification_revision: q.revision, intent, intent_sha256: digestSync(canonical(intent)), attempt, attempt_sha256: digestSync(canonical(attempt)), receipt, receipt_sha256: digestSync(canonical(receipt)), readback_receipt_ref: "fixture-readback", readback_sha256: digestSync("fixture-worker-readback"), state: "ADMITTED", created_at: now, updated_at: now };
  const plan = { qualification: q, operation };
  const proof = { deployment_id: q.cloudflare.deployment_id, version_id: q.cloudflare.version_id, version_etag: q.cloudflare.version_etag, worker_readback_sha256: digestSync(canonical({ deployment_id: q.cloudflare.deployment_id, version_id: q.cloudflare.version_id, version_etag: q.cloudflare.version_etag })) };
  return { plan, proof };
}

const { plan, proof } = fixture();
const staleDb = new DatabaseSync(":memory:");
schema(staleDb);
staleDb.exec("INSERT INTO backup_primary_writer_qualification(qualification_ref,revision) VALUES('stale-qualification',7); INSERT INTO backup_primary_writer_operation(operation_ref,state) VALUES('stale-operation','UNKNOWN');");
await assert.rejects(() => apply(plan, digest("fixture-plan"), proof, d1Shim(staleDb)), /UNKNOWN/u);
assert.equal(staleDb.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_qualification").get().count, 1);
assert.equal(staleDb.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_operation").get().count, 1);
assert.equal(staleDb.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_current").get().count, 0);
staleDb.close();

const db = new DatabaseSync(":memory:");
schema(db);
const database = d1Shim(db);
const committed = await apply(plan, digest("fixture-plan"), proof, database);
assert.equal(committed.state, "COMMITTED");
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_operation").get().count, 1);
const reconciled = await reconcile(plan, plan.operation.operation_ref, database);
assert.equal(reconciled.state, "COMMITTED_VERIFIED");
assert.equal(reconciled.writes, 0);
await assert.rejects(() => apply(plan, digest("fixture-plan"), proof, database), /UNKNOWN/u);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_operation").get().count, 1);
db.close();

const racedDb = new DatabaseSync(":memory:");
schema(racedDb);
const racedBase = d1Shim(racedDb);
let raced = false;
const racedDatabase = { prepare(sql) {
  const prepared = racedBase.prepare(sql);
  if (!sql.startsWith("INSERT OR IGNORE INTO backup_primary_writer_operation")) return prepared;
  return { ...prepared, bind(...parameters) { const bound = prepared.bind(...parameters); return { ...bound, run: async () => { if (!raced) { racedDb.prepare("UPDATE backup_primary_writer_current SET state='DRAINING'").run(); raced = true; } return bound.run(); } }; } };
} };
await assert.rejects(() => apply(plan, digest("fixture-plan"), proof, racedDatabase), /UNKNOWN/u);
assert.equal(racedDb.prepare("SELECT COUNT(*) AS count FROM backup_primary_writer_operation").get().count, 0);
const noReplay = await reconcile(plan, plan.operation.operation_ref, racedDatabase);
assert.equal(noReplay.state, "UNKNOWN_NO_OPERATION");
assert.equal(noReplay.writes, 0);
racedDb.close();
console.log("primary-writer operator regression fixture: PASS");
