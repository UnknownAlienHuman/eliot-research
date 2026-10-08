import { describe, expect, it, vi } from "vitest";
import { StageRequestSchema, type StageRequest } from "@eliotr/cloudflare-workflows";
import {
  ResearchBranchEvidenceItemSchema,
  ResearchReadExtractCheckpointSchema,
  ResolvedEvidenceSchema,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import type { EvidencePack as RetrievalEvidencePack } from "@eliotr/retrieval";
import type { ModelAttemptPreparationContext } from "@eliotr/cloudflare-model-execution";
import { ModelAttemptError, type ModelAttemptReservationInput } from "@eliotr/cloudflare-model-execution";
import type {
  ResearchModelSpendPolicy,
} from "@eliotr/cloudflare-model-execution";
import type { ResearchModelSpendAdmissionRecord } from "@eliotr/cloudflare-model-execution";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createResearchBranchRoleServerPreparation,
  type ResearchBranchRoleServerPreparationDependencies,
} from "./research-branch-role-server-preparation.js";

const SHA = "b".repeat(64);
const SCOPE: VersionedRef = { id: "scope-1", revision: 1 };
const OBJECT = {
  object_ref: "objects/k",
  sha256: SHA,
  byte_length: 4,
  residency: {
    scope_domain_id: "scope",
    access_domain_id: "access",
    confidentiality_domain_id: "conf",
    encryption_key_domain_id: "enc",
    retention_domain_id: "ret",
    erasure_domain_id: "erase",
    content_digest: { algorithm: "sha256", digest: SHA },
  },
};

function roleRequest(stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH", role: "SUPPORT" | "COUNTER"): StageRequest {
  return StageRequestSchema.parse({
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "op-1",
    investigation_ref: { id: "inv-1", revision: 2 },
    stage,
    idempotency_key: `op-1:${stage}:branch-role:${role}`,
    handler_generation: "gen-1",
    input_manifest: OBJECT,
  });
}

function context(
  stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH" = "ANALYZE_BRANCHES",
  role: "SUPPORT" | "COUNTER" = "SUPPORT",
): ModelAttemptPreparationContext {
  return {
    request: roleRequest(stage, role),
    principal: { principal_ref: "research", credential_generation: "gen-1", deployment_generation: "gen-1" },
    input_bytes: new TextEncoder().encode("input"),
    attempt_ref: "attempt-1",
    budget_receipt_ref: "budget-1",
    model_output_object_ref: "outputs/model",
    stage_request_sha256: SHA,
    model_operation_id: "model-op-1",
    model_idempotency_key: "model-op-1:SUPPORT",
  };
}

function evidenceItem(id: string, revision: number, sourceClass: string) {
  return ResearchBranchEvidenceItemSchema.parse({
    handle_ref: { id, revision },
    source_revision_ref: "rev-1",
    source_id: `src-${id}`,
    source_class: sourceClass,
    source_namespace_id: "ns",
    source_owner_generation: "gen-1",
    source_family_ref: "family-1",
    independence: "UNKNOWN",
    excerpt_sha256: SHA,
    excerpt_byte_length: 5,
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
  });
}

