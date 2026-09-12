import {
  CitationResolutionReceiptSchema,
  type CitationResolutionReceipt,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
} from "./canonical.js";
import {
  EvidenceRuntimeError,
  type CitationResolutionAttemptBinding,
  type PersistCitationResolutionInput,
} from "./types.js";

export interface CitationReceiptRow {
  readonly receipt_id: unknown;
  readonly revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly credential_generation: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly requested_handle_refs_json: unknown;
  readonly resolved_json: unknown;
  readonly rejected_json: unknown;
  readonly requested_count: unknown;
  readonly resolved_count: unknown;
  readonly all_material_citations_resolved: unknown;
  readonly receipt_json: unknown;
  readonly receipt_sha256: unknown;
  readonly created_at: unknown;
}

interface CitationGuardRow {
  readonly receipt_id: unknown;
  readonly receipt_revision: unknown;
  readonly verified: unknown;
  readonly created_at: unknown;
}

interface CitationBindingRow {
  readonly operation_id: unknown;
  readonly stage_index: unknown;
  readonly attempt_ref: unknown;
  readonly request_sha256: unknown;
  readonly receipt_id: unknown;
  readonly receipt_revision: unknown;
  readonly receipt_sha256: unknown;
  readonly bound_at: unknown;
}

export interface CitationSettlement {
  readonly receipt: CitationResolutionReceipt;
  readonly row: CitationReceiptRow;
  readonly receipt_json: string;
  readonly receipt_sha256: string;
  readonly guard: CitationGuardRow | null;
  readonly binding: CitationBindingRow | null;
}

function fail(
  code: EvidenceRuntimeError["code"],
  message: string,
  options: ConstructorParameters<typeof EvidenceRuntimeError>[2] = {},
): never {
  throw new EvidenceRuntimeError(code, message, options);
}

export function citationResolutionReceiptDigestPayload(
  receipt: CitationResolutionReceipt,
): unknown {
  const { receipt_digest: _digest, ...payload } = receipt;
  return payload;
}

function citationResolutionReceiptLogicalPayload(
  receipt: CitationResolutionReceipt,
): unknown {
  const { created_at: _createdAt, receipt_digest: _digest, ...payload } = receipt;
  return payload;
}

async function loadCitationReceiptRow(
  database: D1Database,
  receipt: CitationResolutionReceipt,
): Promise<CitationReceiptRow | null> {
  return database.prepare(
    "SELECT receipt_id, revision, scope_snapshot_id, scope_snapshot_revision, " +
    "principal_ref, client_class, credential_generation, authorization_receipt_ref, " +
    "requested_handle_refs_json, resolved_json, rejected_json, requested_count, " +
    "resolved_count, all_material_citations_resolved, receipt_json, receipt_sha256, created_at " +
    "FROM citation_resolution_receipt WHERE receipt_id = ?1 AND revision = ?2 LIMIT 1",
  ).bind(receipt.receipt_ref.id, receipt.receipt_ref.revision).first<CitationReceiptRow>();
}

async function decodeCitationReceiptRow(
  row: CitationReceiptRow,
): Promise<{ readonly receipt: CitationResolutionReceipt; readonly receipt_json: string; readonly receipt_sha256: string }> {
  const {
    receipt_id,
    revision,
    scope_snapshot_id,
    scope_snapshot_revision,
    principal_ref,
    client_class,
    credential_generation,
    authorization_receipt_ref,
    requested_handle_refs_json,
    resolved_json,
    rejected_json,
    requested_count,
    resolved_count,
    all_material_citations_resolved,
    receipt_json,
    receipt_sha256,
    created_at,
  } = row;
  if (
    typeof receipt_id !== "string" ||
    !Number.isSafeInteger(revision) ||
    typeof scope_snapshot_id !== "string" ||
    !Number.isSafeInteger(scope_snapshot_revision) ||
    typeof principal_ref !== "string" ||
    typeof client_class !== "string" ||
    typeof credential_generation !== "string" ||
    typeof authorization_receipt_ref !== "string" ||
    typeof requested_handle_refs_json !== "string" ||
    typeof resolved_json !== "string" ||
    typeof rejected_json !== "string" ||
    !Number.isSafeInteger(requested_count) ||
    !Number.isSafeInteger(resolved_count) ||
    (all_material_citations_resolved !== 0 && all_material_citations_resolved !== 1) ||
    typeof receipt_json !== "string" ||
    typeof receipt_sha256 !== "string" ||
    typeof created_at !== "string"
  ) {
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt is malformed");
  }
  let parsed: CitationResolutionReceipt;
  try {
    const raw = JSON.parse(receipt_json) as unknown;
    if (canonicalEvidenceJson(raw) !== receipt_json) {
      fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt is not canonical");
    }
    parsed = CitationResolutionReceiptSchema.parse(raw);
  } catch (cause) {
    if (cause instanceof EvidenceRuntimeError) throw cause;
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt failed decoding", { cause });
  }
  if (
    parsed.receipt_ref.id !== receipt_id ||
    parsed.receipt_ref.revision !== revision ||
    parsed.scope_snapshot_ref.id !== scope_snapshot_id ||
    parsed.scope_snapshot_ref.revision !== scope_snapshot_revision ||
    canonicalEvidenceJson(parsed.requested_handle_refs) !== requested_handle_refs_json ||
    canonicalEvidenceJson(parsed.resolved) !== resolved_json ||
    canonicalEvidenceJson(parsed.rejected) !== rejected_json ||
    parsed.requested_count !== requested_count ||
    parsed.resolved_count !== resolved_count ||
    (parsed.all_material_citations_resolved ? 1 : 0) !== all_material_citations_resolved ||
    parsed.created_at !== created_at
  ) {
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt columns disagree with JSON");
  }
  if (await evidenceSha256(citationResolutionReceiptDigestPayload(parsed)) !== parsed.receipt_digest) {
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt payload digest mismatch");
  }
  if (await evidenceSha256(parsed) !== receipt_sha256) {
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt digest mismatch");
  }
  return { receipt: parsed, receipt_json, receipt_sha256 };
}

