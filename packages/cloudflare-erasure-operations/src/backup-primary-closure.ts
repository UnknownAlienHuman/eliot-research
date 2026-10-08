import type { ErasureFence, PurgeTarget } from "@eliotr/contracts";
import { type BackupEpochProducerClaim } from "@eliotr/backup-o2";
import {
  assertErasureIdentifier,
  canonicalErasureJson,
  erasureDigest,
  erasureFail,
  isoFromMs,
  backupPrimaryQualificationInput,
} from "@eliotr/cloudflare-erasure";
import type {
  BackupExportCutInventory,
  BackupExportCutPin,
  BackupPrimaryClosureSealRequest,
  BackupPrimaryObjectPin,
  BackupProducerQuiescenceSnapshot,
} from "@eliotr/cloudflare-erasure";
import type {
  BackupPrimaryWriterQualificationInput,
  BackupPrimaryWriterQualificationReceipt,
} from "@eliotr/cloudflare-erasure";
import { verifyBackupPrimaryClosureChildren } from "./backup-primary-closure-readback.js";

const MAX_CLOSURE_ROWS = 100_000;
const INSERT_CHUNK = 64;
const CUT_STATES = ["OPEN", "ACCEPTED", "REJECTED"] as const;
const CLAIM_STATES = ["COMMITTED", "ABANDONED_NO_WRITES"] as const;

interface D1Rows<T> {
  readonly success?: boolean;
  readonly results?: readonly T[];
}

interface CutRow {
  readonly cut_id: unknown;
  readonly cut_digest: unknown;
  readonly state: unknown;
}

interface ClosureHeaderRow extends Record<string, unknown> {
  readonly state: unknown;
  readonly created_at: unknown;
}

interface ExecutionFenceRow {
  readonly request_sha256: unknown;
  readonly closure_digest: unknown;
  readonly state: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}

function failRead(message: string, cause?: unknown): never {
  erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", message, true, cause);
}

async function all<T>(database: D1Database, sql: string, values: readonly (string | number)[] = []): Promise<readonly T[]> {
  let result: D1Rows<T>;
  try {
    const statement = database.prepare(sql);
    result = await (values.length === 0 ? statement : statement.bind(...values)).all<T>();
  } catch (cause) {
    failRead("backup primary closure D1 read failed", cause);
  }
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > MAX_CLOSURE_ROWS) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary closure D1 result is malformed or over its row bound");
  }
  return result.results;
}

async function first<T>(database: D1Database, sql: string, values: readonly (string | number)[]): Promise<T | null> {
  try {
    return await database.prepare(sql).bind(...values).first<T>();
  } catch (cause) {
    failRead("backup primary closure D1 read failed", cause);
  }
}

async function run(database: D1Database, sql: string, values: readonly (string | number | null)[]): Promise<void> {
  try {
    const result = await database.prepare(sql).bind(...values).run();
    if ((result as { readonly success?: boolean }).success === false) failRead("backup primary closure D1 write did not settle");
  } catch (cause) {
    failRead("backup primary closure D1 write did not settle", cause);
  }
}

async function insertRows(database: D1Database, statements: readonly D1PreparedStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += INSERT_CHUNK) {
    try {
      const result = await database.batch(statements.slice(offset, offset + INSERT_CHUNK));
      if (result.some((item) => (item as { readonly success?: boolean }).success === false)) {
        failRead("backup primary closure child pins did not settle");
      }
    } catch (cause) {
      failRead("backup primary closure child pin acknowledgement is uncertain", cause);
    }
  }
}

async function insertDataRows<T extends Record<string, unknown>>(
  database: D1Database,
  table: string,
  columns: readonly string[],
  rows: readonly T[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
    const statements = rows.slice(offset, offset + INSERT_CHUNK).map((row) => {
      const placeholders = columns.map((_column, index) => `?${index + 1}`).join(",");
      const values = rowValueList(row, columns) as (string | number | null)[];
      return database.prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      ).bind(...values);
    });
    await insertRows(database, statements);
  }
}

