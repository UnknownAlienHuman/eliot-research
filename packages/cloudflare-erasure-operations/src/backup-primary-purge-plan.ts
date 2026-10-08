import type { ErasureFence, PurgeTarget } from "@eliotr/contracts";
import { type BackupEpochProducerClaim } from "@eliotr/backup-o2";
import {
  canonicalErasureJson,
  erasureDigest,
  erasureFail,
  stableErasureId,
} from "@eliotr/cloudflare-erasure";
import type {
  BackupExportCutInventory,
  BackupPrimaryObjectPin,
  BackupPrimaryWriterQualificationReceipt,
  BackupPrimaryWriterQualificationVerifier,
  BackupProducerQuiescencePort,
  BackupProducerQuiescenceSnapshot,
} from "@eliotr/cloudflare-erasure";
import { readBackupPrimaryHandoff, type BackupPrimaryHandoffRow } from "@eliotr/cloudflare-erasure";
import { currentBackupPrimaryExecution } from "./backup-primary-closure.js";

const MAX_ROWS = 100_000;

interface D1Rows<T> {
  readonly success?: boolean;
  readonly results?: readonly T[];
}

interface ClosureRow extends Record<string, unknown> {
  readonly state: unknown;
  readonly erasure_id: unknown;
  readonly erasure_revision: unknown;
  readonly lease_generation: unknown;
  readonly lease_owner: unknown;
  readonly lease_until: unknown;
}

interface TargetRow {
  readonly target_id: unknown;
  readonly backup_epoch_id: unknown;
  readonly target_json: unknown;
  readonly identity_digest: unknown;
  readonly target_digest: unknown;
}

interface PartRow {
  readonly part_key: unknown;
  readonly backup_epoch_id: unknown;
  readonly manifest: unknown;
  readonly part_index: unknown;
  readonly part_sha256: unknown;
  readonly payload_identity_digest: unknown;
  readonly payload_part_count: unknown;
  readonly size_bytes: unknown;
  readonly etag: unknown;
  readonly custom_metadata_json: unknown;
  readonly object_digest: unknown;
  readonly is_target_part: unknown;
}

export interface DeleteRow {
  readonly target_id: unknown;
  readonly part_key: unknown;
  readonly state: unknown;
  readonly delete_intent_ref: unknown;
  readonly delete_intent_digest: unknown;
  readonly delete_receipt_ref: unknown;
  readonly absence_receipt_ref: unknown;
  readonly updated_at: unknown;
}

interface ErasureTargetRow {
  readonly target_kind: unknown;
  readonly exact_subject_ref: unknown;
  readonly location: unknown;
  readonly canonical_ref: unknown;
  readonly provider_ref: unknown;
  readonly identity_digest: unknown;
  readonly shared_live_reference_count: unknown;
  readonly retention_or_hold_ref: unknown;
  readonly next_review_at: unknown;
}

interface StoredPart extends BackupPrimaryObjectPin {
  readonly object_digest: string;
  readonly is_target_part: boolean;
}

export interface LoadedClosure {
  readonly header: ClosureRow;
  readonly targets: ReadonlyMap<string, PurgeTarget>;
  readonly parts: readonly StoredPart[];
  readonly deleteItems: Map<string, DeleteRow>;
  readonly plan_generation: number;
  readonly plan_fence: ErasureFence;
  readonly handoff: BackupPrimaryHandoffRow | null;
}

export interface Dependencies {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly qualification?: BackupPrimaryWriterQualificationVerifier;
  readonly backup_producer_quiescence: BackupProducerQuiescencePort;
  readonly now?: () => number;
}

function rec(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup primary ${label} is malformed`);
  }
  return value;
}

function readInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup primary ${label} is malformed`);
  }
  return value;
}

export async function all<T>(database: D1Database, sql: string, values: readonly (string | number)[] = []): Promise<readonly T[]> {
  let result: D1Rows<T>;
  try {
    const statement = database.prepare(sql);
    result = await (values.length === 0 ? statement : statement.bind(...values)).all<T>();
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup primary deletion D1 read failed", true, cause);
  }
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > MAX_ROWS) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary deletion D1 readback is malformed or over its bound");
  }
  return result.results;
}