export async function loadCitationReceipt(
  database: D1Database,
  receipt: CitationResolutionReceipt,
): Promise<CitationResolutionReceipt | null> {
  const row = await loadCitationReceiptRow(database, receipt);
  if (row === null) return null;
  return (await decodeCitationReceiptRow(row)).receipt;
}

function firstBatchRow<T>(result: D1Result<unknown> | undefined, label: string): T | null {
  if (result === undefined || result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", `${label} readback is unavailable`, { retryable: true });
  }
  return result.results.length === 0 ? null : result.results[0] as T;
}

function assertCitationGuardRow(row: CitationGuardRow, receipt: CitationResolutionReceipt): void {
  if (
    row.receipt_id !== receipt.receipt_ref.id ||
    row.receipt_revision !== receipt.receipt_ref.revision ||
    row.verified !== 1 ||
    row.created_at !== receipt.created_at
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation resolution guard is missing or unverified", {
      retryable: true,
    });
  }
}

function assertCitationBindingRow(row: CitationBindingRow): void {
  if (
    typeof row.operation_id !== "string" ||
    row.stage_index !== 15 ||
    typeof row.attempt_ref !== "string" ||
    typeof row.request_sha256 !== "string" ||
    typeof row.receipt_id !== "string" ||
    !Number.isSafeInteger(row.receipt_revision) ||
    typeof row.receipt_sha256 !== "string" ||
    typeof row.bound_at !== "string"
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation workflow binding readback is malformed", {
      retryable: true,
    });
  }
}

export async function loadCitationSettlement(
  database: D1Database,
  receipt: CitationResolutionReceipt,
  attempt: CitationResolutionAttemptBinding,
): Promise<CitationSettlement | null> {
  let results: D1Result<unknown>[];
  try {
    results = await database.batch([
      database.prepare(
        "SELECT receipt_id, revision, scope_snapshot_id, scope_snapshot_revision, " +
        "principal_ref, client_class, credential_generation, authorization_receipt_ref, " +
        "requested_handle_refs_json, resolved_json, rejected_json, requested_count, " +
        "resolved_count, all_material_citations_resolved, receipt_json, receipt_sha256, created_at " +
        "FROM citation_resolution_receipt WHERE receipt_id = ?1 AND revision = ?2 LIMIT 1",
      ).bind(receipt.receipt_ref.id, receipt.receipt_ref.revision),
      database.prepare(
        "SELECT receipt_id, receipt_revision, verified, created_at FROM citation_resolution_guard " +
        "WHERE receipt_id = ?1 AND receipt_revision = ?2 LIMIT 1",
      ).bind(receipt.receipt_ref.id, receipt.receipt_ref.revision),
      database.prepare(
        "SELECT operation_id, stage_index, attempt_ref, request_sha256, receipt_id, " +
        "receipt_revision, receipt_sha256, bound_at FROM research_workflow_citation_binding " +
        "WHERE operation_id = ?1 AND stage_index = 15 LIMIT 1",
      ).bind(attempt.operation_id),
    ]);
  } catch (cause) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation settlement readback failed", {
      retryable: true,
      cause,
    });
  }
  if (results.length !== 3) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation settlement readback is incomplete", {
      retryable: true,
    });
  }
  const receiptRow = firstBatchRow<CitationReceiptRow>(results[0], "citation receipt");
  const guardRow = firstBatchRow<CitationGuardRow>(results[1], "citation guard");
  const bindingRow = firstBatchRow<CitationBindingRow>(results[2], "citation workflow binding");
  if (receiptRow === null) {
    if (guardRow !== null || bindingRow !== null) {
      fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation settlement has orphaned rows", { retryable: true });
    }
    return null;
  }
  const decoded = await decodeCitationReceiptRow(receiptRow);
  if (guardRow !== null) assertCitationGuardRow(guardRow, decoded.receipt);
  if (bindingRow !== null) assertCitationBindingRow(bindingRow);
  return {
    receipt: decoded.receipt,
    row: receiptRow,
    receipt_json: decoded.receipt_json,
    receipt_sha256: decoded.receipt_sha256,
    guard: guardRow,
    binding: bindingRow,
  };
}

