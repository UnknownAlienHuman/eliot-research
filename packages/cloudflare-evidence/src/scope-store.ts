import type { ScopeSnapshot } from "@eliotr/contracts";
import type { ScopeSnapshotPersistence } from "@eliotr/domain";
import {
  SCOPE_COLUMNS, canonicalScopeStorageJson, decodeStoredScopeRow, scopePersistenceFailure,
  scopeStorageValues, validateScopeStorageRef, validateStoredScope, type StoredScopeRecord,
} from "./scope-codec.js";

export { ScopePersistenceError } from "./scope-codec.js";
export type { StoredScopeRecord } from "./scope-codec.js";

// Using the database binding directly keeps authority reads on D1's primary.
export async function readD1ScopeSnapshot(
  database: D1Database, snapshotId: string, revision: number,
): Promise<StoredScopeRecord | null> {
  validateScopeStorageRef(snapshotId, revision);
  const row = await database.prepare(
    `SELECT ${SCOPE_COLUMNS} FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2 LIMIT 1`,
  ).bind(snapshotId, revision).first<Record<string, unknown>>();
  if (row === null) return null;
  const result = await decodeStoredScopeRow(row);
  if (result.snapshot.snapshot_id !== snapshotId || result.snapshot.revision !== revision) {
    scopePersistenceFailure("SCOPE_STORAGE_READBACK_MISMATCH");
  }
  return result;
}

export function createD1ScopeSnapshotStore(database: D1Database): ScopeSnapshotPersistence {
  const read = (scope: ScopeSnapshot) => readD1ScopeSnapshot(database, scope.snapshot_id, scope.revision);
  const matches = (record: StoredScopeRecord | null, scope: ScopeSnapshot): boolean =>
    record !== null && record.invalidated_at === null &&
    canonicalScopeStorageJson(record.snapshot) === canonicalScopeStorageJson(scope);
  return {
    async readSnapshot(id, revision) {
      const record = await readD1ScopeSnapshot(database, id, revision);
      // Invalidated snapshots are never revived by a replay or handed to requireCurrent.
      return record === null || record.invalidated_at !== null ? null : record.snapshot;
    },
    async persistSnapshot(value) {
      const scope = await validateStoredScope(value);
      const prior = await read(scope);
      if (prior !== null) return matches(prior, scope) ? "REPLAY" : "CONFLICT";
      let inserted: { snapshot_id: string } | null;
      try {
        inserted = await database.prepare(
          `INSERT INTO scope_snapshot (${SCOPE_COLUMNS}) ` +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15) " +
          "ON CONFLICT DO NOTHING RETURNING snapshot_id",
        ).bind(...scopeStorageValues(scope)).first<{ snapshot_id: string }>();
      } catch {
        // Lost ACK is uncertain. Reconcile against exact durable bytes, never assume rollback/success.
        const settled = await read(scope);
        if (matches(settled, scope)) return "REPLAY";
        if (settled !== null) return "CONFLICT";
        scopePersistenceFailure("SCOPE_STORAGE_SETTLEMENT_UNCERTAIN");
      }
      const settled = await read(scope);
      if (!matches(settled, scope)) {
        if (settled !== null) return "CONFLICT";
        scopePersistenceFailure("SCOPE_STORAGE_READBACK_MISMATCH");
      }
      if (inserted !== null && inserted.snapshot_id !== scope.snapshot_id) {
        scopePersistenceFailure("SCOPE_STORAGE_READBACK_MISMATCH");
      }
      return inserted === null ? "REPLAY" : "CREATED";
    },
  };
}
