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
  type PersistCitationResolutionInput,
} from "./types.js";

interface CitationReceiptRow {
  readonly receipt_json: unknown;
  readonly receipt_sha256: unknown;
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

async function loadCitationReceipt(
  database: D1Database,
  receipt: CitationResolutionReceipt,
): Promise<CitationResolutionReceipt | null> {
  const row = await database.prepare(
    "SELECT receipt_json, receipt_sha256 FROM citation_resolution_receipt " +
    "WHERE receipt_id = ?1 AND revision = ?2 LIMIT 1",
  ).bind(receipt.receipt_ref.id, receipt.receipt_ref.revision).first<CitationReceiptRow>();
  if (row === null) return null;
  if (typeof row.receipt_json !== "string" || typeof row.receipt_sha256 !== "string") {
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt is malformed");
  }
  let parsed: CitationResolutionReceipt;
  try {
    const raw = JSON.parse(row.receipt_json) as unknown;
    if (canonicalEvidenceJson(raw) !== row.receipt_json) {
      fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt is not canonical");
    }
    parsed = CitationResolutionReceiptSchema.parse(raw);
  } catch (cause) {
    if (cause instanceof EvidenceRuntimeError) throw cause;
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt failed decoding", { cause });
  }
  if (await evidenceSha256(parsed) !== row.receipt_sha256) {
    fail("EVIDENCE_INPUT_INVALID", "stored citation resolution receipt digest mismatch");
  }
  return parsed;
}

export async function persistCitationResolutionReceipt(
  database: D1Database,
  input: PersistCitationResolutionInput,
): Promise<CitationResolutionReceipt> {
  let receipt: CitationResolutionReceipt;
  try { receipt = CitationResolutionReceiptSchema.parse(input.receipt); }
  catch (cause) {
    fail("CITATION_SET_INVALID", "citation resolution receipt failed strict validation", { cause });
  }
  if (await evidenceSha256(citationResolutionReceiptDigestPayload(receipt)) !== receipt.receipt_digest) {
    fail("CITATION_SET_INVALID", "citation resolution receipt payload digest mismatch");
  }
  if (
    canonicalEvidenceJson(receipt) !== input.receipt_json ||
    await evidenceSha256(receipt) !== input.receipt_sha256
  ) {
    fail("CITATION_SET_INVALID", "citation resolution receipt canonical digest mismatch");
  }
  if (
    receipt.scope_snapshot_ref.id !== input.scope.snapshot.snapshot_id ||
    receipt.scope_snapshot_ref.revision !== input.scope.snapshot.revision ||
    input.authorization.authorization_receipt_ref === ""
  ) {
    fail("CITATION_SET_INVALID", "citation receipt is not bound to the authorized ScopeSnapshot");
  }
  const requestedJson = canonicalEvidenceJson(receipt.requested_handle_refs);
  const resolvedJson = canonicalEvidenceJson(receipt.resolved);
  const rejectedJson = canonicalEvidenceJson(receipt.rejected);
  try {
    await database.batch([
      database.prepare(
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
        requestedJson,
        resolvedJson,
        rejectedJson,
        receipt.requested_count,
        receipt.resolved_count,
        receipt.all_material_citations_resolved ? 1 : 0,
        input.receipt_json,
        input.receipt_sha256,
        receipt.created_at,
      ),
      database.prepare(
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
        "AND s.snapshot_digest = ?16 AND s.invalidated_at IS NULL AND s.expires_at > ?17) " +
        "AND EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.authorization_receipt_ref = ?8 " +
        "AND g.snapshot_id = ?3 AND g.snapshot_revision = ?4 AND g.principal_ref = ?5 " +
        "AND g.client_class = ?6 AND g.credential_generation = ?7 AND g.state = 'ACTIVE' " +
        "AND g.policy_authority_ref = ?18 AND g.expires_at > ?17) " +
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
        requestedJson,
        resolvedJson,
        rejectedJson,
        receipt.requested_count,
        receipt.resolved_count,
        receipt.all_material_citations_resolved ? 1 : 0,
        input.receipt_sha256,
        input.scope.snapshot.digest,
        receipt.created_at,
        input.scope.snapshot.policy_authority_ref,
      ),
    ]);
  } catch (cause) {
    const raced = await loadCitationReceipt(database, receipt);
    if (raced !== null && canonicalEvidenceJson(raced) === canonicalEvidenceJson(receipt)) return raced;
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation resolution receipt transaction failed", {
      retryable: true,
      cause,
    });
  }
  const readback = await loadCitationReceipt(database, receipt);
  if (readback === null || canonicalEvidenceJson(readback) !== canonicalEvidenceJson(receipt)) {
    fail("EVIDENCE_SETTLEMENT_UNCERTAIN", "citation resolution receipt readback mismatch", {
      retryable: true,
    });
  }
  return readback;
}
