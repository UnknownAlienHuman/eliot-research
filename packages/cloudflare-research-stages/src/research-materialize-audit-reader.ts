import {
  canonicalEvidenceJson,
  evidenceSha256Bytes,
} from "@eliotr/cloudflare-evidence";
import {
  createModelAttemptStore,
  type ArtifactDraftSemanticAudit,
  type EvidenceFreezeMaterializeContext,
  type ModelAttemptReadback,
  type ResearchSynthesisOutputReadback,
  type ResearchV2MaterializationCandidate,
} from "@eliotr/cloudflare-research";
import type { VersionedRef } from "@eliotr/contracts";
import {
  fail,
  readCommittedStageLineage,
  readWorkflowObject,
  WorkflowCheckpointError,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import {
  decodeResearchClaimAuditResult,
  type ResearchClaimAuditResult,
  type ResearchClaimAuditClaim,
} from "./research-claim-audit-result.js";
import {
  decodeResearchCitationsResult,
  type ResearchCitationsResult,
} from "./research-citations-result.js";
import {
  decodeResearchCoverageResult,
  type ResearchCoverageResult,
} from "./research-coverage-result.js";

type CommittedLineage = Awaited<ReturnType<typeof readCommittedStageLineage>>;

const VERIFY_STAGE = "VERIFY" as const;
const AUDIT_STAGE = "AUDIT_CLAIMS" as const;
const CITATIONS_STAGE = "RESOLVE_CITATIONS" as const;
const COVERAGE_STAGE = "CALCULATE_COVERAGE" as const;
const MATERIALIZE_STAGE = "MATERIALIZE" as const;

function failCorrupt(): never {
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(value: VersionedRef): string {
  return value.id + ":" + value.revision;
}

function sameRefSequence(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => {
    const expected = right[index];
    return expected !== undefined && sameRef(ref, expected);
  });
}

function sameRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return new Set(leftKeys).size === leftKeys.length &&
    new Set(rightKeys).size === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index]);
}

function sameManifest(left: unknown, right: unknown): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

async function decodeOrCorrupt<T>(read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof WorkflowCheckpointError) throw error;
    return failCorrupt();
  }
}

async function readOutput(
  bucket: R2Bucket,
  lineage: CommittedLineage,
): Promise<Uint8Array> {
  const bytes = await readWorkflowObject(bucket, lineage.receipt.output_manifest, true);
  if (await evidenceSha256Bytes(bytes) !== lineage.receipt.output_manifest.sha256) failCorrupt();
  return new Uint8Array(bytes);
}

function requireWorkflowLineage(
  request: StageRequest,
  lineage: CommittedLineage,
  stage: CommittedLineage["request"]["stage"],
): void {
  if (lineage.request.stage !== stage ||
      lineage.request.operation_id !== request.operation_id ||
      lineage.request.investigation_ref.id !== request.investigation_ref.id ||
      lineage.request.handler_generation !== request.handler_generation ||
      lineage.receipt.engine_state !== "CHECKPOINTED" ||
      lineage.receipt.operation_id !== request.operation_id ||
      lineage.receipt.stage !== stage ||
      lineage.receipt.investigation_ref.id !== lineage.request.investigation_ref.id ||
      lineage.receipt.investigation_ref.revision !== lineage.request.investigation_ref.revision ||
      lineage.receipt.input_manifest_ref !== lineage.request.input_manifest.object_ref ||
      lineage.receipt.attempt_ref !== lineage.attempt_ref ||
      lineage.receipt.request_sha256 !== lineage.request_sha256) {
    failCorrupt();
  }
}

function requireContiguous(previous: CommittedLineage, next: CommittedLineage): void {
  if (previous.request.investigation_ref.revision + 1 !== next.request.investigation_ref.revision ||
      !sameManifest(previous.receipt.output_manifest, next.request.input_manifest)) {
    failCorrupt();
  }
}

