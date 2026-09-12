import { canonicalEvidenceJson, type EvidenceSourceAuthority } from "@eliotr/cloudflare-evidence";
import type {
  EvidenceFreezeSynthesisContext,
  ResearchEvidencePack,
} from "@eliotr/cloudflare-research";
import type { VersionedRef } from "@eliotr/contracts";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type { NormalizedSynthesisClaims } from "@eliotr/research";
import type { ResearchVerificationResultV2 } from "./research-verification-result-v2.js";
import type {
  ResearchClaimAuditEvidenceSnapshot,
  ResearchClaimAuditNormalizationConfig,
  ResearchClaimAuditSynthesisBinding,
  ResearchClaimAuditVerifierAuthority,
} from "./research-claim-audit-input.js";
import type { ResearchClaimAuditPolicy } from "./research-claim-audit-policy.js";

export function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

export function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

export function sortedRefKeys(refs: readonly VersionedRef[]): readonly string[] {
  return refs.map(refKey).sort();
}

export function compareKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keep current source identity separate from transient navigation/resolution observations. */
export function stableSourceAuthority(value: EvidenceSourceAuthority): Record<string, unknown> {
  return {
    source_id: value.source_id,
    owner_system_id: value.owner_system_id,
    source_namespace_id: value.source_namespace_id,
    source_owner_generation: value.source_owner_generation,
    source_revision_ref: value.source_revision_ref,
    source_title: value.source_title,
    source_class: value.source_class,
    content_sha256: value.content_sha256,
    object_residency_key_digest: value.object_residency_key_digest,
    normalized_artifact_ref: value.normalized_artifact_ref,
    purge_state: value.purge_state,
    admission_receipt_ref: value.admission_receipt_ref,
    source_assurance_ceiling: value.source_assurance_ceiling,
    instruction_taint: value.instruction_taint,
    allowed_effects: value.allowed_effects,
    allowed_use: [...value.allowed_use],
    disclosure_ceiling: value.disclosure_ceiling,
    ...(value.admission_expires_at === undefined ? {} : { admission_expires_at: value.admission_expires_at }),
  };
}

export function stableSourceAuthorities(value: readonly EvidenceSourceAuthority[]): readonly Record<string, unknown>[] {
  return value.map(stableSourceAuthority).sort((left, right) => compareKey(
    String(left.source_revision_ref), String(right.source_revision_ref),
  ));
}

export function stableW1Head(head: EvidenceFreezeSynthesisContext["w1_head"]): Record<string, unknown> {
  return {
    investigation_id: head.investigation_id,
    revision: head.revision,
    protocol_version: head.protocol_version,
    goal: head.goal,
    scope_snapshot_id: head.scope_snapshot_id,
    scope_snapshot_revision: head.scope_snapshot_revision,
    evidence_grade: head.evidence_grade,
    lane: head.lane,
    lane_registrations: [...head.lane_registrations],
    obligations: [...head.obligations],
    hypotheses: [...head.hypotheses],
    portfolio_ref: head.portfolio_ref,
    debt_refs: [...head.debt_refs],
    checkpoint_head: head.checkpoint_head,
    principal_ref: head.principal_ref,
    input_digest: head.input_digest,
    policy_generation: head.policy_generation,
    policy_authority_ref: head.policy_authority_ref,
    deployment_generation: head.deployment_generation,
    idempotency_key: head.idempotency_key,
    model_profile_ref: head.model_profile_ref,
    ...(head.observed_execution === undefined ? {} : { observed_execution: head.observed_execution }),
    ...(head.observed_fidelity === undefined ? {} : { observed_fidelity: head.observed_fidelity }),
    ...(head.observed_assurance === undefined ? {} : { observed_assurance: head.observed_assurance }),
    status: head.status,
    ...(head.supersedes_id === undefined ? {} : { supersedes_id: head.supersedes_id }),
    ...(head.supersession_reason === undefined ? {} : { supersession_reason: head.supersession_reason }),
    event_head: head.event_head,
  };
}

export function stableEvidence(value: ResearchClaimAuditEvidenceSnapshot): Record<string, unknown> {
  return {
    handle: value.handle,
    exact_excerpt: value.exact_excerpt,
    source_revision_content_sha256: value.source_revision_content_sha256,
    scope_snapshot_digest: value.scope_snapshot_digest,
    source_class: value.source_class,
    instruction_taint: value.instruction_taint,
    allowed_effects: value.allowed_effects,
    ...(value.source_title === undefined ? {} : { source_title: value.source_title }),
  };
}

export function stablePack(value: ResearchEvidencePack): Record<string, unknown> {
  const evidence = value.resolved_evidence.map((item) => ({
    handle: item.handle,
    exact_excerpt: item.exact_excerpt,
    source_revision_content_sha256: item.source_revision_content_sha256,
    scope_snapshot_digest: item.scope_snapshot_digest,
    instruction_taint: item.instruction_taint,
    allowed_effects: item.allowed_effects,
    ...(item.source_title === undefined ? {} : { source_title: item.source_title }),
  })).sort((left, right) => compareKey(refKey(left.handle.handle_ref), refKey(right.handle.handle_ref)));
  return {
    pack_ref: value.pack_ref,
    scope_snapshot_ref: value.scope_snapshot_ref,
    trace_ref: value.trace_ref,
    omitted_candidates: [...value.omitted_candidates],
    total_utf8_bytes: value.total_utf8_bytes,
    resolved_evidence: evidence,
  };
}

