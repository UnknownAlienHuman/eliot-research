import type { ErasureFence, ErasureRequest } from "@eliotr/contracts";
import {
  canonicalErasureJson,
  erasureDigest,
  erasureFail,
} from "./canonical.js";
import type { BackupPrimaryPartInventorySnapshot } from "./backup-primary-contract.js";
import type { BackupPrimaryWriterQualificationReceipt } from "./types.js";

const SHA = /^[a-f0-9]{64}$/u;

export interface PreviousBackupPrimaryExecution {
  readonly lease_generation: number;
  readonly request_sha256: string;
  readonly closure_digest: string;
}

export interface PreviousBackupExecutionRow {
  readonly request_sha256: unknown;
  readonly lease_generation: unknown;
  readonly closure_digest: unknown;
}

export async function previousBackupPrimaryExecution(
  database: D1Database,
  row: PreviousBackupExecutionRow,
  request: ErasureRequest,
  requestSha: string,
): Promise<PreviousBackupPrimaryExecution | undefined> {
  if (typeof row.lease_generation !== "number" || !Number.isSafeInteger(row.lease_generation) ||
      row.lease_generation < 1 || row.request_sha256 !== requestSha ||
      !request.required_locations.includes("BackupRestorePath")) {
    return undefined;
  }
  if (typeof row.closure_digest === "string" && /^[a-f0-9]{64}$/u.test(row.closure_digest)) {
    return {
      lease_generation: row.lease_generation,
      request_sha256: requestSha,
      closure_digest: row.closure_digest,
    };
  }
  let handoff: { readonly request_sha256: unknown; readonly erasure_closure_digest: unknown; readonly state: unknown } | null;
  try {
    handoff = await database.prepare(
      "SELECT request_sha256,erasure_closure_digest,state FROM backup_erasure_primary_handoff " +
      "WHERE erasure_id=?1 AND erasure_revision=?2 AND current_lease_generation=?3 LIMIT 1",
    ).bind(request.erasure_ref.id, request.erasure_ref.revision, row.lease_generation)
      .first<{ readonly request_sha256: unknown; readonly erasure_closure_digest: unknown; readonly state: unknown }>();
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "prior backup handoff readback is unavailable", true, cause);
  }
  if (handoff === null || handoff.request_sha256 !== requestSha ||
      typeof handoff.erasure_closure_digest !== "string" || !/^[a-f0-9]{64}$/u.test(handoff.erasure_closure_digest) ||
      handoff.state !== "PENDING" && handoff.state !== "SEALED") {
    return undefined;
  }
  return {
    lease_generation: row.lease_generation,
    request_sha256: requestSha,
    closure_digest: handoff.erasure_closure_digest,
  };
}

export interface BackupPrimaryHandoffRow extends Record<string, unknown> {
  readonly erasure_id: unknown;
  readonly erasure_revision: unknown;
  readonly current_lease_generation: unknown;
  readonly current_lease_owner: unknown;
  readonly current_lease_until: unknown;
  readonly plan_lease_generation: unknown;
  readonly request_sha256: unknown;
  readonly erasure_closure_digest: unknown;
  readonly original_plan_digest: unknown;
  readonly original_target_digest: unknown;
  readonly original_target_part_digest: unknown;
  readonly original_primary_prefix_object_count: unknown;
  readonly original_primary_prefix_inventory_digest: unknown;
  readonly original_qualification_receipt_ref: unknown;
  readonly original_qualification_receipt_digest: unknown;
  readonly current_primary_prefix_object_count: unknown;
  readonly current_primary_prefix_inventory_digest: unknown;
  readonly current_qualification_json: unknown;
  readonly current_qualification_digest: unknown;
  readonly handoff_digest: unknown;
  readonly state: unknown;
  readonly created_at: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup primary handoff ${label} is malformed`);
  }
  return value;
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup primary handoff ${label} is malformed`);
  }
  return value;
}

