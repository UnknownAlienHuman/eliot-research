import {
  EvidenceHandleSchema,
  EvidenceResolutionReceiptSchema,
  type EvidenceHandle,
  type EvidenceHandleTerminalState,
  type EvidenceResolutionReceipt,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  exactEvidenceRef,
  stableEvidenceId,
} from "./canonical.js";
import { loadEvidenceHandle } from "./authority-load.js";
import {
  EvidenceRuntimeError,
  type PersistEvidenceResolutionInput,
} from "./types.js";

interface ReceiptRow {
  readonly receipt_json: unknown;
  readonly receipt_sha256: unknown;
}

interface IdentityRow {
  readonly handle_id: unknown;
  readonly handle_revision: unknown;
}

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

export function evidenceHandleIdentityPayload(handle: EvidenceHandle): unknown {
  return {
    source_namespace_id: handle.source_namespace_id,
    source_owner_generation: handle.source_owner_generation,
    source_revision_ref: handle.source_revision_ref,
    scope_snapshot_ref: handle.scope_snapshot_ref,
    anchor: handle.anchor,
    excerpt_sha256: handle.excerpt_sha256,
    excerpt_byte_length: handle.excerpt_byte_length,
    coordinate_map_ref: handle.coordinate_map_ref ?? null,
    loss_map_ref: handle.loss_map_ref ?? null,
    object_residency_key_digest: handle.object_residency_key_digest,
    source_assurance_ceiling: handle.source_assurance_ceiling,
    materializer_assurance_ceiling: handle.materializer_assurance_ceiling,
    expires_at: handle.expires_at ?? null,
  };
}

export function evidenceResolutionReceiptDigestPayload(receipt: EvidenceResolutionReceipt): unknown {
  const { receipt_digest: _digest, ...payload } = receipt;
  return payload;
}

function sameHandleIdentity(left: EvidenceHandle, right: EvidenceHandle): boolean {
  return canonicalEvidenceJson(evidenceHandleIdentityPayload(left)) ===
    canonicalEvidenceJson(evidenceHandleIdentityPayload(right));
}

async function loadReceipt(
  database: D1Database,
  receipt: EvidenceResolutionReceipt,
): Promise<EvidenceResolutionReceipt | null> {
  const row = await database.prepare(
    "SELECT receipt_json, receipt_sha256 FROM evidence_resolution_receipt " +
    "WHERE receipt_id = ?1 AND revision = ?2 LIMIT 1",
  ).bind(receipt.receipt_ref.id, receipt.receipt_ref.revision).first<ReceiptRow>();
  if (row === null) return null;
  if (typeof row.receipt_json !== "string" || typeof row.receipt_sha256 !== "string") {
    fail("EVIDENCE_INPUT_INVALID", "stored evidence resolution receipt is malformed");
  }
  let parsed: EvidenceResolutionReceipt;
  try {
    const raw = JSON.parse(row.receipt_json) as unknown;
    if (canonicalEvidenceJson(raw) !== row.receipt_json) {
      fail("EVIDENCE_INPUT_INVALID", "stored evidence resolution receipt is not canonical");
    }
    parsed = EvidenceResolutionReceiptSchema.parse(raw);
  } catch (cause) {
    if (cause instanceof EvidenceRuntimeError) throw cause;
    fail("EVIDENCE_INPUT_INVALID", "stored evidence resolution receipt failed decoding", { cause });
  }
  if (await evidenceSha256(parsed) !== row.receipt_sha256) {
    fail("EVIDENCE_INPUT_INVALID", "stored evidence resolution receipt digest mismatch");
  }
  return parsed;
}

async function exactExistingHandle(
  database: D1Database,
  identityDigest: string,
  proposed: EvidenceHandle,
): Promise<EvidenceHandle | null> {
  const identity = await database.prepare(
    "SELECT handle_id, handle_revision FROM evidence_handle_identity " +
    "WHERE identity_digest = ?1 LIMIT 1",
  ).bind(identityDigest).first<IdentityRow>();
  if (identity === null) return null;
  if (typeof identity.handle_id !== "string" || typeof identity.handle_revision !== "number") {
    fail("EVIDENCE_INPUT_INVALID", "stored evidence handle identity is malformed");
  }
  const handle = await loadEvidenceHandle(database, {
    id: identity.handle_id,
    revision: identity.handle_revision,
  });
  if (handle === null || !sameHandleIdentity(handle, proposed)) {
    fail("EVIDENCE_IDENTITY_CONFLICT", "evidence identity is bound to another handle authority");
  }
  return handle;
}

