import type {
  AbsenceVerificationReceipt,
  ErasureFence,
  ErasureRequest,
  PurgeAttemptReceipt,
  PurgeTarget,
} from "@eliotr/contracts";
import {
  assertErasureIdentifier,
  assertErasureSha256,
  canonicalErasureJson,
  erasureDigest,
  erasureFail,
  erasureSha256Utf8,
  parseErasureSubject,
  stableErasureId,
  validateErasureRequest,
} from "./canonical.js";
import {
  assertRawIngestGraph,
  rawIngestMemberCounts,
  rawIngestMemberDeleteStatements,
  rawIngestMemberInsertStatements,
} from "./raw-ingest-members.js";
import type { ErasureLocationPort } from "./types.js";

export const RAW_INGEST_ERASURE_PREFIX = "d1-core:raw-ingest:";

const TARGET_STATES = ["ENUMERATED", "QUARANTINED", "PURGE_REQUESTED"] as const;
const SOURCE_PURGE_STATES = ["PURGE_REQUESTED", "REDACTED"] as const;

interface ExecutionRow {
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly state: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}

interface TargetRow {
  readonly target_kind: unknown;
  readonly exact_subject_ref: unknown;
  readonly location: unknown;
  readonly canonical_ref: unknown;
  readonly provider_ref: unknown;
  readonly identity_digest: unknown;
  readonly shared_live_reference_count: unknown;
  readonly retention_or_hold_ref: unknown;
  readonly next_review_at: unknown;
  readonly state: unknown;
}

interface SourceRevisionRow {
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly purge_state: unknown;
}

interface BoundTarget {
  readonly source_revision_ref: string;
  readonly request_json: string;
  readonly request_sha256: string;
  readonly source: SourceRevisionRow;
}

export interface D1RawIngestErasureLocationDependencies {
  readonly database: D1Database;
  readonly now?: () => number;
}

export function isRawIngestErasureTarget(target: PurgeTarget): boolean {
  return target.target_kind === "OBJECT" && target.canonical_ref.startsWith(RAW_INGEST_ERASURE_PREFIX);
}

function sourceRevisionRef(target: PurgeTarget): string {
  if (!isRawIngestErasureTarget(target)) {
    erasureFail("ERASURE_INPUT_INVALID", `unsupported raw-ingest target ${target.canonical_ref}`);
  }
  return assertErasureIdentifier(
    target.canonical_ref.slice(RAW_INGEST_ERASURE_PREFIX.length),
    "raw-ingest source revision ref",
  );
}

async function receipt(
  request: ErasureRequest,
  target: PurgeTarget,
  disposition: string,
): Promise<string> {
  return stableErasureId(
    "delete-raw-ingest",
    request.erasure_ref.id,
    String(request.erasure_ref.revision),
    target.target_id,
    disposition,
  );
}

async function blockedReceipt(
  request: ErasureRequest,
  target: PurgeTarget,
  reasonCode: string,
): Promise<PurgeAttemptReceipt> {
  return {
    target_id: target.target_id,
    disposition: "BLOCKED",
    receipt_ref: await receipt(request, target, `blocked:${reasonCode}`),
    reason_code: reasonCode,
  };
}

async function first<T>(
  database: D1Database,
  sql: string,
  values: readonly unknown[],
  label: string,
): Promise<T | null> {
  try {
    return (await database.prepare(sql).bind(...values).first<T>()) ?? null;
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} is unavailable`, true, cause);
  }
}

async function count(
  database: D1Database,
  sql: string,
  values: readonly unknown[],
  label: string,
): Promise<number> {
  const row = await first<{ readonly count: unknown }>(database, sql, values, label);
  if (row === null || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} returned a malformed count`, true);
  }
  return row.count;
}

function guardPredicate(): string {
  return "EXISTS (SELECT 1 FROM raw_ingest_erasure_guard g WHERE " +
    "g.source_revision_ref=?1 AND g.erasure_id=?2 AND g.erasure_revision=?3 " +
    "AND g.target_id=?4 AND g.lease_owner=?5 AND g.lease_generation=?6)";
}

function targetStateAllowed(value: unknown): boolean {
  return typeof value === "string" && (TARGET_STATES as readonly string[]).includes(value);
}

function sourceStateAllowed(value: unknown): value is (typeof SOURCE_PURGE_STATES)[number] {
  return typeof value === "string" && (SOURCE_PURGE_STATES as readonly string[]).includes(value);
}

function providerValue(value: unknown): string | null {
  return value === null || value === undefined ? null : assertErasureIdentifier(value, "raw-ingest target provider ref");
}

function optionalStoredValue(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return assertErasureIdentifier(value, label);
}

