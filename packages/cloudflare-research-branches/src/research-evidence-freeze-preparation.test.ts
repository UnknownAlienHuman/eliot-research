import { describe, expect, it } from "vitest";
import {
  ResolvedEvidenceSchema,
  type ResolvedEvidence,
  type ResearchBranchReconciliationCheckpointV2,
  type VersionedRef,
} from "@eliotr/contracts";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { EvidencePack } from "@eliotr/retrieval";
import type { ResearchBranchReconciliationLineage } from "./research-branch-execution.js";
import { buildEvidenceFreezeLineage } from "./research-evidence-freeze-branch-lineage.js";
import { createSynthesisEvidencePackProjection } from "./research-evidence-freeze-preparation.js";
import type { EvidenceFreezeStageFiveLineage } from "./research-evidence-freeze-preparation.js";
import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";

const SHA = "a".repeat(64);
const SCOPE: VersionedRef = { id: "scope-1", revision: 1 };

function resolvedEvidence(id: string, excerpt: string): ResolvedEvidence {
  return ResolvedEvidenceSchema.parse({
    handle: {
      handle_ref: { id, revision: 1 },
      source_namespace_id: "ns",
      source_owner_generation: "gen-1",
      source_revision_ref: "rev-1",
      scope_snapshot_ref: SCOPE,
      anchor: { kind: "normalized_byte_range", start: 0, end: 10 },
      excerpt_sha256: SHA,
      excerpt_byte_length: new TextEncoder().encode(excerpt).byteLength,
      object_residency_key_digest: SHA,
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    exact_excerpt: excerpt,
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
    credential_generation: "cred-1",
    source_revision_content_sha256: SHA,
    scope_snapshot_digest: SHA,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-01-01T00:00:00.000Z",
  });
}

function stageFivePack(items: readonly ResolvedEvidence[]): EvidencePack {
  return {
    pack_ref: { id: "pack-stage-five", revision: 1 },
    scope_snapshot_ref: SCOPE,
    resolved_evidence: items,
    omitted_candidates: [{ candidate_id: "root-omitted", reason_code: "EVIDENCE_UNRESOLVED" }],
    trace_ref: { id: "trace-stage-five", revision: 1 },
    total_utf8_bytes: items.reduce((sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength, 0),
  };
}

const branchLineage = {
  branch_resolved_evidence: [resolvedEvidence("h-branch", "branch evidence")],
  branch_omitted_candidate_refs: ["branch-omitted"],
  branch_trace_refs: [{ id: "trace-branch", revision: 1 }],
  branch_scope_snapshot_ref: SCOPE,
  branch_reconciliation_ref: { id: "reconciliation-1", revision: 1 },
  branch_reconciliation_digest: SHA,
} as const;

describe("createSynthesisEvidencePackProjection", () => {
  it("creates a frozen root-plus-branch pack with independent content and trace identity", async () => {
    const stageFive = stageFivePack([resolvedEvidence("h-root", "root evidence")]);
    const historicalBytes = JSON.stringify(stageFive);
    const projection = await createSynthesisEvidencePackProjection({
      stage_five_pack: stageFive,
      ...branchLineage,
      freeze_ref: { id: "freeze-1", revision: 1 },
      manifest_digest: "b".repeat(64),
    });

    expect(projection.resolved_evidence.map((item) => item.handle.handle_ref.id)).toEqual(["h-branch", "h-root"]);
    expect(projection.omitted_candidates).toEqual([
      { candidate_id: "branch-omitted", reason_code: "BRANCH_QUERY_OMITTED" },
      { candidate_id: "root-omitted", reason_code: "EVIDENCE_UNRESOLVED" },
    ]);
    expect(projection.pack_ref.id).not.toBe(stageFive.pack_ref.id);
    expect(projection.trace_ref.id).not.toBe(stageFive.trace_ref.id);
    expect(projection.stage_five_pack_ref).toEqual(stageFive.pack_ref);
    expect(projection.stage_five_trace_ref).toEqual(stageFive.trace_ref);
    expect(projection.provenance_trace_refs).toEqual([
      { id: "trace-branch", revision: 1 },
      { id: "trace-stage-five", revision: 1 },
    ]);
    expect(projection.freeze_ref).toEqual({ id: "freeze-1", revision: 1 });
    expect(projection.manifest_digest).toBe("b".repeat(64));
    expect(JSON.stringify(stageFive)).toBe(historicalBytes);
    expect(Object.isFrozen(projection.resolved_evidence[0]?.handle)).toBe(true);
  });

  it("rejects a same-handle disagreement instead of changing the stage-five evidence", async () => {
    const stageFive = stageFivePack([resolvedEvidence("h-shared", "root bytes")]);
    await expect(createSynthesisEvidencePackProjection({
      stage_five_pack: stageFive,
      ...branchLineage,
      branch_resolved_evidence: [resolvedEvidence("h-shared", "branch bytes")],
      freeze_ref: { id: "freeze-1", revision: 1 },
      manifest_digest: "b".repeat(64),
    })).rejects.toThrow("root and branch query evidence disagree for one exact handle");
    expect(stageFive.resolved_evidence[0]?.exact_excerpt).toBe("root bytes");
  });

  it("merges fresh same-source receipts but rejects metadata substitution with identical text", async () => {
    const committed = resolvedEvidence("h-shared", "same bytes");
    const stageFive = stageFivePack([committed]);
    const historicalBytes = JSON.stringify(stageFive);
    const fresh = { ...committed, verification_receipt_ref: "verification-new",
      authorization_receipt_ref: "authorization-new", resolved_at: "2026-10-09T01:00:00.000Z" };
    const project = (evidence: ResolvedEvidence) => createSynthesisEvidencePackProjection({
      stage_five_pack: stageFive, ...branchLineage, branch_resolved_evidence: [evidence],
    });
    const projection = await project(fresh);
    const originalProjection = await project(committed);
    expect(projection.resolved_evidence).toEqual([fresh]);
    expect(projection.pack_ref).toEqual(originalProjection.pack_ref);
    expect(projection.trace_ref).toEqual(originalProjection.trace_ref);
    expect(projection.projection_digest).toBe(originalProjection.projection_digest);
    expect(JSON.stringify(stageFive)).toBe(historicalBytes);
    await expect(project({ ...fresh, handle: { ...fresh.handle, source_revision_ref: "other-revision" } }))
      .rejects.toThrow("root and branch query evidence disagree for one exact handle");
  });
});

async function v2CounterLineage(unresolvedContradictionRefs: readonly string[]): Promise<ResearchBranchReconciliationLineage> {
  const handleRef = { id: "counter-handle", revision: 1 };
  const resultMaterial = {
    protocol: "eliotr.research.branch-result.v2",
    role: "COUNTER",
    status: "CANDIDATE_READY",
    evidence_handle_refs: [handleRef],
  };
  const resultDigest = await evidenceSha256({ domain: "eliotr.research.branch-result.v2", value: resultMaterial });
  const counterResult = {
    ...resultMaterial,
    identity_digest: resultDigest,
    result_ref: { id: `eliotr.research.branch-result-v2-${resultDigest}`, revision: 1 },
  };
  const checkpointMaterial = {
    protocol: "eliotr.research.branch-reconciliation.v2",
    operation_id: "operation-1",
    investigation_ref: { id: "investigation-1", revision: 1 },
    principal_ref: "principal-1",
    scope_snapshot_ref: SCOPE,
    inquiry_protocol_ref: { id: "protocol-1", revision: 1 },
    protocol_digest: SHA,
    planning_manifest_ref: { id: "planning-1", revision: 1 },
    planning_manifest_digest: SHA,
    branch_analysis_ref: { id: "analysis-1", revision: 1 },
    required_roles: ["COUNTER"],
    branch_results: [counterResult],
    unmet_required_roles: [],
    unresolved_contradiction_refs: [...unresolvedContradictionRefs],
    research_debts: [],
    counter_search_status: "COMPLETE",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const digest = await evidenceSha256({ domain: "eliotr.research.branch-reconciliation.v2", value: checkpointMaterial });
  const checkpoint = {
    ...checkpointMaterial,
    identity_digest: digest,
    checkpoint_ref: { id: `eliotr.research.branch-reconciliation-v2-${digest}`, revision: 1 },
  } as unknown as ResearchBranchReconciliationCheckpointV2;

  return {
    checkpoint,
    read_extract_attempt_ref: "read-attempt",
    read_extract_request_sha256: SHA,
    branch_analysis_attempt_ref: "analysis-attempt",
    branch_analysis_request_sha256: SHA,
    stage_attempt_ref: "stage-attempt",
    stage_request_sha256: SHA,
  };
}

describe("V2 counter relation authority", () => {
  it("rejects a self-rehashed contradiction derived only from a COUNTER evidence handle", async () => {
    const handleRef = { id: "counter-handle", revision: 1 };
    const handleDerivedContradiction = `eliotr.research.contradiction-${await evidenceSha256({
      domain: "eliotr.research.contradiction.v1",
      handle_ref: handleRef,
    })}`;
    const stageZero = {
      operation_id: "operation-1",
      attempt_ref: "zero-attempt",
      investigation_ref: { id: "investigation-1", revision: 1 },
      principal_ref: "principal-1",
      scope_snapshot_ref: SCOPE,
      profile_definition_ref: { id: "protocol-1", revision: 1 },
      protocol_digest: SHA,
      planning_manifest_ref: { id: "planning-1", revision: 1 },
      planning_manifest_digest: SHA,
      denominator_digest: SHA,
      coverage_denominator: { required_question_branches: ["COUNTER"] },
    } as unknown as ProtocolScopeCheckpoint;
    const stageFive = {
      operation_id: "operation-1",
      stage_attempt_ref: "stage-attempt",
      stage_request_sha256: SHA,
    } as unknown as EvidenceFreezeStageFiveLineage;
    const build = async (refs: readonly string[]) => buildEvidenceFreezeLineage({
      operation_id: "operation-1",
      stage_zero: stageZero,
      stage_five: stageFive,
      model_profile_binding_ref: { id: "model-binding-1", revision: 1 },
      branch_reconciliation: await v2CounterLineage(refs),
    });

    await expect(build([])).resolves.toMatchObject({ branch: { unresolved_contradiction_refs: [] } });
    await expect(build([handleDerivedContradiction])).rejects.toThrow("branch reconciliation lineage is inconsistent");
  });
});
