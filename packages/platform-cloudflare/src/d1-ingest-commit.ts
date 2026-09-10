import {
  BundleAdmissionReceiptSchema,
  QualificationReportSchema,
  SourceAdmissionDecisionSchema,
  SNAPSHOT_VIEW_REF_PREFIX,
  SnapshotViewWitnessSchema,
  type BundleAdmissionReceipt,
  type QualificationReport,
  type SourceAdmissionDecision,
  type SnapshotViewWitness,
} from "@eliotr/contracts";
import { canonicalJson } from "./ingest-validation.js";
import { CURRENT_INGEST_POLICY_SQL, requireCurrentIngestPolicy } from "./d1-ingest-policy.js";
import type {
  BundlePromotionReceipt,
  CommitAdmittedBundleInput,
  PreparedIngestOperation,
} from "./d1-ingest-types.js";
import {
  IngestAuthorityError,
  authorityFail,
  authorityIdentifier,
  authorityIso,
  authoritySha256,
  canonicalDigest,
  stableIngestId,
} from "./d1-ingest-validation.js";

interface DecisionRow {
  readonly decision_json: unknown;
  readonly decision_sha256: unknown;
}
interface QualificationRow {
  readonly report_json: unknown;
  readonly report_sha256: unknown;
}

interface RawAdmissionSnapshotRow {
  readonly admission_operation_id: unknown;
  readonly principal_ref: unknown;
  readonly capture_id: unknown;
  readonly source_revision_ref: unknown;
  readonly source_view_ref: unknown;
  readonly snapshot_view_json: unknown;
  readonly snapshot_view_sha256: unknown;
  readonly state: unknown;
}

interface VerifiedSnapshotViewFence {
  readonly admission_operation_id: string;
  readonly principal_ref: string;
  readonly capture_id: string;
  readonly source_revision_ref: string;
  readonly source_view_ref: string;
  readonly snapshot_view_json: string;
  readonly snapshot_view_sha256: string;
}

function snapshotViewDescriptor(witness: SnapshotViewWitness): Record<string, unknown> {
  return {
    protocol: witness.protocol,
    capture_id: witness.capture_id,
    source_revision_ref: witness.source_revision_ref,
    source_logical_id: witness.source_logical_id,
    verified_principal_ref: witness.verified_principal_ref,
    owner_system_id: witness.owner_system_id,
    source_namespace_id: witness.source_namespace_id,
    source_owner_generation: witness.source_owner_generation,
    original_sha256: witness.original_sha256,
    original_size_bytes: witness.original_size_bytes,
    residency_key_digest: witness.residency_key_digest,
    policy_snapshot_sha256: witness.policy_snapshot_sha256,
    policy_revision: witness.policy_revision,
    observed_at: witness.observed_at,
    observation_freshness: witness.observation_freshness,
  };
}

