import { erasureFail } from "./canonical.js";

export interface RawIngestMemberBatchContext {
  readonly source_revision_ref: string;
  readonly guard_predicate: string;
  readonly guard_values: readonly unknown[];
}

type CountRow = { readonly count: unknown };

async function count(
  database: D1Database,
  sql: string,
  sourceRevisionRef: string,
  label: string,
): Promise<number> {
  let row: CountRow | null;
  try {
    row = await database.prepare(sql).bind(sourceRevisionRef).first<CountRow>();
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} is unavailable`, true, cause);
  }
  if (row === null || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} returned a malformed count`, true);
  }
  return row.count;
}

/**
 * Refuses to operate on a raw graph whose persisted links cross the selected
 * source revision, owner, or operation chain.  This runs before any effect;
 * it is deliberately conservative when an orphan cannot be identified.
 */
export async function assertRawIngestGraph(
  database: D1Database,
  sourceRevisionRef: string,
): Promise<void> {
  const [conversionOwner, admissionGraph, referencedConversion, bindingGraph, foreignConversionBinding, foreignAdmissionBinding] =
    await Promise.all([
      count(
        database,
        "SELECT COUNT(*) AS count FROM raw_markdown_conversion m " +
          "JOIN raw_file_capture c ON c.capture_id=m.capture_id " +
          "WHERE c.source_revision_ref=?1 AND m.principal_ref IS NOT c.principal_ref",
        sourceRevisionRef,
        "raw conversion graph validation",
      ),
      count(
        database,
        "SELECT COUNT(*) AS count FROM raw_normalized_admission a WHERE a.source_revision_ref=?1 " +
          "AND (NOT EXISTS (SELECT 1 FROM raw_file_capture c WHERE c.capture_id=a.capture_id " +
          "AND c.source_revision_ref=?1 AND c.principal_ref=a.principal_ref) " +
          "OR NOT EXISTS (SELECT 1 FROM raw_markdown_conversion m WHERE m.operation_id=a.conversion_operation_id " +
          "AND m.capture_id=a.capture_id AND m.principal_ref=a.principal_ref))",
        sourceRevisionRef,
        "raw admission graph validation",
      ),
      count(
        database,
        "SELECT COUNT(*) AS count FROM raw_markdown_conversion m " +
          "WHERE m.operation_id IN (SELECT a.conversion_operation_id FROM raw_normalized_admission a " +
          "WHERE a.source_revision_ref=?1) AND NOT EXISTS (SELECT 1 FROM raw_file_capture c " +
          "WHERE c.capture_id=m.capture_id AND c.source_revision_ref=?1)",
        sourceRevisionRef,
        "raw referenced conversion validation",
      ),
      count(
        database,
        "SELECT COUNT(*) AS count FROM workspace_mcp_raw_normalized_admission b " +
          "JOIN raw_file_capture c ON c.capture_id=b.capture_id AND c.source_revision_ref=?1 " +
          "WHERE b.principal_ref IS NOT c.principal_ref " +
          "OR NOT EXISTS (SELECT 1 FROM raw_markdown_conversion m WHERE m.operation_id=b.conversion_operation_id " +
          "AND m.capture_id=b.capture_id AND m.principal_ref=b.principal_ref) " +
          "OR (b.state='BOUND' AND NOT EXISTS (SELECT 1 FROM raw_normalized_admission a " +
          "WHERE a.admission_operation_id=b.admission_operation_id AND a.source_revision_ref=?1 " +
          "AND a.capture_id=b.capture_id AND a.conversion_operation_id=b.conversion_operation_id " +
          "AND a.principal_ref=b.principal_ref))",
        sourceRevisionRef,
        "raw workspace graph validation",
      ),
      count(
        database,
        "SELECT COUNT(*) AS count FROM workspace_mcp_raw_normalized_admission b " +
          "WHERE b.conversion_operation_id IN (SELECT m.operation_id FROM raw_markdown_conversion m " +
          "JOIN raw_file_capture c ON c.capture_id=m.capture_id AND c.source_revision_ref=?1) " +
          "AND NOT EXISTS (SELECT 1 FROM raw_file_capture c WHERE c.capture_id=b.capture_id " +
          "AND c.source_revision_ref=?1)",
        sourceRevisionRef,
        "raw foreign conversion binding validation",
      ),
      count(
        database,
        "SELECT COUNT(*) AS count FROM workspace_mcp_raw_normalized_admission b " +
          "WHERE b.admission_operation_id IN (SELECT a.admission_operation_id FROM raw_normalized_admission a " +
          "WHERE a.source_revision_ref=?1) AND NOT EXISTS (SELECT 1 FROM raw_file_capture c " +
          "WHERE c.capture_id=b.capture_id AND c.source_revision_ref=?1)",
        sourceRevisionRef,
        "raw foreign admission binding validation",
      ),
    ]);
  if (conversionOwner + admissionGraph + referencedConversion + bindingGraph + foreignConversionBinding + foreignAdmissionBinding > 0) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest dependency graph crosses the selected source revision");
  }
}

