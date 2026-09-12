import { canonicalEvidenceJson, type CloudflareEvidenceResolver, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { decodeModelGatewayBody } from "@eliotr/cloudflare-ai";
import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import {
  decodeSynthesisSectionCandidate,
  readCommittedResearchSynthesisOutput,
  sameEvidence,
  type EvidenceFreezeSynthesisContext,
  type EvidenceFreezeVerificationContextReader,
} from "@eliotr/cloudflare-research";
import {
  decodeSynthesisClaimsCandidateV2,
  normalizeSynthesisClaimsCandidateV2,
  type NormalizedSynthesisClaims,
} from "@eliotr/research";
import { encodeResearchVerificationResult } from "./research-verification-result.js";
import {
  encodeResearchVerificationResultV2,
  researchVerificationNormalizationBindingSha256,
  type ResearchVerificationResultV2,
} from "./research-verification-result-v2.js";
import { digest, fail, type StageRequest, type WorkflowPrincipal, type WorkflowStageHandler } from "@eliotr/cloudflare-workflows";
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import { readCommittedStageLineage } from "@eliotr/cloudflare-workflows";
import { z } from "zod";

const ResearchVerificationV2ConfigSchema = z.object({
  section_ref: VersionedRefSchema,
  required_precision: IdentifierSchema,
  required_source_class: IdentifierSchema,
}).strict();

export type ResearchVerificationV2Config = z.infer<typeof ResearchVerificationV2ConfigSchema>;

export interface ResearchVerificationStageDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  readonly recheck_authority: Parameters<typeof readCommittedResearchSynthesisOutput>[0]["recheck_authority"];
  /** Fresh reader validates current stage13 head while loading committed stage12 context. */
  readonly context: EvidenceFreezeVerificationContextReader;
  /** Optional server-owned v2 normalization contract; presence selects v2 only. */
  readonly v2_config?: ResearchVerificationV2Config;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sameManifest(left: { readonly object_ref: string; readonly sha256: string }, right: { readonly object_ref: string; readonly sha256: string }): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function failCorrupt(): never {
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}

function failAuthority(): never {
  return fail("WORKFLOW_AUTHORITY_STALE");
}

function requireCandidateRefs(
  refs: readonly VersionedRef[],
  context: EvidenceFreezeSynthesisContext,
): void {
  const keys = refs.map(refKey);
  if (new Set(keys).size !== keys.length || refs.length === 0) failCorrupt();
  const manifest = new Set(context.manifest.allowed_evidence_handle_refs.map(refKey));
  const frozen = new Set(context.freeze.included_evidence.map((item) => refKey(item.handle_ref)));
  const pack = new Set(context.stage_five.evidence_pack.resolved_evidence.map((item) => refKey(item.handle.handle_ref)));
  if (keys.some((key) => !manifest.has(key) || !frozen.has(key) || !pack.has(key))) failCorrupt();
}

async function committedSynthesisInput(
  database: D1Database,
  request: StageRequest,
): Promise<{ readonly request: StageRequest; readonly request_sha256: string; readonly attempt_ref: string }> {
  const checkpoint = await readCommittedStageLineage(new WorkflowCheckpointStore(database), request.operation_id, "SYNTHESIZE");
  if (checkpoint.receipt.investigation_ref.id !== request.investigation_ref.id ||
      !sameManifest(checkpoint.receipt.output_manifest, request.input_manifest)) return failCorrupt();
  return checkpoint;
}

function requireContext(request: StageRequest, principal: WorkflowPrincipal, context: EvidenceFreezeSynthesisContext): void {
  if (context.operation_id !== request.operation_id || context.investigation_id !== request.investigation_ref.id ||
      context.principal_ref !== principal.principal_ref || context.credential_generation !== principal.credential_generation ||
      context.deployment_generation !== principal.deployment_generation ||
      context.current_revision !== request.investigation_ref.revision ||
      context.stage_eleven_request.stage !== "FREEZE_EVIDENCE" ||
      context.stage_eleven_receipt.engine_state !== "CHECKPOINTED" ||
      !sameRef(context.freeze.scope_snapshot_ref, { id: context.stage_five.scope_snapshot_ref.id, revision: context.stage_five.scope_snapshot_ref.revision }) ||
      !sameRef(context.manifest.scope_snapshot_ref, context.freeze.scope_snapshot_ref)) failAuthority();
}

function snapshotV2Config(value: ResearchVerificationV2Config | undefined): ResearchVerificationV2Config | undefined {
  if (value === undefined) return undefined;
  const parsed = ResearchVerificationV2ConfigSchema.safeParse(value);
  if (!parsed.success) fail("WORKFLOW_INPUT_INVALID");
  return Object.freeze({
    section_ref: Object.freeze({ ...parsed.data.section_ref }),
    required_precision: parsed.data.required_precision,
    required_source_class: parsed.data.required_source_class,
  });
}

function v2ResultInput(input: {
  readonly request: StageRequest;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly synthesis: NonNullable<Awaited<ReturnType<typeof readCommittedResearchSynthesisOutput>>>;
  readonly context: EvidenceFreezeSynthesisContext;
  readonly config: ResearchVerificationV2Config;
  readonly normalized: NormalizedSynthesisClaims;
  readonly resolved: readonly ResearchVerificationResultV2["source_verification"]["resolved"][number][];
  readonly verified_at: string;
}): ResearchVerificationResultV2 {
  return {
    protocol: "eliotr.research.verification.v2",
    operation_id: input.request.operation_id,
    stage: "VERIFY",
    stage_attempt_ref: input.attempt_ref,
    stage_request_sha256: input.request_sha256,
    synthesis: {
      stage_attempt_ref: input.synthesis.stage_attempt_ref,
      stage_request_sha256: input.synthesis.stage_request_sha256,
      output_sha256: input.synthesis.output.output_sha256,
    },
    freeze_ref: input.context.freeze.freeze_ref,
    scope_snapshot_ref: input.context.freeze.scope_snapshot_ref,
    manifest_ref: input.context.manifest.manifest_ref,
    semantic_verification: "NOT_EXECUTED",
    normalization: {
      section_ref: input.config.section_ref,
      required_precision: input.config.required_precision,
      required_source_class: input.config.required_source_class,
      claims: input.normalized.claims.map((claim) => ({
        claim_ref: claim.claim_ref,
        claim_text_digest: claim.text_digest,
        claim_kind: claim.kind,
        support_handle_refs: [...claim.support_handle_refs],
        counterevidence_handle_refs: [...claim.counterevidence_handle_refs],
      })),
      cited_handle_refs: [...input.normalized.cited_handle_refs],
      binding_sha256: "0".repeat(64),
    },
    source_verification: {
      requested_handle_refs: [...input.normalized.cited_handle_refs],
      resolved: [...input.resolved],
    },
    verified_at: input.verified_at,
  };
}

/** Verifies cited source bytes against the frozen owner-bound evidence set. */
export function createResearchVerificationStageHandler(
  dependencies: ResearchVerificationStageDependencies,
): WorkflowStageHandler {
  const v2Config = snapshotV2Config(dependencies.v2_config);
  return async ({ request, principal, input_bytes, attempt_ref }) => {
    if (request.stage !== "VERIFY") fail("WORKFLOW_INPUT_INVALID");
    const request_sha256 = await digest(new TextEncoder().encode(JSON.stringify(request)));
    if (request.input_manifest.sha256 !== await digest(input_bytes)) failCorrupt();
    const synthesisStage = await committedSynthesisInput(dependencies.database, request);
    let context: EvidenceFreezeSynthesisContext;
    try { context = await dependencies.context.read({ request, principal, input_bytes }); }
    catch { return failAuthority(); }
    requireContext(request, principal, context);
    const synthesis = await readCommittedResearchSynthesisOutput({
      database: dependencies.database, work_bucket: dependencies.work_bucket,
      operation_id: request.operation_id, principal, recheck_authority: dependencies.recheck_authority,
    });
    if (synthesis === null || synthesis.stage_attempt_ref !== synthesisStage.attempt_ref ||
        synthesis.stage_request_sha256 !== synthesisStage.request_sha256 ||
        !sameManifest(synthesis.workflow_receipt.output_manifest, request.input_manifest)) failCorrupt();
    let candidate;
    let normalized: NormalizedSynthesisClaims | undefined;
    let citedHandleRefs: readonly VersionedRef[];
    let assistantContent: string;
    try { assistantContent = (await decodeModelGatewayBody(synthesis.bytes)).assistant_content; }
    catch { return failCorrupt(); }
    if (v2Config !== undefined) {
      try {
        normalized = await normalizeSynthesisClaimsCandidateV2({
          candidate: decodeSynthesisClaimsCandidateV2(assistantContent),
          operation_id: request.operation_id,
          section_ref: v2Config.section_ref,
          allowed_handle_refs: context.freeze.included_evidence.map((entry) => entry.handle_ref),
          required_precision: v2Config.required_precision,
          required_source_class: v2Config.required_source_class,
        });
      } catch { return failCorrupt(); }
      citedHandleRefs = normalized.cited_handle_refs;
      requireCandidateRefs(citedHandleRefs, context);
    } else {
      try { candidate = decodeSynthesisSectionCandidate(assistantContent); }
      catch { return failCorrupt(); }
      citedHandleRefs = candidate.cited_handle_refs;
      requireCandidateRefs(citedHandleRefs, context);
    }
    const before = await dependencies.navigation.current();
    if (!before.allowed_use.includes("research") || Date.parse(before.expires_at) <= Date.parse(dependencies.navigation.timestamp())) failAuthority();
    let citations: Awaited<ReturnType<CloudflareEvidenceResolver["resolveCitationSet"]>>;
    try {
      citations = await dependencies.evidence_resolver.resolveCitationSet({
        handle_refs: citedHandleRefs,
        scope_snapshot_ref: context.freeze.scope_snapshot_ref,
        access: dependencies.navigation.access,
      });
    } catch { return failAuthority(); }
    const requested = [...citedHandleRefs].map(refKey).sort();
    const resolved = citations.resolved_evidence;
    if (!sameRef(citations.receipt.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
        citations.receipt.rejected.length !== 0 || !citations.receipt.all_material_citations_resolved ||
        citations.receipt.resolved_count !== requested.length ||
        resolved.length !== requested.length ||
        JSON.stringify(resolved.map((item) => refKey(item.handle.handle_ref)).sort()) !== JSON.stringify(requested)) failCorrupt();
    const verified = resolved.map((item) => {
      const frozen = context.freeze.included_evidence.find((entry) => sameRef(entry.handle_ref, item.handle.handle_ref));
      const packed = context.stage_five.evidence_pack.resolved_evidence.find((entry) => sameRef(entry.handle.handle_ref, item.handle.handle_ref));
      if (frozen === undefined || packed === undefined || !sameEvidence(packed, item) || frozen.digest !== item.handle.excerpt_sha256 || item.handle.terminal_state !== "LIVE" ||
          item.handle.scope_snapshot_ref.id !== context.freeze.scope_snapshot_ref.id ||
          item.handle.scope_snapshot_ref.revision !== context.freeze.scope_snapshot_ref.revision ||
          item.authorization_receipt_ref !== before.authorization_receipt_ref || item.credential_generation !== dependencies.navigation.access.credential_generation) failCorrupt();
      return {
        handle_ref: item.handle.handle_ref, source_revision_ref: item.handle.source_revision_ref,
        source_owner_generation: item.handle.source_owner_generation, excerpt_sha256: item.handle.excerpt_sha256,
        source_revision_content_sha256: item.source_revision_content_sha256,
        scope_snapshot_digest: item.scope_snapshot_digest, authorization_receipt_ref: item.authorization_receipt_ref,
        credential_generation: item.credential_generation, verification_receipt_ref: item.verification_receipt_ref,
      };
    });
    const after = await dependencies.navigation.current();
    const finalHead = await new WorkflowCheckpointStore(dependencies.database).head(request.investigation_ref.id);
    if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after) ||
        canonicalEvidenceJson(finalHead) !== canonicalEvidenceJson(context.w1_head) ||
        finalHead.investigation_id !== request.investigation_ref.id ||
        finalHead.revision !== request.investigation_ref.revision ||
        finalHead.principal_ref !== principal.principal_ref ||
        finalHead.deployment_generation !== principal.deployment_generation) failAuthority();
    if (normalized !== undefined && v2Config !== undefined) {
      const unbound = v2ResultInput({
        request, attempt_ref, request_sha256, synthesis, context, config: v2Config, normalized,
        resolved: verified.map((item) => item),
        verified_at: dependencies.navigation.timestamp(),
      });
      const binding_sha256 = await researchVerificationNormalizationBindingSha256(unbound);
      return encodeResearchVerificationResultV2({ ...unbound, normalization: { ...unbound.normalization, binding_sha256 } });
    }
    return encodeResearchVerificationResult({
      protocol: "eliotr.research.verification.v1", operation_id: request.operation_id, stage: "VERIFY",
      stage_attempt_ref: attempt_ref, stage_request_sha256: request_sha256,
      synthesis: { stage_attempt_ref: synthesis.stage_attempt_ref, stage_request_sha256: synthesis.stage_request_sha256, output_sha256: synthesis.output.output_sha256 },
      freeze_ref: context.freeze.freeze_ref, scope_snapshot_ref: context.freeze.scope_snapshot_ref, manifest_ref: context.manifest.manifest_ref,
      semantic_verification: "NOT_EXECUTED",
      source_verification: { requested_handle_refs: [...citedHandleRefs], resolved: verified },
      verified_at: dependencies.navigation.timestamp(),
    });
  };
}
