import {
  BundleAdmissionReceiptSchema,
  QualificationReportSchema,
  SourceAdmissionDecisionSchema,
  type BundleAdmissionReceipt,
} from "@eliotr/contracts";
import { canonicalJson } from "./ingest-validation.js";
import { objectResidencyKeyDigest } from "./r2.js";
import type {
  IngestAdmissionAuthority,
  IngestAdmissionPolicySnapshot,
  PrepareIngestAuthorityInput,
  PreparedIngestOperation,
  RecordQualificationDecisionInput,
} from "./d1-ingest-types.js";
import {
  IngestAuthorityError,
  authorityFail,
  authorityIdentifier,
  canonicalDigest,
  decodeOperationRow,
  decodePolicyRow,
  ingestInputFingerprint,
  normalizePrepareInput,
  stableIngestId,
  type ActiveOwnerRow,
  type AdmissionPolicyRow,
  type ExistingSourceRow,
  type IngestOperationRow,
} from "./d1-ingest-validation.js";
import { commitAdmittedBundle } from "./d1-ingest-commit.js";

const OPERATION_SELECT =
  "SELECT operation_id, principal_ref, origin_authentication_receipt_ref, idempotency_key, " +
  "input_fingerprint, manifest_sha256, manifest_json, file_hashes_json, total_bytes, " +
  "source_namespace_id, owner_system_id, source_owner_generation, source_revision_ref, " +
  "source_id, expected_head_revision_ref, residency_key_json, residency_key_digest, " +
  "policy_revision, policy_snapshot_json, policy_snapshot_sha256, candidate_id, " +
  "staging_session_ref, qualification_report_ref, decision_receipt_ref, " +
  "promotion_receipt_ref, state, bundle_receipt_json, bundle_receipt_sha256, " +
  "created_at, updated_at, expires_at FROM bundle_ingest_operation ";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export interface D1IngestAdmissionDependencies {
  readonly now?: () => number;
  readonly operation_ttl_ms?: number;
}

async function readOperation(
  database: D1Database,
  clause: string,
  ...values: readonly unknown[]
): Promise<PreparedIngestOperation | null> {
  const row = await database.prepare(`${OPERATION_SELECT}${clause} LIMIT 1`)
    .bind(...values).first<IngestOperationRow>();
  return row === null ? null : decodeOperationRow(row);
}

async function readByIdempotency(
  database: D1Database,
  principalRef: string,
  idempotencyKey: string,
): Promise<PreparedIngestOperation | null> {
  return readOperation(database, "WHERE principal_ref = ?1 AND idempotency_key = ?2", principalRef, idempotencyKey);
}

async function activeOwner(
  database: D1Database,
  namespaceId: string,
): Promise<ActiveOwnerRow> {
  const row = await database.prepare(
    "SELECT source_namespace_id, ownership_record_revision, owner_system_id, " +
    "source_owner_generation, source_admission_policy_revision, status, cutover_receipt_ref " +
    "FROM source_namespace_ownership WHERE source_namespace_id = ?1 AND status = 'ACTIVE' " +
    "ORDER BY ownership_record_revision DESC LIMIT 1",
  ).bind(namespaceId).first<ActiveOwnerRow>();
  if (row === null) authorityFail("INGEST_OWNER_NOT_ACTIVE", "source namespace has no active owner");
  return row;
}

async function policySnapshot(
  database: D1Database,
  namespaceId: string,
  revision: number,
): Promise<IngestAdmissionPolicySnapshot> {
  const row = await database.prepare(
    "SELECT source_namespace_id, revision, authorized_principal_refs_json, " +
    "allowed_ownership_modes_json, source_class, assurance_ceiling, instruction_taint, " +
    "allowed_effects, allowed_use_json, disclosure_ceiling, license_policy_ref, " +
    "default_storage_policy, default_residency_profile_id, default_retention_policy_id, " +
    "minimum_quality_state, created_at FROM source_admission_policy " +
    "WHERE source_namespace_id = ?1 AND revision = ?2 LIMIT 1",
  ).bind(namespaceId, revision).first<AdmissionPolicyRow>();
  if (row === null) authorityFail("INGEST_POLICY_DENIED", "active source admission policy is missing");
  return decodePolicyRow(row);
}