function bindHandleInsert(database: D1Database, handle: EvidenceHandle): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO evidence_handle(handle_id, revision, source_namespace_id, " +
    "source_owner_generation, source_revision_ref, scope_snapshot_id, scope_snapshot_revision, " +
    "anchor_json, excerpt_sha256, excerpt_byte_length, coordinate_map_ref, loss_map_ref, " +
    "object_residency_key_digest, source_assurance_ceiling, materializer_assurance_ceiling, " +
    "terminal_state, invalidation_ref, created_at, expires_at) VALUES (" +
    "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'LIVE',NULL,?16,?17) " +
    "ON CONFLICT(handle_id, revision) DO NOTHING",
  ).bind(
    handle.handle_ref.id,
    handle.handle_ref.revision,
    handle.source_namespace_id,
    handle.source_owner_generation,
    handle.source_revision_ref,
    handle.scope_snapshot_ref.id,
    handle.scope_snapshot_ref.revision,
    canonicalEvidenceJson(handle.anchor),
    handle.excerpt_sha256,
    handle.excerpt_byte_length,
    handle.coordinate_map_ref ?? null,
    handle.loss_map_ref ?? null,
    handle.object_residency_key_digest,
    handle.source_assurance_ceiling,
    handle.materializer_assurance_ceiling,
    handle.created_at,
    handle.expires_at ?? null,
  );
}

function bindReceiptInsert(
  database: D1Database,
  input: PersistEvidenceResolutionInput,
  handle: EvidenceHandle,
): D1PreparedStatement {
  const receipt = input.resolution_receipt;
  return database.prepare(
    "INSERT INTO evidence_resolution_receipt(receipt_id, revision, handle_id, handle_revision, " +
    "source_revision_ref, scope_snapshot_id, scope_snapshot_revision, authorization_receipt_ref, " +
    "normalized_object_ref, normalized_object_ref_digest, source_revision_content_sha256, " +
    "source_object_size, scope_snapshot_digest, anchor_digest, excerpt_sha256, " +
    "excerpt_byte_length, source_owner_generation, purge_state, terminal_state, receipt_json, " +
    "receipt_sha256, resolved_at) VALUES (" +
    "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'LIVE','LIVE',?18,?19,?20) " +
    "ON CONFLICT(receipt_id, revision) DO NOTHING",
  ).bind(
    receipt.receipt_ref.id,
    receipt.receipt_ref.revision,
    handle.handle_ref.id,
    handle.handle_ref.revision,
    receipt.source_revision_ref,
    receipt.scope_snapshot_ref.id,
    receipt.scope_snapshot_ref.revision,
    receipt.authorization_receipt_ref,
    input.normalized_object_ref,
    receipt.normalized_object_ref_digest,
    receipt.source_revision_content_sha256,
    receipt.source_object_size,
    receipt.scope_snapshot_digest,
    receipt.anchor_digest,
    receipt.excerpt_sha256,
    receipt.excerpt_byte_length,
    receipt.source_owner_generation,
    input.resolution_receipt_json,
    input.resolution_receipt_sha256,
    receipt.resolved_at,
  );
}

