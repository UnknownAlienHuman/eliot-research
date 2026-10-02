import { OperationIntentSchema, type ArtifactRevision, type OperationIntent, type VersionedRef } from "@eliotr/contracts";
import { canonicalDigest, canonicalJson, prepareIntentWithOutboxMutation } from "@eliotr/platform-cloudflare";
import type { ArtifactDraftReadError } from "./artifact-draft-reader-core.js";
import {
  ACCEPT_TOPIC, SHA256, ArtifactPublicationError, type ArtifactPublicationErrorCode,
  type CreateArtifactPublicationProducerInput, type ArtifactPublicationAuthorityInput,
  type AcceptArtifactInput, type ArtifactOwnerAcceptanceDecision,
  type ResolveArtifactAcceptanceDecisionInput, type ReadArtifactPublicationInput,
  type ArtifactPublicationReceipt, type ArtifactPublicationResult, type ArtifactPublicationRead,
  type PublicationRow, type ReadinessSnapshot, fail, validText, validRevision, parseRef, nowIso,
  decodeCanonical, safeString, safePositive, deterministicRef, readinessSnapshot,
  verificationIdentity, currentnessIdentity,
} from "./artifact-publication-internals.js";

export { ArtifactPublicationError };
export type {
  ArtifactPublicationErrorCode, CreateArtifactPublicationProducerInput, ArtifactPublicationAuthorityInput,
  AcceptArtifactInput, ArtifactOwnerAcceptanceDecision, ResolveArtifactAcceptanceDecisionInput,
  ReadArtifactPublicationInput, ArtifactPublicationReceipt, ArtifactPublicationResult,
  ArtifactPublicationRead,
};
export { ArtifactPublicationReadinessError } from "./artifact-publication-policy.js";
function decodePublicationRow(row: PublicationRow): ArtifactPublicationReceipt {
  const artifactId = safeString(row.artifact_id, "publication artifact id");
  const draftRevision = safePositive(row.draft_revision, "publication draft revision");
  const publicationRevision = safePositive(row.publication_revision, "publication revision");
  const manifestSha = safeString(row.manifest_sha256, "publication manifest digest");
  const verificationSha = safeString(row.verification_set_sha256, "publication verification digest");
  const currentnessSha = safeString(row.evidence_currentness_sha256, "publication currentness digest");
  const acceptanceSha = safeString(row.acceptance_decision_sha256, "acceptance decision digest");
  if (!SHA256.test(manifestSha) || !SHA256.test(verificationSha) || !SHA256.test(currentnessSha) || !SHA256.test(acceptanceSha)) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication digest is malformed");
  }
  const decisionJson = decodeCanonical(row.acceptance_decision_json, "acceptance decision");
  if (decisionJson === null || typeof decisionJson !== "object" || Array.isArray(decisionJson)) fail("ARTIFACT_PUBLICATION_INTEGRITY", "acceptance decision shape is invalid");
  const expectedDecisionKeys = [
    "protocol", "mode", "artifact_ref", "expected_draft_head_revision", "expected_publication_revision",
    "principal_ref", "credential_generation", "idempotency_key", "decision_ref", "provenance_ref", "expires_at",
  ].sort();
  if (Object.keys(decisionJson).sort().join("\u0000") !== expectedDecisionKeys.join("\u0000")) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "acceptance decision contains unsupported fields");
  }
  const decision = decisionJson as Partial<ArtifactOwnerAcceptanceDecision>;
  const decisionArtifact = parseRef(decision.artifact_ref, "persisted acceptance artifact reference");
  const decisionExpectedPublication = validRevision(decision.expected_publication_revision, "persisted expected publication revision", true);
  if (decision.protocol !== "eliotr.artifact-owner-acceptance.v1" || decision.mode !== "OWNER_EXPLICIT" ||
      decisionArtifact.id !== artifactId || decisionArtifact.revision !== draftRevision ||
      decision.expected_draft_head_revision !== draftRevision || decisionExpectedPublication !== row.expected_publication_revision ||
      decision.principal_ref !== row.principal_ref || typeof decision.credential_generation !== "string" ||
      decision.credential_generation !== row.credential_generation || decision.idempotency_key !== row.idempotency_key ||
      decision.decision_ref !== row.acceptance_decision_ref || decision.provenance_ref !== row.acceptance_provenance_ref ||
      typeof decision.expires_at !== "string" || !Number.isFinite(Date.parse(decision.expires_at)) ||
      canonicalJson(decisionJson) !== row.acceptance_decision_json) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "persisted acceptance decision does not match receipt authority");
  }
  return {
    publication_ref: safeString(row.publication_ref, "publication reference"),
    artifact_ref: { id: artifactId, revision: draftRevision },
    publication_revision: publicationRevision,
    manifest_sha256: manifestSha,
    verification_set_sha256: verificationSha,
    evidence_currentness_sha256: currentnessSha,
    acceptance_decision_ref: safeString(row.acceptance_decision_ref, "acceptance decision reference"),
    acceptance_provenance_ref: safeString(row.acceptance_provenance_ref, "acceptance provenance reference"),
    acceptance_decision_sha256: acceptanceSha,
    principal_ref: safeString(row.principal_ref, "publication principal"),
    authorization_receipt_ref: safeString(row.authorization_receipt_ref, "publication authorization receipt"),
    created_at: safeString(row.created_at, "publication creation time"),
  };
}