async function first<T>(database: D1Database, sql: string, values: readonly (string | number)[]): Promise<T | null> {
  try { return await database.prepare(sql).bind(...values).first<T>(); }
  catch (cause) { erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup primary deletion D1 read failed", true, cause); }
}

export function targetEpoch(target: PurgeTarget): string {
  if (target.target_kind !== "OBJECT" || target.location !== "BackupRestorePath" ||
      !target.canonical_ref.startsWith("backup:")) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary purge target is not an exact backup object");
  }
  return target.canonical_ref.slice("backup:".length);
}

function parsePin(row: PartRow): StoredPart {
  const key = readText(row.part_key, "part key");
  const epochId = readText(row.backup_epoch_id, "epoch ID");
  const manifest = readText(row.manifest, "manifest");
  const partIndex = readInteger(row.part_index, "part index", 1);
  const partSha = readText(row.part_sha256, "part digest");
  const sizeBytes = readInteger(row.size_bytes, "part size");
  const etag = readText(row.etag, "part etag");
  if (!sha(partSha) || typeof row.custom_metadata_json !== "string" || !sha(row.object_digest) ||
      (row.payload_identity_digest !== null && !sha(row.payload_identity_digest)) ||
      (row.payload_part_count !== null && (typeof row.payload_part_count !== "number" || !Number.isSafeInteger(row.payload_part_count) || row.payload_part_count < 1)) ||
      (row.is_target_part !== 0 && row.is_target_part !== 1)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary part pin is malformed");
  }
  let metadata: unknown;
  try { metadata = JSON.parse(row.custom_metadata_json); }
  catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary metadata pin is malformed", false, cause); }
  if (!rec(metadata) || canonicalErasureJson(metadata) !== row.custom_metadata_json) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary metadata pin is not canonical JSON");
  }
  return {
    key,
    epoch_id: epochId,
    manifest,
    part_index: partIndex,
    part_sha256: partSha,
    ...(row.payload_identity_digest === null ? {} : { payload_identity_digest: row.payload_identity_digest as string }),
    ...(row.payload_part_count === null ? {} : { payload_part_count: row.payload_part_count as number }),
    size_bytes: sizeBytes,
    etag,
    custom_metadata: metadata as Readonly<Record<string, string>>,
    object_digest: row.object_digest,
    is_target_part: row.is_target_part === 1,
  };
}

export function pinObject(pin: StoredPart): BackupPrimaryObjectPin {
  return {
    key: pin.key,
    epoch_id: pin.epoch_id,
    manifest: pin.manifest,
    part_index: pin.part_index,
    part_sha256: pin.part_sha256,
    ...(pin.payload_identity_digest === undefined ? {} : { payload_identity_digest: pin.payload_identity_digest }),
    ...(pin.payload_part_count === undefined ? {} : { payload_part_count: pin.payload_part_count }),
    size_bytes: pin.size_bytes,
    etag: pin.etag,
    custom_metadata: pin.custom_metadata,
  };
}

function parseTarget(row: TargetRow): PurgeTarget {
  const targetId = readText(row.target_id, "target ID");
  if (typeof row.target_json !== "string" || !sha(row.identity_digest) || !sha(row.target_digest)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary target pin is malformed");
  }
  let raw: unknown;
  try { raw = JSON.parse(row.target_json); }
  catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary target JSON is malformed", false, cause); }
  if (!rec(raw) || canonicalErasureJson(raw) !== row.target_json || raw["target_id"] !== targetId ||
      raw["identity_digest"] !== row.identity_digest || raw["location"] !== "BackupRestorePath" || raw["target_kind"] !== "OBJECT" ||
      targetEpoch(raw as unknown as PurgeTarget) !== row.backup_epoch_id) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "backup primary target row diverges from its immutable target JSON");
  }
  return raw as unknown as PurgeTarget;
}