export async function readBackupExportCutInventory(database: D1Database): Promise<BackupExportCutInventory> {
  const rows = await all<CutRow>(database,
    `SELECT cut_id,cut_digest,state FROM backup_export_cut ORDER BY cut_id LIMIT ${MAX_CLOSURE_ROWS + 1}`);
  if (rows.length > MAX_CLOSURE_ROWS) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup export-cut inventory exceeds its bound");
  const cuts: BackupExportCutPin[] = rows.map((row) => {
    if (typeof row.cut_id !== "string" || typeof row.cut_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row.cut_digest) || !CUT_STATES.includes(row.state as typeof CUT_STATES[number])) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup export-cut inventory has malformed durable pins");
    }
    return { cut_id: assertErasureIdentifier(row.cut_id, "backup export cut ID"),
      cut_digest: row.cut_digest, state: row.state as typeof CUT_STATES[number] };
  });
  if (new Set(cuts.map((cut) => cut.cut_id)).size !== cuts.length) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup export-cut inventory contains duplicate identities");
  }
  return { cuts, inventory_digest: await erasureDigest(cuts) };
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validateQualification(
  value: BackupPrimaryWriterQualificationReceipt,
  input: BackupPrimaryWriterQualificationInput,
): void {
  const textFields = [
    value.operation_receipt_ref, value.admission_binding_ref, value.cloudflare_account_ref,
    value.primary_bucket_binding_ref, value.worker_version_ref, value.controller_generation,
    value.bootstrap_zero_state_receipt_ref,
  ];
  const digestFields = [
    value.operation_receipt_digest, value.admission_binding_digest, value.controller_fingerprint,
    value.source_sha256, value.configuration_sha256, value.artifact_sha256,
    value.bootstrap_zero_state_digest, value.producer_claims_digest,
    value.export_cut_inventory_digest, value.primary_prefix_inventory_digest, value.evidence_digest,
  ];
  if (value.protocol !== "eliotr.backup-primary-writer-qualification.v1" ||
      (value.mode !== "ISOLATED_NEW_BUCKET" && value.mode !== "LEGACY_WRITERS_DRAINED") ||
      textFields.some((field) => typeof field !== "string" || field.trim() !== field || field.length === 0) ||
      digestFields.some((field) => !isSha(field)) ||
      value.producer_claims_digest !== input.producer_claims_digest ||
      value.export_cut_inventory_digest !== input.export_cut_inventory_digest ||
      value.primary_prefix_inventory_digest !== input.primary_prefix_inventory_digest) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary writer qualification is malformed or binds another snapshot");
  }
}

function cutClassification(
  cuts: BackupExportCutInventory,
  producer: BackupProducerQuiescenceSnapshot,
): readonly { readonly cut_id: string; readonly cut_digest: string; readonly state: string;
  readonly classification: "COMMITTED_CLAIM" | "LEGACY_RETIRED"; readonly idempotency_key: string | null }[] {
  const committed = new Map<string, BackupEpochProducerClaim>();
  for (const claim of producer.claims) {
    if (!CLAIM_STATES.includes(claim.state as typeof CLAIM_STATES[number])) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup producer snapshot contains a nonterminal state");
    }
    if (claim.state === "COMMITTED") {
      if (claim.cut_id === null || claim.cut_digest === null || claim.epoch_id === null ||
          claim.part_prefix !== `backup-parts/${claim.epoch_id}/`) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "committed backup producer claim lacks exact output pins");
      }
      committed.set(claim.cut_id, claim);
    }
  }
  const out = cuts.cuts.map((cut) => {
    const claim = committed.get(cut.cut_id);
    if (claim !== undefined) {
      if (claim.cut_digest !== cut.cut_digest || cut.state !== "ACCEPTED") {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "committed producer cut diverges from its current durable row");
      }
      return { ...cut, classification: "COMMITTED_CLAIM" as const, idempotency_key: claim.idempotency_key };
    }
    return { ...cut, classification: "LEGACY_RETIRED" as const, idempotency_key: null };
  });
  for (const cutId of committed.keys()) {
    if (!cuts.cuts.some((cut) => cut.cut_id === cutId)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "committed producer claim is missing from the exact export-cut inventory");
    }
  }
  return out;
}

export interface BackupPrimaryClosureSealInput extends BackupPrimaryClosureSealRequest {
  readonly database: D1Database;
}

