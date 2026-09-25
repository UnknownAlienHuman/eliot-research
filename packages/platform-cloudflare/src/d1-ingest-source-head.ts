import { authorityFail, authorityIdentifier, type ExistingSourceRow, type normalizePrepareInput } from "./d1-ingest-validation.js";

export async function existingSource(
  database: D1Database,
  sourceId: string,
): Promise<ExistingSourceRow | null> {
  return database.prepare(
    "SELECT source_id, source_namespace_id, source_owner_system_id, " +
    "source_owner_generation, ownership_mode, head_rev FROM source WHERE source_id = ?1 LIMIT 1",
  ).bind(sourceId).first<ExistingSourceRow>();
}

interface RawCaptureHeadBindingRow {
  readonly state: unknown;
  readonly principal_ref: unknown;
  readonly owner_system_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_generation: unknown;
  readonly source_revision_ref: unknown;
  readonly source_logical_id: unknown;
  readonly target_source_id: unknown;
  readonly expected_head_revision_ref: unknown;
}

export async function rawCaptureExpectedHead(
  database: D1Database,
  input: Awaited<ReturnType<typeof normalizePrepareInput>>,
  source: ExistingSourceRow | null,
  requireCurrentHead = true,
): Promise<string | null> {
  let result: D1Result<RawCaptureHeadBindingRow>;
  try {
    result = await database.prepare(
      "SELECT state,principal_ref,owner_system_id,source_namespace_id,source_owner_generation," +
      "source_revision_ref,source_logical_id,target_source_id,expected_head_revision_ref " +
      "FROM raw_file_capture WHERE source_revision_ref=?1 LIMIT 2",
    ).bind(input.manifest.origin.source_revision_ref).all<RawCaptureHeadBindingRow>();
  } catch (cause) {
    authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "raw capture source-head binding read failed", true, cause);
  }
  const rows = result.results ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) authorityFail("INGEST_AUTHORITY_CONFLICT", "source revision is bound to multiple raw captures");
  const row = rows[0];
  if (row === undefined || row.state !== "CAPTURED") {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "raw capture source-head binding is not settled");
  }
  if (row.principal_ref !== input.principal_ref || row.owner_system_id !== input.manifest.origin.owner_system_id ||
      row.source_namespace_id !== input.manifest.origin.source_namespace_id ||
      row.source_owner_generation !== input.manifest.origin.source_owner_generation ||
      row.source_revision_ref !== input.manifest.origin.source_revision_ref ||
      row.source_logical_id !== input.manifest.source.logical_id) {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "raw capture binding does not match the normalized source");
  }
  const target = row.target_source_id;
  const expected = row.expected_head_revision_ref;
  if (target === null && expected === null) return null;
  if (typeof target !== "string" || typeof expected !== "string") {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "raw capture source-head binding is incomplete");
  }
  if (target !== input.manifest.source.logical_id || source === null || source.source_id !== target ||
      (requireCurrentHead && source.head_rev !== expected)) {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "raw capture expected source head is stale");
  }
  return authorityIdentifier(expected, "expected raw source head");
}

export function ensureExistingSource(
  row: ExistingSourceRow | null,
  input: Awaited<ReturnType<typeof normalizePrepareInput>>,
): string | null {
  if (row === null) return null;
  const manifest = input.manifest;
  if (
    row.source_id !== manifest.source.logical_id ||
    row.source_namespace_id !== manifest.origin.source_namespace_id ||
    row.source_owner_system_id !== manifest.origin.owner_system_id ||
    row.source_owner_generation !== manifest.origin.source_owner_generation ||
    row.ownership_mode !== manifest.origin.ownership_mode
  ) {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "source identity is already bound to another lineage");
  }
  if (row.head_rev !== null && typeof row.head_rev !== "string") {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "source head authority is malformed");
  }
  return row.head_rev as string | null;
}