export function receiptFromHeader(header: ClosureRow): BackupPrimaryWriterQualificationReceipt {
  const mode = header["qualification_mode"];
  if (mode !== "ISOLATED_NEW_BUCKET" && mode !== "LEGACY_WRITERS_DRAINED") {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary closure has an unknown qualification mode");
  }
  const receipt: BackupPrimaryWriterQualificationReceipt = {
    protocol: "eliotr.backup-primary-writer-qualification.v1",
    mode,
    operation_receipt_ref: readText(header["qualification_receipt_ref"], "qualification receipt ref"),
    operation_receipt_digest: readText(header["operation_receipt_digest"], "operation receipt digest"),
    admission_binding_ref: readText(header["admission_binding_ref"], "admission binding ref"),
    admission_binding_digest: readText(header["admission_binding_digest"], "admission binding digest"),
    cloudflare_account_ref: readText(header["cloudflare_account_ref"], "Cloudflare account ref"),
    primary_bucket_binding_ref: readText(header["primary_bucket_binding_ref"], "primary bucket binding ref"),
    worker_version_ref: readText(header["worker_version_ref"], "worker version ref"),
    controller_generation: readText(header["controller_generation"], "controller generation"),
    controller_fingerprint: readText(header["controller_fingerprint"], "controller fingerprint"),
    source_sha256: readText(header["source_sha256"], "source digest"),
    configuration_sha256: readText(header["configuration_sha256"], "configuration digest"),
    artifact_sha256: readText(header["artifact_sha256"], "artifact digest"),
    bootstrap_zero_state_receipt_ref: readText(header["bootstrap_zero_state_receipt_ref"], "bootstrap receipt ref"),
    bootstrap_zero_state_digest: readText(header["bootstrap_zero_state_digest"], "bootstrap digest"),
    producer_claims_digest: readText(header["producer_claims_digest"], "producer claims digest"),
    export_cut_inventory_digest: readText(header["export_cut_inventory_digest"], "export cut digest"),
    primary_prefix_inventory_digest: readText(header["primary_prefix_inventory_digest"], "primary prefix digest"),
    evidence_digest: readText(header["qualification_evidence_digest"], "qualification evidence digest"),
  };
  if ([receipt.operation_receipt_digest, receipt.admission_binding_digest, receipt.controller_fingerprint,
    receipt.source_sha256, receipt.configuration_sha256, receipt.artifact_sha256,
    receipt.bootstrap_zero_state_digest, receipt.producer_claims_digest,
    receipt.export_cut_inventory_digest, receipt.primary_prefix_inventory_digest, receipt.evidence_digest,
  ].some((value) => !sha(value))) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "primary qualification receipt has an invalid digest");
  return receipt;
}

function qualificationAuthority(value: BackupPrimaryWriterQualificationReceipt): Record<string, unknown> {
  const { primary_prefix_inventory_digest: _prefix, evidence_digest: _evidence, ...authority } = value;
  return authority;
}

export function sameQualification(left: BackupPrimaryWriterQualificationReceipt, right: BackupPrimaryWriterQualificationReceipt): boolean {
  return canonicalErasureJson(qualificationAuthority(left)) === canonicalErasureJson(qualificationAuthority(right));
}

export function expectedClaimPins(producer: BackupProducerQuiescenceSnapshot, fence: ErasureFence): readonly Record<string, unknown>[] {
  return producer.claims.map((claim: BackupEpochProducerClaim) => ({
    erasure_id: fence.erasure_id,
    erasure_revision: fence.revision,
    lease_generation: fence.lease_generation,
    idempotency_key: claim.idempotency_key,
    base_intent_digest: claim.base_intent_digest,
    attempt_nonce: claim.attempt_nonce,
    state: claim.state,
    epoch_id: claim.epoch_id,
    part_prefix: claim.part_prefix,
    cut_id: claim.cut_id,
    cut_digest: claim.cut_digest,
    vector_digest: claim.vector_digest,
    manifest_digest: claim.manifest_digest,
    intent_digest: claim.intent_digest,
    receipt_digest: claim.receipt_digest,
  }));
}