function bindGuardInsert(
  database: D1Database,
  input: PersistEvidenceResolutionInput,
  handle: EvidenceHandle,
): D1PreparedStatement {
  const receipt = input.resolution_receipt;
  return database.prepare(
    "INSERT INTO evidence_resolution_guard(handle_id, handle_revision, receipt_id, receipt_revision, " +
    "identity_digest, verified, created_at) SELECT ?1,?2,?3,?4,?5,CASE WHEN " +
    "EXISTS (SELECT 1 FROM evidence_handle h WHERE h.handle_id = ?1 AND h.revision = ?2 " +
    "AND h.source_namespace_id = ?7 AND h.source_owner_generation = ?8 " +
    "AND h.source_revision_ref = ?9 AND h.scope_snapshot_id = ?10 " +
    "AND h.scope_snapshot_revision = ?11 AND h.anchor_json = ?12 " +
    "AND h.excerpt_sha256 = ?13 AND h.excerpt_byte_length = ?14 " +
    "AND h.object_residency_key_digest = ?15 AND h.terminal_state = 'LIVE') " +
    "AND EXISTS (SELECT 1 FROM evidence_handle_identity i WHERE i.identity_digest = ?5 " +
    "AND i.handle_id = ?1 AND i.handle_revision = ?2) " +
    "AND EXISTS (SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id = ?10 AND s.revision = ?11 " +
    "AND s.snapshot_digest = ?16 AND s.invalidated_at IS NULL AND s.expires_at > ?6) " +
    "AND EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.authorization_receipt_ref = ?17 " +
    "AND g.snapshot_id = ?10 AND g.snapshot_revision = ?11 AND g.principal_ref = ?18 " +
    "AND g.client_class = ?19 AND g.credential_generation = ?20 AND g.state = 'ACTIVE' " +
    "AND g.policy_authority_ref = ?21 AND g.expires_at > ?6) " +
    "AND EXISTS (SELECT 1 FROM source_revision sr JOIN source src ON src.source_id = sr.source_id " +
    "JOIN source_namespace_ownership o ON o.source_namespace_id = src.source_namespace_id " +
    "AND o.owner_system_id = src.source_owner_system_id " +
    "AND o.source_owner_generation = sr.source_owner_generation AND o.status = 'ACTIVE' " +
    "WHERE sr.source_revision_ref = ?9 AND src.source_namespace_id = ?7 " +
    "AND sr.source_owner_generation = ?8 AND sr.content_sha256 = ?22 " +
    "AND sr.object_residency_key_digest = ?15 AND sr.purge_state = 'LIVE') " +
    "AND EXISTS (SELECT 1 FROM source_admission_decision d WHERE d.source_revision_ref = ?9 " +
    "AND d.decision_receipt_ref = ?23 AND d.decision = 'ADMITTED' " +
    "AND d.source_owner_generation = ?8 AND d.object_residency_key_digest = ?15 " +
    "AND (d.expires_at IS NULL OR d.expires_at > ?6)) " +
    "AND EXISTS (SELECT 1 FROM evidence_resolution_receipt r WHERE r.receipt_id = ?3 " +
    "AND r.revision = ?4 AND r.handle_id = ?1 AND r.handle_revision = ?2 " +
    "AND r.source_revision_ref = ?9 AND r.scope_snapshot_digest = ?16 " +
    "AND r.authorization_receipt_ref = ?17 AND r.source_revision_content_sha256 = ?22 " +
    "AND r.excerpt_sha256 = ?13 AND r.excerpt_byte_length = ?14 " +
    "AND r.receipt_sha256 = ?24 AND r.terminal_state = 'LIVE') " +
    "THEN 1 ELSE NULL END,?6 ON CONFLICT(handle_id,handle_revision,receipt_id,receipt_revision) " +
    "DO NOTHING",
  ).bind(
    handle.handle_ref.id,
    handle.handle_ref.revision,
    receipt.receipt_ref.id,
    receipt.receipt_ref.revision,
    input.identity_digest,
    receipt.resolved_at,
    handle.source_namespace_id,
    handle.source_owner_generation,
    handle.source_revision_ref,
    handle.scope_snapshot_ref.id,
    handle.scope_snapshot_ref.revision,
    canonicalEvidenceJson(handle.anchor),
    handle.excerpt_sha256,
    handle.excerpt_byte_length,
    handle.object_residency_key_digest,
    receipt.scope_snapshot_digest,
    input.authorization.authorization_receipt_ref,
    input.access.principal_ref,
    input.access.client_class,
    input.access.credential_generation,
    input.scope.snapshot.policy_authority_ref,
    input.source.content_sha256,
    input.source.admission_receipt_ref,
    input.resolution_receipt_sha256,
  );
}