function parseStoredRequest(row: ExecutionRow): { readonly json: string; readonly sha256: string } {
  if (typeof row.request_json !== "string" || typeof row.request_sha256 !== "string") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure request is incomplete");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.request_json);
    if (canonicalErasureJson(parsed) !== row.request_json) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure request is not canonical");
    }
    validateErasureRequest(parsed as ErasureRequest);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "ErasureRuntimeError") throw cause;
    erasureFail("ERASURE_IDENTITY_CONFLICT", "stored erasure request is malformed", false, cause);
  }
  return { json: row.request_json, sha256: row.request_sha256 };
}

async function validateBoundTarget(
  database: D1Database,
  request: ErasureRequest,
  fence: ErasureFence,
  target: PurgeTarget,
  expectedExecutionStates: readonly string[],
  now: number,
): Promise<BoundTarget> {
  const validatedRequest = validateErasureRequest(request);
  const sourceRef = sourceRevisionRef(target);
  const subject = parseErasureSubject(target.exact_subject_ref);
  if (
    target.target_kind !== "OBJECT" ||
    target.location !== "OperationalRecovery" ||
    target.provider_ref !== undefined
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest target has an unexpected location identity");
  }
  assertErasureIdentifier(target.target_id, "raw-ingest target ID");
  if (!validatedRequest.required_locations.includes("OperationalRecovery") ||
      !validatedRequest.exact_subject_refs.includes(target.exact_subject_ref)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest target is not included in the exact erasure request");
  }
  if (subject.kind !== "source_revision" && subject.kind !== "source") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest target subject is not a source identity");
  }
  assertErasureSha256(target.identity_digest, "raw-ingest target identity digest");
  if (!Number.isSafeInteger(target.shared_live_reference_count) || target.shared_live_reference_count < 0) {
    erasureFail("ERASURE_INPUT_INVALID", "raw-ingest target reference count is invalid");
  }
  const requestJson = canonicalErasureJson(validatedRequest);
  const requestSha256 = await erasureSha256Utf8(requestJson);
  const expectedIdentity = await erasureDigest({
    exact_subject_ref: target.exact_subject_ref,
    location: target.location,
    canonical_ref: target.canonical_ref,
    provider_ref: null,
  });
  if (target.identity_digest !== expectedIdentity) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest target identity digest does not match its canonical target");
  }
  if (validatedRequest.erasure_ref.id !== fence.erasure_id || validatedRequest.erasure_ref.revision !== fence.revision) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest request and lease refer to different erasure executions");
  }
  const [execution, persistedTarget, source] = await Promise.all([
    first<ExecutionRow>(
      database,
      "SELECT request_json,request_sha256,state,lease_owner,lease_generation,lease_until " +
        "FROM erasure_execution WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
      [fence.erasure_id, fence.revision],
      "raw-ingest erasure execution readback",
    ),
    first<TargetRow>(
      database,
      "SELECT target_kind,exact_subject_ref,location,canonical_ref,provider_ref,identity_digest," +
        "shared_live_reference_count,retention_or_hold_ref,next_review_at,state FROM erasure_target " +
        "WHERE erasure_id=?1 AND erasure_revision=?2 AND target_id=?3 LIMIT 1",
      [fence.erasure_id, fence.revision, target.target_id],
      "raw-ingest erasure target readback",
    ),
    first<SourceRevisionRow>(
      database,
      "SELECT source_revision_ref,source_id,purge_state FROM source_revision " +
        "WHERE source_revision_ref=?1 LIMIT 1",
      [sourceRef],
      "raw-ingest source revision readback",
    ),
  ]);
  if (execution === null || persistedTarget === null || source === null) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest erasure identity is absent");
  }
  if (
    typeof execution.state !== "string" ||
    !expectedExecutionStates.includes(execution.state) ||
    execution.lease_owner !== fence.lease_owner ||
    execution.lease_generation !== fence.lease_generation ||
    typeof execution.lease_until !== "number" ||
    !Number.isSafeInteger(execution.lease_until) ||
    execution.lease_until <= now
  ) {
    erasureFail("ERASURE_LEASE_LOST", "raw-ingest erasure execution fence is stale", true);
  }
  const stored = parseStoredRequest(execution);
  if (stored.json !== requestJson || stored.sha256 !== requestSha256 ||
      await erasureSha256Utf8(stored.json) !== stored.sha256) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest execution is bound to another request");
  }
  const storedProvider = providerValue(persistedTarget.provider_ref);
  if (
    persistedTarget.target_kind !== target.target_kind ||
    persistedTarget.exact_subject_ref !== target.exact_subject_ref ||
    persistedTarget.location !== target.location ||
    persistedTarget.canonical_ref !== target.canonical_ref ||
    storedProvider !== null ||
    persistedTarget.identity_digest !== target.identity_digest ||
    persistedTarget.shared_live_reference_count !== target.shared_live_reference_count ||
    optionalStoredValue(persistedTarget.retention_or_hold_ref, "stored raw-ingest hold ref") !==
      (target.retention_or_hold_ref ?? null) ||
    optionalStoredValue(persistedTarget.next_review_at, "stored raw-ingest review time") !==
      (target.next_review_at ?? null) ||
    !targetStateAllowed(persistedTarget.state)
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "persisted raw-ingest target identity conflicts with the closure");
  }
  if (typeof source.source_revision_ref !== "string" || source.source_revision_ref !== sourceRef ||
      typeof source.source_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(source.source_id) ||
      typeof source.purge_state !== "string") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest source revision is malformed or not erasure-quarantined");
  }
  if (
    (subject.kind === "source_revision" && subject.source_revision_ref !== sourceRef) ||
    (subject.kind === "source" && subject.source_id !== source.source_id)
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest source subject does not match the target revision");
  }
  return { source_revision_ref: sourceRef, request_json: requestJson, request_sha256: requestSha256, source };
}