export async function currentCutPins(
  fence: ErasureFence,
  cuts: BackupExportCutInventory,
  producer: BackupProducerQuiescenceSnapshot,
): Promise<readonly Record<string, unknown>[]> {
  const committed = new Map(producer.claims.filter((claim) => claim.state === "COMMITTED")
    .map((claim) => [claim.cut_id as string, claim]));
  return cuts.cuts.map((cut) => {
    const claim = committed.get(cut.cut_id);
    if (claim !== undefined && (claim.cut_digest !== cut.cut_digest || cut.state !== "ACCEPTED")) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "current producer cut differs from its committed claim");
    }
    return {
      erasure_id: fence.erasure_id,
      erasure_revision: fence.revision,
      lease_generation: fence.lease_generation,
      cut_id: cut.cut_id,
      cut_digest: cut.cut_digest,
      state: cut.state,
      classification: claim === undefined ? "LEGACY_RETIRED" : "COMMITTED_CLAIM",
      idempotency_key: claim?.idempotency_key ?? null,
    };
  });
}

export async function compareChildRows(
  database: D1Database,
  table: string,
  columns: readonly string[],
  key: readonly (string | number)[],
  identity: readonly string[],
  expected: readonly Record<string, unknown>[],
): Promise<void> {
  const selected = [...columns].sort();
  const rows = await all<Record<string, unknown>>(database,
    `SELECT ${selected.join(",")} FROM ${table} WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 ORDER BY ${identity.join(",")}`,
    key);
  const normalize = (values: readonly Record<string, unknown>[]) => values.map((row) =>
    Object.fromEntries(selected.map((column) => [column, row[column]])));
  const ordered = [...expected].sort((left, right) => identity.map((column) => String(left[column]))
    .join("\u0000").localeCompare(identity.map((column) => String(right[column])).join("\u0000")));
  if (canonicalErasureJson(normalize(rows)) !== canonicalErasureJson(normalize(ordered))) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", `sealed backup ${table} rows differ from current durable authority`);
  }
}

