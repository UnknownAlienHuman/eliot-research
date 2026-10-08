import type { ErasureFence } from "@eliotr/contracts";
import { erasureFail } from "./canonical.js";
import { assertErasureLocatorsRetained, retainErasureLocatorsStatement } from "./closure-locators.js";
import {
  insertPendingBackupPrimaryHandoffStatement,
  type PreviousBackupPrimaryExecution,
} from "./backup-primary-handoff.js";

function fencedDelete(
  database: D1Database,
  table: string,
  revisionColumn: string,
  fence: ErasureFence,
): D1PreparedStatement {
  return database.prepare(
    `DELETE FROM ${table} WHERE erasure_id=?1 AND ${revisionColumn}=?2 AND EXISTS (` +
    "SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
    "AND e.lease_owner=?3 AND e.lease_generation=?4 AND e.lease_until=?5 " +
    "AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) " +
    "AND e.state='REQUESTED')",
  ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, fence.lease_until_ms);
}

function resetBackupObligationsStatement(database: D1Database, fence: ErasureFence): D1PreparedStatement {
  return database.prepare(
    "DELETE FROM backup_purge_obligation WHERE erasure_id=?1 AND erasure_revision=?2 AND EXISTS (" +
      "SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
      "AND e.lease_owner=?3 AND e.lease_generation=?4 AND e.lease_until=?5 AND e.state='REQUESTED' " +
      "AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) " +
      "AND NOT EXISTS (SELECT 1 FROM backup_erasure_primary_handoff h WHERE h.erasure_id=?1 " +
        "AND h.erasure_revision=?2 AND h.current_lease_generation=?4 AND h.state='PENDING')",
  ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, fence.lease_until_ms);
}

function resetTargetsStatement(database: D1Database, fence: ErasureFence): D1PreparedStatement {
  return database.prepare(
    "DELETE FROM erasure_target WHERE erasure_id=?1 AND erasure_revision=?2 AND EXISTS (" +
      "SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
      "AND e.lease_owner=?3 AND e.lease_generation=?4 AND e.lease_until=?5 AND e.state='REQUESTED' " +
      "AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) " +
      "AND NOT (location='BackupRestorePath' AND EXISTS (SELECT 1 FROM backup_erasure_primary_handoff h " +
        "WHERE h.erasure_id=?1 AND h.erasure_revision=?2 AND h.current_lease_generation=?4 AND h.state='PENDING'))",
  ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, fence.lease_until_ms);
}

export async function resetErasureAttempt(
  database: D1Database,
  fence: ErasureFence,
  now: string,
  previous?: PreviousBackupPrimaryExecution,
): Promise<void> {
  // Preserve locations from a partially completed older attempt before its
  // transient target rows are removed. Source/raw rows may already be gone.
  await database.batch([retainErasureLocatorsStatement(database, fence, now)]);
  await assertErasureLocatorsRetained(database, fence, now);
  const handoffInsert = previous === undefined
    ? []
    : [insertPendingBackupPrimaryHandoffStatement(database, fence, previous, now)];
  await database.batch([
    ...handoffInsert,
    resetBackupObligationsStatement(database, fence),
    fencedDelete(database, "erasure_dependent_invalidation", "erasure_revision", fence),
    fencedDelete(database, "erasure_stage_receipt", "erasure_revision", fence),
    resetTargetsStatement(database, fence),
    database.prepare(
      "UPDATE erasure_case SET state='REQUESTED',completed_locations_json='[]'," +
      "blocked_locations_json='[]',updated_at=?5 WHERE erasure_id=?1 AND revision=?2 AND EXISTS (" +
      "SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
      "AND e.lease_owner=?3 AND e.lease_generation=?4 AND e.lease_until=?6 " +
      "AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) " +
      "AND e.state='REQUESTED')",
    ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, now, fence.lease_until_ms),
  ]);
  const row = await database.prepare(
    "SELECT state,closure_digest,lease_until FROM erasure_execution WHERE erasure_id=?1 AND revision=?2 " +
    "AND lease_owner=?3 AND lease_generation=?4 AND lease_until=?5 " +
    "AND lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) LIMIT 1",
  ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, fence.lease_until_ms)
    .first<{ state: unknown; closure_digest: unknown; lease_until: unknown }>();
  if (row?.state !== "REQUESTED" || row.closure_digest !== null || row.lease_until !== fence.lease_until_ms) {
    erasureFail("ERASURE_LEASE_LOST", "erasure replay reset lost its execution fence", true);
  }
}