async function loadVerifiedSnapshotViewFence(
  database: D1Database,
  operation: PreparedIngestOperation,
): Promise<VerifiedSnapshotViewFence> {
  const sourceViewRef = operation.manifest.origin.source_view_ref;
  const row = await database.prepare(
    "SELECT admission_operation_id,principal_ref,capture_id,source_revision_ref,source_view_ref," +
    "snapshot_view_json,snapshot_view_sha256,state FROM raw_normalized_admission " +
    "WHERE ingest_operation_id=?1 AND source_view_ref=?2 LIMIT 1",
  ).bind(operation.operation_id, sourceViewRef).first<RawAdmissionSnapshotRow>();
  if (row === null) authorityFail("INGEST_AUTHORITY_MISSING", "raw normalized admission witness is missing");
  const admissionOperationId = authorityIdentifier(row.admission_operation_id, "raw admission operation id");
  const principalRef = authorityIdentifier(row.principal_ref, "raw admission principal");
  const captureId = authorityIdentifier(row.capture_id, "raw admission capture id");
  const sourceRevisionRef = authorityIdentifier(row.source_revision_ref, "raw admission source revision");
  const storedSourceViewRef = authorityIdentifier(row.source_view_ref, "raw admission source view");
  if (storedSourceViewRef !== sourceViewRef || principalRef !== operation.principal_ref || sourceRevisionRef !== operation.source_revision_ref) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission witness identity does not match ingest operation");
  }
  // UNKNOWN is a recoverable replay state after a lost ACK; only terminal
  // rejection/quarantine rows are barred from entering the commit batch.
  if (row.state === "REJECTED" || row.state === "QUARANTINED") {
    authorityFail("INGEST_STATE_CONFLICT", "raw admission witness is not committable");
  }
  if (typeof row.snapshot_view_json !== "string") authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view is not JSON text");
  let decoded: unknown;
  try { decoded = JSON.parse(row.snapshot_view_json); }
  catch (cause) { authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view is malformed JSON", false, cause); }
  let witness: SnapshotViewWitness;
  try { witness = SnapshotViewWitnessSchema.parse(decoded); }
  catch (cause) { authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view failed strict decoding", false, cause); }
  if (canonicalJson(witness) !== row.snapshot_view_json) authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view is not canonical JSON");
  const snapshotViewSha256 = authoritySha256(row.snapshot_view_sha256, "raw admission snapshot view digest");
  if (await canonicalDigest(witness) !== snapshotViewSha256) authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view digest mismatch");
  authorityIso(witness.observed_at, "raw admission snapshot observed_at");
  const descriptorRef = `${SNAPSHOT_VIEW_REF_PREFIX}${await canonicalDigest(snapshotViewDescriptor(witness))}`;
  if (witness.source_view_ref !== descriptorRef || witness.source_view_ref !== sourceViewRef) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot descriptor reference mismatch");
  }
  if (witness.source_revision_ref !== operation.source_revision_ref || witness.verified_principal_ref !== operation.principal_ref) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot binding does not match ingest operation");
  }
  return {
    admission_operation_id: admissionOperationId,
    principal_ref: principalRef,
    capture_id: captureId,
    source_revision_ref: sourceRevisionRef,
    source_view_ref: storedSourceViewRef,
    snapshot_view_json: row.snapshot_view_json,
    snapshot_view_sha256: snapshotViewSha256,
  };
}