async function readPublicationRow(
  database: D1Database,
  artifactRef: VersionedRef,
): Promise<PublicationRow | null> {
  return database.prepare(
    "SELECT p.publication_ref,p.artifact_id,p.draft_revision,p.intent_id,p.intent_revision,p.attempt_id,p.idempotency_key, " +
    "p.operation_receipt_id,p.operation_receipt_revision,p.principal_ref,p.acceptance_decision_ref,p.acceptance_provenance_ref, " +
    "p.acceptance_decision_json,p.acceptance_decision_sha256,p.authorization_scope_id,p.authorization_scope_revision, " +
    "p.authorization_receipt_ref,p.policy_authority_ref,p.credential_generation,p.deployment_generation, " +
      "p.expected_publication_revision,p.publication_revision,p.expected_draft_head_revision,p.manifest_sha256, " +
    "p.verification_set_json,p.verification_set_sha256,p.evidence_currentness_json,p.evidence_currentness_sha256, " +
    "p.purge_ledger_revision,p.created_at,h.disposition,h.publication_ref AS head_publication_ref, " +
    "h.publication_revision AS head_publication_revision,r.outcome AS operation_outcome, " +
    "r.reconciliation_required AS operation_reconciliation_required,r.output_refs_json AS operation_output_refs_json, " +
    "r.readback_receipt_refs_json AS operation_readback_refs_json,i.principal_ref AS operation_principal_ref, " +
    "i.operation_kind,i.idempotency_key AS operation_idempotency_key,i.policy_decision_ref AS operation_policy_decision_ref, " +
    "o.outbox_id,o.topic AS outbox_topic,o.payload_sha256 AS outbox_payload_sha256, " +
    "a.state AS attempt_state,a.attempt_number " +
    "FROM artifact_publication_receipt p " +
    "JOIN operation_intent i ON i.intent_id=p.intent_id AND i.revision=p.intent_revision " +
    "JOIN operation_attempt a ON a.attempt_id=p.attempt_id AND a.intent_id=p.intent_id AND a.intent_revision=p.intent_revision " +
    "JOIN operation_receipt r ON r.receipt_id=p.operation_receipt_id AND r.revision=p.operation_receipt_revision " +
    "JOIN outbox o ON o.outbox_id=p.outbox_id AND o.intent_id=p.intent_id AND o.intent_revision=p.intent_revision " +
    "LEFT JOIN artifact_publication_head h ON h.artifact_id=p.artifact_id " +
    "WHERE p.artifact_id=?1 AND p.draft_revision=?2 LIMIT 1",
  ).bind(artifactRef.id, artifactRef.revision).first<PublicationRow>();
}

