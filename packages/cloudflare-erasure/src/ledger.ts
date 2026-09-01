import {
  PurgeLedgerEntrySchema,
  type ErasureBlocker,
  type ErasureDependencyClosure,
  type ErasureRequest,
  type PurgeTarget,
} from "@eliotr/contracts";
import {
  erasureDigest,
  erasureFail,
  isoFromMs,
  stableErasureId,
} from "./canonical.js";

interface LedgerRow {
  readonly ledger_revision: unknown;
  readonly erasure_id: unknown;
  readonly non_revealing_subject_digest: unknown;
  readonly disposition: unknown;
  readonly receipt_ref: unknown;
  readonly created_at: unknown;
}

function positiveLedgerRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "purge ledger revision is invalid");
  }
  return value;
}

export async function appendPurgeLedger(
  database: D1Database,
  request: ErasureRequest,
  closure: ErasureDependencyClosure,
  completedTargets: readonly PurgeTarget[],
  blockers: readonly ErasureBlocker[],
  nowMs: number,
): Promise<{ readonly ledger_entry_ref: string; readonly ledger_revision: number }> {
  const disposition = blockers.length === 0 && completedTargets.length === closure.targets.length
    ? "COMPLETE"
    : "BLOCKED";
  const subjectDigest = await erasureDigest([...request.exact_subject_refs].sort());
  const receiptRef = await stableErasureId(
    "purge-ledger",
    request.erasure_ref.id,
    String(request.erasure_ref.revision),
    closure.closure_digest,
    disposition,
  );
  const now = isoFromMs(nowMs);
  let revision: number | undefined;
  try {
    const inserted = await database.prepare(
      "INSERT INTO purge_ledger(erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) " +
      "VALUES (?1,?2,?3,?4,?5) RETURNING ledger_revision",
    ).bind(request.erasure_ref.id, subjectDigest, disposition, receiptRef, now)
      .first<{ ledger_revision: unknown }>();
    if (inserted !== null) revision = positiveLedgerRevision(inserted.ledger_revision);
  } catch {
    // A replay or lost acknowledgement is resolved only through exact durable readback below.
  }
  if (revision === undefined) {
    const existing = await database.prepare(
      "SELECT ledger_revision FROM purge_ledger WHERE erasure_id=?1 AND receipt_ref=?2 " +
      "ORDER BY ledger_revision DESC LIMIT 1",
    ).bind(request.erasure_ref.id, receiptRef).first<{ ledger_revision: unknown }>();
    if (existing === null) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "purge ledger append could not be reconciled", true);
    }
    revision = positiveLedgerRevision(existing.ledger_revision);
  }
  const row = await database.prepare(
    "SELECT ledger_revision,erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at " +
    "FROM purge_ledger WHERE ledger_revision=?1 LIMIT 1",
  ).bind(revision).first<LedgerRow>();
  if (row === null) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "purge ledger entry disappeared after append", true);
  }
  const entry = PurgeLedgerEntrySchema.parse({
    protocol: "erc.privacy.erasure.v1",
    ledger_entry_ref: row.receipt_ref,
    ledger_revision: row.ledger_revision,
    erasure_ref: request.erasure_ref,
    non_revealing_subject_digest: row.non_revealing_subject_digest,
    disposition: row.disposition,
    created_at: row.created_at,
  });
  if (
    entry.ledger_entry_ref !== receiptRef ||
    entry.ledger_revision !== revision ||
    row.erasure_id !== request.erasure_ref.id ||
    entry.non_revealing_subject_digest !== subjectDigest ||
    entry.disposition !== disposition ||
    entry.created_at !== now
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "purge ledger readback differs from the exact erasure closure");
  }
  return { ledger_entry_ref: entry.ledger_entry_ref, ledger_revision: entry.ledger_revision };
}
