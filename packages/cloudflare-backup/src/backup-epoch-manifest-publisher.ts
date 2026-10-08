import { BackupEpochSchema, OperationAttemptSchema, OperationReceiptSchema, type OperationAttempt, type OperationReceipt } from "@eliotr/contracts";
import {
  backupSha256Hex,
  backupEpochProducerReceiptDigest,
  canonicalBackupJson,
  backupR2ObjectIdentity,
  copyIdForDigest,
  failBackup,
  readCopyCheckpoints,
  readEpochDraftById,
  verifyPortableBackupManifests,
  type BackupEpochDraft,
  type OffsiteCopyResult,
  type PlaintextBackupPart,
  type VerifiedPortableBackupManifests,
} from "@eliotr/backup-o2";
import { assertBackupEpochManifestMigrationAuthority } from "./backup-epoch-manifest-schema.js";

export const BACKUP_EPOCH_BINDING_PROTOCOL = "eliotr.backup-epoch-manifest-binding.v1";
export const BACKUP_EPOCH_VERIFICATION_RECEIPT_PROTOCOL = "eliotr.backup-epoch-verification-receipt.v1";

export type BackupEpochManifestRole =
  | "CORE_EXPORT"
  | "SEARCH_REBUILD_PLAN"
  | "EVIDENCE_R2_SUBSET"
  | "WORK_R2_SUBSET";

export interface CanonicalBackupManifestBinding {
  readonly backup_epoch_id: string;
  readonly role: BackupEpochManifestRole;
  readonly binding_ref: string;
  readonly descriptor_sha256: string;
  readonly descriptor_json: string;
  readonly source_draft_sha256: string;
  readonly offsite_copy_id: string;
  readonly offsite_readback_digest: string;
}

export interface PendingCanonicalBackupEpoch {
  readonly backup_epoch_id: string;
  readonly verification_state: "PENDING";
  readonly core_export_ref: string;
  readonly search_projection_manifest_ref: string;
  readonly evidence_manifest_ref: string;
  readonly work_manifest_ref: string;
  readonly offsite_copy_ref: string;
  readonly purge_ledger_revision: number;
  readonly created_at: string;
}

export interface PublishedPendingCanonicalBackupEpoch {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly epoch: PendingCanonicalBackupEpoch;
  readonly bindings: readonly CanonicalBackupManifestBinding[];
}

interface EpochReceiptRow {
  readonly idempotency_key: unknown;
  readonly intent_id: unknown;
  readonly intent_digest: unknown;
  readonly vector_digest: unknown;
  readonly manifest_digest: unknown;
  readonly epoch_id: unknown;
  readonly receipt_json: unknown;
  readonly draft_json: unknown;
  readonly attempt_json: unknown;
  readonly created_at: unknown;
}