async function validatePersistedPublication(row: PublicationRow, expected?: {
  readonly principal_ref: string;
  readonly intent: OperationIntent;
  readonly payload_sha256: string;
  readonly expected_publication_revision: number | null;
  readonly readiness: ReadinessSnapshot;
  readonly acceptance_decision: ArtifactOwnerAcceptanceDecision;
  readonly acceptance_decision_sha256: string;
}): Promise<ArtifactPublicationReceipt> {
  const receipt = decodePublicationRow(row);
  const acceptanceDecision = decodeCanonical(row.acceptance_decision_json, "acceptance decision");
  const verification = decodeCanonical(row.verification_set_json, "publication verification set");
  const currentness = decodeCanonical(row.evidence_currentness_json, "publication evidence currentness");
  if (!Array.isArray(verification) || !Array.isArray(currentness) || currentness.length === 0) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication evidence record is incomplete");
  }
  if (await canonicalDigest(acceptanceDecision) !== receipt.acceptance_decision_sha256 ||
      await canonicalDigest(verificationIdentity(verification)) !== receipt.verification_set_sha256 ||
      await canonicalDigest(currentness) !== receipt.evidence_currentness_sha256) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication authority digest does not match its persisted bytes");
  }
  if (row.operation_kind !== "ARTIFACT_PUBLISH" || row.operation_outcome !== "ACCEPTED" ||
      (row.operation_reconciliation_required !== 1 && row.operation_reconciliation_required !== 0) || row.attempt_state !== "SUCCEEDED" ||
      row.attempt_number !== 1 || row.head_publication_ref === null || row.head_publication_revision === null ||
      row.operation_principal_ref !== row.principal_ref || row.operation_idempotency_key !== row.idempotency_key ||
      row.operation_policy_decision_ref !== row.acceptance_decision_ref || row.outbox_topic !== ACCEPT_TOPIC ||
      row.outbox_payload_sha256 === null || row.outbox_id === null) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "canonical operation receipt does not match publication authority");
  }
  const outputRefs = decodeCanonical(row.operation_output_refs_json, "operation output references");
  const readbackRefs = decodeCanonical(row.operation_readback_refs_json, "operation readback references");
  if (!Array.isArray(outputRefs) || outputRefs.length !== 1 || outputRefs[0] !== receipt.publication_ref ||
      !Array.isArray(readbackRefs) || readbackRefs.length !== 1 || readbackRefs[0] !== receipt.publication_ref) {
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "operation receipt does not bind the publication reference");
  }
  if (expected !== undefined) {
    if (receipt.principal_ref !== expected.principal_ref || row.intent_id !== expected.intent.intent_ref.id ||
        row.intent_revision !== expected.intent.intent_ref.revision || row.outbox_payload_sha256 !== expected.payload_sha256 ||
        row.idempotency_key !== expected.intent.idempotency_key ||
        row.expected_publication_revision !== expected.expected_publication_revision ||
        receipt.artifact_ref.id !== expected.readiness.draft.artifact_ref.id ||
        receipt.artifact_ref.revision !== expected.readiness.draft.artifact_ref.revision ||
        receipt.manifest_sha256 !== expected.readiness.manifest_sha256 ||
        receipt.verification_set_sha256 !== expected.readiness.verification_set_sha256 ||
        canonicalJson(currentnessIdentity(currentness)) !== canonicalJson(currentnessIdentity(expected.readiness.evidence_currentness))) {
      fail("ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT", "idempotent publication request differs from its persisted receipt");
    }
    if (receipt.acceptance_decision_sha256 !== expected.acceptance_decision_sha256 ||
        receipt.acceptance_decision_ref !== expected.acceptance_decision.decision_ref ||
        receipt.acceptance_provenance_ref !== expected.acceptance_decision.provenance_ref ||
        canonicalJson(acceptanceDecision) !== canonicalJson(expected.acceptance_decision)) {
      fail("ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT", "idempotent owner acceptance decision differs from its persisted receipt");
    }
  }
  return receipt;
}