async function existingSource(
  database: D1Database,
  sourceId: string,
): Promise<ExistingSourceRow | null> {
  return database.prepare(
    "SELECT source_id, source_namespace_id, source_owner_system_id, " +
    "source_owner_generation, ownership_mode, head_rev FROM source WHERE source_id = ?1 LIMIT 1",
  ).bind(sourceId).first<ExistingSourceRow>();
}

function ensureOwnerAndPolicy(
  input: Awaited<ReturnType<typeof normalizePrepareInput>>,
  owner: ActiveOwnerRow,
  policy: IngestAdmissionPolicySnapshot,
): void {
  const manifest = input.manifest;
  if (
    owner.source_namespace_id !== manifest.origin.source_namespace_id ||
    owner.owner_system_id !== manifest.origin.owner_system_id ||
    owner.source_owner_generation !== manifest.origin.source_owner_generation ||
    owner.status !== "ACTIVE"
  ) {
    authorityFail("INGEST_OWNER_NOT_ACTIVE", "normalized bundle owner generation is not active");
  }
  if (
    typeof owner.source_admission_policy_revision !== "number" ||
    owner.source_admission_policy_revision !== policy.revision
  ) {
    authorityFail("INGEST_POLICY_DENIED", "active owner policy revision is inconsistent");
  }
  const cutoverRef = manifest.origin.ownership_cutover_receipt_ref;
  if (manifest.origin.ownership_mode === "ownership_cutover") {
    if (typeof owner.cutover_receipt_ref !== "string" || owner.cutover_receipt_ref !== cutoverRef) {
      authorityFail("INGEST_OWNER_NOT_ACTIVE", "ownership cutover receipt is not bound to the active owner");
    }
  } else if (owner.cutover_receipt_ref !== null && cutoverRef !== undefined) {
    authorityFail("INGEST_OWNER_NOT_ACTIVE", "unexpected ownership cutover receipt");
  }
  if (!policy.authorized_principal_refs.includes(input.principal_ref)) {
    authorityFail("INGEST_POLICY_DENIED", "principal is not authorized by the source admission policy");
  }
  if (!policy.allowed_ownership_modes.includes(manifest.origin.ownership_mode)) {
    authorityFail("INGEST_POLICY_DENIED", "ownership mode is not allowed by the source admission policy");
  }
  if (manifest.residency_and_disclosure.disclosure_ceiling !== policy.disclosure_ceiling) {
    authorityFail("INGEST_POLICY_DENIED", "manifest disclosure ceiling does not match policy");
  }
  if (manifest.residency_and_disclosure.allowed_use.some((use) => !policy.allowed_use.includes(use))) {
    authorityFail("INGEST_POLICY_DENIED", "manifest requests an allowed-use capability outside policy");
  }
}