function requireModelAttempt(
  result: ResearchClaimAuditResult,
  readback: ModelAttemptReadback | null,
  request: StageRequest,
  principal: WorkflowPrincipal,
  context: EvidenceFreezeMaterializeContext,
  audit: CommittedLineage,
): void {
  const expected = result.model_attempt;
  if (readback === null ||
      readback.state !== "SUCCEEDED" ||
      readback.persisted_state !== "SUCCEEDED" ||
      readback.receipt === null ||
      readback.output === null ||
      readback.operation_receipt === null ||
      readback.attempt_id !== expected.attempt_id ||
      !sameRef(readback.intent.intent_ref, expected.intent_ref) ||
      readback.request_sha256 !== expected.request_sha256 ||
      readback.stage_attempt_ref !== audit.attempt_ref ||
      readback.stage_request_sha256 !== audit.request_sha256 ||
      readback.workflow_budget_receipt_ref !== expected.workflow_budget_receipt_ref ||
      readback.authority.principal_ref !== principal.principal_ref ||
      readback.authority.credential_generation !== principal.credential_generation ||
      readback.authority.deployment_generation !== principal.deployment_generation ||
      !sameRef(readback.authority.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      expected.receipt.receipt_ref !== readback.receipt.receipt_ref ||
      expected.receipt.route_fingerprint_ref !== readback.receipt.route_fingerprint_ref ||
      expected.receipt.output_object_ref !== readback.receipt.output_object_ref ||
      expected.receipt.output_sha256 !== readback.receipt.output_sha256 ||
      expected.output.output_object_ref !== readback.output.output_object_ref ||
      expected.output.output_sha256 !== readback.output.output_sha256 ||
      expected.output.output_size_bytes !== readback.output.output_size_bytes ||
      expected.output.readback_sha256 !== readback.output.readback_sha256 ||
      !sameRef(expected.operation_receipt_ref, readback.operation_receipt.receipt_ref) ||
      result.operation_id !== request.operation_id) {
    failCorrupt();
  }
}

type CompactClaim = Pick<ResearchClaimAuditClaim,
  "claim_ref" | "claim_text_digest" | "claim_kind" |
  "support_handle_refs" | "counterevidence_handle_refs" |
  "reference_verification" | "value_or_measurement_verification" |
  "specification_compliance" | "method_artifact_alignment" |
  "source_satisfies_requirement" | "supplied_excerpt_supports_requirement" |
  "evidence_grade" | "lane" | "coverage_limitations" |
  "unsupported_precision" | "disposition">;

function claimProjection(value: CompactClaim): Record<string, unknown> {
  return {
    claim_ref: value.claim_ref,
    claim_text_digest: value.claim_text_digest,
    claim_kind: value.claim_kind,
    support_handle_refs: value.support_handle_refs,
    counterevidence_handle_refs: value.counterevidence_handle_refs,
    reference_verification: value.reference_verification,
    value_or_measurement_verification: value.value_or_measurement_verification,
    specification_compliance: value.specification_compliance,
    method_artifact_alignment: value.method_artifact_alignment,
    source_satisfies_requirement: value.source_satisfies_requirement,
    supplied_excerpt_supports_requirement: value.supplied_excerpt_supports_requirement,
    evidence_grade: value.evidence_grade,
    lane: value.lane,
    coverage_limitations: value.coverage_limitations,
    unsupported_precision: value.unsupported_precision,
    disposition: value.disposition,
  };
}

function auditedHandleRefs(result: ResearchClaimAuditResult): readonly VersionedRef[] {
  const refs = new Map<string, VersionedRef>();
  for (const claim of result.claims) {
    for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
      refs.set(refKey(ref), ref);
    }
  }
  return [...refs.values()];
}

