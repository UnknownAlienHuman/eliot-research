import { canonicalEvidenceJson, type CloudflareEvidenceResolver, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { decodeModelGatewayBody } from "@eliotr/cloudflare-ai";
import type { VersionedRef } from "@eliotr/contracts";
import { decodeSynthesisSectionCandidate } from "./research-artifact-draft.js";
import type { EvidenceFreezeSynthesisContext } from "./research-evidence-freeze-composition.js";
import { readCommittedResearchSynthesisOutput } from "./research-synthesis-output-reader.js";
import { encodeResearchVerificationResult } from "./research-verification-result.js";
import { digest, fail, type StageRequest, type WorkflowPrincipal, type WorkflowStageHandler } from "./types.js";
import { readWorkflowObject } from "./objects.js";
import { WorkflowCheckpointStore } from "./store.js";

export interface ResearchVerificationStageDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  readonly recheck_authority: Parameters<typeof readCommittedResearchSynthesisOutput>[0]["recheck_authority"];
  /** Reads the committed freeze/manifest/evidence-pack context for SYNTHESIZE. */
  /** Fresh reader validates current stage13 head while loading committed stage12 context. */
  readonly context: ResearchVerificationContextReader;
}

export interface ResearchVerificationContextReader {
  read(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
  }): Promise<EvidenceFreezeSynthesisContext>;
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
  work_bucket: R2Bucket,
  request: StageRequest,
): Promise<{ readonly request: StageRequest; readonly request_sha256: string; readonly attempt_ref: string }> {
  const checkpoint = await new WorkflowCheckpointStore(database).readCommittedStageRequest(request.operation_id, "SYNTHESIZE");
  if (checkpoint === null) return failCorrupt();
  const receipt = await new WorkflowCheckpointStore(database).receipt(checkpoint.request, checkpoint.request_sha256);
  if (receipt === null || receipt.stage !== "SYNTHESIZE" || receipt.attempt_ref !== checkpoint.attempt_ref ||
      receipt.request_sha256 !== checkpoint.request_sha256 || receipt.investigation_ref.id !== request.investigation_ref.id ||
      !sameManifest(receipt.output_manifest, request.input_manifest)) return failCorrupt();
  try { await readWorkflowObject(work_bucket, checkpoint.request.input_manifest, true); }
  catch { return failCorrupt(); }
  return { request: checkpoint.request, request_sha256: checkpoint.request_sha256, attempt_ref: checkpoint.attempt_ref };
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

/** Verifies cited source bytes against the frozen owner-bound evidence set. */
export function createResearchVerificationStageHandler(
  dependencies: ResearchVerificationStageDependencies,
): WorkflowStageHandler {
  return async ({ request, principal, input_bytes, attempt_ref }) => {
    if (request.stage !== "VERIFY") fail("WORKFLOW_INPUT_INVALID");
    const request_sha256 = await digest(new TextEncoder().encode(JSON.stringify(request)));
    if (request.input_manifest.sha256 !== await digest(input_bytes)) failCorrupt();
    const synthesisStage = await committedSynthesisInput(dependencies.database, dependencies.work_bucket, request);
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
    try { candidate = decodeSynthesisSectionCandidate((await decodeModelGatewayBody(synthesis.bytes)).assistant_content); }
    catch { return failCorrupt(); }
    requireCandidateRefs(candidate.cited_handle_refs, context);
    const before = await dependencies.navigation.current();
    if (!before.allowed_use.includes("research") || Date.parse(before.expires_at) <= Date.parse(dependencies.navigation.timestamp())) failAuthority();
    let citations: Awaited<ReturnType<CloudflareEvidenceResolver["resolveCitationSet"]>>;
    try {
      citations = await dependencies.evidence_resolver.resolveCitationSet({
        handle_refs: candidate.cited_handle_refs,
        scope_snapshot_ref: context.freeze.scope_snapshot_ref,
        access: dependencies.navigation.access,
      });
    } catch { return failAuthority(); }
    const requested = [...candidate.cited_handle_refs].map(refKey).sort();
    const resolved = citations.resolved_evidence;
    if (!sameRef(citations.receipt.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
        citations.receipt.rejected.length !== 0 || !citations.receipt.all_material_citations_resolved ||
        citations.receipt.resolved_count !== requested.length ||
        resolved.length !== requested.length ||
        JSON.stringify(resolved.map((item) => refKey(item.handle.handle_ref)).sort()) !== JSON.stringify(requested)) failCorrupt();
    const verified = resolved.map((item) => {
      const frozen = context.freeze.included_evidence.find((entry) => sameRef(entry.handle_ref, item.handle.handle_ref));
      if (frozen === undefined || frozen.digest !== item.handle.excerpt_sha256 || item.handle.terminal_state !== "LIVE" ||
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
    if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after)) failAuthority();
    return encodeResearchVerificationResult({
      protocol: "eliotr.research.verification.v1", operation_id: request.operation_id, stage: "VERIFY",
      stage_attempt_ref: attempt_ref, stage_request_sha256: request_sha256,
      synthesis: { stage_attempt_ref: synthesis.stage_attempt_ref, stage_request_sha256: synthesis.stage_request_sha256, output_sha256: synthesis.output.output_sha256 },
      freeze_ref: context.freeze.freeze_ref, scope_snapshot_ref: context.freeze.scope_snapshot_ref, manifest_ref: context.manifest.manifest_ref,
      semantic_verification: "NOT_EXECUTED",
      source_verification: { requested_handle_refs: [...candidate.cited_handle_refs], resolved: verified },
      verified_at: dependencies.navigation.timestamp(),
    });
  };
}