const HEADER_COLUMNS = [
  "erasure_id", "erasure_revision", "lease_generation", "lease_owner", "lease_until", "request_sha256",
  "erasure_closure_digest", "state", "producer_claim_count", "producer_claims_digest",
  "canonical_epoch_count", "canonical_epochs_digest", "export_cut_count", "export_cut_inventory_digest",
  "qualification_mode", "qualification_receipt_ref", "operation_receipt_digest", "qualification_receipt_digest", "admission_binding_ref",
  "admission_binding_digest", "cloudflare_account_ref", "primary_bucket_binding_ref", "worker_version_ref",
  "controller_generation", "controller_fingerprint", "source_sha256", "configuration_sha256", "artifact_sha256",
  "bootstrap_zero_state_receipt_ref", "bootstrap_zero_state_digest", "qualification_evidence_digest",
  "primary_prefix_object_count", "primary_prefix_inventory_digest", "target_count", "target_digest",
  "target_part_count", "target_part_digest", "plan_digest", "created_at",
] as const;

function rowValueList<T extends Record<string, unknown>>(row: T, columns: readonly string[]): unknown[] {
  return columns.map((column) => row[column]);
}

export async function currentBackupPrimaryExecution(
  database: D1Database,
  fence: ErasureFence,
  stage: "QUARANTINE_AND_REVOKE" | "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
  nowMs: number,
): Promise<ExecutionFenceRow> {
  const row = await first<ExecutionFenceRow>(database,
    "SELECT request_sha256,closure_digest,state,lease_owner,lease_generation,lease_until " +
      "FROM erasure_execution WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
    [fence.erasure_id, fence.revision]);
  if (row === null || row.state !== stage || row.lease_owner !== fence.lease_owner ||
      row.lease_generation !== fence.lease_generation || row.lease_until !== fence.lease_until_ms ||
      typeof row.lease_until !== "number" || row.lease_until <= nowMs || !isSha(row.request_sha256) ||
      (stage === "QUARANTINE_AND_REVOKE" ? row.closure_digest !== null && !isSha(row.closure_digest) : !isSha(row.closure_digest))) {
    erasureFail("ERASURE_LEASE_LOST", "backup primary operation no longer holds the exact live erasure fence", true);
  }
  return row;
}

function claimPin(claim: BackupEpochProducerClaim, fence: ErasureFence): Record<string, unknown> {
  if (claim.state === "ABANDONED_NO_WRITES") {
    return {
      erasure_id: fence.erasure_id, erasure_revision: fence.revision, lease_generation: fence.lease_generation,
      idempotency_key: claim.idempotency_key, base_intent_digest: claim.base_intent_digest,
      attempt_nonce: claim.attempt_nonce, state: claim.state, epoch_id: null, part_prefix: null,
      cut_id: null, cut_digest: null, vector_digest: null, manifest_digest: null, intent_digest: null,
      receipt_digest: null,
    };
  }
  if (claim.state !== "COMMITTED" || claim.epoch_id === null || claim.part_prefix === null || claim.cut_id === null ||
      claim.cut_digest === null || claim.vector_digest === null || claim.manifest_digest === null ||
      claim.intent_digest === null || claim.receipt_digest === null) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup producer claim is not durably terminal");
  }
  return {
    erasure_id: fence.erasure_id, erasure_revision: fence.revision, lease_generation: fence.lease_generation,
    idempotency_key: claim.idempotency_key, base_intent_digest: claim.base_intent_digest,
    attempt_nonce: claim.attempt_nonce, state: claim.state, epoch_id: claim.epoch_id, part_prefix: claim.part_prefix,
    cut_id: claim.cut_id, cut_digest: claim.cut_digest, vector_digest: claim.vector_digest,
    manifest_digest: claim.manifest_digest, intent_digest: claim.intent_digest, receipt_digest: claim.receipt_digest,
  };
}

function targetEpoch(target: PurgeTarget): string {
  if (target.location !== "BackupRestorePath" || target.target_kind !== "OBJECT" ||
      !target.canonical_ref.startsWith("backup:")) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary closure received a non-object target");
  }
  return assertErasureIdentifier(target.canonical_ref.slice("backup:".length), "backup epoch target");
}

function partPinRow(
  pin: BackupPrimaryObjectPin,
  fence: ErasureFence,
  isTarget: boolean,
): Record<string, unknown> {
  return {
    erasure_id: fence.erasure_id, erasure_revision: fence.revision, lease_generation: fence.lease_generation,
    part_key: pin.key, backup_epoch_id: pin.epoch_id, manifest: pin.manifest, part_index: pin.part_index,
    part_sha256: pin.part_sha256, payload_identity_digest: pin.payload_identity_digest ?? null,
    payload_part_count: pin.payload_part_count ?? null, size_bytes: pin.size_bytes, etag: pin.etag,
    custom_metadata_json: canonicalErasureJson(pin.custom_metadata), object_digest: "", is_target_part: isTarget ? 1 : 0,
  };
}