async function activeWriterCount(database: D1Database, sourceRef: string): Promise<number> {
  const values = [sourceRef];
  const [capture, conversion, admission, workspace] = await Promise.all([
    count(
      database,
      "SELECT COUNT(*) AS count FROM raw_file_capture WHERE source_revision_ref=?1 AND state='INTENT'",
      values,
      "raw capture writer check",
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM raw_markdown_conversion WHERE state IN ('STARTED','UNKNOWN') " +
        "AND (capture_id IN (SELECT capture_id FROM raw_file_capture WHERE source_revision_ref=?1) " +
        "OR operation_id IN (SELECT conversion_operation_id FROM raw_normalized_admission " +
        "WHERE source_revision_ref=?1))",
      values,
      "raw conversion writer check",
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM raw_normalized_admission WHERE source_revision_ref=?1 " +
        "AND state NOT IN ('COMMITTED','QUARANTINED','REJECTED')",
      values,
      "raw admission writer check",
    ),
    count(
      database,
      "SELECT COUNT(*) AS count FROM workspace_mcp_raw_normalized_admission WHERE state='RESERVED' " +
        "AND (capture_id IN (SELECT capture_id FROM raw_file_capture WHERE source_revision_ref=?1) " +
        "OR conversion_operation_id IN (SELECT conversion_operation_id FROM raw_normalized_admission " +
        "WHERE source_revision_ref=?1) OR admission_operation_id IN " +
        "(SELECT admission_operation_id FROM raw_normalized_admission WHERE source_revision_ref=?1))",
      values,
      "workspace raw admission writer check",
    ),
  ]);
  const total = capture + conversion + admission + workspace;
  if (!Number.isSafeInteger(total)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "raw-ingest writer count overflowed", true);
  }
  return total;
}

function batchChanges(value: unknown): number | null {
  if (value === null || typeof value !== "object") return null;
  const meta = (value as { readonly meta?: unknown }).meta;
  if (meta === null || typeof meta !== "object") return null;
  const changes = (meta as { readonly changes?: unknown }).changes;
  return typeof changes === "number" && Number.isSafeInteger(changes) && changes >= 0 ? changes : null;
}