function requireNormalizedClaims(
  audit: ResearchClaimAuditResult,
  normalized: ResearchV2MaterializationCandidate,
): ArtifactDraftSemanticAudit["claims"] {
  if (audit.verification.normalization_binding_sha256 !== normalized.normalization_binding_sha256 ||
      audit.claims.length !== normalized.claims.length) failCorrupt();

  const normalizedByRef = new Map(normalized.claims.map((claim) => [refKey(claim.claim_ref), claim]));
  if (normalizedByRef.size !== normalized.claims.length) failCorrupt();

  const claims = audit.claims.map((claim) => {
    const expected = normalizedByRef.get(refKey(claim.claim_ref));
    if (expected === undefined ||
        claim.claim_text_digest !== expected.text_digest ||
        claim.claim_kind !== expected.kind ||
        !sameRefSequence(claim.support_handle_refs, expected.support_handle_refs) ||
        !sameRefSequence(claim.counterevidence_handle_refs, expected.counterevidence_handle_refs)) {
      failCorrupt();
    }
    const storedText = (claim as ResearchClaimAuditClaim & { readonly claim_text?: unknown }).claim_text;
    if (storedText !== undefined && storedText !== expected.text) failCorrupt();
    return {
      claim_ref: { ...claim.claim_ref },
      claim_text: expected.text,
      claim_text_digest: claim.claim_text_digest,
      disposition: claim.disposition,
      support_handle_refs: claim.support_handle_refs.map((ref) => ({ ...ref })),
      counterevidence_handle_refs: claim.counterevidence_handle_refs.map((ref) => ({ ...ref })),
    };
  });
  return claims;
}