function readSha(value: unknown, label: string): string {
  const text = readText(value, label);
  if (!SHA.test(text)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup primary handoff ${label} is not SHA-256`);
  return text;
}

function validateQualification(value: unknown): asserts value is BackupPrimaryWriterQualificationReceipt {
  if (!isRecord(value) || value.protocol !== "eliotr.backup-primary-writer-qualification.v1" ||
      value.mode !== "ISOLATED_NEW_BUCKET" && value.mode !== "LEGACY_WRITERS_DRAINED") {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup handoff qualification protocol or mode is malformed");
  }
  const textFields = ["operation_receipt_ref", "admission_binding_ref", "cloudflare_account_ref",
    "primary_bucket_binding_ref", "worker_version_ref", "controller_generation", "bootstrap_zero_state_receipt_ref"];
  const digestFields = ["operation_receipt_digest", "admission_binding_digest", "controller_fingerprint",
    "source_sha256", "configuration_sha256", "artifact_sha256", "bootstrap_zero_state_digest",
    "producer_claims_digest", "export_cut_inventory_digest", "primary_prefix_inventory_digest", "evidence_digest"];
  if (textFields.some((field) => typeof value[field] !== "string" || value[field] === "" || value[field] !== value[field].trim()) ||
      digestFields.some((field) => typeof value[field] !== "string" || !SHA.test(value[field]))) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup handoff qualification identity or digest is malformed");
  }
}

export function insertPendingBackupPrimaryHandoffStatement(
  database: D1Database,
  fence: ErasureFence,
  previous: PreviousBackupPrimaryExecution,
  createdAt: string,
): D1PreparedStatement {
  return database.prepare(
    "WITH source AS (" +
      "SELECT 0 AS priority,p.lease_generation AS plan_lease_generation,p.request_sha256," +
        "p.erasure_closure_digest,p.plan_digest,p.target_digest,p.target_part_digest," +
        "p.primary_prefix_object_count,p.primary_prefix_inventory_digest," +
        "p.qualification_receipt_ref,p.qualification_receipt_digest " +
      "FROM backup_erasure_primary_closure p WHERE p.erasure_id=?1 AND p.erasure_revision=?2 " +
        "AND p.lease_generation=?3 AND p.request_sha256=?4 AND p.erasure_closure_digest=?5 AND p.state='SEALED' " +
      "UNION ALL " +
      "SELECT 1,h.plan_lease_generation,h.request_sha256,h.erasure_closure_digest,h.original_plan_digest," +
        "h.original_target_digest,h.original_target_part_digest,h.original_primary_prefix_object_count," +
        "h.original_primary_prefix_inventory_digest,h.original_qualification_receipt_ref," +
        "h.original_qualification_receipt_digest " +
      "FROM backup_erasure_primary_handoff h WHERE h.erasure_id=?1 AND h.erasure_revision=?2 " +
        "AND h.current_lease_generation=?3 AND h.request_sha256=?4 AND h.erasure_closure_digest=?5 " +
        "AND h.state IN ('PENDING','SEALED')" +
    ") INSERT OR IGNORE INTO backup_erasure_primary_handoff(" +
      "erasure_id,erasure_revision,current_lease_generation,current_lease_owner,current_lease_until," +
      "plan_lease_generation,request_sha256,erasure_closure_digest,original_plan_digest,original_target_digest," +
      "original_target_part_digest,original_primary_prefix_object_count,original_primary_prefix_inventory_digest," +
      "original_qualification_receipt_ref,original_qualification_receipt_digest,state,created_at) " +
      "SELECT ?1,?2,?6,?7,?8,s.plan_lease_generation,s.request_sha256,s.erasure_closure_digest,s.plan_digest," +
        "s.target_digest,s.target_part_digest,s.primary_prefix_object_count,s.primary_prefix_inventory_digest," +
        "s.qualification_receipt_ref,s.qualification_receipt_digest,'PENDING',?9 FROM source s " +
      "WHERE EXISTS (SELECT 1 FROM backup_erasure_primary_delete_item d WHERE d.erasure_id=?1 " +
        "AND d.erasure_revision=?2 AND d.lease_generation=s.plan_lease_generation AND d.state<>'PINNED' " +
        "AND d.delete_intent_ref IS NOT NULL AND d.delete_intent_digest IS NOT NULL) OR EXISTS (" +
        "SELECT 1 FROM backup_purge_obligation o JOIN backup_erasure_primary_target_pin t " +
          "ON t.erasure_id=o.erasure_id AND t.erasure_revision=o.erasure_revision " +
          "AND t.lease_generation=s.plan_lease_generation AND t.target_id=o.target_id " +
          "AND t.backup_epoch_id=o.backup_epoch_id WHERE o.erasure_id=?1 AND o.erasure_revision=?2 " +
          "AND o.primary_delete_intent_ref IS NOT NULL AND o.primary_delete_intent_digest IS NOT NULL) " +
      "ORDER BY s.priority LIMIT 1",
  ).bind(
    fence.erasure_id,
    fence.revision,
    previous.lease_generation,
    previous.request_sha256,
    previous.closure_digest,
    fence.lease_generation,
    fence.lease_owner,
    fence.lease_until_ms,
    createdAt,
  );
}

async function expectedHandoffDigest(row: BackupPrimaryHandoffRow): Promise<string> {
  return erasureDigest({
    protocol: "eliotr.backup-primary-plan-handoff.v1",
    erasure_id: row.erasure_id,
    revision: row.erasure_revision,
    current_lease_generation: row.current_lease_generation,
    current_lease_owner: row.current_lease_owner,
    current_lease_until: row.current_lease_until,
    plan_lease_generation: row.plan_lease_generation,
    request_sha256: row.request_sha256,
    erasure_closure_digest: row.erasure_closure_digest,
    original_plan_digest: row.original_plan_digest,
    original_target_digest: row.original_target_digest,
    original_target_part_digest: row.original_target_part_digest,
    original_primary_prefix_object_count: row.original_primary_prefix_object_count,
    original_primary_prefix_inventory_digest: row.original_primary_prefix_inventory_digest,
    original_qualification_receipt_ref: row.original_qualification_receipt_ref,
    original_qualification_receipt_digest: row.original_qualification_receipt_digest,
    current_primary_prefix_object_count: row.current_primary_prefix_object_count,
    current_primary_prefix_inventory_digest: row.current_primary_prefix_inventory_digest,
    current_qualification_digest: row.current_qualification_digest,
  });
}

export async function readBackupPrimaryHandoff(
  database: D1Database,
  fence: ErasureFence,
): Promise<BackupPrimaryHandoffRow | null> {
  let row: BackupPrimaryHandoffRow | null;
  try {
    row = await database.prepare(
      "SELECT * FROM backup_erasure_primary_handoff WHERE erasure_id=?1 AND erasure_revision=?2 " +
      "AND current_lease_generation=?3 LIMIT 1",
    ).bind(fence.erasure_id, fence.revision, fence.lease_generation).first<BackupPrimaryHandoffRow>();
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup primary handoff readback is unavailable", true, cause);
  }
  if (row === null) return null;
  if (row.erasure_id !== fence.erasure_id || row.erasure_revision !== fence.revision ||
      row.current_lease_generation !== fence.lease_generation || row.current_lease_owner !== fence.lease_owner ||
      row.current_lease_until !== fence.lease_until_ms ||
      readNumber(row.plan_lease_generation, "historical plan generation", 1) >= fence.lease_generation ||
      row.state !== "PENDING" && row.state !== "SEALED") {
    erasureFail("ERASURE_LEASE_LOST", "backup primary handoff is not bound to the exact current lease", true);
  }
  readSha(row.request_sha256, "request digest");
  readSha(row.erasure_closure_digest, "closure digest");
  readSha(row.original_plan_digest, "original plan digest");
  readSha(row.original_target_digest, "original target digest");
  readSha(row.original_target_part_digest, "original part digest");
  readNumber(row.original_primary_prefix_object_count, "original prefix count");
  readSha(row.original_primary_prefix_inventory_digest, "original prefix digest");
  readText(row.original_qualification_receipt_ref, "original qualification receipt ref");
  readSha(row.original_qualification_receipt_digest, "original qualification receipt digest");
  if (row.state === "PENDING") {
    if (row.current_primary_prefix_object_count !== null || row.current_primary_prefix_inventory_digest !== null ||
        row.current_qualification_json !== null || row.current_qualification_digest !== null || row.handoff_digest !== null) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "pending backup handoff carries sealed-only fields");
    }
  } else {
    const count = readNumber(row.current_primary_prefix_object_count, "current prefix count");
    const prefixDigest = readSha(row.current_primary_prefix_inventory_digest, "current prefix digest");
    const qualificationDigest = readSha(row.current_qualification_digest, "current qualification digest");
    const qualificationJson = readText(row.current_qualification_json, "current qualification JSON");
    let qualification: unknown;
    try { qualification = JSON.parse(qualificationJson) as unknown; }
    catch (cause) { erasureFail("ERASURE_IDENTITY_CONFLICT", "current handoff qualification JSON is malformed", false, cause); }
    if (!isRecord(qualification) || canonicalErasureJson(qualification) !== qualificationJson ||
        await erasureDigest(qualification) !== qualificationDigest ||
        count < 0 || prefixDigest !== row.current_primary_prefix_inventory_digest ||
        await expectedHandoffDigest(row) !== row.handoff_digest) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "sealed backup handoff digest differs from its exact qualification pins");
    }
    validateQualification(qualification);
  }
  return row;
}

export async function sealBackupPrimaryHandoff(
  database: D1Database,
  fence: ErasureFence,
  primary: BackupPrimaryPartInventorySnapshot,
  qualification: BackupPrimaryWriterQualificationReceipt,
): Promise<BackupPrimaryHandoffRow> {
  const pending = await readBackupPrimaryHandoff(database, fence);
  if (pending === null || pending.state !== "PENDING") {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "current backup attempt has no pending immutable-plan handoff");
  }
  validateQualification(qualification);
  if (qualification.primary_prefix_inventory_digest !== primary.inventory_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "current handoff qualification is not bound to the exact primary prefix readback");
  }
  const qualificationJson = canonicalErasureJson(qualification);
  const qualificationDigest = await erasureDigest(qualification);
  const candidate = {
    ...pending,
    current_primary_prefix_object_count: primary.object_count,
    current_primary_prefix_inventory_digest: primary.inventory_digest,
    current_qualification_json: qualificationJson,
    current_qualification_digest: qualificationDigest,
    state: "SEALED",
  } as BackupPrimaryHandoffRow;
  const handoffDigest = await expectedHandoffDigest(candidate);
  try {
    await database.prepare(
      "UPDATE backup_erasure_primary_handoff SET current_primary_prefix_object_count=?4," +
        "current_primary_prefix_inventory_digest=?5,current_qualification_json=?6," +
        "current_qualification_digest=?7,handoff_digest=?8,state='SEALED' " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND current_lease_generation=?3 AND state='PENDING' " +
        "AND EXISTS (SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
        "AND e.state='QUARANTINE_AND_REVOKE' AND e.request_sha256=?9 AND e.lease_owner=?10 " +
        "AND e.lease_generation=?3 AND e.lease_until=?11 " +
        "AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))",
    ).bind(fence.erasure_id, fence.revision, fence.lease_generation, primary.object_count,
      primary.inventory_digest, qualificationJson, qualificationDigest, handoffDigest,
      pending.request_sha256 as string, fence.lease_owner, fence.lease_until_ms).run();
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "current backup plan handoff qualification did not settle", true, cause);
  }
  const sealed = await readBackupPrimaryHandoff(database, fence);
  if (sealed === null || sealed.state !== "SEALED" || sealed.plan_lease_generation !== pending.plan_lease_generation ||
      sealed.current_primary_prefix_object_count !== primary.object_count ||
      sealed.current_primary_prefix_inventory_digest !== primary.inventory_digest ||
      sealed.current_qualification_json !== qualificationJson || sealed.current_qualification_digest !== qualificationDigest ||
      sealed.handoff_digest !== handoffDigest) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "sealed backup plan handoff failed exact D1 readback", true);
  }
  return sealed;
}

export async function parseHandoffQualification(
  row: BackupPrimaryHandoffRow,
): Promise<BackupPrimaryWriterQualificationReceipt> {
  if (row.state !== "SEALED" || typeof row.current_qualification_json !== "string") {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "sealed backup handoff qualification is unavailable");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.current_qualification_json) as unknown; }
  catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "sealed backup handoff qualification is malformed", false, cause); }
  validateQualification(parsed);
  return parsed;
}