export function normalizedClaimMaterial(claims: NormalizedSynthesisClaims): readonly Record<string, unknown>[] {
  return claims.claims.map((claim) => ({
    claim_ref: claim.claim_ref,
    text: claim.text,
    text_digest: claim.text_digest,
    kind: claim.kind,
    span: claim.span,
    required_precision: claim.required_precision,
    required_source_class: claim.required_source_class,
    support_handle_refs: sortedRefKeys(claim.support_handle_refs),
    counterevidence_handle_refs: sortedRefKeys(claim.counterevidence_handle_refs),
  }));
}

export function verifyClaimMaterial(value: ResearchVerificationResultV2): Record<string, unknown> {
  return {
    section_ref: value.normalization.section_ref,
    required_precision: value.normalization.required_precision,
    required_source_class: value.normalization.required_source_class,
    claims: value.normalization.claims.map((claim) => ({
      claim_ref: claim.claim_ref,
      claim_text_digest: claim.claim_text_digest,
      claim_kind: claim.claim_kind,
      support_handle_refs: sortedRefKeys(claim.support_handle_refs),
      counterevidence_handle_refs: sortedRefKeys(claim.counterevidence_handle_refs),
    })),
    cited_handle_refs: sortedRefKeys(value.normalization.cited_handle_refs),
  };
}

export function auditInputMaterial(input: {
  readonly request: StageRequest;
  readonly principal: Readonly<Pick<WorkflowPrincipal, "principal_ref" | "credential_generation" | "deployment_generation">>;
  readonly context: EvidenceFreezeSynthesisContext;
  readonly verify: ResearchVerificationResultV2;
  readonly synthesis: ResearchClaimAuditSynthesisBinding;
  readonly normalization: ResearchClaimAuditNormalizationConfig;
  readonly claims: NormalizedSynthesisClaims;
  readonly evidence: readonly ResearchClaimAuditEvidenceSnapshot[];
  readonly verifier: ResearchClaimAuditVerifierAuthority;
  readonly audit_policy: ResearchClaimAuditPolicy;
}): Record<string, unknown> {
  return {
    protocol: "eliotr.research.audit-claims-input.v1",
    operation_id: input.request.operation_id,
    stage: input.request.stage,
    investigation_ref: input.request.investigation_ref,
    handler_generation: input.request.handler_generation,
    input_manifest: input.request.input_manifest,
    principal: input.principal,
    verify: {
      stage_attempt_ref: input.verify.stage_attempt_ref,
      stage_request_sha256: input.verify.stage_request_sha256,
      synthesis: input.verify.synthesis,
      freeze_ref: input.verify.freeze_ref,
      scope_snapshot_ref: input.verify.scope_snapshot_ref,
      manifest_ref: input.verify.manifest_ref,
      normalization: {
        section_ref: input.normalization.section_ref,
        required_precision: input.normalization.required_precision,
        required_source_class: input.normalization.required_source_class,
        section_text: input.claims.section_text,
        claims: normalizedClaimMaterial(input.claims),
        cited_handle_refs: sortedRefKeys(input.claims.cited_handle_refs),
      },
    },
    committed_synthesis: input.synthesis,
    frozen: {
      freeze: {
        freeze_ref: input.context.freeze.freeze_ref,
        scope_snapshot_ref: input.context.freeze.scope_snapshot_ref,
        ...(input.context.freeze.client_fence_ref === undefined ? {} : { client_fence_ref: input.context.freeze.client_fence_ref }),
        coverage_denominator_ref: input.context.freeze.coverage_denominator_ref,
        contract_protocol_digest: input.context.freeze.contract_protocol_digest,
        lane_digest: input.context.freeze.lane_digest,
        included_evidence: [...input.context.freeze.included_evidence].sort((left, right) => compareKey(refKey(left.handle_ref), refKey(right.handle_ref))),
        excluded_evidence: [...input.context.freeze.excluded_evidence],
        unresolved_contradiction_refs: [...input.context.freeze.unresolved_contradiction_refs],
        open_research_debt_refs: [...input.context.freeze.open_research_debt_refs],
        provider_model_prompt_tool_generations: input.context.freeze.provider_model_prompt_tool_generations,
        frozen_at: input.context.freeze.frozen_at,
      },
      manifest: input.context.manifest,
      stage_five: {
        operation_id: input.context.stage_five.operation_id,
        investigation_ref: input.context.stage_five.investigation_ref,
        scope_snapshot_ref: input.context.stage_five.scope_snapshot_ref,
        protocol_digest: input.context.stage_five.protocol_digest,
        denominator_digest: input.context.stage_five.denominator_digest,
        retrieval_request_digest: input.context.stage_five.retrieval_request_digest,
        stage_attempt_ref: input.context.stage_five.stage_attempt_ref,
        stage_request_sha256: input.context.stage_five.stage_request_sha256,
        evidence_pack: stablePack(input.context.stage_five.evidence_pack),
      },
      model_profile: {
        definition_ref: input.context.stage_ten_input.model_profile_definition.definition_ref,
        definition_sha256: input.context.stage_ten_input.model_profile_definition.definition_sha256,
        model_profile_ref: input.context.stage_ten_input.model_profile_definition.model_profile_ref,
        max_context_bytes: input.context.stage_ten_input.model_profile_definition.max_context_bytes,
      },
      w1_head: stableW1Head(input.context.w1_head),
    },
    evidence: [...input.evidence].map(stableEvidence).sort((left, right) => {
      const l = left.handle as { readonly handle_ref: VersionedRef };
      const r = right.handle as { readonly handle_ref: VersionedRef };
      return compareKey(refKey(l.handle_ref), refKey(r.handle_ref));
    }),
    audit_policy: input.audit_policy,
    verifier: input.verifier,
  };
}