function resolvedEvidence(id: string, revision: number, excerpt: string): ResolvedEvidence {
  return ResolvedEvidenceSchema.parse({
    handle: {
      handle_ref: { id, revision },
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

const DIGEST = "c".repeat(64);
function stageFivePack(items: ResolvedEvidence[]): RetrievalEvidencePack {
  return {
    pack_ref: { id: "pack-stage-five", revision: 1 },
    scope_snapshot_ref: SCOPE,
    resolved_evidence: items,
    omitted_candidates: [],
    trace_ref: { id: "trace-1", revision: 1 },
    total_utf8_bytes: 0,
  };
}

function readExtract(items: ReturnType<typeof evidenceItem>) {
  return ResearchReadExtractCheckpointSchema.parse({
    protocol: "eliotr.research.read-extract.v1",
    checkpoint_ref: { id: `eliotr.research.read-extract-${DIGEST}`, revision: 1 },
    identity_digest: DIGEST,
    operation_id: "op-1",
    investigation_ref: { id: "inv-1", revision: 2 },
    principal_ref: "research",
    scope_snapshot_ref: SCOPE,
    inquiry_protocol_ref: { id: "inq", revision: 1 },
    protocol_digest: DIGEST,
    planning_manifest_ref: { id: "plan", revision: 1 },
    planning_manifest_digest: DIGEST,
    retrieval_request_digest: DIGEST,
    evidence: [items],
    omitted_candidate_refs: [],
    created_at: "2026-01-01T00:00:00.000Z",
  });
}

const DEPLOYMENT: ModelRouteDeployment = {
  route_ref: "dynamic/eliotr-balanced",
  route_version: "1",
  prompt_generation: "g1",
  schema_generation: "g1",
  parameters_digest: SHA,
  pricing_snapshot_ref: "price-1",
};

function rules(): ResearchModelSpendPolicy["rules"] {
  return [
    {
      stage: "ANALYZE_BRANCHES",
      deployment: DEPLOYMENT,
      max_input_bytes: 1000,
      max_output_bytes: 1000,
      quote: {
        estimated_model_calls: 1, estimated_input_tokens: 100, estimated_output_tokens: 100,
        estimated_embedding_tokens: 0, quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0,
        byok_usd: 0, max_total_usd: 1, workflow_steps: 1, expected_sources: 1,
        expected_sections: 1, confidence: 1,
      },
    },
    {
      stage: "COUNTER_SEARCH",
      deployment: DEPLOYMENT,
      max_input_bytes: 1000,
      max_output_bytes: 1000,
      quote: {
        estimated_model_calls: 1, estimated_input_tokens: 100, estimated_output_tokens: 100,
        estimated_embedding_tokens: 0, quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0,
        byok_usd: 0, max_total_usd: 1, workflow_steps: 1, expected_sources: 1,
        expected_sections: 1, confidence: 1,
      },
    },
  ];
}

const ADMISSION = { admission: "record" } as unknown as ResearchModelSpendAdmissionRecord;
const RESERVATION = { reservation: "input" } as unknown as ModelAttemptReservationInput;

function deps(overrides: Partial<ResearchBranchRoleServerPreparationDependencies> = {}) {
  const mocks = {
    read_stage_five: vi.fn<ResearchBranchRoleServerPreparationDependencies["read_stage_five"]>(),
    read_read_extract: vi.fn<ResearchBranchRoleServerPreparationDependencies["read_read_extract"]>(),
    admit_branch_role: vi.fn<ResearchBranchRoleServerPreparationDependencies["admit_branch_role"]>(),
    prepare_attempt: vi.fn<ResearchBranchRoleServerPreparationDependencies["prepare_attempt"]>(),
  };
  mocks.read_stage_five.mockResolvedValue({ evidence_pack: stageFivePack([resolvedEvidence("h-a", 1, "alpha")]) });
  mocks.read_read_extract.mockResolvedValue(readExtract(evidenceItem("h-a", 1, "primary source")));
  mocks.admit_branch_role.mockResolvedValue(ADMISSION);
  mocks.prepare_attempt.mockResolvedValue(RESERVATION);
  const full: ResearchBranchRoleServerPreparationDependencies = {
    read_stage_five: mocks.read_stage_five,
    read_read_extract: mocks.read_read_extract,
    policy_rules: rules(),
    admit_branch_role: mocks.admit_branch_role,
    prepare_attempt: mocks.prepare_attempt,
    ...overrides,
  };
  return { ...mocks, deps: full };
}

describe("createResearchBranchRoleServerPreparation", () => {
  it("recovers the stage request, reads frozen evidence, admits, and prepares the attempt", async () => {
    const d = deps();
    const prepare = createResearchBranchRoleServerPreparation(d.deps);
    const ctx = context();
    const result = await prepare(ctx, "SUPPORT");
    expect(result).toBe(RESERVATION);
    expect(d.read_stage_five).toHaveBeenCalledWith({
      operation_id: "op-1",
      investigation_id: "inv-1",
      principal: ctx.principal,
    });
    expect(d.read_read_extract).toHaveBeenCalledWith("op-1", "inv-1");
    const admissionInput = d.admit_branch_role.mock.calls[0]?.[0];
    expect(admissionInput?.role).toBe("SUPPORT");
    expect(admissionInput?.deployment).toEqual(DEPLOYMENT);
    expect(admissionInput?.stage_request.stage).toBe("ANALYZE_BRANCHES");
    expect(admissionInput?.stage_request.idempotency_key).not.toContain(":branch-role:");
    const prepareArgs = d.prepare_attempt.mock.calls[0];
    expect(prepareArgs?.[0]).toBe(ctx);
    expect(prepareArgs?.[1]).toBe("SUPPORT");
    expect(prepareArgs?.[2]).toBe(ADMISSION);
    const pack: RetrievalEvidencePack | undefined = prepareArgs?.[3];
    expect(pack?.resolved_evidence.map((item) => item.handle.handle_ref.id)).toEqual(["h-a"]);
    expect(pack?.pack_ref.id.startsWith("branch-role-evidence-pack-")).toBe(true);
  });

  it("selects the COUNTER_SEARCH rule for a counter-stage request", async () => {
    const d = deps({
      read_stage_five: vi.fn(async () => ({ evidence_pack: stageFivePack([resolvedEvidence("h-c", 1, "contra")]) })),
      read_read_extract: vi.fn(async () => readExtract(evidenceItem("h-c", 1, "counter evidence"))),
    });
    const prepare = createResearchBranchRoleServerPreparation(d.deps);
    await prepare(context("COUNTER_SEARCH", "COUNTER"), "COUNTER");
    const admissionInput = d.admit_branch_role.mock.calls[0]?.[0];
    expect(admissionInput?.stage_request.stage).toBe("COUNTER_SEARCH");
    expect(admissionInput?.deployment).toEqual(DEPLOYMENT);
  });

  it("fails closed when the stage has no installed rule", async () => {
    const d = deps({ policy_rules: rules().filter((rule) => rule.stage === "ANALYZE_BRANCHES") });
    const prepare = createResearchBranchRoleServerPreparation(d.deps);
    await expect(prepare(context("COUNTER_SEARCH", "COUNTER"), "COUNTER")).rejects.toMatchObject({
      code: "WORKFLOW_CONFIGURATION_MISSING",
    });
    expect(d.admit_branch_role).not.toHaveBeenCalled();
  });

  it("fails closed when the committed read-extract selects nothing for the role", async () => {
    const d = deps({
      read_stage_five: vi.fn(async () => ({ evidence_pack: stageFivePack([resolvedEvidence("h-a", 1, "alpha")]) })),
      read_read_extract: vi.fn(async () => readExtract(evidenceItem("h-a", 1, "counter evidence"))),
    });
    const prepare = createResearchBranchRoleServerPreparation(d.deps);
    // SUPPORT excludes counter-class evidence; the selection is empty.
    await expect(prepare(context(), "SUPPORT")).rejects.toMatchObject({
      code: "WORKFLOW_CONFIGURATION_MISSING",
    });
    expect(d.admit_branch_role).not.toHaveBeenCalled();
  });

  it("fails closed when the selection disagrees with the frozen pack", async () => {
    const d = deps({
      read_read_extract: vi.fn(async () => readExtract(evidenceItem("h-x", 1, "primary source"))),
    });
    const prepare = createResearchBranchRoleServerPreparation(d.deps);
    await expect(prepare(context(), "SUPPORT")).rejects.toBeInstanceOf(ModelAttemptError);
    expect(d.admit_branch_role).not.toHaveBeenCalled();
  });

  it("rejects invalid dependencies", () => {
    expect(() => createResearchBranchRoleServerPreparation({} as never)).toThrow(ModelAttemptError);
  });
});