function stableAttemptId(intentRef: VersionedRef): string {
  return `artifact-publish-attempt-${intentRef.id.slice(-32)}`;
}

function stableOperationReceiptId(intentRef: VersionedRef): string {
  return `artifact-publish-result-${intentRef.id.slice(-32)}`;
}

function validateOwnerAcceptanceDecision(
  raw: ArtifactOwnerAcceptanceDecision,
  input: AcceptArtifactInput,
  draft: ArtifactRevision,
  expectedDraftHead: number,
  expectedPublicationRevision: number | null,
  idempotencyKey: string,
  nowText: string,
): ArtifactOwnerAcceptanceDecision {
  const expectedKeys = [
    "protocol", "mode", "artifact_ref", "expected_draft_head_revision", "expected_publication_revision",
    "principal_ref", "credential_generation", "idempotency_key", "decision_ref", "provenance_ref", "expires_at",
  ].sort();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join("\u0000") !== expectedKeys.join("\u0000") ||
      raw.protocol !== "eliotr.artifact-owner-acceptance.v1" || raw.mode !== "OWNER_EXPLICIT") {
    fail("ARTIFACT_PUBLICATION_DENIED", "explicit owner acceptance decision is missing or invalid");
  }
  const artifactRef = parseRef(raw.artifact_ref, "acceptance decision artifact reference");
  const decisionRef = validText(raw.decision_ref, "acceptance decision reference");
  const provenanceRef = validText(raw.provenance_ref, "acceptance decision provenance");
  const expiry = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
  if (artifactRef.id !== draft.artifact_ref.id || artifactRef.revision !== draft.artifact_ref.revision ||
      raw.expected_draft_head_revision !== expectedDraftHead ||
      raw.expected_publication_revision !== expectedPublicationRevision ||
      raw.principal_ref !== input.access.principal_ref || raw.credential_generation !== input.access.credential_generation ||
      raw.idempotency_key !== idempotencyKey || !Number.isFinite(expiry) || expiry <= Date.parse(nowText) ||
      expiry > Date.parse(input.current_authorization.expires_at) || new Date(expiry).toISOString() !== raw.expires_at) {
    fail("ARTIFACT_PUBLICATION_DENIED", "owner acceptance decision is not bound to this exact request and current authorization");
  }
  return {
    protocol: raw.protocol,
    mode: raw.mode,
    artifact_ref: artifactRef,
    expected_draft_head_revision: expectedDraftHead,
    expected_publication_revision: expectedPublicationRevision,
    principal_ref: input.access.principal_ref,
    credential_generation: input.access.credential_generation,
    idempotency_key: idempotencyKey,
    decision_ref: decisionRef,
    provenance_ref: provenanceRef,
    expires_at: raw.expires_at,
  };
}

function activeStatus(row: PublicationRow, receipt: ArtifactPublicationReceipt): ArtifactRevision["status"] {
  if (row.head_publication_ref === receipt.publication_ref) {
    if (row.head_publication_revision !== receipt.publication_revision) fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication head revision differs from its receipt");
    if (row.disposition === "ACCEPTED" || row.disposition === "PENDING_REVALIDATION" || row.disposition === "REDACTED_DEPENDENCY") {
      return row.disposition;
    }
    fail("ARTIFACT_PUBLICATION_INTEGRITY", "publication head disposition is invalid");
  }
  return "SUPERSEDED";
}