export async function loadClosure(
  database: D1Database,
  fence: ErasureFence,
  nowMs: number,
  stage: "QUARANTINE_AND_REVOKE" | "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK" = "PURGE_EACH_LOCATION",
): Promise<LoadedClosure> {
  const execution = await currentBackupPrimaryExecution(database, fence, stage, nowMs);
  const handoff = await readBackupPrimaryHandoff(database, fence);
  let planGeneration = fence.lease_generation;
  if (handoff !== null) {
    if (stage === "QUARANTINE_AND_REVOKE") {
      if (handoff.state !== "PENDING" || execution.closure_digest !== null) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup plan handoff is not pending before inventory replay");
      }
    } else if (handoff.state !== "SEALED" || execution.closure_digest !== handoff.erasure_closure_digest) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup plan handoff is not sealed to the active erasure closure");
    }
    planGeneration = readInteger(handoff.plan_lease_generation, "historical plan generation", 1);
  }
  const header = await first<ClosureRow>(database,
    "SELECT * FROM backup_erasure_primary_closure WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 LIMIT 1",
    [fence.erasure_id, fence.revision, planGeneration]);
  const exactHeader = handoff === null
    ? header?.lease_owner === fence.lease_owner && header.lease_until === fence.lease_until_ms &&
      header.lease_generation === fence.lease_generation && header.erasure_closure_digest === execution.closure_digest
    : header?.lease_generation === planGeneration && header.request_sha256 === handoff.request_sha256 &&
      header.erasure_closure_digest === handoff.erasure_closure_digest && header.plan_digest === handoff.original_plan_digest &&
      header.target_digest === handoff.original_target_digest && header.target_part_digest === handoff.original_target_part_digest &&
      header.primary_prefix_object_count === handoff.original_primary_prefix_object_count &&
      header.primary_prefix_inventory_digest === handoff.original_primary_prefix_inventory_digest &&
      header.qualification_receipt_ref === handoff.original_qualification_receipt_ref &&
      header.qualification_receipt_digest === handoff.original_qualification_receipt_digest;
  if (header === null || header.state !== "SEALED" || header.erasure_id !== fence.erasure_id ||
      header.erasure_revision !== fence.revision || !exactHeader ||
      header.request_sha256 !== execution.request_sha256 ||
      (stage !== "QUARANTINE_AND_REVOKE" && header.erasure_closure_digest !== execution.closure_digest) ||
      !sha(header.request_sha256) || !sha(header.erasure_closure_digest) ||
      !sha(header.plan_digest) || !sha(header.primary_prefix_inventory_digest) ||
      !sha(header.target_digest) || !sha(header.target_part_digest) ||
      !sha(header.producer_claims_digest) || !sha(header.canonical_epochs_digest) ||
      !sha(header.export_cut_inventory_digest) || !sha(header.operation_receipt_digest) ||
      !sha(header.qualification_receipt_digest)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "no sealed primary closure matches the current erasure generation");
  }
  const key = [fence.erasure_id, fence.revision, planGeneration] as const;
  const [targetRows, rawPartRows, rawDeleteRows] = await Promise.all([
    all<TargetRow>(database, "SELECT target_id,backup_epoch_id,target_json,identity_digest,target_digest " +
      "FROM backup_erasure_primary_target_pin WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 ORDER BY target_id", key),
    all<PartRow>(database, "SELECT part_key,backup_epoch_id,manifest,part_index,part_sha256,payload_identity_digest," +
      "payload_part_count,size_bytes,etag,custom_metadata_json,object_digest,is_target_part " +
      "FROM backup_erasure_primary_part_pin WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 ORDER BY part_key", key),
    all<DeleteRow>(database, "SELECT target_id,part_key,state,delete_intent_ref,delete_intent_digest,delete_receipt_ref," +
      "absence_receipt_ref,updated_at FROM backup_erasure_primary_delete_item " +
      "WHERE erasure_id=?1 AND erasure_revision=?2 AND lease_generation=?3 ORDER BY target_id,part_key", key),
  ]);
  if (targetRows.length !== header.target_count || rawPartRows.length !== header.primary_prefix_object_count ||
      rawDeleteRows.length !== header.target_part_count) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "sealed backup primary closure child counts diverge");
  }
  const targets = new Map<string, PurgeTarget>();
  for (const row of targetRows) {
    const target = parseTarget(row);
    if (targets.has(target.target_id) || !sha(row.target_digest) || await erasureDigest(target) !== row.target_digest) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "sealed backup primary target digest is invalid");
    }
    targets.set(target.target_id, target);
    const current = await first<ErasureTargetRow>(database,
      "SELECT target_kind,exact_subject_ref,location,canonical_ref,provider_ref,identity_digest," +
        "shared_live_reference_count,retention_or_hold_ref,next_review_at FROM erasure_target " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND target_id=?3 LIMIT 1",
      [fence.erasure_id, fence.revision, target.target_id]);
    if (current === null || current.target_kind !== target.target_kind || current.exact_subject_ref !== target.exact_subject_ref ||
        current.location !== target.location || current.canonical_ref !== target.canonical_ref ||
        current.provider_ref !== (target.provider_ref ?? null) || current.identity_digest !== target.identity_digest ||
        current.shared_live_reference_count !== target.shared_live_reference_count ||
        current.retention_or_hold_ref !== (target.retention_or_hold_ref ?? null) ||
        current.next_review_at !== (target.next_review_at ?? null)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "sealed backup target diverges from the current erasure target row");
    }
  }
  const parts: StoredPart[] = [];
  for (const raw of rawPartRows) {
    const pin = parsePin(raw);
    if (await erasureDigest(pinObject(pin)) !== pin.object_digest) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "sealed backup primary part digest is invalid");
    }
    const isTarget = [...targets.values()].some((target) => targetEpoch(target) === pin.epoch_id);
    if (pin.is_target_part !== isTarget) erasureFail("ERASURE_IDENTITY_CONFLICT", "primary part target membership diverged");
    parts.push(pin);
  }
  const expectedPrefixDigest = await erasureDigest(parts.map(pinObject));
  const targetRowsDigest = await erasureDigest(targetRows.map((row) => ({
    erasure_id: fence.erasure_id, erasure_revision: fence.revision, lease_generation: planGeneration,
    target_id: row.target_id, backup_epoch_id: row.backup_epoch_id, target_json: row.target_json,
    identity_digest: row.identity_digest, target_digest: row.target_digest,
  })));
  const targetPartPins = parts.filter((pin) => pin.is_target_part).map(pinObject);
  if (expectedPrefixDigest !== header.primary_prefix_inventory_digest || targetRowsDigest !== header.target_digest ||
      targetPartPins.length !== header.target_part_count || await erasureDigest(targetPartPins) !== header.target_part_digest) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "sealed backup primary object plan digest does not match its pins");
  }
  const deleteItems = new Map<string, DeleteRow>();
  for (const item of rawDeleteRows) {
    const target = targets.get(String(item.target_id));
    const part = parts.find((candidate) => candidate.key === item.part_key);
    if (target === undefined || part === undefined || !part.is_target_part || targetEpoch(target) !== part.epoch_id ||
        !["PINNED", "DELETE_INTENT", "UNKNOWN", "DELETED", "ABSENT"].includes(String(item.state)) ||
        typeof item.updated_at !== "string") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary delete obligation is malformed or out of plan");
    }
    const itemKey = `${item.target_id}\u0000${item.part_key}`;
    if (deleteItems.has(itemKey)) erasureFail("ERASURE_IDENTITY_CONFLICT", "backup primary delete plan contains duplicate keys");
    deleteItems.set(itemKey, item);
  }
  if (deleteItems.size !== targetPartPins.length) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup primary delete plan omits a targeted object");
  }
  const planFence: ErasureFence = {
    erasure_id: fence.erasure_id,
    revision: fence.revision,
    lease_owner: readText(header.lease_owner, "original lease owner"),
    lease_generation: readInteger(header.lease_generation, "original lease generation", 1),
    lease_until_ms: readInteger(header.lease_until, "original lease expiry", 1),
  };
  return { header, targets, parts, deleteItems, plan_generation: planGeneration, plan_fence: planFence, handoff };
}

