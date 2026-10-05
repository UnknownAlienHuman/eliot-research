import { assertErasureIdentifier, assertErasureSha256, assertErasureText, erasureFail } from "./canonical.js";
import { BACKUP_R2_PAYLOAD_PROTOCOL } from "@eliotr/backup-o2";

const PROTOCOL = "eliotr.backup-manifest.v1";
const MANIFESTS = [
  "schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes",
  "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector",
] as const;
const MAX_EPOCHS = 10_000;
const MAX_PARTS = 100_000;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SCOPED_TARGETS = 100_000;

export interface BackupEpochScopePart {
  readonly manifest: string;
  readonly index: number;
  readonly part_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface BackupEpochScopePayloadPart {
  readonly object_identity_digest: string;
  readonly index: number;
  readonly count: number;
  readonly part_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface BackupEpochScopeDraft {
  readonly epoch_id: string;
  readonly schema_generation: string;
  readonly migration_ledger_digest: string;
  readonly manifest_digests: Readonly<Record<string, string>>;
  readonly group_digests: Readonly<Record<string, string>>;
  readonly manifest_protocol: string;
  readonly part_index: readonly BackupEpochScopePart[];
  readonly r2_payload_protocol?: typeof BACKUP_R2_PAYLOAD_PROTOCOL;
  readonly payload_part_index?: readonly BackupEpochScopePayloadPart[];
  readonly purge_ledger_revision: number;
  readonly purge_ledger_digest: string;
  readonly r2_object_count: number;
  readonly r2_total_bytes: number;
  readonly audit_sample_receipt_ref: string;
  readonly vector_digest: string;
  readonly vector_manifest_digest: string;
  readonly cut_id: string;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface VerifiedBackupSourceRows {
  readonly source_rows: readonly { readonly table: string; readonly row: Readonly<Record<string, unknown>> }[];
}

export interface BackupEpochScopeArchive {
  readonly epoch_id: unknown;
  readonly verification_state: unknown;
  /** Reads the exact D1-persisted backup_epoch_receipt.draft_json on demand. */
  readonly read_draft_json: () => Promise<unknown>;
  /** Resolve every part through an authorized complete local or O2 offsite read path. */
  readonly read_plaintext_part: (part: BackupEpochScopePart, draft: BackupEpochScopeDraft) => Promise<Uint8Array | null>;
}

export interface BackupEpochScopeSubject {
  readonly kind: "source" | "source-revision";
  readonly source_id: string;
  readonly source_owner_generation: string;
  readonly source_revision_ref?: string;
  readonly content_sha256?: string;
  readonly object_residency_key_digest?: string;
}

export type VerifyBackupEpochManifests = (input: {
  readonly draft: BackupEpochScopeDraft;
  readonly plaintext_parts: readonly { readonly manifest: string; readonly index: number; readonly bytes: Uint8Array }[];
}) => Promise<VerifiedBackupSourceRows>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseDraft(value: unknown, epochId: string): BackupEpochScopeDraft {
  const json = assertErasureText(value, "persisted backup epoch draft", 1_048_576);
  let decoded: unknown;
  try { decoded = JSON.parse(json) as unknown; }
  catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch draft JSON is malformed", false, cause); }
  const legacyFields = [
    "epoch_id", "schema_generation", "migration_ledger_digest", "manifest_digests", "group_digests", "part_index",
    "purge_ledger_revision", "purge_ledger_digest", "r2_object_count", "r2_total_bytes", "audit_sample_receipt_ref",
    "vector_digest", "vector_manifest_digest", "cut_id", "manifest_protocol", "created_at", "expires_at",
  ] as const;
  const payloadFields = ["r2_payload_protocol", "payload_part_index"] as const;
  if (!isRecord(decoded) || decoded.epoch_id !== epochId || decoded.manifest_protocol !== PROTOCOL) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch draft is unbound or uses an unknown manifest protocol");
  }
  const hasPayloadProtocol = Object.prototype.hasOwnProperty.call(decoded, "r2_payload_protocol");
  const hasPayloadIndex = Object.prototype.hasOwnProperty.call(decoded, "payload_part_index");
  if (hasPayloadProtocol !== hasPayloadIndex || !exactKeys(decoded, hasPayloadProtocol ? [...legacyFields, ...payloadFields] : legacyFields)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch draft has unknown or incomplete payload protocol fields");
  }
  const schemaGeneration = assertErasureIdentifier(decoded.schema_generation, "backup schema generation");
  const migrationDigest = assertErasureSha256(decoded.migration_ledger_digest, "backup migration digest");
  const purgeDigest = assertErasureSha256(decoded.purge_ledger_digest, "backup purge digest");
  const vectorDigest = assertErasureSha256(decoded.vector_digest, "backup vector digest");
  const vectorManifestDigest = assertErasureSha256(decoded.vector_manifest_digest, "backup vector manifest digest");
  const cutId = assertErasureIdentifier(decoded.cut_id, "backup cut ID");
  const auditReceipt = assertErasureIdentifier(decoded.audit_sample_receipt_ref, "backup audit receipt");
  const digestMap = (value: unknown, keys: readonly string[]): Readonly<Record<string, string>> | null => {
    if (!isRecord(value) || !exactKeys(value, keys)) return null;
    const out: Record<string, string> = {};
    for (const [key, digest] of Object.entries(value)) {
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return null;
      out[key] = digest;
    }
    return out;
  };
  const manifestDigests = digestMap(decoded.manifest_digests, MANIFESTS);
  const groupDigests = digestMap(decoded.group_digests, ["core", "heads", "generations", "r2"]);
  if (manifestDigests === null || groupDigests === null) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch digest inventory is incomplete or malformed");
  }
  if (!Number.isSafeInteger(decoded.purge_ledger_revision) || (decoded.purge_ledger_revision as number) < 0 ||
    !Number.isSafeInteger(decoded.r2_object_count) || (decoded.r2_object_count as number) < 0 ||
    !Number.isSafeInteger(decoded.r2_total_bytes) || (decoded.r2_total_bytes as number) < 0) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch draft has malformed counters or timestamps");
  }
  if (!Array.isArray(decoded.part_index) || decoded.part_index.length < MANIFESTS.length || decoded.part_index.length > MAX_PARTS) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch part inventory is incomplete or over its bound");
  }
  const parts: BackupEpochScopePart[] = decoded.part_index.map((raw): BackupEpochScopePart => {
    if (!isRecord(raw) || !exactKeys(raw, ["manifest", "index", "part_key", "sha256", "size_bytes", "etag", "existed_identically"])) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch part entry is malformed");
    }
    if (typeof raw.manifest !== "string" || !MANIFESTS.includes(raw.manifest as (typeof MANIFESTS)[number]) ||
      typeof raw.index !== "number" || !Number.isSafeInteger(raw.index) || raw.index < 1 ||
      typeof raw.size_bytes !== "number" || !Number.isSafeInteger(raw.size_bytes) || raw.size_bytes < 0 ||
      raw.size_bytes > MAX_PART_BYTES || typeof raw.existed_identically !== "boolean") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch part entry has malformed identity or bounds");
    }
    const manifest = raw.manifest as string;
    const sha256 = assertErasureSha256(raw.sha256, "backup part digest");
    const partKey = assertErasureText(raw.part_key, "backup part key", 1024);
    const index = raw.index;
    if (partKey !== `backup-parts/${epochId}/${manifest}/${String(index).padStart(6, "0")}-${sha256}`) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup part key does not match its exact epoch manifest index");
    }
    return {
      manifest,
      index,
      part_key: partKey,
      sha256,
      size_bytes: raw.size_bytes,
      etag: assertErasureText(raw.etag, "backup part etag", 256),
      existed_identically: raw.existed_identically,
    };
  });
  const byManifest = new Map<string, BackupEpochScopePart[]>();
  let previousManifestOrder = -1;
  let previousPartIndex = 0;
  let indexedBytes = 0;
  for (const part of parts) {
    const manifestOrder = MANIFESTS.indexOf(part.manifest as (typeof MANIFESTS)[number]);
    if (manifestOrder < previousManifestOrder ||
      (manifestOrder === previousManifestOrder && part.index <= previousPartIndex)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch part index is not in canonical manifest and part order");
    }
    previousManifestOrder = manifestOrder;
    previousPartIndex = part.index;
    indexedBytes += part.size_bytes;
    if (indexedBytes > MAX_TOTAL_BYTES) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup manifest bytes exceed their total bound");
    const list = byManifest.get(part.manifest) ?? [];
    list.push(part);
    byManifest.set(part.manifest, list);
  }
  for (const manifest of MANIFESTS) {
    const manifestParts = (byManifest.get(manifest) ?? []).sort((left, right) => left.index - right.index);
    if (manifestParts.length === 0 || manifestParts.some((part, index) => part.index !== index + 1)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup ${manifest} part sequence is incomplete`);
    }
  }
  let payloadParts: BackupEpochScopePayloadPart[] = [];
  if (hasPayloadProtocol) {
    if (decoded.r2_payload_protocol !== BACKUP_R2_PAYLOAD_PROTOCOL || !Array.isArray(decoded.payload_part_index) ||
      decoded.payload_part_index.length > MAX_PARTS - parts.length) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch payload protocol or part index is unsupported or over its bound");
    }
    payloadParts = [];
    const identities = new Set<string>();
    let previousIdentity = "";
    let previousIndex = 0;
    let previousCount = 0;
    let payloadBytes = 0;
    for (const raw of decoded.payload_part_index) {
      if (!isRecord(raw) || !exactKeys(raw, ["object_identity_digest", "index", "count", "part_key", "sha256", "size_bytes", "etag", "existed_identically"])) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch payload part entry is malformed");
      }
      const identity = assertErasureSha256(raw.object_identity_digest, "backup payload object identity digest");
      const index = raw.index;
      const count = raw.count;
      if (!Number.isSafeInteger(index) || (index as number) < 1 || !Number.isSafeInteger(count) || (count as number) < 1 ||
        (index as number) > (count as number) || (count as number) > MAX_PARTS ||
        !Number.isSafeInteger(raw.size_bytes) || (raw.size_bytes as number) < 0 || typeof raw.existed_identically !== "boolean") {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch payload part entry has malformed identity or bounds");
      }
      const sha256 = assertErasureSha256(raw.sha256, "backup payload part digest");
      const partKey = assertErasureText(raw.part_key, "backup payload part key", 1024);
      const expectedIndex = index as number;
      const expectedCount = count as number;
      if (identity < previousIdentity || (identity === previousIdentity && expectedIndex !== previousIndex + 1) ||
        (identity !== previousIdentity && expectedIndex !== 1) || (identity === previousIdentity && expectedCount !== previousCount) ||
        (previousIdentity !== "" && identity !== previousIdentity && previousIndex !== previousCount)) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch payload part index is duplicate, unordered, or incomplete");
      }
      if (partKey !== `backup-parts/${epochId}/r2-payload/${identity}/${String(expectedIndex).padStart(6, "0")}-${sha256}`) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup payload part key does not match its exact epoch identity and index");
      }
      const size = raw.size_bytes as number;
      payloadBytes += size;
      if (!Number.isSafeInteger(payloadBytes)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup payload byte total exceeds its safe bound");
      if (identity !== previousIdentity) identities.add(identity);
      payloadParts.push({
        object_identity_digest: identity,
        index: expectedIndex,
        count: expectedCount,
        part_key: partKey,
        sha256,
        size_bytes: size,
        etag: assertErasureText(raw.etag, "backup payload part etag", 256),
        existed_identically: raw.existed_identically,
      });
      previousIdentity = identity;
      previousIndex = expectedIndex;
      previousCount = expectedCount;
    }
    if ((previousIdentity !== "" && previousIndex !== previousCount) ||
      identities.size !== decoded.r2_object_count || payloadBytes !== decoded.r2_total_bytes) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch payload inventory does not match its object and byte totals");
    }
  }
  return {
    epoch_id: epochId,
    schema_generation: schemaGeneration,
    migration_ledger_digest: migrationDigest,
    manifest_digests: manifestDigests,
    group_digests: groupDigests,
    part_index: parts,
    ...(hasPayloadProtocol ? { r2_payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL, payload_part_index: payloadParts } : {}),
    purge_ledger_revision: decoded.purge_ledger_revision as number,
    purge_ledger_digest: purgeDigest,
    r2_object_count: decoded.r2_object_count as number,
    r2_total_bytes: decoded.r2_total_bytes as number,
    audit_sample_receipt_ref: auditReceipt,
    vector_digest: vectorDigest,
    vector_manifest_digest: vectorManifestDigest,
    cut_id: cutId,
    manifest_protocol: PROTOCOL,
    created_at: assertErasureText(decoded.created_at, "backup epoch creation time", 128),
    expires_at: assertErasureText(decoded.expires_at, "backup epoch expiry time", 128),
  };
}

interface IndexedSubjects {
  readonly subjects: readonly BackupEpochScopeSubject[];
  readonly source_indexes: ReadonlyMap<string, readonly number[]>;
  readonly revision_indexes: ReadonlyMap<string, readonly number[]>;
}

function indexSubjects(subjects: readonly BackupEpochScopeSubject[]): IndexedSubjects {
  const sourceSubjectIndexes = new Map<string, number[]>();
  const revisionSubjectIndexes = new Map<string, number[]>();
  for (const [index, subject] of subjects.entries()) {
    const sourceId = assertErasureIdentifier(subject.source_id, "selected backup source ID");
    assertErasureIdentifier(subject.source_owner_generation, "selected backup source owner generation");
    if (subject.kind === "source") {
      const indexes = sourceSubjectIndexes.get(sourceId) ?? [];
      indexes.push(index);
      sourceSubjectIndexes.set(sourceId, indexes);
    } else if (subject.kind === "source-revision") {
      const revisionRef = assertErasureIdentifier(subject.source_revision_ref, "selected source revision");
      const indexes = revisionSubjectIndexes.get(revisionRef) ?? [];
      indexes.push(index);
      revisionSubjectIndexes.set(revisionRef, indexes);
      assertErasureSha256(subject.content_sha256, "selected source content digest");
      assertErasureSha256(subject.object_residency_key_digest, "selected source residency digest");
    } else {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "selected backup subject kind is unknown");
    }
  }
  return { subjects, source_indexes: sourceSubjectIndexes, revision_indexes: revisionSubjectIndexes };
}

function matchingSubjectIndexes(
  selected: IndexedSubjects,
  result: VerifiedBackupSourceRows,
): ReadonlySet<number> {
  if (!Array.isArray(result.source_rows) || result.source_rows.length > 100_000) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "verified backup row set is incomplete or over its bound");
  }
  const sources = new Map<string, string>();
  const revisions = new Map<string, Record<string, unknown>>();
  for (const item of result.source_rows) {
    if (!isRecord(item) || typeof item.table !== "string" || !isRecord(item.row)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "verified backup row set has an unknown shape");
    }
    if (item.table === "source") {
      const id = assertErasureIdentifier(item.row.source_id, "backup source ID");
      const generation = assertErasureIdentifier(item.row.source_owner_generation, "backup source owner generation");
      if (sources.has(id)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup manifest contains duplicate source IDs");
      sources.set(id, generation);
    } else if (item.table === "source_revision") {
      const ref = assertErasureIdentifier(item.row.source_revision_ref, "backup source revision");
      if (revisions.has(ref)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup manifest contains duplicate source revisions");
      revisions.set(ref, item.row);
    }
  }
  for (const [revisionRef, row] of revisions) {
    const sourceId = assertErasureIdentifier(row.source_id, "backup revision source ID");
    const generation = assertErasureIdentifier(row.source_owner_generation, "backup revision owner generation");
    if (sources.get(sourceId) !== generation) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", `backup revision ${revisionRef} does not bind to an exact source owner generation`);
    }
  }
  const matched = new Set<number>();
  for (const [sourceId, generation] of sources) {
    const indexes = selected.source_indexes.get(sourceId);
    if (indexes === undefined) continue;
    for (const index of indexes) {
      if (generation !== selected.subjects[index]?.source_owner_generation) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup source owner generation differs from the selected source");
      }
      matched.add(index);
    }
  }
  for (const [revisionRef, row] of revisions) {
    const indexes = selected.revision_indexes.get(revisionRef);
    if (indexes === undefined) continue;
    for (const index of indexes) {
      const subject = selected.subjects[index];
      if (subject === undefined || subject.kind !== "source-revision") {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "selected backup revision identity is malformed");
      }
      if (assertErasureIdentifier(row.source_id, "backup revision source ID") !== subject.source_id ||
        assertErasureIdentifier(row.source_owner_generation, "backup revision owner generation") !== subject.source_owner_generation ||
        assertErasureSha256(row.content_sha256, "backup revision content digest") !== assertErasureSha256(subject.content_sha256, "selected source content digest") ||
        assertErasureSha256(row.object_residency_key_digest, "backup revision residency digest") !== assertErasureSha256(subject.object_residency_key_digest, "selected source residency digest")) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup source revision differs from the selected root identity");
      }
      matched.add(index);
    }
  }
  return matched;
}

/**
 * Scope backup erasure targets by authenticated full O2 manifests. The caller
 * must supply the complete bounded union of backup_epoch rows, O2 receipts,
 * and O4 copy-authority epochs and a part reader that uses durable local or
 * authenticated offsite authority. DRAFT/PENDING/FAILED, unknown copy epochs,
 * missing parts, or incomplete canonical manifests block the entire result.
 */
export async function scopeBackupEpochsForSubjects(input: {
  readonly subjects: readonly BackupEpochScopeSubject[];
  readonly archives: readonly BackupEpochScopeArchive[];
  readonly copy_authority_epoch_ids: readonly string[];
  readonly verify_manifests: VerifyBackupEpochManifests;
}): Promise<readonly (readonly string[])[]> {
  if (!Array.isArray(input.archives) || input.archives.length > MAX_EPOCHS || !Array.isArray(input.copy_authority_epoch_ids) ||
    input.copy_authority_epoch_ids.length > MAX_PARTS || !Array.isArray(input.subjects) || input.subjects.length > MAX_EPOCHS) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch or copy-authority inventory exceeds its bound");
  }
  if (input.subjects.length === 0) return [];
  for (const subject of input.subjects) {
    assertErasureIdentifier(subject.source_id, "selected backup source ID");
    assertErasureIdentifier(subject.source_owner_generation, "selected backup source owner generation");
    if (subject.kind !== "source" && subject.kind !== "source-revision") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "selected backup subject kind is unknown");
    }
  }
  const selected = indexSubjects(input.subjects);
  const byEpoch = new Map<string, BackupEpochScopeArchive>();
  for (const archive of input.archives) {
    const epochId = assertErasureIdentifier(archive.epoch_id, "backup epoch ID");
    if (byEpoch.has(epochId)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch inventory contains duplicate IDs");
    if (archive.verification_state !== "VERIFIED") {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup inventory contains a DRAFT, PENDING, FAILED, or unknown epoch");
    }
    byEpoch.set(epochId, archive);
  }
  const seenCopyAuthorityEpochs = new Set<string>();
  for (const rawEpochId of input.copy_authority_epoch_ids) {
    const epochId = assertErasureIdentifier(rawEpochId, "offsite copy epoch ID");
    if (seenCopyAuthorityEpochs.has(epochId)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "offsite copy authority inventory contains duplicate epochs");
    }
    seenCopyAuthorityEpochs.add(epochId);
    if (!byEpoch.has(epochId)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "offsite copy authority references an unverified or unknown epoch");
  }

  const affected: string[][] = input.subjects.map(() => []);
  let targetCount = 0;
  for (const [epochId, archive] of byEpoch) {
    let draftJson: unknown;
    try { draftJson = await archive.read_draft_json(); }
    catch (cause) { erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "persisted backup epoch receipt readback is unavailable", true, cause); }
    const draft = parseDraft(draftJson, epochId);
    let totalBytes = 0;
    const plaintext_parts: { manifest: string; index: number; bytes: Uint8Array }[] = [];
    for (const part of draft.part_index) {
      let bytes: Uint8Array | null;
      try { bytes = await archive.read_plaintext_part(part, draft); }
      catch (cause) { erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup manifest part readback is unavailable", true, cause); }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== part.size_bytes || await digestBytes(bytes) !== part.sha256) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup manifest part bytes fail exact persisted identity");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup manifest bytes exceed their total bound");
      plaintext_parts.push({ manifest: part.manifest, index: part.index, bytes });
    }
    let verified: VerifiedBackupSourceRows;
    try { verified = await input.verify_manifests({ draft, plaintext_parts }); }
    catch (cause) { erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup canonical manifests could not be verified", false, cause); }
    for (const index of matchingSubjectIndexes(selected, verified)) {
      targetCount += 1;
      if (targetCount > MAX_SCOPED_TARGETS) {
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "scoped backup target count exceeds its bound");
      }
      affected[index]?.push(epochId);
    }
  }
  return affected.map((epochIds) => epochIds.sort());
}

export async function scopeBackupEpochsForSubject(input: {
  readonly subject: BackupEpochScopeSubject;
  readonly archives: readonly BackupEpochScopeArchive[];
  readonly copy_authority_epoch_ids: readonly string[];
  readonly verify_manifests: VerifyBackupEpochManifests;
}): Promise<readonly string[]> {
  const [affected = []] = await scopeBackupEpochsForSubjects({
    subjects: [input.subject],
    archives: input.archives,
    copy_authority_epoch_ids: input.copy_authority_epoch_ids,
    verify_manifests: input.verify_manifests,
  });
  return affected;
}