function ensureExistingSource(
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
function exactReplay(existing: PreparedIngestOperation, fingerprint: string): PreparedIngestOperation {
  if (existing.input_fingerprint !== fingerprint) {
    authorityFail("INGEST_AUTHORITY_CONFLICT", "principal idempotency identity is already bound to different ingest input");
  }
  return existing;
}

function qualityStateForDecision(decision: string): "AUTHORIZED" | "QUARANTINED" | "REJECTED" {
  if (decision === "ADMITTED") return "AUTHORIZED";
  if (decision === "QUARANTINED") return "QUARANTINED";
  return "REJECTED";
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function createD1IngestAdmissionAuthority(
  database: D1Database,
  dependencies: D1IngestAdmissionDependencies = {},
): IngestAdmissionAuthority {
  const clock = dependencies.now ?? Date.now;
  const ttl = dependencies.operation_ttl_ms ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 7 * 24 * 60 * 60 * 1000) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "operation_ttl_ms is outside its allowed range");
  }

  const authority: IngestAdmissionAuthority = {
    async prepare(rawInput: PrepareIngestAuthorityInput) {
      const input = await normalizePrepareInput(rawInput);
      const owner = await activeOwner(database, input.manifest.origin.source_namespace_id);
      if (typeof owner.source_admission_policy_revision !== "number") {
        authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "owner policy revision is malformed");
      }
      const policy = await policySnapshot(
        database,
        input.manifest.origin.source_namespace_id,
        owner.source_admission_policy_revision,
      );
      ensureOwnerAndPolicy(input, owner, policy);
      const expectedHead = ensureExistingSource(
        await existingSource(database, input.manifest.source.logical_id),
        input,
      );
      const manifestSha = await canonicalDigest(input.manifest);
      const residencyDigest = await objectResidencyKeyDigest(input.residency_key);
      const policySha = await canonicalDigest(policy);
      const fingerprintFor = (head: string | null) => ingestInputFingerprint({
        ...input,
        residency_key_digest: residencyDigest,
        expected_head_revision_ref: head,
        policy_snapshot_sha256: policySha,
      });
      const prior = await readByIdempotency(database, input.principal_ref, input.idempotency_key);
      if (prior !== null) return { disposition: "EXISTING", operation: exactReplay(prior, await fingerprintFor(prior.expected_head_revision_ref)) };
      const fingerprint = await fingerprintFor(expectedHead);
      const operationId = await stableIngestId("ingest", input.principal_ref, input.idempotency_key);
      const candidateId = await stableIngestId("candidate", operationId);
      const createdEpoch = clock();
      if (!Number.isSafeInteger(createdEpoch) || createdEpoch < 0) {
        authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "ingest authority clock is invalid");
      }
      const createdAt = new Date(createdEpoch).toISOString();
      const expiresAt = new Date(createdEpoch + ttl).toISOString();
      const manifestJson = canonicalJson(input.manifest);
      const fileHashesJson = canonicalJson(input.file_hashes);
      const residencyJson = canonicalJson(input.residency_key);
      const policyJson = canonicalJson(policy);
      try {
        const results = await database.batch([
          database.prepare(
            "INSERT INTO bundle_ingest_operation(" +
            "operation_id, principal_ref, origin_authentication_receipt_ref, idempotency_key, " +
            "input_fingerprint, manifest_sha256, manifest_json, file_hashes_json, total_bytes, " +
            "source_namespace_id, owner_system_id, source_owner_generation, source_revision_ref, " +
            "source_id, expected_head_revision_ref, residency_key_json, residency_key_digest, " +
            "policy_revision, policy_snapshot_json, policy_snapshot_sha256, candidate_id, state, " +
            "created_at, updated_at, expires_at) VALUES (" +
            "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,'PREPARING',?22,?22,?23)",
          ).bind(
            operationId,
            input.principal_ref,
            input.origin_authentication_receipt_ref,
            input.idempotency_key,
            fingerprint,
            manifestSha,
            manifestJson,
            fileHashesJson,
            input.total_bytes,
            input.manifest.origin.source_namespace_id,
            input.manifest.origin.owner_system_id,
            input.manifest.origin.source_owner_generation,
            input.manifest.origin.source_revision_ref,
            input.manifest.source.logical_id,
            expectedHead,
            residencyJson,
            residencyDigest,
            policy.revision,
            policyJson,
            policySha,
            candidateId,
            createdAt,
            expiresAt,
          ),
          database.prepare(
            "INSERT INTO source_acquisition_candidate(" +
            "candidate_id, revision, operation_id, observed_locator_identifier_or_upload_ref, " +
            "proposer_principal_ref, proposed_source_class, purpose, " +
            "requested_scope_expression_json, untrusted_metadata_json, policy_refs_json, state, " +
            "effect_ceiling, created_at, expires_at) VALUES (" +
            "?1,1,?2,?3,?4,?5,?6,?7,?8,?9,'OBSERVED','NO_EXTERNAL_EFFECT',?10,?11)",
          ).bind(
            candidateId,
            operationId,
            `normalized-upload:${input.manifest.origin.source_revision_ref}`,
            input.principal_ref,
            policy.source_class,
            input.manifest.export.purpose,
            canonicalJson({ scope_domain_id: input.manifest.residency_and_disclosure.scope_domain_id }),
            canonicalJson({
              original_name: input.manifest.source.original_name,
              mime_type: input.manifest.source.mime_type,
              origin_location_class: input.manifest.source.origin_location_class,
            }),
            canonicalJson([`source-policy:${policy.source_namespace_id}:${policy.revision}`]),
            createdAt,
            expiresAt,
          ),
        ]);
        if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
          authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "ingest prepare batch did not create exact authority", true);
        }
      } catch (cause) {
        const raced = await readByIdempotency(database, input.principal_ref, input.idempotency_key);
        if (raced !== null) return { disposition: "EXISTING", operation: exactReplay(raced, await fingerprintFor(raced.expected_head_revision_ref)) };
        if (cause instanceof IngestAuthorityError) throw cause;
        authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "ingest prepare authority failed", true, cause);
      }
      const readback = await readOperation(database, "WHERE operation_id = ?1", operationId);
      if (readback === null) authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "ingest prepare readback is missing", true);
      return { disposition: "CREATED", operation: exactReplay(readback, fingerprint) };
    },

    async bindStagingSession(operationId, stagingSessionRef) {
      const id = authorityIdentifier(operationId, "operation_id");
      const session = authorityIdentifier(stagingSessionRef, "staging session ref");
      const existing = await authority.load(id);
      if (existing === null) authorityFail("INGEST_AUTHORITY_MISSING", "ingest operation does not exist");
      if (existing.bundle_receipt !== null) return existing;
      if (existing.staging_session_ref !== null && existing.staging_session_ref !== session) {
        authorityFail("INGEST_AUTHORITY_CONFLICT", "ingest operation is bound to another staging session");
      }
      const updatedAt = new Date(clock()).toISOString();
      try {
        await database.batch([
          database.prepare(
            "UPDATE bundle_ingest_operation SET staging_session_ref = COALESCE(staging_session_ref, ?2), " +
            "state = CASE WHEN state = 'PREPARING' THEN 'UPLOAD_REQUIRED' ELSE state END, updated_at = ?3 " +
            "WHERE operation_id = ?1 AND (staging_session_ref IS NULL OR staging_session_ref = ?2) " +
            "AND state IN ('PREPARING','UPLOAD_REQUIRED','VERIFIED','AUTHORIZED')",
          ).bind(id, session, updatedAt),
          database.prepare(
            "UPDATE source_acquisition_candidate SET staging_object_ref = COALESCE(staging_object_ref, ?2), " +
            "state = CASE WHEN state = 'OBSERVED' THEN 'RESOLVING' ELSE state END " +
            "WHERE operation_id = ?1 AND (staging_object_ref IS NULL OR staging_object_ref = ?2) " +
            "AND state IN ('OBSERVED','RESOLVING')",
          ).bind(id, session),
        ]);
      } catch (cause) {
        authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "staging-session binding failed", true, cause);
      }
      const readback = await authority.load(id);
      if (readback === null || readback.staging_session_ref !== session) {
        authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "staging-session binding readback mismatch", true);
      }
      return readback;
    },

    async load(operationId) {
      return readOperation(
        database,
        "WHERE operation_id = ?1",
        authorityIdentifier(operationId, "operation_id"),
      );
    },

    async loadForPrincipal(operationId, principalRef) {
      return readOperation(
        database,
        "WHERE operation_id = ?1 AND principal_ref = ?2",
        authorityIdentifier(operationId, "operation_id"),
        authorityIdentifier(principalRef, "principal_ref"),
      );
    },

    async recordQualificationDecision(input: RecordQualificationDecisionInput) {
      const operation = await authority.load(input.operation_id);
      if (operation === null) authorityFail("INGEST_AUTHORITY_MISSING", "ingest operation does not exist");
      if (operation.staging_session_ref !== input.staging_session_ref) {
        authorityFail("INGEST_AUTHORITY_CONFLICT", "qualification is bound to another staging session");
      }
      let qualification;
      let decision;
      try {
        qualification = QualificationReportSchema.parse(input.qualification);
        decision = SourceAdmissionDecisionSchema.parse(input.decision);
      } catch (cause) {
        authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "qualification or decision failed strict validation", false, cause);
      }
      const expectedReportRef = `${qualification.report_ref.id}:${qualification.report_ref.revision}`;
      const exact = qualification.source_revision_ref === operation.source_revision_ref &&
        decision.source_namespace_id === operation.source_namespace_id &&
        decision.owner_system_id === operation.owner_system_id &&
        decision.source_owner_generation === operation.source_owner_generation &&
        decision.source_revision_ref === operation.source_revision_ref &&
        decision.origin_authentication_receipt_ref === operation.origin_authentication_receipt_ref &&
        decision.source_class === operation.policy.source_class &&
        decision.object_residency_key_digest === operation.residency_key_digest &&
        decision.disclosure_ceiling === operation.policy.disclosure_ceiling &&
        decision.license_policy_ref === operation.policy.license_policy_ref &&
        decision.instruction_taint === operation.policy.instruction_taint &&
        decision.allowed_effects === operation.policy.allowed_effects &&
        decision.allowed_use.every((use) => operation.policy.allowed_use.includes(use)) &&
        decision.allowed_use.every((use) => operation.manifest.residency_and_disclosure.allowed_use.includes(use));
      if (!exact) authorityFail("INGEST_AUTHORITY_CONFLICT", "admission decision does not match prepared authority");
      if (!sameStringSet(decision.allowed_use, operation.manifest.residency_and_disclosure.allowed_use)) {
        authorityFail("INGEST_POLICY_DENIED", "admission decision changed the manifest allowed-use set");
      }
      const reportJson = canonicalJson(qualification);
      const reportSha = await canonicalDigest(qualification);
      const decisionJson = canonicalJson(decision);
      const decisionSha = await canonicalDigest(decision);
      const nextState = qualityStateForDecision(decision.decision);
      const candidateState = decision.decision === "REJECTED" ? "REJECTED" : "CAPTURED";
      const updatedAt = new Date(clock()).toISOString();
      try {
        await database.batch([
          database.prepare(
            "INSERT INTO qualification_report(report_id, revision, operation_id, source_revision_ref, " +
            "parser_profile_generation, checks_json, overall, exact_precision_ceiling, warnings_json, " +
            "report_json, report_sha256, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) " +
            "ON CONFLICT(operation_id) DO NOTHING",
          ).bind(
            qualification.report_ref.id,
            qualification.report_ref.revision,
            operation.operation_id,
            qualification.source_revision_ref,
            qualification.parser_profile_generation,
            canonicalJson(qualification.checks),
            qualification.overall,
            qualification.exact_precision_ceiling,
            canonicalJson(qualification.warnings),
            reportJson,
            reportSha,
            qualification.created_at,
          ),
          database.prepare(
            "INSERT INTO source_admission_decision(decision_receipt_ref, operation_id, source_namespace_id, " +
            "owner_system_id, source_owner_generation, source_revision_ref, origin_authentication_receipt_ref, " +
            "source_class, assurance_ceiling, instruction_taint, allowed_effects, object_residency_key_digest, " +
            "allowed_use_json, disclosure_ceiling, license_policy_ref, expires_at, decision, reason_codes_json, " +
            "decision_json, decision_sha256, created_at) VALUES (" +
            "?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21) " +
            "ON CONFLICT(operation_id) DO NOTHING",
          ).bind(
            decision.decision_receipt_ref,
            operation.operation_id,
            decision.source_namespace_id,
            decision.owner_system_id,
            decision.source_owner_generation,
            decision.source_revision_ref,
            decision.origin_authentication_receipt_ref,
            decision.source_class,
            decision.assurance_ceiling,
            decision.instruction_taint,
            decision.allowed_effects,
            decision.object_residency_key_digest,
            canonicalJson(decision.allowed_use),
            decision.disclosure_ceiling,
            decision.license_policy_ref,
            decision.expires_at ?? null,
            decision.decision,
            canonicalJson(decision.reason_codes),
            decisionJson,
            decisionSha,
            updatedAt,
          ),
          database.prepare(
            "UPDATE source_acquisition_candidate SET state = ?2, terminal_receipt_ref = ?3 " +
            "WHERE operation_id = ?1 AND state IN ('OBSERVED','RESOLVING','CAPTURED','REJECTED')",
          ).bind(operation.operation_id, candidateState, decision.decision_receipt_ref),
          database.prepare(
            "UPDATE bundle_ingest_operation SET qualification_report_ref = ?2, decision_receipt_ref = ?3, " +
            "state = ?4, updated_at = ?5 WHERE operation_id = ?1 AND staging_session_ref = ?6 " +
            "AND state IN ('UPLOAD_REQUIRED','VERIFIED','AUTHORIZED','QUARANTINED','REJECTED')",
          ).bind(
            operation.operation_id,
            expectedReportRef,
            decision.decision_receipt_ref,
            nextState,
            updatedAt,
            input.staging_session_ref,
          ),
        ]);
      } catch (cause) {
        authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "qualification/decision authority failed", true, cause);
      }
      const readback = await authority.load(operation.operation_id);
      if (
        readback === null ||
        readback.qualification_report_ref !== expectedReportRef ||
        readback.decision_receipt_ref !== decision.decision_receipt_ref ||
        readback.state !== nextState
      ) {
        authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "qualification/decision readback mismatch", true);
      }
      return readback;
    },

    async finalizeNonAdmitted(operationId, rawReceipt) {
      let receipt: BundleAdmissionReceipt;
      try { receipt = BundleAdmissionReceiptSchema.parse(rawReceipt); }
      catch (cause) {
        authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "bundle receipt failed strict validation", false, cause);
      }
      if (receipt.decision !== "QUARANTINED" && receipt.decision !== "REJECTED") {
        authorityFail("INGEST_STATE_CONFLICT", "non-admitted finalization requires a non-admitted receipt");
      }
      const operation = await authority.load(operationId);
      if (operation === null || operation.decision_receipt_ref === null) {
        authorityFail("INGEST_AUTHORITY_MISSING", "admission decision authority is missing");
      }
      if (operation.bundle_receipt !== null) {
        if (canonicalJson(operation.bundle_receipt) !== canonicalJson(receipt)) {
          authorityFail("INGEST_AUTHORITY_CONFLICT", "terminal receipt already differs");
        }
        return operation.bundle_receipt;
      }
      if (
        operation.operation_id !== receipt.operation_id ||
        operation.manifest_sha256 !== receipt.manifest_sha256 ||
        operation.source_revision_ref !== receipt.source_revision_ref ||
        operation.residency_key_digest !== receipt.object_residency_key_digest ||
        operation.state !== receipt.decision
      ) {
        authorityFail("INGEST_AUTHORITY_CONFLICT", "terminal non-admitted receipt does not match authority");
      }
      const receiptJson = canonicalJson(receipt);
      const receiptSha = await canonicalDigest(receipt);
      const updatedAt = new Date(clock()).toISOString();
      try {
        await database.prepare(
          "UPDATE bundle_ingest_operation SET bundle_receipt_json = ?2, bundle_receipt_sha256 = ?3, " +
          "updated_at = ?4 WHERE operation_id = ?1 AND bundle_receipt_json IS NULL " +
          "AND state = ?5 AND decision_receipt_ref IS NOT NULL",
        ).bind(operation.operation_id, receiptJson, receiptSha, updatedAt, receipt.decision).run();
      } catch (cause) {
        authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "terminal non-admitted receipt write failed", true, cause);
      }
      const readback = await authority.load(operation.operation_id);
      if (readback?.bundle_receipt === null || readback?.bundle_receipt === undefined) {
        authorityFail("INGEST_SETTLEMENT_UNCERTAIN", "terminal non-admitted receipt readback is missing", true);
      }
      if (canonicalJson(readback.bundle_receipt) !== receiptJson) {
        authorityFail("INGEST_AUTHORITY_CONFLICT", "terminal non-admitted receipt readback differs");
      }
      return readback.bundle_receipt;
    },

    async authorizePromotion(input, admissionReceiptRef) {
      const operation = await authority.load(input.session_id.startsWith("ingest-")
        ? input.session_id
        : await operationIdForSession(database, input.session_id));
      if (operation === null) return false;
      return operation.state === "AUTHORIZED" &&
        operation.staging_session_ref === input.session_id &&
        operation.input_fingerprint === input.input_fingerprint &&
        operation.residency_key_digest === input.residency_key_digest &&
        operation.owner_system_id === input.owner_system_id &&
        operation.source_namespace_id === input.source_namespace_id &&
        operation.source_owner_generation === input.source_owner_generation &&
        operation.source_revision_ref === input.source_revision_ref &&
        operation.decision_receipt_ref === admissionReceiptRef &&
        await decisionIsAdmitted(database, operation.operation_id, admissionReceiptRef);
    },

    async commitAdmitted(input) {
      return commitAdmittedBundle(database, input, authority.load, clock);
    },
  };
  return authority;
}

async function operationIdForSession(database: D1Database, sessionRef: string): Promise<string> {
  const row = await database.prepare(
    "SELECT operation_id FROM bundle_ingest_operation WHERE staging_session_ref = ?1 LIMIT 1",
  ).bind(authorityIdentifier(sessionRef, "staging session ref"))
    .first<{ operation_id: unknown }>();
  if (row === null) return "missing-operation";
  return authorityIdentifier(row.operation_id, "operation_id");
}

async function decisionIsAdmitted(
  database: D1Database,
  operationId: string,
  decisionReceiptRef: string,
): Promise<boolean> {
  const row = await database.prepare(
    "SELECT decision FROM source_admission_decision " +
    "WHERE operation_id = ?1 AND decision_receipt_ref = ?2 LIMIT 1",
  ).bind(operationId, decisionReceiptRef).first<{ decision: unknown }>();
  return row?.decision === "ADMITTED";
}

export { IngestAuthorityError } from "./d1-ingest-validation.js";
export type { IngestAuthorityErrorCode } from "./d1-ingest-validation.js";