function requireAuditBinding(
  request: StageRequest,
  principal: WorkflowPrincipal,
  context: EvidenceFreezeMaterializeContext,
  synthesis: ResearchSynthesisOutputReadback,
  normalized: ResearchV2MaterializationCandidate,
  verify: CommittedLineage,
  auditLineage: CommittedLineage,
  audit: ResearchClaimAuditResult,
): ArtifactDraftSemanticAudit["claims"] {
  if (audit.protocol !== "eliotr.research.audit-claims-result.v1" ||
      audit.stage !== AUDIT_STAGE ||
      audit.operation_id !== request.operation_id ||
      !sameRef(audit.investigation_ref, auditLineage.request.investigation_ref) ||
      audit.stage_attempt_ref !== auditLineage.attempt_ref ||
      audit.stage_request_sha256 !== auditLineage.request_sha256 ||
      audit.synthesis.stage_attempt_ref !== synthesis.stage_attempt_ref ||
      audit.synthesis.stage_request_sha256 !== synthesis.stage_request_sha256 ||
      audit.synthesis.output_sha256 !== synthesis.output.output_sha256 ||
      audit.verification.stage_attempt_ref !== verify.attempt_ref ||
      audit.verification.stage_request_sha256 !== verify.request_sha256 ||
      audit.verification.output_sha256 !== verify.receipt.output_manifest.sha256 ||
      !sameRef(audit.freeze_ref, context.freeze.freeze_ref) ||
      !sameRef(audit.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(audit.manifest_ref, context.manifest.manifest_ref) ||
      audit.verifier.deployment_generation !== context.deployment_generation ||
      !audit.verifier.qualified ||
      !audit.verifier.current ||
      !context.manifest.allowed_verifier_refs.includes(audit.verifier.verifier_ref) ||
      context.principal_ref !== principal.principal_ref ||
      context.credential_generation !== principal.credential_generation ||
      context.deployment_generation !== principal.deployment_generation ||
      context.stage_twelve_attempt_ref !== synthesis.stage_attempt_ref ||
      context.stage_twelve_request_sha256 !== synthesis.stage_request_sha256 ||
      context.stage_twelve_receipt.attempt_ref !== synthesis.workflow_receipt.attempt_ref ||
      context.stage_twelve_receipt.request_sha256 !== synthesis.workflow_receipt.request_sha256 ||
      !sameManifest(context.stage_twelve_receipt.output_manifest, synthesis.workflow_receipt.output_manifest)) {
    failCorrupt();
  }
  return requireNormalizedClaims(audit, normalized);
}

function requireCitationBinding(
  request: StageRequest,
  context: EvidenceFreezeMaterializeContext,
  auditLineage: CommittedLineage,
  audit: ResearchClaimAuditResult,
  citationsLineage: CommittedLineage,
  citations: ResearchCitationsResult,
): void {
  if (citations.protocol !== "eliotr.research.citations.v2" ||
      citations.operation_id !== request.operation_id ||
      !sameRef(citations.investigation_ref, citationsLineage.request.investigation_ref) ||
      citations.stage !== CITATIONS_STAGE ||
      citations.stage_attempt_ref !== citationsLineage.attempt_ref ||
      citations.stage_request_sha256 !== citationsLineage.request_sha256 ||
      !sameRef(citations.freeze_ref, context.freeze.freeze_ref) ||
      !sameRef(citations.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(citations.manifest_ref, context.manifest.manifest_ref) ||
      !sameRef(citations.evidence_pack_ref, context.stage_five.evidence_pack.pack_ref) ||
      citations.audit.protocol !== audit.protocol ||
      citations.audit.stage_attempt_ref !== audit.stage_attempt_ref ||
      citations.audit.stage_request_sha256 !== audit.stage_request_sha256 ||
      citations.audit.output_sha256 !== auditLineage.receipt.output_manifest.sha256 ||
      canonicalEvidenceJson(citations.audit.synthesis) !== canonicalEvidenceJson(audit.synthesis) ||
      canonicalEvidenceJson(citations.audit.verification) !== canonicalEvidenceJson(audit.verification) ||
      citations.audit.audit_input_sha256 !== audit.audit_input_sha256 ||
      citations.audit.normalization_binding_sha256 !== audit.verification.normalization_binding_sha256 ||
      canonicalEvidenceJson(citations.claims.map(claimProjection)) !==
        canonicalEvidenceJson(audit.claims.map(claimProjection)) ||
      !sameRefSet(citations.citation_resolution_receipt.requested_handle_refs, auditedHandleRefs(audit)) ||
      !sameRef(citations.citation_resolution_receipt.scope_snapshot_ref, context.freeze.scope_snapshot_ref)) {
    failCorrupt();
  }
}

function requireCoverageBinding(
  request: StageRequest,
  context: EvidenceFreezeMaterializeContext,
  citationsLineage: CommittedLineage,
  citations: ResearchCitationsResult,
  coverageLineage: CommittedLineage,
  coverage: ResearchCoverageResult,
): void {
  if (coverage.protocol !== "eliotr.research.coverage.v2" ||
      coverage.operation_id !== request.operation_id ||
      !sameRef(coverage.investigation_ref, coverageLineage.request.investigation_ref) ||
      coverage.stage !== COVERAGE_STAGE ||
      coverage.stage_attempt_ref !== coverageLineage.attempt_ref ||
      coverage.stage_request_sha256 !== coverageLineage.request_sha256 ||
      !sameRef(coverage.freeze_ref, context.freeze.freeze_ref) ||
      !sameRef(coverage.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(coverage.manifest_ref, context.manifest.manifest_ref) ||
      !sameRef(coverage.evidence_pack_ref, context.stage_five.evidence_pack.pack_ref) ||
      coverage.stage_fifteen.protocol !== citations.protocol ||
      coverage.stage_fifteen.operation_id !== citations.operation_id ||
      !sameRef(coverage.stage_fifteen.investigation_ref, citations.investigation_ref) ||
      coverage.stage_fifteen.stage !== CITATIONS_STAGE ||
      coverage.stage_fifteen.stage_attempt_ref !== citations.stage_attempt_ref ||
      coverage.stage_fifteen.stage_request_sha256 !== citations.stage_request_sha256 ||
      coverage.stage_fifteen.output_sha256 !== citationsLineage.receipt.output_manifest.sha256 ||
      canonicalEvidenceJson(coverage.stage_fifteen.citation_resolution_receipt) !==
        canonicalEvidenceJson(citations.citation_resolution_receipt) ||
      canonicalEvidenceJson(coverage.claims.map(claimProjection)) !==
        canonicalEvidenceJson(citations.claims.map(claimProjection))) {
    failCorrupt();
  }
}

export interface ResearchMaterializeAuditReaderInput {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly context: EvidenceFreezeMaterializeContext;
  readonly input_bytes: Uint8Array;
  readonly synthesis_readback: ResearchSynthesisOutputReadback;
  readonly normalized_synthesis: ResearchV2MaterializationCandidate;
}

/** Reads the immutable Stage14 audit for Stage17 without invoking any model or resolver. */
export async function readCommittedResearchMaterializeAudit(
  input: ResearchMaterializeAuditReaderInput,
): Promise<ArtifactDraftSemanticAudit> {
  if (input.request.stage !== MATERIALIZE_STAGE ||
      !(input.input_bytes instanceof Uint8Array) ||
      input.input_bytes.byteLength !== input.request.input_manifest.byte_length ||
      await evidenceSha256Bytes(input.input_bytes) !== input.request.input_manifest.sha256) {
    failCorrupt();
  }

  const checkpoints = new WorkflowCheckpointStore(input.database);
  const verify = await readCommittedStageLineage(checkpoints, input.request.operation_id, VERIFY_STAGE);
  const auditLineage = await readCommittedStageLineage(checkpoints, input.request.operation_id, AUDIT_STAGE);
  const citationsLineage = await readCommittedStageLineage(checkpoints, input.request.operation_id, CITATIONS_STAGE);
  const coverageLineage = await readCommittedStageLineage(checkpoints, input.request.operation_id, COVERAGE_STAGE);
  requireWorkflowLineage(input.request, verify, VERIFY_STAGE);
  requireWorkflowLineage(input.request, auditLineage, AUDIT_STAGE);
  requireWorkflowLineage(input.request, citationsLineage, CITATIONS_STAGE);
  requireWorkflowLineage(input.request, coverageLineage, COVERAGE_STAGE);
  requireContiguous(verify, auditLineage);
  requireContiguous(auditLineage, citationsLineage);
  requireContiguous(citationsLineage, coverageLineage);
  if (coverageLineage.request.investigation_ref.revision + 1 !== input.request.investigation_ref.revision ||
      !sameManifest(coverageLineage.receipt.output_manifest, input.request.input_manifest)) {
    failCorrupt();
  }

  const auditBytes = await readOutput(input.work_bucket, auditLineage);
  const citationsBytes = await readOutput(input.work_bucket, citationsLineage);
  const audit = await decodeOrCorrupt(() => decodeResearchClaimAuditResult(auditBytes));
  const citations = await decodeOrCorrupt(() => decodeResearchCitationsResult(citationsBytes));
  const coverage = await decodeOrCorrupt(() => decodeResearchCoverageResult(new Uint8Array(input.input_bytes)));
  const modelAttempt = await (async () => {
    try {
      return await createModelAttemptStore(input.database).readByAttempt(audit.model_attempt.attempt_id);
    } catch {
      return failCorrupt();
    }
  })();

  const claims = requireAuditBinding(
    input.request,
    input.principal,
    input.context,
    input.synthesis_readback,
    input.normalized_synthesis,
    verify,
    auditLineage,
    audit,
  );
  requireCitationBinding(input.request, input.context, auditLineage, audit, citationsLineage, citations);
  requireCoverageBinding(input.request, input.context, citationsLineage, citations, coverageLineage, coverage);
  requireModelAttempt(
    audit,
    modelAttempt,
    input.request,
    input.principal,
    input.context,
    auditLineage,
  );

  return Object.freeze({
    stage_attempt_ref: auditLineage.attempt_ref,
    stage_request_sha256: auditLineage.request_sha256,
    output_sha256: auditLineage.receipt.output_manifest.sha256,
    synthesis_output_sha256: audit.synthesis.output_sha256,
    normalization_binding_sha256: audit.verification.normalization_binding_sha256,
    verifier_ref: audit.verifier.verifier_ref,
    verifier_schema_generation: audit.verifier.verifier_schema_generation,
    model_receipt_ref: audit.model_attempt.receipt.receipt_ref,
    claims: Object.freeze(claims.map((claim) => Object.freeze({
      ...claim,
      claim_ref: Object.freeze({ ...claim.claim_ref }),
      support_handle_refs: Object.freeze(claim.support_handle_refs.map((ref) => Object.freeze({ ...ref }))),
      counterevidence_handle_refs: Object.freeze(claim.counterevidence_handle_refs.map((ref) => Object.freeze({ ...ref }))),
    }))),
  });
}