async function pinObjectDigest(pin: BackupPrimaryObjectPin): Promise<string> {
  return erasureDigest(pin);
}

export async function sealBackupPrimaryClosure(input: BackupPrimaryClosureSealInput): Promise<void> {
  const { database, request, fence, producer, cuts, qualification, primary_parts, targets } = input;
  if (request.erasure_ref.id !== fence.erasure_id || request.erasure_ref.revision !== fence.revision ||
      producer.erasure_id !== fence.erasure_id || producer.revision !== fence.revision ||
      producer.claim_count !== producer.claims.length || producer.claim_count > MAX_CLOSURE_ROWS ||
      producer.canonical_epoch_count !== producer.claims.filter((claim) => claim.state === "COMMITTED").length ||
      cuts.cuts.length > MAX_CLOSURE_ROWS || primary_parts.object_count !== primary_parts.objects.length ||
      primary_parts.object_count > MAX_CLOSURE_ROWS || targets.length === 0 || targets.length > MAX_CLOSURE_ROWS) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary closure inputs do not share one bounded erasure snapshot");
  }
  if (input.request_sha256 !== await erasureDigest(request) ||
      qualification.producer_claims_digest !== producer.claims_digest ||
      qualification.export_cut_inventory_digest !== cuts.inventory_digest ||
      qualification.primary_prefix_inventory_digest !== primary_parts.inventory_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "primary closure inputs diverged from the qualified active snapshot");
  }
  validateQualification(qualification, backupPrimaryQualificationInput(
    fence, input.request_sha256, producer, cuts, primary_parts,
  ));
  const cutPins = cutClassification(cuts, producer);
  const producerClaimsDigest = await erasureDigest({
    protocol: "eliotr.backup-producer-claims.v1",
    erasure_id: producer.erasure_id,
    revision: producer.revision,
    claims: producer.claims,
  });
  if (producerClaimsDigest !== producer.claims_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup producer snapshot digest does not match canonical terminal claims");
  }
  const canonicalEpochDigest = producer.canonical_epochs_digest;
  if (!isSha(canonicalEpochDigest) || !isSha(producer.claims_digest) || !isSha(cuts.inventory_digest) ||
      !isSha(primary_parts.inventory_digest) || !isSha(input.closure_digest)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary closure input contains a malformed digest");
  }
  const sortedTargets = [...targets].sort((left, right) => left.target_id.localeCompare(right.target_id));
  if (new Set(sortedTargets.map((target) => target.target_id)).size !== sortedTargets.length) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup primary closure contains duplicate targets");
  }
  const targetRows = await Promise.all(sortedTargets.map(async (target) => ({
    erasure_id: fence.erasure_id,
    erasure_revision: fence.revision,
    lease_generation: fence.lease_generation,
    target_id: target.target_id,
    backup_epoch_id: targetEpoch(target),
    target_json: canonicalErasureJson(target),
    identity_digest: target.identity_digest,
    target_digest: await erasureDigest(target),
  })));
  const targetEpochs = new Set(targetRows.map((target) => target.backup_epoch_id));
  if (targetEpochs.size !== targetRows.length) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup primary closure has multiple targets for one epoch");
  }
  const partRows = await Promise.all(primary_parts.objects.map(async (pin) => {
    const isTarget = targetEpochs.has(pin.epoch_id);
    const row = partPinRow(pin, fence, isTarget);
    row.object_digest = await pinObjectDigest(pin);
    return row;
  }));
  const targetPartPins = primary_parts.objects.filter((pin) => targetEpochs.has(pin.epoch_id));
  if (targetPartPins.length === 0) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup erasure target has no exact primary part inventory");
  const deleteRows = await Promise.all(targetRows.flatMap((target) => targetPartPins
    .filter((pin) => pin.epoch_id === target.backup_epoch_id)
    .map(async (pin) => ({
      erasure_id: fence.erasure_id,
      erasure_revision: fence.revision,
      lease_generation: fence.lease_generation,
      target_id: target.target_id,
      part_key: pin.key,
      state: "PINNED",
      delete_intent_ref: null,
      delete_intent_digest: null,
      delete_receipt_ref: null,
      absence_receipt_ref: null,
      updated_at: isoFromMs(input.now()),
    }))));
  const primaryPinsDigest = await erasureDigest(primary_parts.objects);
  const targetDigest = await erasureDigest(targetRows);
  const targetPartDigest = await erasureDigest(targetPartPins);
  const qualificationDigest = await erasureDigest(qualification);
  const planDigest = await erasureDigest({
    protocol: "eliotr.backup-primary-delete-plan.v1",
    erasure_id: fence.erasure_id,
    revision: fence.revision,
    lease_owner: fence.lease_owner,
    lease_generation: fence.lease_generation,
    lease_until: fence.lease_until_ms,
    request_sha256: input.request_sha256,
    erasure_closure_digest: input.closure_digest,
    producer_claims_digest: producer.claims_digest,
    canonical_epochs_digest: canonicalEpochDigest,
    export_cut_inventory_digest: cuts.inventory_digest,
    qualification_digest: qualificationDigest,
    primary_prefix_inventory_digest: primaryPinsDigest,
    target_digest: targetDigest,
    target_part_digest: targetPartDigest,
  });
  const baseHeader: Record<string, unknown> = {
    erasure_id: fence.erasure_id,
    erasure_revision: fence.revision,
    lease_generation: fence.lease_generation,
    lease_owner: fence.lease_owner,
    lease_until: fence.lease_until_ms,
    request_sha256: input.request_sha256,
    erasure_closure_digest: input.closure_digest,
    state: "BUILDING",
    producer_claim_count: producer.claim_count,
    producer_claims_digest: producer.claims_digest,
    canonical_epoch_count: producer.canonical_epoch_count,
    canonical_epochs_digest: canonicalEpochDigest,
    export_cut_count: cutPins.length,
    export_cut_inventory_digest: cuts.inventory_digest,
    qualification_mode: qualification.mode,
    qualification_receipt_ref: qualification.operation_receipt_ref,
    operation_receipt_digest: qualification.operation_receipt_digest,
    qualification_receipt_digest: qualificationDigest,
    admission_binding_ref: qualification.admission_binding_ref,
    admission_binding_digest: qualification.admission_binding_digest,
    cloudflare_account_ref: qualification.cloudflare_account_ref,
    primary_bucket_binding_ref: qualification.primary_bucket_binding_ref,
    worker_version_ref: qualification.worker_version_ref,
    controller_generation: qualification.controller_generation,
    controller_fingerprint: qualification.controller_fingerprint,
    source_sha256: qualification.source_sha256,
    configuration_sha256: qualification.configuration_sha256,
    artifact_sha256: qualification.artifact_sha256,
    bootstrap_zero_state_receipt_ref: qualification.bootstrap_zero_state_receipt_ref,
    bootstrap_zero_state_digest: qualification.bootstrap_zero_state_digest,
    qualification_evidence_digest: qualification.evidence_digest,
    primary_prefix_object_count: primary_parts.object_count,
    primary_prefix_inventory_digest: primaryPinsDigest,
    target_count: targetRows.length,
    target_digest: targetDigest,
    target_part_count: targetPartPins.length,
    target_part_digest: targetPartDigest,
    plan_digest: planDigest,
  };
  const prior = await first<ClosureHeaderRow>(database,
    `SELECT ${HEADER_COLUMNS.join(",")} FROM backup_erasure_primary_closure WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 LIMIT 1`,
    [fence.erasure_id, fence.revision, fence.lease_generation]);
  let createdAt = isoFromMs(input.now());
  if (prior !== null) {
    if (typeof prior.created_at !== "string" || prior.lease_owner !== fence.lease_owner ||
        prior.lease_until !== fence.lease_until_ms || prior.request_sha256 !== input.request_sha256 ||
        prior.erasure_closure_digest !== input.closure_digest || prior.producer_claims_digest !== producer.claims_digest ||
        prior.canonical_epochs_digest !== canonicalEpochDigest || prior.export_cut_inventory_digest !== cuts.inventory_digest ||
        prior.operation_receipt_digest !== qualification.operation_receipt_digest ||
        prior.qualification_receipt_digest !== qualificationDigest || prior.primary_prefix_inventory_digest !== primaryPinsDigest ||
        prior.target_digest !== targetDigest || prior.target_part_digest !== targetPartDigest || prior.plan_digest !== planDigest) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "existing primary closure generation is bound to different immutable pins");
    }
    createdAt = prior.created_at;
  }
  const header: Record<string, unknown> = { ...baseHeader, created_at: createdAt };
  if (prior === null) {
    const placeholders = HEADER_COLUMNS.map((_column, index) => `?${index + 1}`).join(",");
    const values = rowValueList(header, HEADER_COLUMNS) as (string | number)[];
    await run(database,
      `INSERT INTO backup_erasure_primary_closure(${HEADER_COLUMNS.join(",")}) VALUES (${placeholders})`,
      values);
  }
  if (prior?.state !== "SEALED") {
    const claimRows = producer.claims.map((claim) => claimPin(claim, fence));
    const cutRows = cutPins.map((cut) => ({
      erasure_id: fence.erasure_id, erasure_revision: fence.revision, lease_generation: fence.lease_generation,
      cut_id: cut.cut_id, cut_digest: cut.cut_digest, state: cut.state,
      classification: cut.classification, idempotency_key: cut.idempotency_key,
    }));
    const deleteItems = deleteRows;
    await insertDataRows(database, "backup_erasure_primary_claim_pin", [
      "erasure_id", "erasure_revision", "lease_generation", "idempotency_key", "base_intent_digest", "attempt_nonce",
      "state", "epoch_id", "part_prefix", "cut_id", "cut_digest", "vector_digest", "manifest_digest", "intent_digest", "receipt_digest",
    ], claimRows);
    await insertDataRows(database, "backup_erasure_primary_cut_pin", [
      "erasure_id", "erasure_revision", "lease_generation", "cut_id", "cut_digest", "state", "classification", "idempotency_key",
    ], cutRows);
    await insertDataRows(database, "backup_erasure_primary_target_pin", [
      "erasure_id", "erasure_revision", "lease_generation", "target_id", "backup_epoch_id", "target_json", "identity_digest", "target_digest",
    ], targetRows);
    await insertDataRows(database, "backup_erasure_primary_part_pin", [
      "erasure_id", "erasure_revision", "lease_generation", "part_key", "backup_epoch_id", "manifest", "part_index",
      "part_sha256", "payload_identity_digest", "payload_part_count", "size_bytes", "etag", "custom_metadata_json", "object_digest", "is_target_part",
    ], partRows);
    await insertDataRows(database, "backup_erasure_primary_delete_item", [
      "erasure_id", "erasure_revision", "lease_generation", "target_id", "part_key", "state", "delete_intent_ref",
      "delete_intent_digest", "delete_receipt_ref", "absence_receipt_ref", "updated_at",
    ], deleteItems);
    await verifyBackupPrimaryClosureChildren(database, fence, claimRows, cutRows, targetRows, partRows, deleteItems);
    const exec = await currentBackupPrimaryExecution(database, fence, "QUARANTINE_AND_REVOKE", input.now());
    if (exec.request_sha256 !== input.request_sha256) {
      erasureFail("ERASURE_LEASE_LOST", "backup primary closure request digest changed before seal", true);
    }
    await run(database,
      "UPDATE backup_erasure_primary_closure SET state='SEALED' WHERE erasure_id=?1 AND erasure_revision=?2 " +
      "AND lease_generation=?3 AND lease_owner=?4 AND lease_until=?5 AND request_sha256=?6 " +
      "AND erasure_closure_digest=?7 AND state='BUILDING'",
      [fence.erasure_id, fence.revision, fence.lease_generation, fence.lease_owner,
        fence.lease_until_ms, input.request_sha256, input.closure_digest]);
  } else {
    await verifyBackupPrimaryClosureChildren(
      database,
      fence,
      producer.claims.map((claim) => claimPin(claim, fence)),
      cutPins.map((cut) => ({
        erasure_id: fence.erasure_id, erasure_revision: fence.revision, lease_generation: fence.lease_generation,
        cut_id: cut.cut_id, cut_digest: cut.cut_digest, state: cut.state,
        classification: cut.classification, idempotency_key: cut.idempotency_key,
      })),
      targetRows,
      partRows,
      deleteRows,
    );
  }
  const sealed = await first<ClosureHeaderRow>(database,
    `SELECT ${HEADER_COLUMNS.join(",")} FROM backup_erasure_primary_closure WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 LIMIT 1`,
    [fence.erasure_id, fence.revision, fence.lease_generation]);
  if (sealed === null || sealed.state !== "SEALED" || sealed.created_at !== createdAt ||
      HEADER_COLUMNS.some((column) => column !== "state" && sealed[column] !== header[column])) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "sealed backup primary closure failed exact header readback", true);
  }
}