export function createArtifactPublicationProducer(options: CreateArtifactPublicationProducerInput) {
  const now = options.now ?? Date.now;

  async function readIdempotentPublication(
    input: AcceptArtifactInput,
    artifactRef: VersionedRef,
    expectedDraftHead: number,
    expectedPublicationRevision: number | null,
    idempotencyKey: string,
  ): Promise<ArtifactPublicationResult | null> {
    const bound = await options.database.prepare(
      "SELECT artifact_id,draft_revision,expected_draft_head_revision,expected_publication_revision " +
      "FROM artifact_publication_receipt WHERE principal_ref=?1 AND idempotency_key=?2 LIMIT 1",
    ).bind(input.access.principal_ref, idempotencyKey).first<{
      readonly artifact_id: unknown;
      readonly draft_revision: unknown;
      readonly expected_draft_head_revision: unknown;
      readonly expected_publication_revision: unknown;
    }>();
    if (bound === null) return null;
    if (bound.artifact_id !== artifactRef.id || bound.draft_revision !== artifactRef.revision ||
        bound.expected_draft_head_revision !== expectedDraftHead ||
        bound.expected_publication_revision !== expectedPublicationRevision) {
      fail("ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT", "idempotency key is already bound to another publication request");
    }
    const replay = await readValidated(input);
    if (replay === null) fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "persisted idempotency binding has no readable publication", true);
    return { ...replay, disposition: "EXISTING" };
  }

  async function readValidated(input: ArtifactPublicationAuthorityInput): Promise<ArtifactPublicationRead | null> {
    const artifactRef = parseRef(input.artifact_ref, "artifact reference");
    const row = await readPublicationRow(options.database, artifactRef);
    if (row === null) return null;
    const receipt = await validatePersistedPublication(row);
    const readiness = await readinessSnapshot(options, input);
    const verification = decodeCanonical(row.verification_set_json, "publication verification set");
    const currentness = decodeCanonical(row.evidence_currentness_json, "publication currentness record");
    if (receipt.manifest_sha256 !== readiness.manifest_sha256 ||
        receipt.verification_set_sha256 !== readiness.verification_set_sha256 ||
        row.purge_ledger_revision !== readiness.purge_ledger_revision ||
        canonicalJson(verificationIdentity(verification)) !== canonicalJson(verificationIdentity(readiness.verification_set)) ||
        canonicalJson(currentnessIdentity(currentness)) !== canonicalJson(currentnessIdentity(readiness.evidence_currentness))) {
      fail("ARTIFACT_PUBLICATION_STALE", "accepted publication is no longer supported by its exact current evidence");
    }
    const status = activeStatus(row, receipt);
    return { receipt, revision: { ...readiness.draft, status } };
  }

  return {
    async accept(rawInput: AcceptArtifactInput): Promise<ArtifactPublicationResult> {
      const input = rawInput;
      const artifactRef = parseRef(input.artifact_ref, "artifact reference");
      const expectedDraftHead = validRevision(input.expected_draft_head_revision, "expected draft head");
      const expectedPublicationRevision = validRevision(input.expected_publication_revision, "expected publication revision", true);
      const idempotencyKey = validText(input.idempotency_key, "idempotency key");
      if (expectedDraftHead !== artifactRef.revision) fail("ARTIFACT_PUBLICATION_STALE", "acceptance must target the exact expected draft head");
      const previous = await readIdempotentPublication(input, artifactRef, expectedDraftHead, expectedPublicationRevision, idempotencyKey);
      if (previous !== null) return previous;
      const readiness = await readinessSnapshot(options, input);
      if (readiness.draft.artifact_ref.id !== artifactRef.id || readiness.draft.artifact_ref.revision !== artifactRef.revision) {
        fail("ARTIFACT_PUBLICATION_INTEGRITY", "draft reader returned a different revision");
      }
      const operationRequest = {
        artifact_ref: artifactRef,
        expected_draft_head_revision: expectedDraftHead,
        expected_publication_revision: expectedPublicationRevision,
      };
      if (options.resolve_acceptance_decision === undefined) {
        fail("ARTIFACT_PUBLICATION_DENIED", "explicit owner acceptance decision service is unavailable");
      }
      let acceptanceDecisionRaw: ArtifactOwnerAcceptanceDecision;
      try {
        acceptanceDecisionRaw = await options.resolve_acceptance_decision({
          artifact_ref: artifactRef,
          expected_draft_head_revision: expectedDraftHead,
          expected_publication_revision: expectedPublicationRevision,
          access: input.access,
          authorization: input.current_authorization,
          draft: readiness.draft,
        });
      } catch (cause) {
        fail("ARTIFACT_PUBLICATION_DENIED", "explicit owner acceptance decision could not be resolved", false, cause);
      }
      const acceptanceDecision = validateOwnerAcceptanceDecision(
        acceptanceDecisionRaw, input, readiness.draft, expectedDraftHead, expectedPublicationRevision,
        idempotencyKey, nowIso(now),
      );
      const acceptanceDecisionJson = canonicalJson(acceptanceDecision);
      const acceptanceDecisionSha = await canonicalDigest(acceptanceDecision);
      const requestSha = await canonicalDigest({ request: operationRequest, acceptance_decision_sha256: acceptanceDecisionSha });
      const principal = input.access.principal_ref;
      const intentId = deterministicRef("artifact-publish-intent", await canonicalDigest({ principal, idempotencyKey, acceptance_decision_sha256: acceptanceDecisionSha }));
      const createdAt = nowIso(now);
      const rawIntent: OperationIntent = {
        intent_ref: { id: intentId, revision: 1 },
        operation_kind: "ARTIFACT_PUBLISH",
        principal_ref: principal,
        idempotency_key: idempotencyKey,
        payload_ref: `artifact-publication-${requestSha}`,
        policy_decision_ref: acceptanceDecision.decision_ref,
        created_at: createdAt,
      };
      let intent: OperationIntent;
      try { intent = OperationIntentSchema.parse(rawIntent); }
      catch (cause) { fail("ARTIFACT_PUBLICATION_INPUT_INVALID", "server publication intent failed strict validation", false, cause); }
      const intentPlan = await prepareIntentWithOutboxMutation(options.database, {
        intent,
        topic: ACCEPT_TOPIC,
        payload_sha256: requestSha,
      });
      let existingIntent: Awaited<ReturnType<typeof intentPlan.readback>>;
      try { existingIntent = await intentPlan.readback(); }
      catch (cause) { fail("ARTIFACT_PUBLICATION_IDEMPOTENCY_CONFLICT", "idempotency key is bound to different publication input", false, cause); }
      if (existingIntent !== null) {
        const existingRow = await readPublicationRow(options.database, artifactRef);
        if (existingRow === null || existingRow.intent_id !== intent.intent_ref.id || existingRow.intent_revision !== intent.intent_ref.revision) {
          fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication intent exists without its acceptance readback", true);
        }
        const receipt = await validatePersistedPublication(existingRow, {
          principal_ref: principal,
          intent,
          payload_sha256: requestSha,
          expected_publication_revision: expectedPublicationRevision,
          readiness,
          acceptance_decision: acceptanceDecision,
          acceptance_decision_sha256: acceptanceDecisionSha,
        });
        const replay = await readValidated(input);
        if (replay === null || replay.receipt.publication_ref !== receipt.publication_ref) {
          fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "persisted publication could not be revalidated", true);
        }
        return { ...replay, disposition: "EXISTING" };
      }

      const attemptId = stableAttemptId(intent.intent_ref);
      const operationReceiptId = stableOperationReceiptId(intent.intent_ref);
      const publicationRef = deterministicRef("artifact-publication", await canonicalDigest({ artifactRef, intent: intent.intent_ref }));
      const publicationRevision = (expectedPublicationRevision ?? 0) + 1;
      const attemptInsert = options.database.prepare(
        "INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,state,started_at) " +
        "VALUES(?1,?2,?3,1,'STARTED',?4)",
      ).bind(attemptId, intent.intent_ref.id, intent.intent_ref.revision, createdAt);
      const operationReceiptInsert = options.database.prepare(
        "INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,attempt_id,outcome,output_refs_json,readback_receipt_refs_json,reconciliation_required,reason_codes_json,created_at) " +
        "VALUES(?1,1,?2,?3,?4,'ACCEPTED',?5,?5,1,'[]',?6)",
      ).bind(operationReceiptId, intent.intent_ref.id, intent.intent_ref.revision, attemptId,
        canonicalJson([publicationRef]), createdAt);
      const currentnessJson = canonicalJson(readiness.evidence_currentness);
      const verificationJson = canonicalJson(readiness.verification_set);
      const publicationInsert = options.database.prepare(
        "INSERT INTO artifact_publication_receipt(publication_ref,artifact_id,draft_revision,intent_id,intent_revision,attempt_id,operation_receipt_id,operation_receipt_revision,outbox_id,principal_ref,idempotency_key,acceptance_decision_ref,acceptance_provenance_ref,acceptance_decision_json,acceptance_decision_sha256,authorization_scope_id,authorization_scope_revision,authorization_receipt_ref,policy_authority_ref,credential_generation,authorization_expires_at,deployment_generation,expected_publication_revision,publication_revision,expected_draft_head_revision,manifest_sha256,verification_set_json,verification_set_sha256,evidence_currentness_json,evidence_currentness_sha256,purge_ledger_revision,created_at) " +
        "VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31)",
      ).bind(publicationRef, artifactRef.id, artifactRef.revision, intent.intent_ref.id, intent.intent_ref.revision,
        attemptId, operationReceiptId, intentPlan.outbox_id, principal, idempotencyKey,
        acceptanceDecision.decision_ref, acceptanceDecision.provenance_ref, acceptanceDecisionJson, acceptanceDecisionSha,
        readiness.authorization_scope.id, readiness.authorization_scope.revision, readiness.authorization_receipt_ref,
        readiness.policy_authority_ref, readiness.credential_generation, readiness.authorization_expires_at,
        readiness.deployment_generation, expectedPublicationRevision, publicationRevision, expectedDraftHead,
        readiness.manifest_sha256, verificationJson, readiness.verification_set_sha256, currentnessJson,
        readiness.evidence_currentness_sha256, readiness.purge_ledger_revision, createdAt);
      const headUpsert = options.database.prepare(
        "INSERT INTO artifact_publication_head(artifact_id,publication_revision,draft_revision,publication_ref,disposition,updated_at) " +
        "VALUES(?1,?2,?3,?4,'ACCEPTED',?5) " +
        "ON CONFLICT(artifact_id) DO UPDATE SET publication_revision=excluded.publication_revision,draft_revision=excluded.draft_revision, " +
        "publication_ref=excluded.publication_ref,disposition='ACCEPTED',updated_at=excluded.updated_at " +
        "WHERE artifact_publication_head.publication_revision=?6",
      ).bind(artifactRef.id, publicationRevision, artifactRef.revision, publicationRef, createdAt, expectedPublicationRevision);
      const headCasGuard = options.database.prepare(
        "INSERT INTO artifact_publication_mutation_guard(publication_ref,created_at) VALUES(?1,?2)",
      ).bind(publicationRef, createdAt);
      const attemptComplete = options.database.prepare(
        "UPDATE operation_attempt SET state='SUCCEEDED',ended_at=?2 WHERE attempt_id=?1 AND state='STARTED'",
      ).bind(attemptId, createdAt);
      const statements = [...intentPlan.statements, attemptInsert, operationReceiptInsert, publicationInsert,
        headUpsert, headCasGuard, attemptComplete];
      try {
        let transactionScope;
        try { transactionScope = await options.require_current(input.current_navigation.scope); }
        catch (cause) { fail("ARTIFACT_PUBLICATION_STALE", "owner scope was revoked before the publication transaction", false, cause); }
        if (transactionScope.snapshot_id !== readiness.authorization_scope.id ||
            transactionScope.revision !== readiness.authorization_scope.revision ||
            transactionScope.digest !== input.current_navigation.scope.digest) {
          fail("ARTIFACT_PUBLICATION_STALE", "owner scope changed before the publication transaction");
        }
        const results = await options.database.batch(statements);
        intentPlan.assertBatchResults(results, 0);
        if (results.length !== statements.length || results.slice(2).some((result) => result?.success !== true || (result.meta?.changes ?? 0) !== 1)) {
          fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication transaction did not mutate all expected rows", true);
        }
      } catch (cause) {
        const raced = await readPublicationRow(options.database, artifactRef).catch(() => null);
        if (raced !== null && raced.intent_id === intent.intent_ref.id && raced.intent_revision === intent.intent_ref.revision) {
          const receipt = await validatePersistedPublication(raced, {
            principal_ref: principal,
            intent,
            payload_sha256: requestSha,
            expected_publication_revision: expectedPublicationRevision,
            readiness,
            acceptance_decision: acceptanceDecision,
            acceptance_decision_sha256: acceptanceDecisionSha,
          });
          const replay = await readValidated(input);
          if (replay !== null && replay.receipt.publication_ref === receipt.publication_ref) return { ...replay, disposition: "EXISTING" };
        }
        if (cause instanceof ArtifactPublicationError) throw cause;
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication transaction failed or may have committed", true, cause);
      }

      let committed = await readPublicationRow(options.database, artifactRef);
      if (committed === null || committed.publication_ref !== publicationRef) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication receipt readback is missing", true);
      }
      const receipt = await validatePersistedPublication(committed, {
        principal_ref: principal,
        intent,
        payload_sha256: requestSha,
        expected_publication_revision: expectedPublicationRevision,
        readiness,
        acceptance_decision: acceptanceDecision,
        acceptance_decision_sha256: acceptanceDecisionSha,
      });
      const postCommit = await readValidated(input);
      if (postCommit === null || postCommit.receipt.publication_ref !== receipt.publication_ref) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "committed publication failed exact readback validation", true);
      }
      const reconciliation = await options.database.prepare(
        "UPDATE operation_receipt SET reconciliation_required=0 WHERE receipt_id=?1 AND revision=?2 AND reconciliation_required=1 " +
        "AND EXISTS(SELECT 1 FROM artifact_publication_receipt p WHERE p.operation_receipt_id=operation_receipt.receipt_id " +
        "AND p.operation_receipt_revision=operation_receipt.revision AND p.publication_ref=?3)",
      ).bind(operationReceiptId, 1, publicationRef).run();
      if (!reconciliation.success || (reconciliation.meta?.changes ?? 0) !== 1) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "canonical operation reconciliation did not update exactly one receipt", true);
      }
      committed = await readPublicationRow(options.database, artifactRef);
      if (committed === null || committed.operation_reconciliation_required !== 0 || committed.publication_ref !== publicationRef) {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "publication reconciliation readback is incomplete", true);
      }
      const final = await readValidated(input);
      if (final === null || final.receipt.publication_ref !== publicationRef || final.revision.status !== "ACCEPTED") {
        fail("ARTIFACT_PUBLICATION_EFFECT_UNCERTAIN", "final accepted publication readback is incomplete", true);
      }
      return { ...final, disposition: "CREATED" };
    },

    async read(input: ReadArtifactPublicationInput): Promise<ArtifactPublicationRead | null> {
      return readValidated(input);
    },
  };
}

export type ArtifactPublicationDraftReadError = ArtifactDraftReadError;