export async function persistEvidenceResolution(
  database: D1Database,
  input: PersistEvidenceResolutionInput,
): Promise<{ readonly handle: EvidenceHandle; readonly receipt: EvidenceResolutionReceipt }> {
  let proposed: EvidenceHandle;
  let receipt: EvidenceResolutionReceipt;
  try {
    proposed = EvidenceHandleSchema.parse(input.proposed_handle);
    receipt = EvidenceResolutionReceiptSchema.parse(input.resolution_receipt);
  } catch (cause) {
    fail("EVIDENCE_INPUT_INVALID", "proposed evidence authority failed strict validation", { cause });
  }
  if (await evidenceSha256(evidenceHandleIdentityPayload(proposed)) !== input.identity_digest) {
    fail("EVIDENCE_INPUT_INVALID", "evidence identity digest mismatch");
  }
  if (await evidenceSha256(evidenceResolutionReceiptDigestPayload(receipt)) !== receipt.receipt_digest) {
    fail("EVIDENCE_INPUT_INVALID", "evidence resolution receipt payload digest mismatch");
  }
  if (
    canonicalEvidenceJson(receipt) !== input.resolution_receipt_json ||
    await evidenceSha256(receipt) !== input.resolution_receipt_sha256
  ) {
    fail("EVIDENCE_INPUT_INVALID", "evidence resolution receipt canonical digest mismatch");
  }
  if (
    !exactEvidenceRef(receipt.handle_ref, proposed.handle_ref) ||
    receipt.source_revision_ref !== proposed.source_revision_ref ||
    !exactEvidenceRef(receipt.scope_snapshot_ref, proposed.scope_snapshot_ref) ||
    receipt.excerpt_sha256 !== proposed.excerpt_sha256 ||
    receipt.excerpt_byte_length !== proposed.excerpt_byte_length
  ) {
    fail("EVIDENCE_INPUT_INVALID", "resolution receipt is not bound to the proposed handle");
  }

  const existing = await exactExistingHandle(database, input.identity_digest, proposed);
  const handle = existing ?? proposed;
  try {
    await database.batch([
      bindHandleInsert(database, handle),
      database.prepare(
        "INSERT INTO evidence_handle_identity(identity_digest, handle_id, handle_revision, created_at) " +
        "VALUES (?1,?2,?3,?4) ON CONFLICT(identity_digest) DO NOTHING",
      ).bind(input.identity_digest, handle.handle_ref.id, handle.handle_ref.revision, handle.created_at),
      bindReceiptInsert(database, input, handle),
      bindGuardInsert(database, input, handle),
    ]);
  } catch (cause) {
    const racedHandle = await exactExistingHandle(database, input.identity_digest, proposed);
    const racedReceipt = await loadReceipt(database, receipt);
    if (racedHandle !== null && racedReceipt !== null) {
      return { handle: racedHandle, receipt: racedReceipt };
    }
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "evidence handle/receipt transaction failed", {
      retryable: true,
      cause,
    });
  }
  const readbackHandle = await exactExistingHandle(database, input.identity_digest, proposed);
  const readbackReceipt = await loadReceipt(database, receipt);
  if (readbackHandle === null || readbackReceipt === null) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "evidence handle/receipt readback is missing", {
      retryable: true,
    });
  }
  if (
    !sameHandleIdentity(readbackHandle, proposed) ||
    canonicalEvidenceJson(readbackReceipt) !== canonicalEvidenceJson(receipt)
  ) {
    fail("EVIDENCE_IDENTITY_CONFLICT", "evidence handle/receipt readback differs from exact input");
  }
  return { handle: readbackHandle, receipt: readbackReceipt };
}

export async function invalidateEvidenceHandle(
  database: D1Database,
  handle: EvidenceHandle,
  state: Exclude<EvidenceHandleTerminalState, "LIVE">,
  reasonCode: string,
  observedAt: string,
): Promise<EvidenceHandle> {
  const invalidationRef = await stableEvidenceId(
    "evidence-invalidation",
    handle.handle_ref.id,
    String(handle.handle_ref.revision),
    state,
    reasonCode,
  );
  try {
    await database.batch([
      database.prepare(
        "INSERT INTO evidence_handle_invalidation(invalidation_ref, handle_id, handle_revision, " +
        "terminal_state, reason_code, observed_at) VALUES (?1,?2,?3,?4,?5,?6) " +
        "ON CONFLICT(invalidation_ref) DO NOTHING",
      ).bind(
        invalidationRef,
        handle.handle_ref.id,
        handle.handle_ref.revision,
        state,
        reasonCode,
        observedAt,
      ),
      database.prepare(
        "UPDATE evidence_handle SET terminal_state = ?3, invalidation_ref = ?4 " +
        "WHERE handle_id = ?1 AND revision = ?2 " +
        "AND (terminal_state = 'LIVE' OR (terminal_state = ?3 AND invalidation_ref = ?4))",
      ).bind(handle.handle_ref.id, handle.handle_ref.revision, state, invalidationRef),
    ]);
  } catch (cause) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "evidence invalidation settlement failed", {
      retryable: true,
      cause,
    });
  }
  const readback = await loadEvidenceHandle(database, handle.handle_ref);
  if (
    readback === null ||
    readback.terminal_state !== state ||
    readback.invalidation_ref !== invalidationRef
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "evidence invalidation readback mismatch", {
      retryable: true,
    });
  }
  return readback;
}
