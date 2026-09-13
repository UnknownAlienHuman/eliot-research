import type { CloudflareEvidenceResolver, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ArtifactDraftAdmissionPort, ArtifactDraftSemanticAudit } from "@eliotr/cloudflare-artifacts";
import type { CoverageReceipt } from "@eliotr/contracts";
import { readCommittedResearchSynthesisOutput } from "./research-synthesis-output-reader.js";
import type { ResearchSynthesisOutputReadback } from "./research-synthesis-output-reader.js";
import type { RunStatusAuthoritySnapshot } from "./research-run-status.js";
import type { EvidenceFreezeMaterializeContext } from "./research-evidence-freeze-composition.js";
import { digest as requestDigest, fail, type StageRequest, type WorkflowPrincipal, type WorkflowStageHandler } from "@eliotr/cloudflare-workflows";
import {
  materializeResearchResult,
  type ResearchMaterializeResultWriterInput,
} from "./research-materialize-result.js";
import { readCommittedResearchV2MaterializationCandidate, type ResearchV2MaterializationCandidate } from "./research-v2-materialize-adapter.js";

/**
 * Raw's reader owns all fresh W2/freeze/current-authority reads.  It returns
 * server-selected materializer inputs; no output or authority identity comes
 * from the MATERIALIZE request body.
 */
/** The Raw reader supplies this projection from its full frozen lineage context. */
export type ResearchMaterializeContext = EvidenceFreezeMaterializeContext;

export interface ResearchMaterializeContextReader {
  read(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
  }): Promise<ResearchMaterializeContext>;
}

export interface ResearchMaterializeCoverageReader {
  (input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly context: ResearchMaterializeContext;
    readonly input_bytes: Uint8Array;
  }): CoverageReceipt | Promise<CoverageReceipt>;
}

/** Read committed Stage14 evidence bound to this exact synthesis and frozen context. */
export interface ResearchMaterializeClaimAuditReader {
  (input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly context: ResearchMaterializeContext;
    readonly input_bytes: Uint8Array;
    readonly synthesis_readback: ResearchSynthesisOutputReadback;
    readonly normalized_synthesis: ResearchV2MaterializationCandidate;
  }): Promise<ArtifactDraftSemanticAudit>;
}

export type ResearchMaterializeTrustedMetadata = Pick<ResearchMaterializeResultWriterInput,
  "intent" | "expected_draft_head_revision" | "artifact_ref" | "spec" | "section" |
  "section_residency" | "referenced_objects" | "manifest_residency" | "created_at">;

export interface ResearchMaterializeStageDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  /** Server-composed REPORT admission; metadata cannot provide authority. */
  readonly admission?: ArtifactDraftAdmissionPort;
  readonly recheck_authority: () => Promise<RunStatusAuthoritySnapshot>;
  readonly context: ResearchMaterializeContextReader;
  /** Optional server-owned Stage16 coverage readback; absent keeps legacy materialization unchanged. */
  readonly read_coverage_receipt?: ResearchMaterializeCoverageReader;
  /** Required by the composed semantic workflow; legacy drafts retain NOT_EXECUTED. */
  readonly read_claim_audit?: ResearchMaterializeClaimAuditReader;
  /** Server-owned artifact metadata only; it cannot supply lineage or output identity. */
  readonly metadata: (input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly context: ResearchMaterializeContext;
  }) => ResearchMaterializeTrustedMetadata | Promise<ResearchMaterializeTrustedMetadata>;
}

/** Emits the stage17 W2 payload after the reader has revalidated its lineage. */
export function createResearchMaterializeStageHandler(
  dependencies: ResearchMaterializeStageDependencies,
): WorkflowStageHandler {
  return async ({ request, principal, input_bytes, attempt_ref }) => {
    if (request.stage !== "MATERIALIZE") fail("WORKFLOW_INPUT_INVALID");
    const context = await dependencies.context.read({ request, principal, input_bytes });
    if (context.operation_id !== request.operation_id) fail("WORKFLOW_AUTHORITY_STALE");
    const coverageReceipt = dependencies.read_coverage_receipt === undefined
      ? undefined
      : await dependencies.read_coverage_receipt({ request, principal, context, input_bytes: new Uint8Array(input_bytes) });
    const synthesis = await readCommittedResearchSynthesisOutput({
      database: dependencies.database,
      work_bucket: dependencies.work_bucket,
      operation_id: request.operation_id,
      principal,
      recheck_authority: dependencies.recheck_authority,
    });
    if (synthesis === null) fail("WORKFLOW_OUTPUT_CORRUPT");
    const normalizedSynthesis = dependencies.read_coverage_receipt === undefined
      ? undefined
      : await readCommittedResearchV2MaterializationCandidate({
        database: dependencies.database,
        work_bucket: dependencies.work_bucket,
        request,
        principal,
        context,
        synthesis_readback: synthesis,
      });
    if (dependencies.read_claim_audit !== undefined && normalizedSynthesis === undefined) fail("WORKFLOW_OUTPUT_CORRUPT");
    const claimAudit = dependencies.read_claim_audit === undefined || normalizedSynthesis === undefined ? undefined
      : await dependencies.read_claim_audit({ request, principal, context,
        input_bytes: new Uint8Array(input_bytes), synthesis_readback: synthesis, normalized_synthesis: normalizedSynthesis });
    const metadata = await dependencies.metadata({ request, principal, context });
    if (Object.hasOwn(metadata, "claim_audit")) fail("WORKFLOW_INPUT_INVALID");
    const stageRequestSha256 = await requestDigest(new TextEncoder().encode(JSON.stringify(request)));
    return materializeResearchResult({
      ...metadata,
      database: dependencies.database,
      work_bucket: dependencies.work_bucket,
      operation_id: request.operation_id,
      stage_attempt_ref: attempt_ref,
      stage_request_sha256: stageRequestSha256,
      evidence_freeze: context.freeze,
      reference_manifest: context.manifest,
      evidence_pack: context.stage_five.evidence_pack,
      navigation: dependencies.navigation,
      evidence_resolver: dependencies.evidence_resolver,
      ...(dependencies.admission === undefined ? {} : { admission: dependencies.admission }),
      ...(coverageReceipt === undefined ? {} : { coverage_receipt: coverageReceipt }),
      ...(claimAudit === undefined ? {} : { claim_audit: claimAudit }),
      ...(normalizedSynthesis === undefined ? {} : {
        normalized_synthesis: normalizedSynthesis,
        require_v2_synthesis: true,
      }),
      synthesis_readback: synthesis,
    });
  };
}