function memberInsertStatements(
  database: D1Database,
  context: RawIngestMemberBatchContext,
): readonly D1PreparedStatement[] {
  const { guard_predicate: guard, guard_values: values } = context;
  return [
    database.prepare(
      "INSERT INTO raw_ingest_erasure_member(source_revision_ref,member_kind,member_id) " +
        "SELECT ?1,'CAPTURE',c.capture_id FROM raw_file_capture c " +
        "WHERE c.source_revision_ref=?1 AND " + guard +
        " ON CONFLICT(source_revision_ref,member_kind,member_id) DO NOTHING",
    ).bind(...values),
    database.prepare(
      "INSERT INTO raw_ingest_erasure_member(source_revision_ref,member_kind,member_id) " +
        "SELECT ?1,'CONVERSION',m.operation_id FROM raw_markdown_conversion m " +
        "JOIN raw_file_capture c ON c.capture_id=m.capture_id AND c.source_revision_ref=?1 " +
        "WHERE m.principal_ref=c.principal_ref AND " + guard +
        " ON CONFLICT(source_revision_ref,member_kind,member_id) DO NOTHING",
    ).bind(...values),
    database.prepare(
      "INSERT INTO raw_ingest_erasure_member(source_revision_ref,member_kind,member_id) " +
        "SELECT ?1,'ADMISSION',a.admission_operation_id FROM raw_normalized_admission a " +
        "JOIN raw_file_capture c ON c.capture_id=a.capture_id AND c.source_revision_ref=?1 " +
        "JOIN raw_markdown_conversion m ON m.operation_id=a.conversion_operation_id " +
        "AND m.capture_id=a.capture_id AND m.principal_ref=a.principal_ref " +
        "WHERE a.source_revision_ref=?1 AND a.principal_ref=c.principal_ref AND " + guard +
        " ON CONFLICT(source_revision_ref,member_kind,member_id) DO NOTHING",
    ).bind(...values),
    database.prepare(
      "INSERT INTO raw_ingest_erasure_member(source_revision_ref,member_kind,member_id) " +
        "SELECT ?1,'WORKSPACE_BINDING',b.binding_id FROM workspace_mcp_raw_normalized_admission b " +
        "JOIN raw_file_capture c ON c.capture_id=b.capture_id AND c.source_revision_ref=?1 " +
        "JOIN raw_markdown_conversion m ON m.operation_id=b.conversion_operation_id " +
        "AND m.capture_id=b.capture_id AND m.principal_ref=b.principal_ref " +
        "LEFT JOIN raw_normalized_admission a ON a.admission_operation_id=b.admission_operation_id " +
        "WHERE b.principal_ref=c.principal_ref AND (b.state='RESERVED' OR (" +
        "a.source_revision_ref=?1 AND a.capture_id=b.capture_id " +
        "AND a.conversion_operation_id=b.conversion_operation_id AND a.principal_ref=b.principal_ref)) " +
        "AND " + guard +
        " ON CONFLICT(source_revision_ref,member_kind,member_id) DO NOTHING",
    ).bind(...values),
  ];
}

