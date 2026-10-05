import { BACKUP_MANIFEST_PROTOCOL } from "./coherent-cut.js";
import { BACKUP_R2_PAYLOAD_PROTOCOL } from "./r2-inventory.js";
import { failBackup } from "./shared.js";

const MANIFESTS = [
  "schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes",
  "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector",
] as const;
const MAX_PARTS = 100_000;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface BackupEpochOffsitePartRef {
  readonly offsite_ref: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidPartInventory(): never {
  failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted backup epoch part inventory is malformed or incomplete", false);
}

/** Validate the persisted O2 draft and return every manifest and payload offsite ref. */
export function readBackupEpochOffsitePartRefs(value: unknown, epochId: string): readonly BackupEpochOffsitePartRef[] {
  const legacyFields = [
    "epoch_id", "schema_generation", "migration_ledger_digest", "manifest_digests", "group_digests", "part_index",
    "purge_ledger_revision", "purge_ledger_digest", "r2_object_count", "r2_total_bytes", "audit_sample_receipt_ref",
    "vector_digest", "vector_manifest_digest", "cut_id", "manifest_protocol", "created_at", "expires_at",
  ] as const;
  const payloadFields = ["r2_payload_protocol", "payload_part_index"] as const;
  if (!isRecord(value) || value.epoch_id !== epochId || value.manifest_protocol !== BACKUP_MANIFEST_PROTOCOL) invalidPartInventory();
  const hasProtocol = Object.prototype.hasOwnProperty.call(value, "r2_payload_protocol");
  const hasPayloadIndex = Object.prototype.hasOwnProperty.call(value, "payload_part_index");
  if (hasProtocol !== hasPayloadIndex || !hasExactKeys(value, hasProtocol ? [...legacyFields, ...payloadFields] : legacyFields)) invalidPartInventory();
  if (!Number.isSafeInteger(value.r2_object_count) || (value.r2_object_count as number) < 0 ||
    !Number.isSafeInteger(value.r2_total_bytes) || (value.r2_total_bytes as number) < 0) invalidPartInventory();
  if (!Array.isArray(value.part_index) || value.part_index.length < MANIFESTS.length || value.part_index.length > MAX_PARTS) {
    invalidPartInventory();
  }

  const refs: BackupEpochOffsitePartRef[] = [];
  const seenRefs = new Set<string>();
  const addRef = (ref: string): void => {
    if (seenRefs.has(ref) || refs.length >= MAX_PARTS) invalidPartInventory();
    seenRefs.add(ref);
    refs.push({ offsite_ref: ref });
  };
  let priorManifest = -1;
  let priorManifestPart = 0;
  for (const raw of value.part_index) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["manifest", "index", "part_key", "sha256", "size_bytes", "etag", "existed_identically"])) invalidPartInventory();
    if (typeof raw.manifest !== "string" || !Number.isSafeInteger(raw.index) || (raw.index as number) < 1 ||
      !Number.isSafeInteger(raw.size_bytes) || (raw.size_bytes as number) < 0 || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256) ||
      typeof raw.etag !== "string" || raw.etag.length === 0 || raw.etag.length > 256 || typeof raw.existed_identically !== "boolean") invalidPartInventory();
    const manifestOrder = MANIFESTS.indexOf(raw.manifest as (typeof MANIFESTS)[number]);
    const index = raw.index as number;
    if (manifestOrder < 0 || manifestOrder < priorManifest || manifestOrder > priorManifest + 1 ||
      (manifestOrder === priorManifest ? index !== priorManifestPart + 1 : index !== 1)) invalidPartInventory();
    const digest = raw.sha256 as string;
    if (raw.part_key !== `backup-parts/${epochId}/${raw.manifest}/${String(index).padStart(6, "0")}-${digest}`) invalidPartInventory();
    addRef(`offsite/${epochId}/${raw.manifest}/${String(index).padStart(6, "0")}-${digest}`);
    priorManifest = manifestOrder;
    priorManifestPart = index;
  }
  if (priorManifest !== MANIFESTS.length - 1) invalidPartInventory();

  if (!hasProtocol) return refs;
  if (value.r2_payload_protocol !== BACKUP_R2_PAYLOAD_PROTOCOL || !Array.isArray(value.payload_part_index) ||
    value.payload_part_index.length > MAX_PARTS - refs.length) invalidPartInventory();
  const objectIdentities = new Set<string>();
  let payloadBytes = 0;
  let priorIdentity = "";
  let priorPayloadIndex = 0;
  let priorPayloadCount = 0;
  for (const raw of value.payload_part_index) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["object_identity_digest", "index", "count", "part_key", "sha256", "size_bytes", "etag", "existed_identically"])) invalidPartInventory();
    if (typeof raw.object_identity_digest !== "string" || !SHA256.test(raw.object_identity_digest) ||
      !Number.isSafeInteger(raw.index) || (raw.index as number) < 1 || !Number.isSafeInteger(raw.count) || (raw.count as number) < 1 ||
      (raw.index as number) > (raw.count as number) || (raw.count as number) > MAX_PARTS ||
      !Number.isSafeInteger(raw.size_bytes) || (raw.size_bytes as number) < 0 || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256) ||
      typeof raw.etag !== "string" || raw.etag.length === 0 || raw.etag.length > 256 || typeof raw.existed_identically !== "boolean") invalidPartInventory();
    const identity = raw.object_identity_digest as string;
    const index = raw.index as number;
    const count = raw.count as number;
    const size = raw.size_bytes as number;
    const digest = raw.sha256 as string;
    if (identity < priorIdentity || (identity === priorIdentity && index !== priorPayloadIndex + 1) ||
      (identity !== priorIdentity && index !== 1) || (identity === priorIdentity && count !== priorPayloadCount) ||
      (priorIdentity !== "" && identity !== priorIdentity && priorPayloadIndex !== priorPayloadCount)) invalidPartInventory();
    if (identity !== priorIdentity) objectIdentities.add(identity);
    const expectedKey = `backup-parts/${epochId}/r2-payload/${identity}/${String(index).padStart(6, "0")}-${digest}`;
    if (raw.part_key !== expectedKey) invalidPartInventory();
    payloadBytes += size;
    if (!Number.isSafeInteger(payloadBytes)) invalidPartInventory();
    addRef(`offsite/${epochId}/r2-payload/${identity}/${String(index).padStart(6, "0")}-${digest}`);
    priorIdentity = identity;
    priorPayloadIndex = index;
    priorPayloadCount = count;
  }
  if ((priorIdentity !== "" && priorPayloadIndex !== priorPayloadCount) ||
    objectIdentities.size !== value.r2_object_count || payloadBytes !== value.r2_total_bytes) invalidPartInventory();
  return refs;
}
