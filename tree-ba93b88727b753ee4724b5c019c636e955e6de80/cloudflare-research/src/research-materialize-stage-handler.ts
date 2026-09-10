import type { CloudflareEvidenceResolver, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { readCommittedResearchSynthesisOutput } from "./research-synthesis-output-reader.js";
import type { RunStatusAuthoritySnapshot } from "./research-run-status.js";
import type { EvidenceFreezeMaterializeContext } from "./research-evidence-freeze-composition.js";
import { digest as requestDigest, fail, type StageRequest, type WorkflowPrincipal, type WorkflowStageHandler } from "./types.js";
import {
  materializeResearchResult,
  type ResearchMaterializeResultWriterInput,
} from "./research-materialize-result.js";

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

export type ResearchMaterializeTrustedMetadata = Pick<ResearchMaterializeResultWriterInput,
  "intent" | "expected_draft_head_revision" | "artifact_ref" | "spec" | "section" |
  "section_residency" | "referenced_objects" | "manifest_residency" | "created_at" | "admission">;

export interface ResearchMaterializeStageDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  readonly recheck_authority: () => Promise<RunStatusAuthoritySnapshot>;
  readonly context: ResearchMaterializeContextReader;
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
    const synthesis = await readCommittedResearchSynthesisOutput({
      database: dependencies.database,
      work_bucket: dependencies.work_bucket,
      operation_id: request.operation_id,
      principal,
      recheck_authority: dependencies.recheck_authority,
    });
    if (synthesis === null) fail("WORKFLOW_OUTPUT_CORRUPT");
    const metadata = await dependencies.metadata({ request, principal, context });
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
      synthesis_readback: synthesis,
    });
  };
}
