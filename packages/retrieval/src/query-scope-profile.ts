import { ScopeSnapshotSchema, type ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalQueryErrorCode } from "./service.js";

export interface ScopeProfileBinding {
  readonly version: string;
  readonly max_sources: number;
  readonly max_results: number;
}

interface ScopeProfileStatement {
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface ScopeProfilePrepared {
  bind(...values: unknown[]): ScopeProfileStatement;
}

interface ScopeProfileDatabase {
  prepare(sql: string): ScopeProfilePrepared;
}

interface ScopeProfileRow {
  readonly profile_version: unknown;
  readonly max_sources: unknown;
  readonly max_results: unknown;
}

interface ScopeProfileErrors {
  readonly failQuery: (code: RetrievalQueryErrorCode, message: string, retryable?: boolean) => never;
  readonly rethrowTypedQueryError: (error: unknown) => void;
  readonly mapStoreError: (error: unknown) => never;
}

async function readScopeProfileBinding(
  database: ScopeProfileDatabase,
  snapshotId: string,
  revision: number,
  errors: ScopeProfileErrors,
): Promise<ScopeProfileRow | null> {
  try {
    return await database.prepare(
      "SELECT profile_version, max_sources, max_results FROM retrieval_scope_profile " +
      "WHERE snapshot_id = ?1 AND revision = ?2 LIMIT 1",
    ).bind(snapshotId, revision).first<ScopeProfileRow>();
  } catch (error: unknown) {
    errors.rethrowTypedQueryError(error);
    errors.failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope profile readback is unavailable", true);
  }
}

function decodeScopeProfileBinding(
  row: ScopeProfileRow | null,
  failQuery: ScopeProfileErrors["failQuery"],
): ScopeProfileBinding {
  if (
    row === null || typeof row.profile_version !== "string" ||
    row.profile_version.length < 1 || row.profile_version.length > 128 ||
    typeof row.max_sources !== "number" || !Number.isSafeInteger(row.max_sources) || row.max_sources < 1 ||
    typeof row.max_results !== "number" || !Number.isSafeInteger(row.max_results) || row.max_results < 1
  ) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope profile readback is malformed", true);
  }
  return { version: row.profile_version, max_sources: row.max_sources, max_results: row.max_results };
}

async function loadScopeProfileBinding(
  database: ScopeProfileDatabase,
  snapshot: ScopeSnapshot,
  errors: ScopeProfileErrors,
): Promise<ScopeProfileBinding> {
  const parsed = ScopeSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) errors.failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
  return decodeScopeProfileBinding(
    await readScopeProfileBinding(database, parsed.data.snapshot_id, parsed.data.revision, errors),
    errors.failQuery,
  );
}

function requireBindingMatch(
  row: ScopeProfileBinding | null,
  binding: ScopeProfileBinding,
  failQuery: ScopeProfileErrors["failQuery"],
): void {
  if (row === null) failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "scope profile readback is unavailable", true);
  if (row.version !== binding.version || row.max_sources !== binding.max_sources || row.max_results !== binding.max_results) {
    failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "scope frozen under another profile version does not replay here");
  }
}

export function createScopeProfilePort(
  database: ScopeProfileDatabase,
  now: () => string,
  errors: ScopeProfileErrors,
): {
  loadBinding(snapshot: ScopeSnapshot): Promise<ScopeProfileBinding>;
  recordBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void>;
  requireBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void>;
} {
  return {
    async loadBinding(snapshot: ScopeSnapshot): Promise<ScopeProfileBinding> {
      return loadScopeProfileBinding(database, snapshot, errors);
    },
    async recordBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void> {
      const parsed = ScopeSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) errors.failQuery("RETRIEVAL_INPUT_INVALID", "scope snapshot fails strict validation");
      try {
        await database.prepare(
          "INSERT INTO retrieval_scope_profile (snapshot_id, revision, profile_version, " +
          "max_sources, max_results, created_at) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
        ).bind(
          parsed.data.snapshot_id, parsed.data.revision,
          binding.version, binding.max_sources, binding.max_results, now(),
        ).run();
      } catch (error: unknown) {
        errors.mapStoreError(error);
      }
      requireBindingMatch(await loadScopeProfileBinding(database, parsed.data, errors), binding, errors.failQuery);
    },
    async requireBinding(snapshot: ScopeSnapshot, binding: ScopeProfileBinding): Promise<void> {
      requireBindingMatch(await loadScopeProfileBinding(database, snapshot, errors), binding, errors.failQuery);
    },
  };
}