function assertCitationReceiptAccess(
  row: CitationReceiptRow,
  input: PersistCitationResolutionInput,
): void {
  if (
    row.scope_snapshot_id !== input.scope.snapshot.snapshot_id ||
    row.scope_snapshot_revision !== input.scope.snapshot.revision ||
    row.principal_ref !== input.access.principal_ref ||
    row.client_class !== input.access.client_class ||
    row.credential_generation !== input.access.credential_generation ||
    row.authorization_receipt_ref !== input.authorization.authorization_receipt_ref
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation receipt access identity differs from the current request", {
      retryable: true,
    });
  }
}

export function assertHistoricalCitationReceipt(
  settlement: CitationSettlement,
  input: PersistCitationResolutionInput,
  requested: CitationResolutionReceipt,
): void {
  assertCitationReceiptAccess(settlement.row, input);
  if (
    canonicalEvidenceJson(citationResolutionReceiptLogicalPayload(settlement.receipt)) !==
    canonicalEvidenceJson(citationResolutionReceiptLogicalPayload(requested))
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "historical citation receipt has a conflicting logical payload", {
      retryable: true,
    });
  }
  if (settlement.guard === null) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "historical citation receipt guard is missing", {
      retryable: true,
    });
  }
  assertCitationGuardRow(settlement.guard, settlement.receipt);
}

export function citationReceiptInsert(
  database: D1Database,
  receipt: CitationResolutionReceipt,
  receiptJson: string,
  receiptSha256: string,
  input: PersistCitationResolutionInput,
): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO citation_resolution_receipt(receipt_id, revision, scope_snapshot_id, " +
    "scope_snapshot_revision, principal_ref, client_class, credential_generation, " +
    "authorization_receipt_ref, requested_handle_refs_json, resolved_json, rejected_json, " +
    "requested_count, resolved_count, all_material_citations_resolved, receipt_json, " +
    "receipt_sha256, created_at) VALUES (" +
    "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17) " +
    "ON CONFLICT(receipt_id, revision) DO NOTHING",
  ).bind(
    receipt.receipt_ref.id,
    receipt.receipt_ref.revision,
    receipt.scope_snapshot_ref.id,
    receipt.scope_snapshot_ref.revision,
    input.access.principal_ref,
    input.access.client_class,
    input.access.credential_generation,
    input.authorization.authorization_receipt_ref,
    canonicalEvidenceJson(receipt.requested_handle_refs),
    canonicalEvidenceJson(receipt.resolved),
    canonicalEvidenceJson(receipt.rejected),
    receipt.requested_count,
    receipt.resolved_count,
    receipt.all_material_citations_resolved ? 1 : 0,
    receiptJson,
    receiptSha256,
    receipt.created_at,
  );
}

