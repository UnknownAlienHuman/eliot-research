import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { EvidenceFreezeSchema, ResearchEvidenceFreezeV3Schema, type EvidenceFreeze, type EvidenceFreezeBranchFindings,
  type ResolvedEvidence } from "@eliotr/contracts";
import { fail, type StageRequest, type StageReceipt } from "@eliotr/cloudflare-workflows";
import { BRANCH_QUERY_HANDLER_GENERATION } from "./research-branch-execution.js";
import { sourceBoundEvidenceIdentity } from "./research-branch-evidence-identity.js";

/** Checks the existing committed-query-to-freeze binding, not source authority. */
export function assertFrozenBranchEvidenceBinding(
  committed: readonly ResolvedEvidence[],
  frozen: readonly ResolvedEvidence[],
): void {
  const byHandle = new Map<string, string>();
  for (const evidence of committed) {
    const key = canonicalEvidenceJson(evidence.handle.handle_ref);
    const identity = sourceBoundEvidenceIdentity(evidence);
    const previous = byHandle.get(key);
    if (previous !== undefined && previous !== identity) fail("WORKFLOW_OUTPUT_CORRUPT");
    byHandle.set(key, identity);
  }
  const frozenKeys = new Set<string>();
  for (const evidence of frozen) {
    const key = canonicalEvidenceJson(evidence.handle.handle_ref);
    if (frozenKeys.has(key) || byHandle.get(key) !== sourceBoundEvidenceIdentity(evidence)) {
      fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    frozenKeys.add(key);
  }
  if (frozenKeys.size !== byHandle.size) fail("WORKFLOW_OUTPUT_CORRUPT");
}

export async function parseCommittedFreeze(bytes: Uint8Array, generation: string): Promise<{
  readonly freeze: EvidenceFreeze;
  readonly branch_findings?: EvidenceFreezeBranchFindings;
}> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (generation === BRANCH_QUERY_HANDLER_GENERATION) {
      const envelope = ResearchEvidenceFreezeV3Schema.parse(JSON.parse(text));
      const { identity_digest: envelopeDigest, ...envelopeMaterial } = envelope;
      const { identity_digest: findingsDigest, ...findingsMaterial } = envelope.branch_findings;
      if (canonicalEvidenceJson(envelope) !== text ||
          envelopeDigest !== await evidenceSha256({ domain: "eliotr.research.evidence-freeze.v3", value: envelopeMaterial }) ||
          findingsDigest !== await evidenceSha256({ domain: "eliotr.research.evidence-freeze-branch-findings.v1", value: findingsMaterial })) {
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      return { freeze: envelope.freeze, branch_findings: envelope.branch_findings };
    }
    const value = EvidenceFreezeSchema.parse(JSON.parse(text));
    if (canonicalEvidenceJson(value) !== text) fail("WORKFLOW_OUTPUT_CORRUPT");
    return { freeze: value };
  } catch {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
}

export function assertSynthesisLineage(
  request: StageRequest,
  stageTen: { readonly request: StageRequest; readonly attempt_ref: string; readonly request_sha256: string },
  stageTenReceipt: StageReceipt,
  stageEleven: { readonly request: StageRequest; readonly attempt_ref: string; readonly request_sha256: string },
  stageElevenReceipt: StageReceipt,
): void {
  if (request.stage !== "SYNTHESIZE" || stageTen.request.stage !== "RECONCILE" || stageEleven.request.stage !== "FREEZE_EVIDENCE" ||
      request.operation_id !== stageTen.request.operation_id || request.operation_id !== stageEleven.request.operation_id ||
      request.handler_generation !== stageTen.request.handler_generation ||
      request.handler_generation !== stageEleven.request.handler_generation ||
      request.investigation_ref.id !== stageTen.request.investigation_ref.id ||
      request.investigation_ref.id !== stageEleven.request.investigation_ref.id ||
      stageTenReceipt.investigation_ref.id !== request.investigation_ref.id ||
      stageElevenReceipt.investigation_ref.id !== request.investigation_ref.id ||
      stageTenReceipt.investigation_ref.revision !== stageEleven.request.investigation_ref.revision ||
      stageElevenReceipt.investigation_ref.revision !== request.investigation_ref.revision ||
      stageTenReceipt.output_manifest.object_ref !== stageEleven.request.input_manifest.object_ref ||
      stageTenReceipt.output_manifest.sha256 !== stageEleven.request.input_manifest.sha256 ||
      stageElevenReceipt.output_manifest.object_ref !== request.input_manifest.object_ref ||
      stageElevenReceipt.output_manifest.sha256 !== request.input_manifest.sha256 ||
      stageTenReceipt.input_manifest_ref !== stageTen.request.input_manifest.object_ref ||
      stageElevenReceipt.input_manifest_ref !== stageEleven.request.input_manifest.object_ref ||
      stageTenReceipt.attempt_ref !== stageTen.attempt_ref || stageElevenReceipt.attempt_ref !== stageEleven.attempt_ref ||
      stageTenReceipt.request_sha256 !== stageTen.request_sha256 || stageElevenReceipt.request_sha256 !== stageEleven.request_sha256) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
}
