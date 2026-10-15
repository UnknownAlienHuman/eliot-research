import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ResearchModule from "@eliotr/cloudflare-research";
import type * as WorkflowModule from "@eliotr/cloudflare-workflows";
import type { EvidenceFreezeSynthesisContext } from "@eliotr/cloudflare-research";
import {
  digest,
  workflowFailure,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { createResearchVerificationStageHandler, type ResearchVerificationStageDependencies } from "./research-verification-stage-handler.js";

const mocks = vi.hoisted(() => ({
  readCommittedStageLineage: vi.fn(),
  readCommittedResearchSynthesisOutput: vi.fn(),
}));

vi.mock("@eliotr/cloudflare-workflows", async () => {
  const workflows = await vi.importActual<typeof WorkflowModule>("@eliotr/cloudflare-workflows");
  return { ...workflows, readCommittedStageLineage: mocks.readCommittedStageLineage };
});

vi.mock("@eliotr/cloudflare-research", async () => {
  const research = await vi.importActual<typeof ResearchModule>("@eliotr/cloudflare-research");
  return { ...research, readCommittedResearchSynthesisOutput: mocks.readCommittedResearchSynthesisOutput };
});

const principal: WorkflowPrincipal = {
  principal_ref: "owner-1",
  credential_generation: "credential-1",
  deployment_generation: "deployment-1",
};

const scope = { id: "scope-1", revision: 1 };
const requestHash = "a".repeat(64);
const synthesisAttemptRef = "synthesis-attempt-1";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("unsupported synthesis candidate failure", () => {
  it("keeps the strict no-reference rejection and reports a known VERIFY no-dispatch outcome", async () => {
    const assistantContent = JSON.stringify({
      schema: "eliotr.research.synthesis-claims-candidate.v3",
      material_claims: [{
        text: "An unsupported candidate claim",
        kind: "observation",
        support_handle_refs: [],
        counterevidence_handle_refs: [],
      }],
    });
    const providerBody = new TextEncoder().encode(JSON.stringify({
      id: "compat-1",
      object: "chat.completion",
      created: 1,
      model: "test-model",
      service_tier: "default",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: assistantContent } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, neurons: 0.25 },
    }));
    const providerBodySha = await digest(providerBody);
    const outputManifest = {
      object_ref: "workflow/synthesis-output",
      sha256: providerBodySha,
      byte_length: providerBody.byteLength,
      residency: {
        scope_domain_id: scope.id,
        access_domain_id: principal.principal_ref,
        confidentiality_domain_id: "confidentiality-1",
        encryption_key_domain_id: "key-1",
        retention_domain_id: "retention-1",
        erasure_domain_id: "erasure-1",
        content_digest: { algorithm: "sha256" as const, digest: providerBodySha },
      },
    };
    const request: StageRequest = {
      protocol: "eliotr.workflow-stage.v1",
      operation_id: "operation-1",
      investigation_ref: { id: "investigation-1", revision: 14 },
      stage: "VERIFY",
      idempotency_key: "verify-key-1",
      handler_generation: "research-handler-v1",
      input_manifest: outputManifest,
    };
    const synthesisRequest = {
      ...request,
      investigation_ref: { id: request.investigation_ref.id, revision: 13 },
      stage: "SYNTHESIZE" as const,
    };
    mocks.readCommittedStageLineage.mockResolvedValue({
      request: synthesisRequest,
      request_sha256: requestHash,
      attempt_ref: synthesisAttemptRef,
      receipt: {
        investigation_ref: synthesisRequest.investigation_ref,
        output_manifest: outputManifest,
        engine_state: "CHECKPOINTED",
      },
    });
    mocks.readCommittedResearchSynthesisOutput.mockResolvedValue({
      stage_attempt_ref: synthesisAttemptRef,
      stage_request_sha256: requestHash,
      output: { output_sha256: providerBodySha },
      workflow_receipt: { output_manifest: outputManifest },
      bytes: providerBody,
    });
    const evidencePack = { resolved_evidence: [] };
    const context = {
      operation_id: request.operation_id,
      investigation_id: request.investigation_ref.id,
      current_revision: request.investigation_ref.revision,
      ...principal,
      stage_eleven_request: { stage: "FREEZE_EVIDENCE" },
      stage_eleven_receipt: { engine_state: "CHECKPOINTED" },
      freeze: { scope_snapshot_ref: scope, included_evidence: [] },
      manifest: { scope_snapshot_ref: scope, allowed_evidence_handle_refs: [] },
      stage_five: { scope_snapshot_ref: scope, evidence_pack: evidencePack },
    } as unknown as EvidenceFreezeSynthesisContext;
    const resolver = { resolveCitationSet: vi.fn() };
    const handler = createResearchVerificationStageHandler({
      database: {} as D1Database,
      work_bucket: {} as R2Bucket,
      navigation: {} as ResearchVerificationStageDependencies["navigation"],
      evidence_resolver: resolver as unknown as ResearchVerificationStageDependencies["evidence_resolver"],
      recheck_authority: vi.fn() as ResearchVerificationStageDependencies["recheck_authority"],
      context: { read: vi.fn(async () => context) },
      v2_config: {
        section_ref: { id: "section-1", revision: 1 },
        required_precision: "exact",
        required_source_class: "primary-source",
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await handler({
      request,
      principal,
      input_bytes: providerBody,
      attempt_ref: "verify-attempt-1",
      budget_receipt_ref: "budget-1",
    }).then(() => null, (reason: unknown) => reason);

    const expectedFailure = {
      protocol: "eliotr.workflow-failure-outcome.v1",
      code: "WORKFLOW_OUTPUT_CORRUPT",
      phase: "STAGE",
      stage: "VERIFY",
      retryable: false,
      dispatch_state: "NOT_STARTED",
      references_intact: "INTACT",
      recovery_action: "NONE",
    } as const;
    expect(error).toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT", failure: expectedFailure });
    expect(workflowFailure(error, "STAGE", "VERIFY")).toEqual(expectedFailure);
    expect(mocks.readCommittedStageLineage).toHaveBeenCalledOnce();
    expect(mocks.readCommittedResearchSynthesisOutput).toHaveBeenCalledOnce();
    expect(resolver.resolveCitationSet).not.toHaveBeenCalled();
  });
});