async function purgeRawIngest(
  database: D1Database,
  request: ErasureRequest,
  fence: ErasureFence,
  target: PurgeTarget,
  bound: BoundTarget,
  now: number,
): Promise<PurgeAttemptReceipt> {
  if (!sourceStateAllowed(bound.source.purge_state)) {
    return blockedReceipt(request, target, "RAW_SOURCE_NOT_PURGE_REQUESTED");
  }
  if (target.shared_live_reference_count > 0 || target.retention_or_hold_ref !== undefined) {
    return blockedReceipt(request, target, "RAW_INGEST_TARGET_BLOCKED");
  }
  if (await activeWriterCount(database, bound.source_revision_ref) > 0) {
    return blockedReceipt(request, target, "RAW_INGEST_WRITER_ACTIVE");
  }
  await assertRawIngestGraph(database, bound.source_revision_ref);

  const guard = guardPredicate();
  const commonGuard: readonly unknown[] = [
    bound.source_revision_ref,
    fence.erasure_id,
    fence.revision,
    target.target_id,
    fence.lease_owner,
    fence.lease_generation,
  ];
  const canonicalRef = `${RAW_INGEST_ERASURE_PREFIX}${bound.source_revision_ref}`;
  let results: readonly unknown[];
  try {
    results = await database.batch([
      database.prepare(
        "INSERT INTO raw_ingest_erasure_guard(source_revision_ref,erasure_id,erasure_revision,target_id," +
          "lease_owner,lease_generation) SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS (" +
          "SELECT 1 FROM erasure_execution e WHERE e.erasure_id=?2 AND e.revision=?3 " +
          "AND e.state='PURGE_EACH_LOCATION' AND e.lease_owner=?5 AND e.lease_generation=?6 " +
          "AND e.lease_until>?11 AND e.request_sha256=?7 " +
          "AND EXISTS (SELECT 1 FROM json_each(e.request_json,'$.exact_subject_refs') s WHERE s.value=?9) " +
          "AND EXISTS (SELECT 1 FROM json_each(e.request_json,'$.required_locations') l " +
          "WHERE l.value='OperationalRecovery')) AND EXISTS (" +
          "SELECT 1 FROM erasure_target t WHERE t.erasure_id=?2 AND t.erasure_revision=?3 " +
          "AND t.target_id=?4 AND t.target_kind='OBJECT' AND t.exact_subject_ref=?9 " +
          "AND t.location='OperationalRecovery' AND t.canonical_ref=?10 AND t.provider_ref IS NULL " +
          "AND t.identity_digest=?8 AND t.state IN ('ENUMERATED','QUARANTINED','PURGE_REQUESTED')) " +
          "AND EXISTS (SELECT 1 FROM source_revision s WHERE s.source_revision_ref=?1 " +
          "AND s.purge_state IN ('PURGE_REQUESTED','REDACTED'))",
      ).bind(
        bound.source_revision_ref,
        fence.erasure_id,
        fence.revision,
        target.target_id,
        fence.lease_owner,
        fence.lease_generation,
        bound.request_sha256,
        target.identity_digest,
        target.exact_subject_ref,
        canonicalRef,
        now,
      ),
      ...rawIngestMemberInsertStatements(database, {
        source_revision_ref: bound.source_revision_ref,
        guard_predicate: guard,
        guard_values: commonGuard,
      }),
      ...rawIngestMemberDeleteStatements(database, {
        source_revision_ref: bound.source_revision_ref,
        guard_predicate: guard,
        guard_values: commonGuard,
      }),
      database.prepare(
        "DELETE FROM raw_ingest_erasure_guard WHERE source_revision_ref=?1 AND erasure_id=?2 " +
          "AND erasure_revision=?3 AND target_id=?4 AND lease_owner=?5 AND lease_generation=?6",
      ).bind(...commonGuard),
    ]);
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "raw-ingest erasure batch outcome is uncertain", true, cause);
  }
  if (batchChanges(results[0]) !== 1 || batchChanges(results[results.length - 1]) !== 1) {
    erasureFail("ERASURE_LEASE_LOST", "raw-ingest erasure guard was not installed under the current fence", true);
  }
  return {
    target_id: target.target_id,
    disposition: "DELETE_ACCEPTED",
    receipt_ref: await receipt(request, target, "accepted"),
  };
}

export function createRawIngestErasureLocationPort(
  dependencies: D1RawIngestErasureLocationDependencies,
): ErasureLocationPort {
  const database = dependencies.database;
  const clock = dependencies.now ?? Date.now;
  return {
    async purge(request, fence, target): Promise<PurgeAttemptReceipt> {
      const bound = await validateBoundTarget(database, request, fence, target, ["PURGE_EACH_LOCATION"], clock());
      return purgeRawIngest(database, request, fence, target, bound, clock());
    },

    async verifyAbsent(request, fence, target, purgeReceipt): Promise<AbsenceVerificationReceipt> {
      if (purgeReceipt.target_id !== target.target_id || purgeReceipt.disposition === "BLOCKED") {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "raw-ingest absence receipt is not bound to the target");
      }
      const bound = await validateBoundTarget(
        database,
        request,
        fence,
        target,
        ["VERIFY_ABSENCE_OR_BLOCK"],
        clock(),
      );
      const counts = await rawIngestMemberCounts(database, bound.source_revision_ref);
      const absent = counts.every((value) => value === 0) && sourceStateAllowed(bound.source.purge_state);
      return {
        target_id: target.target_id,
        absent,
        receipt_ref: await stableErasureId(
          "absence-raw-ingest",
          request.erasure_ref.id,
          String(request.erasure_ref.revision),
          target.target_id,
          absent ? "absent" : "present",
        ),
        ...(absent ? {} : { reason_code: "RAW_INGEST_AUTHORITY_REMAINS" }),
      };
    },
  };
}
