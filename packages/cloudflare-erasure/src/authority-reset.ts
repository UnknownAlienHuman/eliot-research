import type { ErasureFence } from "@eliotr/contracts";
import { erasureFail } from "./canonical.js";

function fencedDelete(
  database: D1Database,
  table: string,
  revisionColumn: string,
  fence: ErasureFence,
): D1PreparedStatement {
  return database.prepare(
    `DELETE FROM ${table} WHERE erasure_id=?1 AND ${revisionColumn}=?2 AND EXISTS (` +
    "SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
    "AND e.lease_owner=?3 AND e.lease_generation=?4 AND e.state='REQUESTED')",
  ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation);
}

export async function resetErasureAttempt(
  database: D1Database,
  fence: ErasureFence,
  now: string,
): Promise<void> {
  await database.batch([
    fencedDelete(database, "backup_purge_obligation", "erasure_revision", fence),
    fencedDelete(database, "erasure_dependent_invalidation", "erasure_revision", fence),
    fencedDelete(database, "erasure_stage_receipt", "erasure_revision", fence),
    fencedDelete(database, "erasure_target", "erasure_revision", fence),
    database.prepare(
      "UPDATE erasure_case SET state='REQUESTED',completed_locations_json='[]'," +
      "blocked_locations_json='[]',updated_at=?5 WHERE erasure_id=?1 AND revision=?2 AND EXISTS (" +
      "SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
      "AND e.lease_owner=?3 AND e.lease_generation=?4 AND e.state='REQUESTED')",
    ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, now),
  ]);
  const row = await database.prepare(
    "SELECT state,closure_digest FROM erasure_execution WHERE erasure_id=?1 AND revision=?2 " +
    "AND lease_owner=?3 AND lease_generation=?4 LIMIT 1",
  ).bind(fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation)
    .first<{ state: unknown; closure_digest: unknown }>();
  if (row?.state !== "REQUESTED" || row.closure_digest !== null) {
    erasureFail("ERASURE_LEASE_LOST", "erasure replay reset lost its execution fence", true);
  }
}
