import {
  EvidenceResolutionReceiptSchema,
  VersionedRefSchema,
  type EvidenceResolutionReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  assertEvidenceIdentifier,
  assertEvidenceSha256,
  canonicalEvidenceJson,
  evidenceRefKey,
  evidenceSha256,
  exactEvidenceRef,
} from "./canonical.js";
import { loadEvidenceHandle } from "./authority-load.js";
import {
  evidenceHandleIdentityPayload,
  evidenceResolutionReceiptDigestPayload,
} from "./registry.js";
import { EvidenceRuntimeError } from "./types.js";

interface ResolutionRow {
  readonly receipt_id: unknown;
  readonly revision: unknown;
  readonly handle_id: unknown;
  readonly handle_revision: unknown;
  readonly source_revision_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly normalized_object_ref_digest: unknown;
  readonly source_revision_content_sha256: unknown;
  readonly source_object_size: unknown;
  readonly scope_snapshot_digest: unknown;
  readonly anchor_digest: unknown;
  readonly excerpt_sha256: unknown;
  readonly excerpt_byte_length: unknown;
  readonly source_owner_generation: unknown;
  readonly purge_state: unknown;
  readonly terminal_state: unknown;
  readonly receipt_json: unknown;
  readonly receipt_sha256: unknown;
  readonly resolved_at: unknown;
  readonly guard_verified: unknown;
  readonly guard_identity_digest: unknown;
  readonly identity_digest: unknown;
  readonly identity_handle_id: unknown;
  readonly identity_handle_revision: unknown;
}

function fail(message: string): never {
  throw new EvidenceRuntimeError("EVIDENCE_INPUT_INVALID", message);
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`stored evidence resolution ${label} conflicts with its receipt`);
}

function parseReceipt(row: ResolutionRow): EvidenceResolutionReceipt {
  if (typeof row.receipt_json !== "string") {
    fail("stored evidence resolution receipt is missing canonical JSON");
  }
  if (typeof row.receipt_sha256 !== "string") {
    fail("stored evidence resolution receipt is missing its row digest");
  }
  let parsed: EvidenceResolutionReceipt;
  try {
    const raw = JSON.parse(row.receipt_json) as unknown;
    if (canonicalEvidenceJson(raw) !== row.receipt_json) {
      fail("stored evidence resolution receipt is not canonical");
    }
    parsed = EvidenceResolutionReceiptSchema.parse(raw);
  } catch (cause) {
    if (cause instanceof EvidenceRuntimeError) throw cause;
    fail("stored evidence resolution receipt failed strict decoding");
  }
  assertEvidenceSha256(row.receipt_sha256, "stored evidence resolution receipt row digest");
  return parsed;
}

export interface ReadEvidenceResolutionReceiptInput {
  readonly verification_receipt_ref: string;
  readonly expected_handle_ref: VersionedRef;
}

/**
 * Read one persisted verification receipt without resolving or materializing it.
 * Callers must still authorize the current scope/source and perform exact R2 readback
 * before exposing any evidence bytes.
 */