export function citationGuardInsert(
  database: D1Database,
  receipt: CitationResolutionReceipt,
  receiptSha256: string,
  input: PersistCitationResolutionInput,
  authorityNow: string,
): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO citation_resolution_guard(receipt_id, receipt_revision, verified, created_at) " +
    "SELECT ?1,?2,CASE WHEN " +
    "EXISTS (SELECT 1 FROM citation_resolution_receipt r WHERE r.receipt_id = ?1 " +
    "AND r.revision = ?2 AND r.scope_snapshot_id = ?3 AND r.scope_snapshot_revision = ?4 " +
    "AND r.principal_ref = ?5 AND r.client_class = ?6 AND r.credential_generation = ?7 " +
    "AND r.authorization_receipt_ref = ?8 AND r.requested_handle_refs_json = ?9 " +
    "AND r.resolved_json = ?10 AND r.rejected_json = ?11 AND r.requested_count = ?12 " +
    "AND r.resolved_count = ?13 AND r.all_material_citations_resolved = ?14 " +
    "AND r.receipt_sha256 = ?15) " +
    "AND EXISTS (SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id = ?3 AND s.revision = ?4 " +
    "AND s.snapshot_digest = ?16 AND s.invalidated_at IS NULL AND s.expires_at > ?19) " +
    "AND EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.authorization_receipt_ref = ?8 " +
    "AND g.snapshot_id = ?3 AND g.snapshot_revision = ?4 AND g.principal_ref = ?5 " +
    "AND g.client_class = ?6 AND g.credential_generation = ?7 AND g.state = 'ACTIVE' " +
    "AND g.policy_authority_ref = ?18 AND g.expires_at > ?19) " +
    "AND NOT EXISTS (SELECT 1 FROM json_each(?10) j WHERE NOT EXISTS (" +
    "SELECT 1 FROM evidence_handle h JOIN evidence_resolution_receipt er " +
    "ON er.handle_id = h.handle_id AND er.handle_revision = h.revision " +
    "WHERE h.handle_id = json_extract(j.value,'$.handle_ref.id') " +
    "AND h.revision = json_extract(j.value,'$.handle_ref.revision') " +
    "AND h.scope_snapshot_id = ?3 AND h.scope_snapshot_revision = ?4 " +
    "AND h.terminal_state = 'LIVE' " +
    "AND h.excerpt_sha256 = json_extract(j.value,'$.excerpt_sha256') " +
    "AND (er.receipt_id || ':' || er.revision) = json_extract(j.value,'$.verification_receipt_ref')" +
    ")) THEN 1 ELSE NULL END,?17 " +
    "ON CONFLICT(receipt_id, receipt_revision) DO NOTHING",
  ).bind(
    receipt.receipt_ref.id,
    receipt.receipt_ref.revision,
    receipt.scope_snapshot_ref.id,
    receipt.scope_snapshot_ref.revision,
    input.access.principal_ref,
    input.access.client_class,
    input.access.credential_generation,
    input.authorization.authorization_receipt_ref,
    canonicalEvidenceJson(receipt.requested_handle_refs),
    canonicalEvidenceJson(receipt.resolved),
    canonicalEvidenceJson(receipt.rejected),
    receipt.requested_count,
    receipt.resolved_count,
    receipt.all_material_citations_resolved ? 1 : 0,
    receiptSha256,
    input.scope.snapshot.digest,
    receipt.created_at,
    input.scope.snapshot.policy_authority_ref,
    authorityNow,
  );
}

export function citationBindingInsert(
  database: D1Database,
  receipt: CitationResolutionReceipt,
  receiptSha256: string,
  input: PersistCitationResolutionInput,
): D1PreparedStatement {
  const binding = input.attempt_binding;
  if (binding === undefined) fail("EVIDENCE_INPUT_INVALID", "citation workflow binding is missing");
  return database.prepare(
    "INSERT INTO research_workflow_citation_binding(" +
    "operation_id, stage_index, attempt_ref, request_sha256, receipt_id, " +
    "receipt_revision, receipt_sha256, bound_at) VALUES (" +
    "?1,15,?2,?3,?4,?5,?6,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).bind(
    binding.operation_id,
    binding.attempt_ref,
    binding.request_sha256,
    receipt.receipt_ref.id,
    receipt.receipt_ref.revision,
    receiptSha256,
  );
}

function assertCitationBindingMatches(
  row: CitationBindingRow,
  receipt: CitationResolutionReceipt,
  receiptSha256: string,
  input: PersistCitationResolutionInput,
): void {
  const binding = input.attempt_binding;
  if (
    binding === undefined ||
    row.operation_id !== binding.operation_id ||
    row.stage_index !== 15 ||
    row.attempt_ref !== binding.attempt_ref ||
    row.request_sha256 !== binding.request_sha256 ||
    row.receipt_id !== receipt.receipt_ref.id ||
    row.receipt_revision !== receipt.receipt_ref.revision ||
    row.receipt_sha256 !== receiptSha256
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation workflow binding differs from the current attempt", {
      retryable: true,
    });
  }
}

export function assertBoundCitationSettlement(
  settlement: CitationSettlement,
  receipt: CitationResolutionReceipt,
  receiptJson: string,
  receiptSha256: string,
  input: PersistCitationResolutionInput,
): CitationResolutionReceipt {
  assertCitationReceiptAccess(settlement.row, input);
  if (settlement.guard === null) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation guard readback is missing for a bound receipt", {
      retryable: true,
    });
  }
  if (settlement.binding === null) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation workflow binding readback is missing", {
      retryable: true,
    });
  }
  assertCitationGuardRow(settlement.guard, settlement.receipt);
  assertCitationBindingMatches(settlement.binding, receipt, receiptSha256, input);
  if (
    settlement.receipt_json !== receiptJson ||
    settlement.receipt_sha256 !== receiptSha256 ||
    canonicalEvidenceJson(settlement.receipt) !== receiptJson
  ) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "bound citation receipt readback differs from the exact receipt", {
      retryable: true,
    });
  }
  return settlement.receipt;
}