function memberDeleteStatements(
  database: D1Database,
  context: RawIngestMemberBatchContext,
): readonly D1PreparedStatement[] {
  const { guard_predicate: guard, guard_values: values } = context;
  const captures = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='CAPTURE'";
  const conversions = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='CONVERSION'";
  const admissions = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='ADMISSION'";
  const bindings = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='WORKSPACE_BINDING'";
  return [
    database.prepare(
      "DELETE FROM workspace_mcp_raw_normalized_admission WHERE binding_id IN (" + bindings + ") " +
        "AND capture_id IN (" + captures + ") AND " + guard,
    ).bind(...values),
    database.prepare(
      "DELETE FROM raw_markdown_conversion WHERE operation_id IN (" + conversions + ") " +
        "AND capture_id IN (" + captures + ") AND " + guard,
    ).bind(...values),
    database.prepare(
      "DELETE FROM raw_normalized_admission WHERE admission_operation_id IN (" + admissions + ") " +
        "AND source_revision_ref=?1 AND capture_id IN (" + captures + ") " +
        "AND conversion_operation_id IN (" + conversions + ") AND " + guard,
    ).bind(...values),
    database.prepare(
      "DELETE FROM raw_file_capture WHERE capture_id IN (" + captures + ") " +
        "AND source_revision_ref=?1 AND " + guard,
    ).bind(...values),
  ];
}

export function rawIngestMemberInsertStatements(
  database: D1Database,
  context: RawIngestMemberBatchContext,
): readonly D1PreparedStatement[] {
  return memberInsertStatements(database, context);
}

export function rawIngestMemberDeleteStatements(
  database: D1Database,
  context: RawIngestMemberBatchContext,
): readonly D1PreparedStatement[] {
  return memberDeleteStatements(database, context);
}

export async function rawIngestMemberCounts(
  database: D1Database,
  sourceRevisionRef: string,
): Promise<readonly number[]> {
  const captureMembers = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='CAPTURE'";
  const conversionMembers = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='CONVERSION'";
  const admissionMembers = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='ADMISSION'";
  const bindingMembers = "SELECT member_id FROM raw_ingest_erasure_member WHERE source_revision_ref=?1 AND member_kind='WORKSPACE_BINDING'";
  return Promise.all([
    count(
      database,
      "SELECT COUNT(*) AS count FROM raw_file_capture c WHERE c.source_revision_ref=?1 " +
        "OR c.capture_id IN (" + captureMembers + ")",
      sourceRevisionRef,
      "raw capture absence readback",
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM raw_markdown_conversion m WHERE " +
        "m.capture_id IN (SELECT capture_id FROM raw_file_capture WHERE source_revision_ref=?1) " +
        "OR m.capture_id IN (" + captureMembers + ") " +
        "OR m.operation_id IN (" + conversionMembers + ")",
      sourceRevisionRef,
      "raw conversion absence readback",
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM raw_normalized_admission a WHERE a.source_revision_ref=?1 " +
        "OR a.admission_operation_id IN (" + admissionMembers + ")",
      sourceRevisionRef,
      "raw admission absence readback",
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM workspace_mcp_raw_normalized_admission b WHERE " +
        "b.binding_id IN (" + bindingMembers + ") " +
        "OR b.capture_id IN (" + captureMembers + ") " +
        "OR b.conversion_operation_id IN (" + conversionMembers + ") " +
        "OR b.admission_operation_id IN (" + admissionMembers + ")",
      sourceRevisionRef,
      "workspace raw admission absence readback",
    ),
  ]);
}