export async function readEvidenceResolutionReceipt(
  database: D1Database,
  input: ReadEvidenceResolutionReceiptInput,
): Promise<EvidenceResolutionReceipt | null> {
  const verificationRef = assertEvidenceIdentifier(
    input.verification_receipt_ref,
    "verification receipt ref",
  );
  let expectedHandle: VersionedRef;
  try {
    expectedHandle = Object.freeze(VersionedRefSchema.parse(input.expected_handle_ref));
  } catch (cause) {
    throw new EvidenceRuntimeError(
      "EVIDENCE_INPUT_INVALID",
      "expected evidence handle ref failed strict validation",
      { cause },
    );
  }

  // Compare the opaque ref against the stored id/revision expression. Do not split on ':';
  // IdentifierSchema permits colons in receipt ids.
  const row = await database.prepare(
    "SELECT r.receipt_id, r.revision, r.handle_id, r.handle_revision, " +
    "r.source_revision_ref, r.scope_snapshot_id, r.scope_snapshot_revision, " +
    "r.authorization_receipt_ref, r.normalized_object_ref_digest, " +
    "r.source_revision_content_sha256, r.source_object_size, r.scope_snapshot_digest, " +
    "r.anchor_digest, r.excerpt_sha256, r.excerpt_byte_length, r.source_owner_generation, " +
    "r.purge_state, r.terminal_state, r.receipt_json, r.receipt_sha256, r.resolved_at, " +
    "g.verified AS guard_verified, g.identity_digest AS guard_identity_digest, " +
    "i.identity_digest AS identity_digest, i.handle_id AS identity_handle_id, " +
    "i.handle_revision AS identity_handle_revision " +
    "FROM evidence_resolution_receipt r " +
    "LEFT JOIN evidence_resolution_guard g ON " +
    "g.receipt_id = r.receipt_id AND g.receipt_revision = r.revision " +
    "AND g.handle_id = r.handle_id AND g.handle_revision = r.handle_revision " +
    "LEFT JOIN evidence_handle_identity i ON " +
    "i.handle_id = r.handle_id AND i.handle_revision = r.handle_revision " +
    "AND i.identity_digest = g.identity_digest " +
    "WHERE r.handle_id = ?1 AND r.handle_revision = ?2 " +
    "AND (r.receipt_id || ':' || CAST(r.revision AS TEXT)) = ?3 LIMIT 1",
  ).bind(expectedHandle.id, expectedHandle.revision, verificationRef).first<ResolutionRow>();
  if (row === null) return null;

  if (row.guard_verified !== 1 || typeof row.guard_identity_digest !== "string" ||
      typeof row.identity_digest !== "string" || row.identity_digest !== row.guard_identity_digest) {
    fail("stored evidence resolution receipt is not bound to a verified handle guard");
  }
  if (row.identity_handle_id !== expectedHandle.id ||
      row.identity_handle_revision !== expectedHandle.revision) {
    fail("stored evidence handle identity conflicts with the expected handle");
  }
  const identityDigest = assertEvidenceSha256(
    row.identity_digest,
    "stored evidence handle identity digest",
  );
  const handle = await loadEvidenceHandle(database, expectedHandle);
  if (handle === null) fail("stored evidence resolution handle is missing");
  if (!exactEvidenceRef(handle.handle_ref, expectedHandle)) {
    fail("stored evidence resolution handle conflicts with the expected handle");
  }
  if (await evidenceSha256(evidenceHandleIdentityPayload(handle)) !== identityDigest) {
    fail("stored evidence handle identity digest does not match the handle");
  }

  const receipt = parseReceipt(row);
  requireEqual(row.receipt_id, receipt.receipt_ref.id, "receipt id");
  requireEqual(row.revision, receipt.receipt_ref.revision, "receipt revision");
  requireEqual(evidenceRefKey(receipt.receipt_ref), verificationRef, "receipt ref");
  requireEqual(row.handle_id, receipt.handle_ref.id, "handle id");
  requireEqual(row.handle_revision, receipt.handle_ref.revision, "handle revision");
  if (!exactEvidenceRef(receipt.handle_ref, expectedHandle)) {
    fail("stored evidence resolution receipt conflicts with the expected handle");
  }
  if (receipt.source_revision_ref !== handle.source_revision_ref ||
      !exactEvidenceRef(receipt.scope_snapshot_ref, handle.scope_snapshot_ref) ||
      receipt.excerpt_sha256 !== handle.excerpt_sha256 ||
      receipt.excerpt_byte_length !== handle.excerpt_byte_length ||
      receipt.source_owner_generation !== handle.source_owner_generation) {
    fail("stored evidence resolution receipt conflicts with handle authority");
  }
  if (await evidenceSha256(handle.anchor) !== receipt.anchor_digest) {
    fail("stored evidence resolution anchor digest conflicts with the handle");
  }
  requireEqual(row.source_revision_ref, receipt.source_revision_ref, "source revision");
  requireEqual(row.scope_snapshot_id, receipt.scope_snapshot_ref.id, "scope snapshot id");
  requireEqual(row.scope_snapshot_revision, receipt.scope_snapshot_ref.revision, "scope snapshot revision");
  requireEqual(row.authorization_receipt_ref, receipt.authorization_receipt_ref, "authorization receipt");
  requireEqual(row.normalized_object_ref_digest, receipt.normalized_object_ref_digest, "normalized object digest");
  requireEqual(row.source_revision_content_sha256, receipt.source_revision_content_sha256, "source content digest");
  requireEqual(row.source_object_size, receipt.source_object_size, "source object size");
  requireEqual(row.scope_snapshot_digest, receipt.scope_snapshot_digest, "scope digest");
  requireEqual(row.anchor_digest, receipt.anchor_digest, "anchor digest");
  requireEqual(row.excerpt_sha256, receipt.excerpt_sha256, "excerpt digest");
  requireEqual(row.excerpt_byte_length, receipt.excerpt_byte_length, "excerpt byte length");
  requireEqual(row.source_owner_generation, receipt.source_owner_generation, "owner generation");
  requireEqual(row.purge_state, receipt.purge_state, "purge state");
  requireEqual(row.terminal_state, receipt.terminal_state, "terminal state");
  requireEqual(row.resolved_at, receipt.resolved_at, "resolved timestamp");
  if (await evidenceSha256(receipt) !== row.receipt_sha256) {
    fail("stored evidence resolution receipt row digest mismatch");
  }
  if (await evidenceSha256(evidenceResolutionReceiptDigestPayload(receipt)) !== receipt.receipt_digest) {
    fail("stored evidence resolution receipt payload digest mismatch");
  }
  return receipt;
}