interface ProducerClaimRow {
  readonly idempotency_key: unknown;
  readonly base_intent_digest: unknown;
  readonly attempt_nonce: unknown;
  readonly state: unknown;
  readonly epoch_id: unknown;
  readonly part_prefix: unknown;
  readonly cut_id: unknown;
  readonly cut_digest: unknown;
  readonly vector_digest: unknown;
  readonly manifest_digest: unknown;
  readonly intent_digest: unknown;
  readonly receipt_digest: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface CopyReceiptRow {
  readonly copy_id: unknown;
  readonly epoch_id: unknown;
  readonly destination_id: unknown;
  readonly key_generation: unknown;
  readonly policy_digest: unknown;
  readonly intent_digest: unknown;
  readonly receipt_json: unknown;
  readonly epoch_json: unknown;
  readonly attempt_json: unknown;
  readonly readback_digest: unknown;
  readonly expires_at: unknown;
  readonly failure_domain: unknown;
  readonly descriptor_digest: unknown;
  readonly authority_authorized_at: unknown;
  readonly created_at: unknown;
}

interface CanonicalEpochRow {
  readonly backup_epoch_id: unknown;
  readonly core_export_ref: unknown;
  readonly search_projection_manifest_ref: unknown;
  readonly evidence_manifest_ref: unknown;
  readonly work_manifest_ref: unknown;
  readonly offsite_copy_ref: unknown;
  readonly purge_ledger_revision: unknown;
  readonly verification_state: unknown;
  readonly created_at: unknown;
  readonly verified_at: unknown;
}

interface BindingRow {
  readonly backup_epoch_id: unknown;
  readonly role: unknown;
  readonly binding_ref: unknown;
  readonly descriptor_sha256: unknown;
  readonly descriptor_json: unknown;
  readonly source_draft_sha256: unknown;
  readonly offsite_copy_id: unknown;
  readonly offsite_readback_digest: unknown;
  readonly created_at: unknown;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function invalid(message: string): never {
  return failBackup("BACKUP_VECTOR_UNVERIFIABLE", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") return invalid(`${label} is not persisted JSON text`);
  try { return JSON.parse(value) as unknown; }
  catch (cause) { failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is invalid JSON`, false, {}, cause); }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) return invalid(`${label} is missing or malformed`);
  return value;
}

function digestField(value: unknown, label: string): string {
  const result = stringField(value, label);
  if (!SHA256.test(result)) return invalid(`${label} is not a lowercase SHA-256 digest`);
  return result;
}

async function all<T>(database: D1Database, sql: string, values: readonly unknown[] = []): Promise<readonly T[]> {
  try {
    const result = await database.prepare(sql).bind(...values).all<T>();
    if (result.success !== true || !Array.isArray(result.results)) return invalid("backup canonical publication readback is malformed");
    return result.results;
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup canonical publication authority read failed", true, {}, cause);
  }
}

async function first<T>(database: D1Database, sql: string, values: readonly unknown[] = []): Promise<T | null> {
  try { return await database.prepare(sql).bind(...values).first<T>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "backup canonical publication readback failed", true, {}, cause); }
}

async function persistedEpochSource(database: D1Database, epochId: string): Promise<{
  readonly draft: BackupEpochDraft;
  readonly draft_json: string;
  readonly draft_sha256: string;
  readonly producer: Readonly<Record<string, unknown>>;
}> {
  const readback = await readEpochDraftById(database, epochId);
  if (readback === null) return invalid("canonical backup publication requires a D1-persisted O2 epoch draft");
  const rows = await all<EpochReceiptRow>(database,
    "SELECT idempotency_key,intent_id,intent_digest,vector_digest,manifest_digest,epoch_id,receipt_json,draft_json,attempt_json,created_at FROM backup_epoch_receipt WHERE epoch_id=?1 ORDER BY created_at LIMIT 2",
    [epochId]);
  if (rows.length !== 1 || rows[0]?.draft_json !== readback.draft_json || rows[0]?.idempotency_key !== readback.idempotency_key) {
    return invalid("canonical backup publication requires exactly one matching persisted O2 epoch receipt");
  }
  const source = rows[0];
  if (source === undefined) return invalid("persisted O2 epoch receipt disappeared during readback");
  let sourceReceipt: OperationReceipt;
  let sourceAttempt: OperationAttempt;
  try {
    sourceReceipt = OperationReceiptSchema.parse(parseJson(source.receipt_json, "persisted O2 producer receipt"));
    sourceAttempt = OperationAttemptSchema.parse(parseJson(source.attempt_json, "persisted O2 producer attempt"));
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted O2 producer receipt is malformed", false, {}, cause);
  }
  if (sourceReceipt.outcome !== "SUCCEEDED" || sourceReceipt.attempt_id !== sourceAttempt.attempt_id ||
      !sourceReceipt.output_refs.includes(epochId) || sourceAttempt.state !== "SUCCEEDED") {
    return invalid("persisted O2 producer receipt does not confirm this completed epoch");
  }
  const draftValue = parseJson(source.draft_json, "persisted O2 epoch draft");
  if (!isRecord(draftValue) || draftValue["epoch_id"] !== epochId) return invalid("persisted O2 draft identity disagrees with its epoch receipt");
  const draft = draftValue as unknown as BackupEpochDraft;
  if (source.vector_digest !== draft.vector_digest || !SHA256.test(String(source.intent_digest)) || !SHA256.test(String(source.manifest_digest))) {
    return invalid("persisted O2 receipt digests disagree with the exact epoch draft");
  }
  const persistedProducerReceiptDigest = await backupEpochProducerReceiptDigest({
    idempotency_key: stringField(source.idempotency_key, "persisted O2 idempotency key"),
    intent_id: stringField(source.intent_id, "persisted O2 intent id"),
    intent_digest: digestField(source.intent_digest, "persisted O2 intent digest"),
    vector_digest: digestField(source.vector_digest, "persisted O2 vector digest"),
    manifest_digest: digestField(source.manifest_digest, "persisted O2 manifest digest"),
    epoch_id: stringField(source.epoch_id, "persisted O2 epoch id"),
    receipt_json: stringField(source.receipt_json, "persisted O2 receipt JSON"),
    draft_json: stringField(source.draft_json, "persisted O2 draft JSON"),
    attempt_json: stringField(source.attempt_json, "persisted O2 attempt JSON"),
  });
  if (source.epoch_id !== epochId || sourceReceipt.intent_ref.id !== source.intent_id ||
      sourceAttempt.intent_ref.id !== source.intent_id ||
      sourceReceipt.intent_ref.revision !== sourceAttempt.intent_ref.revision) {
    return invalid("persisted O2 producer receipt intent or epoch identity diverges from its exact row");
  }
  const producerRows = await all<ProducerClaimRow>(database,
    "SELECT idempotency_key,base_intent_digest,attempt_nonce,state,epoch_id,part_prefix,cut_id,cut_digest,vector_digest,manifest_digest,intent_digest,receipt_digest,created_at,updated_at FROM backup_epoch_producer_claim WHERE epoch_id=?1 LIMIT 2",
    [epochId]);
  const producer = producerRows[0];
  if (producerRows.length !== 1 || producer === undefined || producer.state !== "COMMITTED" ||
      producer.idempotency_key !== source.idempotency_key || producer.epoch_id !== epochId ||
      producer.part_prefix !== `backup-parts/${epochId}/` || producer.cut_id !== draft.cut_id ||
      producer.vector_digest !== draft.vector_digest || producer.manifest_digest !== source.manifest_digest ||
      producer.intent_digest !== source.intent_digest || !SHA256.test(String(producer.base_intent_digest)) ||
      !SHA256.test(String(producer.cut_digest)) || !SHA256.test(String(producer.receipt_digest))) {
    return invalid("canonical backup publication requires one committed producer claim pinned to the persisted epoch receipt");
  }
  // This proves persisted-field consistency, not authenticity against a privileged D1 writer.
  if (producer.receipt_digest !== persistedProducerReceiptDigest) {
    return invalid("committed producer claim digest does not cover the exact persisted epoch receipt fields");
  }
  if (!SHA256.test(String(draft.vector_digest)) || !Number.isSafeInteger(draft.purge_ledger_revision) ||
      typeof draft.created_at !== "string" || typeof draft.expires_at !== "string") {
    return invalid("persisted O2 draft has incomplete canonical publication pins");
  }
  const draftSha = await backupSha256Hex(String(source.draft_json));
  const producerPin = {
    idempotency_key: source.idempotency_key,
    base_intent_digest: producer.base_intent_digest,
    attempt_nonce: producer.attempt_nonce,
    state: producer.state,
    epoch_id: producer.epoch_id,
    part_prefix: producer.part_prefix,
    cut_id: producer.cut_id,
    cut_digest: producer.cut_digest,
    vector_digest: producer.vector_digest,
    manifest_digest: producer.manifest_digest,
    intent_digest: producer.intent_digest,
    receipt_digest: producer.receipt_digest,
    created_at: producer.created_at,
    updated_at: producer.updated_at,
    source_receipt_sha256: await backupSha256Hex(String(source.receipt_json)),
    source_attempt_sha256: await backupSha256Hex(String(source.attempt_json)),
  };
  return { draft, draft_json: String(source.draft_json), draft_sha256: draftSha, producer: producerPin };
}

async function persistedCopySource(input: {
  readonly database: D1Database;
  readonly draft: BackupEpochDraft;
  readonly offsite_copy: OffsiteCopyResult;
}): Promise<{ readonly row: CopyReceiptRow; readonly copy_id: string; readonly remote_refs: readonly string[] }> {
  let returnedEpoch: ReturnType<typeof BackupEpochSchema.parse>;
  let returnedAttempt: ReturnType<typeof OperationAttemptSchema.parse>;
  let returnedReceipt: ReturnType<typeof OperationReceiptSchema.parse>;
  try {
    returnedEpoch = BackupEpochSchema.parse(input.offsite_copy.epoch);
    returnedAttempt = OperationAttemptSchema.parse(input.offsite_copy.attempt);
    returnedReceipt = OperationReceiptSchema.parse(input.offsite_copy.receipt);
  } catch (cause) {
    failBackup("BACKUP_INPUT_INVALID", "offsite copy result is malformed", false, {}, cause);
  }
  if (input.offsite_copy.offsite_copy_ref !== returnedEpoch.offsite_copy_ref ||
      !SHA256.test(input.offsite_copy.readback_digest) || returnedEpoch.epoch_ref.id !== input.draft.epoch_id ||
      returnedEpoch.epoch_ref.revision !== 1 || returnedEpoch.schema_generation !== input.draft.schema_generation ||
      returnedEpoch.migration_ledger_digest !== input.draft.migration_ledger_digest ||
      returnedEpoch.core_export_manifest_ref !== input.draft.group_digests["core"] ||
      returnedEpoch.r2_object_manifest_ref !== input.draft.group_digests["r2"] ||
      returnedEpoch.head_manifest_ref !== input.draft.group_digests["heads"] ||
      returnedEpoch.generation_manifest_ref !== input.draft.group_digests["generations"] ||
      returnedEpoch.purge_ledger_revision !== input.draft.purge_ledger_revision ||
      returnedEpoch.purge_ledger_digest !== input.draft.purge_ledger_digest ||
      returnedEpoch.audit_sample_receipt_ref !== input.draft.audit_sample_receipt_ref ||
      returnedEpoch.created_at !== input.draft.created_at || returnedEpoch.expires_at !== input.draft.expires_at) {
    return invalid("offsite copy result does not identify the exact persisted epoch draft");
  }
  const rows = await all<CopyReceiptRow>(input.database,
    "SELECT copy_id,epoch_id,destination_id,key_generation,policy_digest,intent_digest,receipt_json,epoch_json,attempt_json,readback_digest,expires_at,failure_domain,descriptor_digest,authority_authorized_at,created_at FROM backup_offsite_copy_receipt WHERE epoch_id=?1 AND readback_digest=?2 AND json_extract(epoch_json,'$.offsite_copy_ref')=?3 LIMIT 2",
    [input.draft.epoch_id, input.offsite_copy.readback_digest, returnedEpoch.offsite_copy_ref]);
  if (rows.length !== 1 || rows[0] === undefined) return invalid("offsite copy result does not resolve to exactly one persisted success receipt");
  const row = rows[0];
  const copyId = stringField(row.copy_id, "persisted offsite copy id");
  const destinationId = stringField(row.destination_id, "persisted offsite destination id");
  const keyGeneration = stringField(row.key_generation, "persisted offsite key generation");
  const policyDigest = digestField(row.policy_digest, "persisted offsite policy digest");
  const intentDigest = digestField(row.intent_digest, "persisted offsite intent digest");
  const readbackDigest = digestField(row.readback_digest, "persisted offsite readback digest");
  if (row.epoch_id !== input.draft.epoch_id || readbackDigest !== input.offsite_copy.readback_digest ||
      row.expires_at !== input.draft.expires_at || row.failure_domain !== returnedEpoch.offsite_failure_domain ||
      row.created_at !== returnedReceipt.created_at ||
      copyId !== await copyIdForDigest({ epoch_id: input.draft.epoch_id, destination_id: destinationId,
        key_generation: keyGeneration, policy_digest: policyDigest, intent_digest: intentDigest })) {
    return invalid("persisted offsite receipt pins disagree with the returned copy result");
  }
  let persistedEpoch: ReturnType<typeof BackupEpochSchema.parse>;
  let persistedAttempt: ReturnType<typeof OperationAttemptSchema.parse>;
  let persistedReceipt: ReturnType<typeof OperationReceiptSchema.parse>;
  try {
    persistedEpoch = BackupEpochSchema.parse(parseJson(row.epoch_json, "persisted offsite epoch"));
    persistedAttempt = OperationAttemptSchema.parse(parseJson(row.attempt_json, "persisted offsite attempt"));
    persistedReceipt = OperationReceiptSchema.parse(parseJson(row.receipt_json, "persisted offsite receipt"));
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted offsite copy authority is malformed", false, {}, cause);
  }
  if (canonicalBackupJson(persistedEpoch) !== canonicalBackupJson(returnedEpoch) ||
      canonicalBackupJson(persistedAttempt) !== canonicalBackupJson(returnedAttempt) ||
      canonicalBackupJson(persistedReceipt) !== canonicalBackupJson(returnedReceipt) ||
      persistedReceipt.outcome !== "SUCCEEDED" || persistedReceipt.attempt_id !== persistedAttempt.attempt_id ||
      persistedReceipt.intent_ref.id !== persistedAttempt.intent_ref.id ||
      persistedReceipt.intent_ref.revision !== persistedAttempt.intent_ref.revision ||
      persistedReceipt.output_refs.length !== 2 || persistedReceipt.output_refs[0] !== input.draft.epoch_id ||
      persistedReceipt.output_refs[1] !== persistedEpoch.offsite_copy_ref ||
      persistedReceipt.readback_receipt_refs.length !== 4 ||
      persistedReceipt.readback_receipt_refs[0] !== input.draft.audit_sample_receipt_ref ||
      persistedReceipt.readback_receipt_refs[1] !== readbackDigest ||
      persistedReceipt.readback_receipt_refs[2] !== policyDigest) {
    return invalid("offsite result is not the exact successful receipt persisted by O2");
  }
  const authorizationReceiptRef = persistedReceipt.readback_receipt_refs[3];
  if (authorizationReceiptRef === undefined) return invalid("persisted offsite receipt has no destination authorization pin");
  const partRefs = [
    ...input.draft.part_index.map((part) => `offsite/${input.draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`),
    ...(input.draft.payload_part_index ?? []).map((part) => `offsite/${input.draft.epoch_id}/r2-payload/${part.object_identity_digest}/${String(part.index).padStart(6, "0")}-${part.sha256}`),
  ];
  if (await backupSha256Hex(partRefs.join("\n")) !== readbackDigest) return invalid("persisted offsite readback digest does not cover the exact draft part order");
  const expectedOffsiteRef = `offsite-${(await backupSha256Hex(`offsite-copy\u0000${input.draft.epoch_id}\u0000${input.draft.vector_digest}\u0000${policyDigest}\u0000${authorizationReceiptRef}\u0000${keyGeneration}\u0000${partRefs.join(",")}`)).slice(0, 48)}`;
  if (expectedOffsiteRef !== persistedEpoch.offsite_copy_ref) return invalid("persisted offsite reference is not derived from its exact part, policy and authority pins");
  const checkpoints = await readCopyCheckpoints(input.database, copyId);
  if (checkpoints.size !== partRefs.length) return invalid("durable offsite checkpoints do not exactly cover the persisted draft part index");
  for (const part of [...input.draft.part_index, ...(input.draft.payload_part_index ?? [])]) {
    const ref = "object_identity_digest" in part
      ? `offsite/${input.draft.epoch_id}/r2-payload/${part.object_identity_digest}/${String(part.index).padStart(6, "0")}-${part.sha256}`
      : `offsite/${input.draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
    const checkpoint = checkpoints.get(ref);
    if (checkpoint === undefined || checkpoint.state !== "VERIFIED" || checkpoint.content_digest !== part.sha256 || checkpoint.size_bytes !== part.size_bytes) {
      return invalid("a durable offsite part checkpoint is absent, unverified or divergent");
    }
  }
  return { row, copy_id: copyId, remote_refs: partRefs };
}

/** Pure descriptor derivation. It grants no verification or restore authority. */
export async function deriveCanonicalBackupEpochBindings(input: {
  readonly draft: BackupEpochDraft;
  readonly verified: VerifiedPortableBackupManifests;
  readonly source_draft_sha256: string;
  readonly producer: Readonly<Record<string, unknown>>;
  readonly copy: {
    readonly copy_id: string;
    readonly copy_ref: string;
    readonly readback_digest: string;
    readonly receipt_sha256: string;
    readonly epoch_sha256: string;
    readonly attempt_sha256: string;
    readonly destination_id: string;
    readonly key_generation: string;
    readonly policy_digest: string;
    readonly intent_digest: string;
    readonly failure_domain: string;
    readonly descriptor_digest: string;
    readonly authority_authorized_at: string;
    readonly created_at: string;
  };
}): Promise<readonly CanonicalBackupManifestBinding[]> {
  const payloadPartIndex = input.draft.payload_part_index;
  if (!SHA256.test(input.source_draft_sha256) || input.verified.payload_supported !== true ||
      input.draft.r2_payload_protocol === undefined || !Array.isArray(payloadPartIndex)) {
    return invalid("canonical manifest bindings require a payload-capable verified portable epoch");
  }
  const coreMembers = ["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"] as const;
  const r2Objects = input.verified.r2_objects;
  const rebuildRows = input.verified.manifests["rebuild"] ?? [];
  const searchRow = rebuildRows.find((line) => isRecord(line) && line["kind"] === "d1-search" && line["source"] === "search-db");
  if (!isRecord(searchRow) || searchRow["status"] !== "REBUILD_REQUIRED") return invalid("verified portable manifests do not explicitly classify Search as REBUILD_REQUIRED");

  const descriptors: readonly { readonly role: BackupEpochManifestRole; readonly value: Readonly<Record<string, unknown>> }[] = await Promise.all([
    Promise.resolve({
      role: "CORE_EXPORT" as const,
      value: {
        protocol: BACKUP_EPOCH_BINDING_PROTOCOL,
        backup_epoch_id: input.draft.epoch_id,
        role: "CORE_EXPORT",
        coverage: { kind: "d1-core", status: "CANONICAL_EXPORTED" },
        source: { draft_sha256: input.source_draft_sha256, producer: input.producer,
          group_digest: input.draft.group_digests["core"], manifest_digests: Object.fromEntries(coreMembers.map((name) => [name, input.draft.manifest_digests[name]])) },
        purge: { ledger_revision: input.draft.purge_ledger_revision, ledger_digest: input.draft.purge_ledger_digest },
        offsite: input.copy,
      },
    }),
    Promise.resolve({
      role: "SEARCH_REBUILD_PLAN" as const,
      value: {
        protocol: BACKUP_EPOCH_BINDING_PROTOCOL,
        backup_epoch_id: input.draft.epoch_id,
        role: "SEARCH_REBUILD_PLAN",
        coverage: { kind: "d1-search", source: "search-db", status: "REBUILD_REQUIRED", snapshot_present: false },
        source: { draft_sha256: input.source_draft_sha256, producer: input.producer,
          rebuild_manifest_sha256: input.draft.manifest_digests["rebuild"], search_classification: searchRow },
        purge: { ledger_revision: input.draft.purge_ledger_revision, ledger_digest: input.draft.purge_ledger_digest },
        offsite: input.copy,
      },
    }),
    ...(["evidence", "work"] as const).map(async (bucket) => {
      const subset = r2Objects.filter((entry) => entry["bucket"] === bucket);
      const totalBytes = subset.reduce((total, entry) => {
        if (typeof entry["size_bytes"] !== "number" || !Number.isSafeInteger(entry["size_bytes"]) || entry["size_bytes"] < 0) return invalid("verified R2 subset has malformed size metadata");
        return total + entry["size_bytes"];
      }, 0);
      const identities = new Set<string>();
      for (const entry of subset) {
        if (typeof entry["bucket"] !== "string") return invalid("verified R2 subset has malformed object identity");
        identities.add(await backupR2ObjectIdentity(entry as Parameters<typeof backupR2ObjectIdentity>[0]));
      }
      const payloadParts = payloadPartIndex.filter((part) => identities.has(part.object_identity_digest));
      if (payloadParts.length !== subset.reduce((total, entry) => total + (Array.isArray(entry["payload_parts"]) ? entry["payload_parts"].length : 0), 0)) {
        return invalid("verified R2 subset payload index does not cover its exact object inventory");
      }
      return {
        role: bucket === "evidence" ? "EVIDENCE_R2_SUBSET" as const : "WORK_R2_SUBSET" as const,
        value: {
          protocol: BACKUP_EPOCH_BINDING_PROTOCOL,
          backup_epoch_id: input.draft.epoch_id,
          role: bucket === "evidence" ? "EVIDENCE_R2_SUBSET" : "WORK_R2_SUBSET",
          coverage: { bucket, status: "CANONICAL_EXPORTED" },
          source: { draft_sha256: input.source_draft_sha256, producer: input.producer,
            r2_manifest_sha256: input.draft.manifest_digests["r2-objects"], r2_group_digest: input.draft.group_digests["r2"],
            object_count: subset.length, total_bytes: totalBytes,
            fingerprint: await backupSha256Hex(subset.map(canonicalBackupJson).sort().join("\n")),
            payload_part_count: payloadParts.length, payload_part_index_sha256: await backupSha256Hex(canonicalBackupJson(payloadParts)) },
          purge: { ledger_revision: input.draft.purge_ledger_revision, ledger_digest: input.draft.purge_ledger_digest },
          offsite: input.copy,
        },
      };
    }),
  ]);
  const bindings = await Promise.all(descriptors.map(async ({ role, value }) => {
    const descriptorJson = canonicalBackupJson(value);
    const descriptorSha = await backupSha256Hex(descriptorJson);
    return {
      backup_epoch_id: input.draft.epoch_id,
      role,
      binding_ref: `sha256:${descriptorSha}`,
      descriptor_sha256: descriptorSha,
      descriptor_json: descriptorJson,
      source_draft_sha256: input.source_draft_sha256,
      offsite_copy_id: input.copy.copy_id,
      offsite_readback_digest: input.copy.readback_digest,
    } satisfies CanonicalBackupManifestBinding;
  }));
  return bindings;
}

function canonicalEpoch(draft: BackupEpochDraft, offsiteCopyRef: string, bindings: readonly CanonicalBackupManifestBinding[]): PendingCanonicalBackupEpoch {
  const ref = (role: BackupEpochManifestRole): string => {
    const binding = bindings.find((item) => item.role === role);
    if (binding === undefined) return invalid(`canonical backup binding ${role} is absent`);
    return binding.binding_ref;
  };
  return {
    backup_epoch_id: draft.epoch_id,
    verification_state: "PENDING",
    core_export_ref: ref("CORE_EXPORT"),
    search_projection_manifest_ref: ref("SEARCH_REBUILD_PLAN"),
    evidence_manifest_ref: ref("EVIDENCE_R2_SUBSET"),
    work_manifest_ref: ref("WORK_R2_SUBSET"),
    offsite_copy_ref: offsiteCopyRef,
    purge_ledger_revision: draft.purge_ledger_revision,
    created_at: draft.created_at,
  };
}

function epochMatches(actual: CanonicalEpochRow | null, expected: PendingCanonicalBackupEpoch): boolean {
  return actual !== null && actual.backup_epoch_id === expected.backup_epoch_id &&
    actual.core_export_ref === expected.core_export_ref && actual.search_projection_manifest_ref === expected.search_projection_manifest_ref &&
    actual.evidence_manifest_ref === expected.evidence_manifest_ref && actual.work_manifest_ref === expected.work_manifest_ref &&
    actual.offsite_copy_ref === expected.offsite_copy_ref && actual.purge_ledger_revision === expected.purge_ledger_revision &&
    actual.verification_state === "PENDING" && actual.created_at === expected.created_at && actual.verified_at === null;
}

function bindingsMatch(actual: readonly BindingRow[], expected: readonly CanonicalBackupManifestBinding[], createdAt: string): boolean {
  if (actual.length !== expected.length) return false;
  const byRole = new Map(actual.map((row) => [row.role, row]));
  return expected.every((binding) => {
    const row = byRole.get(binding.role);
    return row !== undefined && row.backup_epoch_id === binding.backup_epoch_id && row.binding_ref === binding.binding_ref &&
      row.descriptor_sha256 === binding.descriptor_sha256 && row.descriptor_json === binding.descriptor_json &&
      row.source_draft_sha256 === binding.source_draft_sha256 && row.offsite_copy_id === binding.offsite_copy_id &&
      row.offsite_readback_digest === binding.offsite_readback_digest && row.created_at === createdAt;
  });
}

async function readPublication(database: D1Database, expected: PendingCanonicalBackupEpoch, bindings: readonly CanonicalBackupManifestBinding[]): Promise<boolean> {
  const actualEpoch = await first<CanonicalEpochRow>(database,
    "SELECT backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at FROM backup_epoch WHERE backup_epoch_id=?1",
    [expected.backup_epoch_id]);
  const actualBindings = await all<BindingRow>(database,
    "SELECT backup_epoch_id,role,binding_ref,descriptor_sha256,descriptor_json,source_draft_sha256,offsite_copy_id,offsite_readback_digest,created_at FROM backup_epoch_manifest_binding WHERE backup_epoch_id=?1 ORDER BY role",
    [expected.backup_epoch_id]);
  if (actualEpoch === null && actualBindings.length === 0) return false;
  return epochMatches(actualEpoch, expected) && bindingsMatch(actualBindings, bindings, expected.created_at);
}

/**
 * Publishes exact verified portable bytes as a canonical PENDING backup epoch.
 * This performs no remote calls and never creates a VERIFIED transition.
 */
export async function publishPendingCanonicalBackupEpoch(input: {
  readonly core_db: D1Database;
  readonly epoch_id: string;
  readonly plaintext_parts: readonly PlaintextBackupPart[];
  readonly offsite_copy: OffsiteCopyResult;
}): Promise<PublishedPendingCanonicalBackupEpoch> {
  await assertBackupEpochManifestMigrationAuthority(input.core_db);
  const source = await persistedEpochSource(input.core_db, input.epoch_id);
  const verified = await verifyPortableBackupManifests({ draft: source.draft, plaintext_parts: input.plaintext_parts });
  if (verified.payload_supported !== true) return invalid("canonical publication refuses legacy R2 manifests without authenticated payload parts");
  const vectorProof = verified.manifests["vector"]?.find((line) => isRecord(line) && line["protocol"] === source.draft.manifest_protocol);
  if (!isRecord(vectorProof) || vectorProof["cut_id"] !== source.draft.cut_id ||
      vectorProof["cut_digest"] !== source.producer["cut_digest"] ||
      source.producer["cut_id"] !== source.draft.cut_id ||
      source.producer["vector_digest"] !== source.draft.vector_digest) {
    return invalid("committed producer claim diverges from the authenticated vector cut pins");
  }
  const copy = await persistedCopySource({ database: input.core_db, draft: source.draft, offsite_copy: input.offsite_copy });
  const copyPin = {
    copy_id: copy.copy_id,
    copy_ref: stringField(input.offsite_copy.offsite_copy_ref, "offsite copy reference"),
    readback_digest: digestField(copy.row.readback_digest, "offsite copy readback digest"),
    receipt_sha256: await backupSha256Hex(String(copy.row.receipt_json)),
    epoch_sha256: await backupSha256Hex(String(copy.row.epoch_json)),
    attempt_sha256: await backupSha256Hex(String(copy.row.attempt_json)),
    destination_id: stringField(copy.row.destination_id, "offsite destination id"),
    key_generation: stringField(copy.row.key_generation, "offsite key generation"),
    policy_digest: digestField(copy.row.policy_digest, "offsite policy digest"),
    intent_digest: digestField(copy.row.intent_digest, "offsite intent digest"),
    failure_domain: stringField(copy.row.failure_domain, "offsite failure domain"),
    descriptor_digest: digestField(copy.row.descriptor_digest, "offsite descriptor digest"),
    authority_authorized_at: stringField(copy.row.authority_authorized_at, "destination authorization time"),
    created_at: stringField(copy.row.created_at, "offsite copy receipt time"),
  };
  const bindings = await deriveCanonicalBackupEpochBindings({ draft: source.draft, verified,
    source_draft_sha256: source.draft_sha256, producer: source.producer, copy: copyPin });
  const epoch = canonicalEpoch(source.draft, copyPin.copy_ref, bindings);
  const alreadyPublished = await readPublication(input.core_db, epoch, bindings);
  if (alreadyPublished) return { disposition: "REPLAYED", epoch, bindings };

  const statements = [
    input.core_db.prepare("INSERT INTO backup_epoch (backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'PENDING',?8,NULL)")
      .bind(epoch.backup_epoch_id, epoch.core_export_ref, epoch.search_projection_manifest_ref, epoch.evidence_manifest_ref, epoch.work_manifest_ref, epoch.offsite_copy_ref, epoch.purge_ledger_revision, epoch.created_at),
    ...bindings.map((binding) => input.core_db.prepare("INSERT INTO backup_epoch_manifest_binding (backup_epoch_id,role,binding_ref,descriptor_sha256,descriptor_json,source_draft_sha256,offsite_copy_id,offsite_readback_digest,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)")
      .bind(binding.backup_epoch_id, binding.role, binding.binding_ref, binding.descriptor_sha256, binding.descriptor_json, binding.source_draft_sha256, binding.offsite_copy_id, binding.offsite_readback_digest, source.draft.created_at)),
  ];
  let committed = false;
  try {
    const results = await input.core_db.batch(statements);
    committed = results.length === statements.length && results.every((result) => result.success === true);
  } catch {
    // Reconcile below: D1 may have committed before the acknowledgement was lost.
  }
  if (!committed) {
    if (await readPublication(input.core_db, epoch, bindings)) return { disposition: "REPLAYED", epoch, bindings };
    const residualEpoch = await first<CanonicalEpochRow>(input.core_db,
      "SELECT backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at FROM backup_epoch WHERE backup_epoch_id=?1",
      [epoch.backup_epoch_id]);
    const residualBindings = await all<BindingRow>(input.core_db,
      "SELECT backup_epoch_id,role,binding_ref,descriptor_sha256,descriptor_json,source_draft_sha256,offsite_copy_id,offsite_readback_digest,created_at FROM backup_epoch_manifest_binding WHERE backup_epoch_id=?1 ORDER BY role",
      [epoch.backup_epoch_id]);
    if (residualEpoch !== null || residualBindings.length !== 0) return invalid("canonical backup publication collided with divergent or incomplete epoch state; no retry was applied");
    return failBackup("BACKUP_TABLE_MISSING", "canonical backup publication outcome is unresolved after exact readback", true);
  }
  if (!(await readPublication(input.core_db, epoch, bindings))) {
    return invalid("canonical backup epoch batch acknowledged but exact descriptor readback did not match");
  }
  return { disposition: "CREATED", epoch, bindings };
}