function parseCanonicalJson<T>(
  raw: unknown,
  digest: unknown,
  label: string,
  parse: (value: unknown) => T,
): Promise<T> {
  if (typeof raw !== "string") authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not JSON text`);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (cause) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is malformed JSON`, false, cause);
  }
  let parsed: T;
  try { parsed = parse(value); }
  catch (cause) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} failed strict decoding`, false, cause);
  }
  if (canonicalJson(value) !== raw) authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not canonical JSON`);
  return canonicalDigest(parsed).then((actual) => {
    if (actual !== authoritySha256(digest, `${label} digest`)) {
      authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} digest mismatch`);
    }
    return parsed;
  });
}

async function loadDecision(
  database: D1Database,
  operationId: string,
): Promise<SourceAdmissionDecision> {
  const row = await database.prepare(
    "SELECT decision_json, decision_sha256 FROM source_admission_decision " +
    "WHERE operation_id = ?1 LIMIT 1",
  ).bind(operationId).first<DecisionRow>();
  if (row === null) authorityFail("INGEST_AUTHORITY_MISSING", "source admission decision is missing");
  return parseCanonicalJson(
    row.decision_json,
    row.decision_sha256,
    "source admission decision",
    (value) => SourceAdmissionDecisionSchema.parse(value),
  );
}

async function loadQualification(
  database: D1Database,
  operationId: string,
): Promise<QualificationReport> {
  const row = await database.prepare(
    "SELECT report_json, report_sha256 FROM qualification_report WHERE operation_id = ?1 LIMIT 1",
  ).bind(operationId).first<QualificationRow>();
  if (row === null) authorityFail("INGEST_AUTHORITY_MISSING", "qualification report is missing");
  return parseCanonicalJson(
    row.report_json,
    row.report_sha256,
    "qualification report",
    (value) => QualificationReportSchema.parse(value),
  );
}

function validatePromotion(
  operation: PreparedIngestOperation,
  promotion: BundlePromotionReceipt,
): { readonly promotionRef: string; readonly contentKey: string } {
  if (
    promotion.protocol !== "eliotr.bundle-promotion.v1" ||
    promotion.session_id !== operation.staging_session_ref ||
    promotion.admission_receipt_ref !== operation.decision_receipt_ref ||
    promotion.promoted_objects.length < 3 ||
    promotion.promoted_objects.length > 1024
  ) {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "promotion receipt does not match admitted operation");
  }
  authoritySha256(promotion.readback_digest, "promotion readback digest");
  authorityIdentifier(promotion.canonical_manifest_ref, "canonical manifest ref");
  const seen = new Set<string>();
  let contentKey: string | undefined;
  for (const object of promotion.promoted_objects) {
    if (seen.has(object.logical_path)) {
      authorityFail("INGEST_AUTHORITY_CONFLICT", "promotion receipt contains duplicate logical paths");
    }
    seen.add(object.logical_path);
    authorityIdentifier(object.logical_path, "promoted logical path");
    authorityIdentifier(object.canonical_key, "promoted canonical key");
    authoritySha256(object.sha256, "promoted object digest");
    if (!Number.isSafeInteger(object.size_bytes) || object.size_bytes < 0) {
      authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "promoted object size is invalid");
    }
    if (object.logical_path === "content.md") {
      if (object.sha256 !== operation.manifest.content.markdown_sha256) {
        authorityFail("INGEST_AUTHORITY_CONFLICT", "promoted content digest differs from manifest");
      }
      contentKey = object.canonical_key;
    }
  }
  for (const required of ["content.md", "manifest.json", "hashes.sha256"]) {
    if (!seen.has(required)) authorityFail("INGEST_AUTHORITY_CONFLICT", `promotion is missing ${required}`);
  }
  if (contentKey === undefined) authorityFail("INGEST_AUTHORITY_CONFLICT", "promotion content object is missing");
  return {
    promotionRef: `promotion:${promotion.session_id}:${promotion.readback_digest.slice(0, 24)}`,
    contentKey,
  };
}

function validateBundleReceipt(
  operation: PreparedIngestOperation,
  promotion: BundlePromotionReceipt,
  raw: BundleAdmissionReceipt,
): BundleAdmissionReceipt {
  let receipt: BundleAdmissionReceipt;
  try { receipt = BundleAdmissionReceiptSchema.parse(raw); }
  catch (cause) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "bundle admission receipt failed strict validation", false, cause);
  }
  if (
    receipt.decision !== "ADMITTED" ||
    receipt.operation_id !== operation.operation_id ||
    receipt.manifest_sha256 !== operation.manifest_sha256 ||
    receipt.source_revision_ref !== operation.source_revision_ref ||
    receipt.normalized_artifact_ref !== promotion.canonical_manifest_ref ||
    receipt.object_residency_key_digest !== operation.residency_key_digest ||
    receipt.readback_sha256 !== promotion.readback_digest
  ) {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "bundle admission receipt does not match promotion authority");
  }
  return receipt;
}

function exactTerminal(
  existing: BundleAdmissionReceipt,
  expected: BundleAdmissionReceipt,
): BundleAdmissionReceipt {
  if (canonicalJson(existing) !== canonicalJson(expected)) {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "terminal admitted receipt already differs");
  }
  return existing;
}

function readinessValues(
  operation: PreparedIngestOperation,
  qualification: QualificationReport,
  now: string,
): readonly unknown[] {
  const structureState = qualification.overall === "QUALIFIED" ? "ready" : "degraded";
  const exactState = qualification.overall === "REJECTED" ? "failed" : "queued";
  return [
    operation.source_revision_ref,
    "captured", "ready", "[]", now,
    "normalized", "ready", "[]", now,
    "structure_qualified", structureState,
    canonicalJson(qualification.overall === "DEGRADED" ? ["QUALIFICATION_DEGRADED"] : []), now,
    "exact_ready", exactState, canonicalJson(["PROJECTION_PENDING"]), now,
    "lexical_ready", "queued", canonicalJson(["PROJECTION_PENDING"]), now,
    "semantic_ready", "queued", canonicalJson(["MANAGED_INDEX_PENDING"]), now,
    "sourcecard_ready", "not_requested", "[]", now,
    "atlas_included", "not_requested", "[]", now,
    "distillates_ready", "not_requested", "[]", now,
    "wiki_published", "not_requested", "[]", now,
  ];
}

export async function commitAdmittedBundle(
  database: D1Database,
  input: CommitAdmittedBundleInput,
  loadOperation: (operationId: string) => Promise<PreparedIngestOperation | null>,
  clock: () => number,
): Promise<BundleAdmissionReceipt> {
  const operationId = authorityIdentifier(input.operation_id, "operation_id");
  const operation = await loadOperation(operationId);
  if (operation === null) authorityFail("INGEST_AUTHORITY_MISSING", "ingest operation does not exist");
  await requireCurrentIngestPolicy(database, operation, clock);
  const receipt = validateBundleReceipt(operation, input.promotion_receipt, input.bundle_receipt);
  if (operation.bundle_receipt !== null) return exactTerminal(operation.bundle_receipt, receipt);
  if (
    operation.state !== "AUTHORIZED" ||
    operation.staging_session_ref !== input.staging_session_ref ||
    operation.decision_receipt_ref === null
  ) {
    authorityFail("INGEST_STATE_CONFLICT", "ingest operation is not authorized for commit");
  }
  const decision = await loadDecision(database, operation.operation_id);
  const qualification = await loadQualification(database, operation.operation_id);
  if (
    decision.decision !== "ADMITTED" ||
    decision.decision_receipt_ref !== operation.decision_receipt_ref ||
    decision.source_revision_ref !== operation.source_revision_ref ||
    qualification.source_revision_ref !== operation.source_revision_ref ||
    qualification.overall === "REJECTED"
  ) {
    authorityFail("INGEST_STATE_CONFLICT", "admission or qualification authority does not permit commit");
  }
  const promotion = validatePromotion(operation, input.promotion_receipt);
  const receiptJson = canonicalJson(receipt);
  const receiptSha = await canonicalDigest(receipt);
  const epoch = clock();
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "ingest authority clock is invalid");
  }
  const now = new Date(epoch).toISOString();
  const ingestIntentId = await stableIngestId("intent-ingest", operation.operation_id);
  const ingestAttemptId = await stableIngestId("attempt-ingest", operation.operation_id);
  const ingestReceiptId = await stableIngestId("receipt-ingest", operation.operation_id);
  const ingestIdempotency = await stableIngestId(
    "idem-ingest",
    operation.principal_ref,
    operation.idempotency_key,
  );
  const projectionIntentId = await stableIngestId("intent-projection", operation.source_revision_ref);
  const projectionIdempotency = await stableIngestId("idem-projection", operation.source_revision_ref);
  const outboxId = await stableIngestId("outbox", projectionIntentId, "1");
  const readiness = readinessValues(operation, qualification, now);
  const promotionRef = promotion.promotionRef;
  const expectedHead = operation.expected_head_revision_ref;
  // Reserved snapshot-view references are fenced by a typed, canonical witness
  // read before the batch. The exact bytes and digest are then bound as SQL
  // literals so an async mutation cannot substitute a self-consistent witness.
  const snapshotFence = operation.manifest.origin.source_view_ref.startsWith(SNAPSHOT_VIEW_REF_PREFIX)
    ? await loadVerifiedSnapshotViewFence(database, operation)
    : null;

  const statements: D1PreparedStatement[] = [
    database.prepare(
      "INSERT INTO source(source_id, source_namespace_id, source_owner_system_id, " +
      "source_owner_generation, ownership_mode, kind, origin_uri, title, default_storage_policy, " +
      "default_residency_profile_id, source_class, license_policy_ref, default_retention_policy_id, " +
      "head_rev, created_at) VALUES (?1,?2,?3,?4,?5,?6,NULL,?7,?8,?9,?10,?11,?12,NULL,?13) " +
      "ON CONFLICT(source_id) DO NOTHING",
    ).bind(
      operation.source_id,
      operation.source_namespace_id,
      operation.owner_system_id,
      operation.source_owner_generation,
      operation.manifest.origin.ownership_mode,
      operation.manifest.source.mime_type,
      operation.manifest.source.original_name,
      operation.policy.default_storage_policy,
      operation.policy.default_residency_profile_id,
      operation.policy.source_class,
      operation.policy.license_policy_ref,
      operation.policy.default_retention_policy_id,
      now,
    ),
    database.prepare(
      "INSERT INTO source_revision(source_revision_ref, source_id, source_owner_generation, " +
      "content_sha256, object_residency_key_digest, original_r2_key, normalized_artifact_ref, " +
      "captured_at, parser_profile_generation, quality_state, purge_state, currentness_state, " +
      "source_view_ref, workspace_view_revision_ref, admitted_at) VALUES (" +
      "?1,?2,?3,?4,?5,NULL,?6,?7,?8,?9,'LIVE','current_confirmed',?10,?11,?12) " +
      "ON CONFLICT(source_revision_ref) DO NOTHING",
    ).bind(
      operation.source_revision_ref,
      operation.source_id,
      operation.source_owner_generation,
      operation.manifest.content.markdown_sha256,
      operation.residency_key_digest,
      receipt.normalized_artifact_ref,
      operation.manifest.normalization.created_at,
      `parser:${operation.manifest.normalization.config_hash}`,
      operation.manifest.quality.state,
      operation.manifest.origin.source_view_ref,
      operation.manifest.origin.workspace_view_revision_ref ?? null,
      now,
    ),
    database.prepare(
      "UPDATE source SET head_rev = ?2 WHERE source_id = ?1 " +
      "AND (head_rev IS ?3 OR head_rev = ?2)",
    ).bind(operation.source_id, operation.source_revision_ref, expectedHead),
    database.prepare(
      "INSERT INTO source_readiness(source_revision_ref, channel, state, generation, reason_codes_json, updated_at) VALUES " +
      "(?1,?2,?3,NULL,?4,?5)," +
      "(?1,?6,?7,NULL,?8,?9)," +
      "(?1,?10,?11,NULL,?12,?13)," +
      "(?1,?14,?15,NULL,?16,?17)," +
      "(?1,?18,?19,NULL,?20,?21)," +
      "(?1,?22,?23,NULL,?24,?25)," +
      "(?1,?26,?27,NULL,?28,?29)," +
      "(?1,?30,?31,NULL,?32,?33)," +
      "(?1,?34,?35,NULL,?36,?37)," +
      "(?1,?38,?39,NULL,?40,?41) " +
      "ON CONFLICT(source_revision_ref, channel) DO NOTHING",
    ).bind(...readiness),
    database.prepare(
      "INSERT INTO operation_intent(intent_id, revision, operation_kind, principal_ref, " +
      "idempotency_key, payload_ref, policy_decision_ref, created_at) " +
      "VALUES (?1,1,'INGEST',?2,?3,?4,?5,?6) ON CONFLICT(intent_id, revision) DO NOTHING",
    ).bind(
      ingestIntentId,
      operation.principal_ref,
      ingestIdempotency,
      operation.operation_id,
      operation.decision_receipt_ref,
      now,
    ),
    database.prepare(
      "INSERT INTO operation_attempt(attempt_id, intent_id, intent_revision, attempt_number, " +
      "state, started_at, ended_at) VALUES (?1,?2,1,1,'SUCCEEDED',?3,?3) " +
      "ON CONFLICT(attempt_id) DO NOTHING",
    ).bind(ingestAttemptId, ingestIntentId, now),
    database.prepare(
      "INSERT INTO operation_receipt(receipt_id, revision, intent_id, intent_revision, attempt_id, " +
      "outcome, output_refs_json, readback_receipt_refs_json, reconciliation_required, " +
      "reason_codes_json, created_at) VALUES (?1,1,?2,1,?3,'SUCCEEDED',?4,?5,0,'[]',?6) " +
      "ON CONFLICT(receipt_id, revision) DO NOTHING",
    ).bind(
      ingestReceiptId,
      ingestIntentId,
      ingestAttemptId,
      canonicalJson([operation.operation_id, operation.source_revision_ref]),
      canonicalJson([operation.decision_receipt_ref, promotionRef]),
      now,
    ),
    database.prepare(
      "INSERT INTO operation_intent(intent_id, revision, operation_kind, principal_ref, " +
      "idempotency_key, payload_ref, policy_decision_ref, created_at) " +
      "VALUES (?1,1,'PROJECTION',?2,?3,?4,?5,?6) ON CONFLICT(intent_id, revision) DO NOTHING",
    ).bind(
      projectionIntentId,
      operation.principal_ref,
      projectionIdempotency,
      operation.source_revision_ref,
      operation.decision_receipt_ref,
      now,
    ),
    database.prepare(
      "INSERT INTO outbox(outbox_id, intent_id, intent_revision, topic, payload_ref, " +
      "payload_sha256, state, attempts, next_attempt_at, lease_generation, created_at, updated_at) " +
      "VALUES (?1,?2,1,'source.revision.admitted',?3,?4,'PENDING',0,?5,0,?6,?6) " +
      "ON CONFLICT(outbox_id) DO NOTHING",
    ).bind(
      outboxId,
      projectionIntentId,
      operation.source_revision_ref,
      operation.manifest.content.markdown_sha256,
      epoch,
      now,
    ),
    database.prepare(
      "UPDATE source_acquisition_candidate SET state = 'CAPTURED', terminal_receipt_ref = ?2 " +
      "WHERE operation_id = ?1 AND state = 'CAPTURED'",
    ).bind(operation.operation_id, ingestReceiptId),
    database.prepare(
      "UPDATE bundle_ingest_operation SET state = 'COMMITTED', promotion_receipt_ref = ?2, " +
      "bundle_receipt_json = ?3, bundle_receipt_sha256 = ?4, updated_at = ?5 " +
      "WHERE operation_id = ?1 AND state = 'AUTHORIZED' AND staging_session_ref = ?6 " +
      "AND decision_receipt_ref = ?7 AND bundle_receipt_json IS NULL",
    ).bind(
      operation.operation_id,
      promotionRef,
      receiptJson,
      receiptSha,
      now,
      input.staging_session_ref,
      operation.decision_receipt_ref,
    ),
    database.prepare(
      "UPDATE raw_normalized_admission SET state='COMMITTED', receipt_json=?2, updated_at=?3 " +
      "WHERE ingest_operation_id=?1 AND source_view_ref=?4 AND state NOT IN ('REJECTED','QUARANTINED')",
    ).bind(
      operation.operation_id,
      receiptJson,
      now,
      operation.manifest.origin.source_view_ref,
    ),
    database.prepare(
      "INSERT INTO bundle_ingest_commit_guard(operation_id, source_revision_ref, " +
      "ingest_receipt_id, ingest_receipt_revision, projection_intent_id, " +
      "projection_intent_revision, outbox_id, verified, created_at) " +
      "SELECT ?1,?2,?3,1,?4,1,?5,CASE WHEN " +
      "EXISTS (SELECT 1 FROM bundle_ingest_operation b WHERE b.operation_id = ?1 " +
      "AND b.state = 'COMMITTED' AND b.bundle_receipt_sha256 = ?7 " +
      "AND b.promotion_receipt_ref = ?8 AND b.decision_receipt_ref = ?15) " +
      "AND EXISTS (SELECT 1 FROM source_namespace_ownership o " +
      "JOIN bundle_ingest_operation b ON b.operation_id = ?1 " +
      "WHERE o.source_namespace_id = b.source_namespace_id " +
      "AND o.owner_system_id = b.owner_system_id " +
      "AND o.source_owner_generation = b.source_owner_generation " +
      "AND o.source_admission_policy_revision = b.policy_revision AND o.status = 'ACTIVE') " +
      "AND EXISTS (SELECT 1 FROM source_admission_policy p JOIN bundle_ingest_operation b ON b.operation_id = ?1 " +
      "WHERE p.source_namespace_id=b.source_namespace_id AND p.revision=b.policy_revision AND " + CURRENT_INGEST_POLICY_SQL + ") " +
      "AND EXISTS (SELECT 1 FROM source s WHERE s.source_id = ?9 " +
      "AND s.source_namespace_id = ?10 AND s.source_owner_system_id = ?11 " +
      "AND s.source_owner_generation = ?12 AND s.head_rev = ?2) " +
      "AND EXISTS (SELECT 1 FROM source_revision r WHERE r.source_revision_ref = ?2 " +
      "AND r.source_id = ?9 AND r.source_owner_generation = ?12 " +
      "AND r.content_sha256 = ?13 AND r.object_residency_key_digest = ?14 " +
      "AND r.purge_state = 'LIVE') " +
       "AND EXISTS (SELECT 1 FROM source_admission_decision d WHERE d.operation_id = ?1 " +
      "AND d.decision_receipt_ref = ?15 AND d.decision = 'ADMITTED') " +
      "AND EXISTS (SELECT 1 FROM operation_receipt r WHERE r.receipt_id = ?3 " +
      "AND r.revision = 1 AND r.outcome = 'SUCCEEDED') " +
      "AND EXISTS (SELECT 1 FROM outbox o WHERE o.outbox_id = ?5 " +
      "AND o.intent_id = ?4 AND o.intent_revision = 1 " +
       "AND o.topic = 'source.revision.admitted' AND o.payload_ref = ?2 " +
       "AND o.payload_sha256 = ?13) " +
       "AND ((SELECT json_extract(manifest_json,'$.origin.source_view_ref') FROM bundle_ingest_operation WHERE operation_id=?1) NOT LIKE 'snapshot-view:v1:%' OR EXISTS (" +
       "SELECT 1 FROM raw_normalized_admission a JOIN bundle_ingest_operation b2 ON b2.operation_id=a.ingest_operation_id WHERE a.ingest_operation_id=?1 " +
       "AND a.admission_operation_id=?16 AND a.principal_ref=?17 AND a.capture_id=?18 " +
       "AND a.source_revision_ref=?19 AND a.source_view_ref=?20 " +
       "AND a.snapshot_view_json=?21 AND a.snapshot_view_sha256=?22 " +
       "AND a.state='COMMITTED' AND a.source_revision_ref=b2.source_revision_ref " +
       "AND a.source_view_ref=json_extract(b2.manifest_json,'$.origin.source_view_ref') " +
       "AND a.principal_ref=b2.principal_ref " +
       "AND a.policy_revision=b2.policy_revision AND a.policy_snapshot_sha256=b2.policy_snapshot_sha256 " +
       "AND a.policy_snapshot_json=b2.policy_snapshot_json " +
       "AND a.expires_at>?6 " +
       "AND json_extract(a.snapshot_view_json,'$.protocol')='eliotr.snapshot-view.v1' " +
       "AND json_extract(a.snapshot_view_json,'$.source_view_ref')=a.source_view_ref " +
       "AND json_extract(a.snapshot_view_json,'$.source_revision_ref')=b2.source_revision_ref " +
       "AND json_extract(a.snapshot_view_json,'$.source_logical_id')=json_extract(b2.manifest_json,'$.source.logical_id') " +
       "AND json_extract(a.snapshot_view_json,'$.source_namespace_id')=b2.source_namespace_id " +
       "AND json_extract(a.snapshot_view_json,'$.owner_system_id')=b2.owner_system_id " +
       "AND json_extract(a.snapshot_view_json,'$.source_owner_generation')=b2.source_owner_generation " +
       "AND json_extract(a.snapshot_view_json,'$.original_sha256')=json_extract(b2.manifest_json,'$.source.original_sha256') " +
       "AND json_extract(a.snapshot_view_json,'$.capture_id')=a.capture_id " +
       "AND json_extract(a.snapshot_view_json,'$.verified_principal_ref')=b2.principal_ref " +
       "AND json_extract(a.snapshot_view_json,'$.policy_snapshot_sha256')=b2.policy_snapshot_sha256 " +
       "AND json_extract(a.snapshot_view_json,'$.policy_revision')=b2.policy_revision " +
       "AND json_extract(a.snapshot_view_json,'$.observed_at') IS NOT NULL " +
       "AND EXISTS (SELECT 1 FROM raw_file_capture c WHERE c.capture_id=a.capture_id " +
       "AND c.state='CAPTURED' AND c.principal_ref=b2.principal_ref " +
       "AND c.owner_system_id=b2.owner_system_id AND c.source_namespace_id=b2.source_namespace_id " +
       "AND c.source_owner_generation=b2.source_owner_generation " +
       "AND c.source_revision_ref=b2.source_revision_ref " +
       "AND c.content_sha256=json_extract(a.snapshot_view_json,'$.original_sha256') " +
       "AND c.size_bytes=json_extract(a.snapshot_view_json,'$.original_size_bytes') " +
       "AND json_extract(c.receipt_json,'$.captured_at')=json_extract(a.snapshot_view_json,'$.observed_at') " +
       "AND json_extract(a.snapshot_view_json,'$.observation_freshness') IN ('observed_with_age','unknown') " +
       "AND c.residency_key_digest=json_extract(a.snapshot_view_json,'$.residency_key_digest'))" +
       ")) " +
       "AND (SELECT COUNT(*) FROM source_readiness sr WHERE sr.source_revision_ref = ?2 " +
      "AND sr.channel IN ('captured','normalized') AND sr.state = 'ready') = 2 " +
      "THEN 1 ELSE NULL END,?6",
    ).bind(
      operation.operation_id,
      operation.source_revision_ref,
      ingestReceiptId,
      projectionIntentId,
      outboxId,
      now,
      receiptSha,
      promotionRef,
      operation.source_id,
      operation.source_namespace_id,
      operation.owner_system_id,
      operation.source_owner_generation,
      operation.manifest.content.markdown_sha256,
      operation.residency_key_digest,
      operation.decision_receipt_ref,
      snapshotFence?.admission_operation_id ?? null,
      snapshotFence?.principal_ref ?? null,
      snapshotFence?.capture_id ?? null,
      snapshotFence?.source_revision_ref ?? null,
      snapshotFence?.source_view_ref ?? null,
      snapshotFence?.snapshot_view_json ?? null,
      snapshotFence?.snapshot_view_sha256 ?? null,
    ),
  ];

  try {
    await database.batch(statements);
  } catch (cause) {
    const raced = await loadOperation(operation.operation_id);
    if (raced?.bundle_receipt !== null && raced?.bundle_receipt !== undefined) {
      return exactTerminal(raced.bundle_receipt, receipt);
    }
    if (cause instanceof IngestAuthorityError) throw cause;
    authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "guarded ingest commit failed", true, cause);
  }
  const readback = await loadOperation(operation.operation_id);
  if (readback?.bundle_receipt === null || readback?.bundle_receipt === undefined) {
    authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "guarded ingest commit readback is missing", true);
  }
  return exactTerminal(readback.bundle_receipt, receipt);
}