export function targetDeleteItems(closure: LoadedClosure, targetId: string): DeleteRow[] {
  const out = [...closure.deleteItems.values()].filter((item) => item.target_id === targetId)
    .sort((left, right) => String(left.part_key).localeCompare(String(right.part_key)));
  if (out.length === 0) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup target has no durable primary part plan");
  return out;
}

export async function exactDeleteIntent(
  planFence: ErasureFence,
  targetId: string,
  pin: BackupPrimaryObjectPin,
  planDigest: string,
): Promise<{ readonly ref: string; readonly digest: string }> {
  const ref = await stableErasureId("backup-primary-part-delete", planFence.erasure_id, String(planFence.revision),
    String(planFence.lease_generation), targetId, pin.key, planDigest);
  return {
    ref,
    digest: await erasureDigest({ protocol: "eliotr.backup-primary-part-delete-intent.v1", ref,
      erasure_id: planFence.erasure_id, revision: planFence.revision, lease_owner: planFence.lease_owner,
      lease_generation: planFence.lease_generation, lease_until_ms: planFence.lease_until_ms,
      target_id: targetId, part: pin, plan_digest: planDigest }),
  };
}

export async function allowedMissing(closure: LoadedClosure): Promise<Set<string>> {
  const result = new Set<string>();
  for (const item of closure.deleteItems.values()) {
    if (["DELETE_INTENT", "UNKNOWN", "DELETED", "ABSENT"].includes(String(item.state))) {
      const key = readText(item.part_key, "durable missing part key");
      const targetId = readText(item.target_id, "durable missing part target ID");
      const part = closure.parts.find((candidate) => candidate.key === key);
      if (part === undefined || result.has(key)) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "missing primary key is not backed by one exact durable delete intent");
      }
      const expected = await exactDeleteIntent(
        closure.plan_fence,
        targetId,
        pinObject(part),
        readText(closure.header.plan_digest, "plan digest"),
      );
      if (item.delete_intent_ref !== expected.ref || item.delete_intent_digest !== expected.digest) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "missing primary key is not backed by one exact durable delete intent");
      }
      result.add(key);
    }
  }
  return result;
}
