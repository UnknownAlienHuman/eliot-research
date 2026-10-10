import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EvidenceModule from "@eliotr/cloudflare-evidence";
import type * as ResearchModule from "@eliotr/cloudflare-research";
import type * as WorkflowsModule from "@eliotr/cloudflare-workflows";
import type { EvidenceFreezeSynthesisContext, EvidenceFreezeSynthesisReaderEnvironment, EvidenceFreezeCommittedReaders } from "@eliotr/cloudflare-research";
import type { ResearchCitationsResult } from "./research-citations-result.js";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import { INSTALLED_INQUIRY_PROTOCOL_REFS, installedInquiryProtocolDefinition,
  type InstalledInquiryProtocolName } from "@eliotr/cloudflare-research";
import { createResearchCoverageStageHandlerFromFreeze } from "./research-coverage-stage-handler.js";

const mocks = vi.hoisted(() => ({
  canonicalEvidenceJson: vi.fn((value: unknown) => JSON.stringify(value)),
  stableEvidenceId: vi.fn(async () => "coverage-receipt-1"),
  digest: vi.fn(async () => "a".repeat(64)),
  fail: vi.fn((code: string): never => {
    const error = new Error(code) as Error & { code: string };
    error.code = code;
    throw error;
  }),
  parseRequest: vi.fn((value: unknown) => value),
  readCommittedStageLineage: vi.fn(),
  snapshotPrincipal: vi.fn((value: unknown) => value),
  readCommittedProtocolScopeCheckpoint: vi.fn(),
  createEvidenceFreezePostSynthesisContextReader: vi.fn(),
  decodeResearchCitationsResult: vi.fn(),
  encodeResearchCoverageResult: vi.fn(async () => Uint8Array.of(7)),
}));

vi.mock("@eliotr/cloudflare-evidence", async () => ({
  ...await vi.importActual<typeof EvidenceModule>("@eliotr/cloudflare-evidence"),
  canonicalEvidenceJson: mocks.canonicalEvidenceJson,
  stableEvidenceId: mocks.stableEvidenceId,
}));

vi.mock("@eliotr/cloudflare-research", async () => {
  const inquiry = await vi.importActual<typeof ResearchModule>("@eliotr/cloudflare-research");
  return {
    INSTALLED_INQUIRY_PROTOCOL_REFS: inquiry.INSTALLED_INQUIRY_PROTOCOL_REFS,
    installedInquiryProtocolDefinition: inquiry.installedInquiryProtocolDefinition,
    createEvidenceFreezePostSynthesisContextReader: mocks.createEvidenceFreezePostSynthesisContextReader,
    readCommittedProtocolScopeCheckpoint: mocks.readCommittedProtocolScopeCheckpoint,
  };
});

vi.mock("@eliotr/cloudflare-workflows", async () => ({
  ...await vi.importActual<typeof WorkflowsModule>("@eliotr/cloudflare-workflows"),
  WorkflowCheckpointError: class WorkflowCheckpointError extends Error {},
  WorkflowCheckpointStore: class WorkflowCheckpointStore {},
  digest: mocks.digest,
  fail: mocks.fail,
  parseRequest: mocks.parseRequest,
  readCommittedStageLineage: mocks.readCommittedStageLineage,
  snapshotPrincipal: mocks.snapshotPrincipal,
}));

vi.mock("./research-citations-result.js", () => ({
  decodeResearchCitationsResult: mocks.decodeResearchCitationsResult,
}));

vi.mock("./research-coverage-result.js", () => ({
  encodeResearchCoverageResult: mocks.encodeResearchCoverageResult,
}));

const principal: WorkflowPrincipal = {
  principal_ref: "owner-1",
  credential_generation: "credential-1",
  deployment_generation: "deployment-1",
};

function setup(debtOverride?: unknown, protocolName: InstalledInquiryProtocolName = "lookup") {
  vi.clearAllMocks();
  const inputBytes = Uint8Array.of(1, 2, 3);
  const scopeRef = { id: "scope-1", revision: 1 };
  const freezeRef = { id: "freeze-1", revision: 1 };
  const manifestRef = { id: "manifest-1", revision: 1 };
  const evidencePackRef = { id: "evidence-pack-1", revision: 1 };
  const denominatorRef = { id: "denominator-1", revision: 1 };
  const debtRef = { id: "debt-1", revision: 1 };
  const branchRef = { id: "branch-reconciliation-1", revision: 1 };
  const debt = {
    debt_ref: debtRef,
    kind: "coverage",
    blocked_refs: ["SUPPORT"],
    basis_and_evidence_refs: [],
    owner: "research-owner",
    blocking_effect: "The required support branch did not complete.",
    next_probe: "Run the committed support branch against the frozen scope.",
    review_condition: "Review after the support branch completes.",
    status: "OPEN",
  };
  const checkpoint = {
    protocol: "eliotr.research.branch-reconciliation.v2",
    checkpoint_ref: branchRef,
    identity_digest: "b".repeat(64),
    research_debts: debtOverride === undefined ? [debt] : [debtOverride],
  };
  const branchLineage = { checkpoint };
  const requestInputManifest = {
    object_ref: "stage-15-output",
    sha256: "a".repeat(64),
    byte_length: inputBytes.byteLength,
    residency: {} as StageRequest["input_manifest"]["residency"],
  };
  const request = {
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "operation-1",
    investigation_ref: { id: "investigation-1", revision: 4 },
    stage: "CALCULATE_COVERAGE",
    idempotency_key: "coverage-key-1",
    handler_generation: "research-handler-v1",
    input_manifest: requestInputManifest,
  } as StageRequest;
  const predecessor = {
    request: {
      protocol: "eliotr.workflow-stage.v1",
      operation_id: request.operation_id,
      investigation_ref: { id: request.investigation_ref.id, revision: 3 },
      stage: "RESOLVE_CITATIONS",
      idempotency_key: "citations-key-1",
      handler_generation: request.handler_generation,
      input_manifest: { ...requestInputManifest, object_ref: "stage-14-output" },
    },
    receipt: {
      engine_state: "CHECKPOINTED",
      input_manifest_ref: "stage-14-output",
      investigation_ref: { id: request.investigation_ref.id, revision: 4 },
      output_manifest: requestInputManifest,
    },
    attempt_ref: "citations-attempt-1",
    request_sha256: "a".repeat(64),
  };
  const citations = {
    protocol: "eliotr.research.citations.v2",
    operation_id: request.operation_id,
    investigation_ref: { id: request.investigation_ref.id, revision: 3 },
    stage: "RESOLVE_CITATIONS",
    stage_attempt_ref: predecessor.attempt_ref,
    stage_request_sha256: predecessor.request_sha256,
    freeze_ref: freezeRef,
    scope_snapshot_ref: scopeRef,
    manifest_ref: manifestRef,
    evidence_pack_ref: evidencePackRef,
    claims: [],
    citation_resolution_receipt: { scope_snapshot_ref: scopeRef, resolved: [] },
  } as unknown as ResearchCitationsResult;
  const context = {
    operation_id: request.operation_id,
    investigation_id: request.investigation_ref.id,
    current_revision: request.investigation_ref.revision,
    principal_ref: principal.principal_ref,
    credential_generation: principal.credential_generation,
    deployment_generation: principal.deployment_generation,
    authorization_receipt_ref: "authorization-1",
    stage_ten_input: { lane_material: { lane: "primary", lane_registrations: [] } },
    freeze: {
      freeze_ref: freezeRef,
      scope_snapshot_ref: scopeRef,
      coverage_denominator_ref: denominatorRef,
      included_evidence: [],
      open_research_debt_refs: [debtRef],
    },
    branch_findings: {
      reconciliation_ref: branchRef,
      reconciliation_digest: checkpoint.identity_digest,
      reconciliation_summary: { research_debts: [debt] },
    },
    manifest: { manifest_ref: manifestRef, scope_snapshot_ref: scopeRef, allowed_evidence_handle_refs: [] },
    stage_five: {
      operation_id: request.operation_id,
      investigation_ref: { id: request.investigation_ref.id, revision: 1 },
      principal_ref: principal.principal_ref,
      scope_snapshot_ref: scopeRef,
      evidence_pack: { pack_ref: evidencePackRef, resolved_evidence: [] },
    },
    w1_head: {
      investigation_id: request.investigation_ref.id,
      revision: request.investigation_ref.revision,
      principal_ref: principal.principal_ref,
      deployment_generation: principal.deployment_generation,
    },
  } as unknown as EvidenceFreezeSynthesisContext;
  const contextReader = { read: vi.fn(async () => context) };
  const readBranch = vi.fn(async () => branchLineage);
  const grant = {
    allowed_use: ["research"],
    disclosure_ceiling: "owner-only",
  };
  const navigation = {
    access: {
      principal_ref: principal.principal_ref,
      client_class: "owner_pwa",
      credential_generation: principal.credential_generation,
    },
    scope: {
      snapshot_id: scopeRef.id,
      revision: scopeRef.revision,
      member_source_revision_refs: [],
      resolved_scope_expression: { kind: "all" },
    },
    current: vi.fn(async () => grant),
    sources: vi.fn(async () => []),
  };
  const definitionRef = INSTALLED_INQUIRY_PROTOCOL_REFS[protocolName];
  const definition = installedInquiryProtocolDefinition(definitionRef);
  const protocol = {
    profile_definition_ref: { id: String(definitionRef.id), revision: definitionRef.revision },
    coverage_denominator: {
      denominator_ref: denominatorRef,
      frozen_scope_snapshot_ref: scopeRef,
      eligible_source_revision_refs: [],
      required_source_classes: [...definition.required_source_classes],
      required_question_branches: [...definition.required_question_branches],
      acquisition_method_generations: {},
      excluded_sources: [],
      completeness_test_ref: definition.completeness_test_ref,
    },
    protocol_profile: {
      independence_policy_ref: { id: "independence-1", revision: 1 },
      counter_search_required: definition.counter_search_required,
    },
  };

  mocks.readCommittedStageLineage.mockResolvedValue(predecessor);
  mocks.readCommittedProtocolScopeCheckpoint.mockResolvedValue(protocol);
  mocks.decodeResearchCitationsResult.mockResolvedValue(citations);
  mocks.createEvidenceFreezePostSynthesisContextReader.mockReturnValue(contextReader);

  const readers = {
    read_branch_reconciliation: readBranch,
  } as unknown as EvidenceFreezeCommittedReaders;
  const environment = {
    database: { prepare: vi.fn() },
    work_bucket: { get: vi.fn() },
  } as unknown as EvidenceFreezeSynthesisReaderEnvironment;
  const handler = createResearchCoverageStageHandlerFromFreeze(
    environment,
    navigation as never,
    readers,
    { ledger: { read: vi.fn() } as never },
  );

  return { handler, inputBytes, request, readBranch, debt, branchRef, scopeRef, contextReader, protocol };
}

describe("Research coverage frozen debt consumption", () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries the committed OPEN debt and next probe into the immutable coverage result", async () => {
    const fixture = setup();
    const result = await fixture.handler({
      request: fixture.request,
      principal,
      input_bytes: fixture.inputBytes,
      attempt_ref: "coverage-attempt-1",
      budget_receipt_ref: "budget-1",
    });

    expect(result).toEqual(Uint8Array.of(7));
    expect(fixture.readBranch).toHaveBeenCalledTimes(2);
    expect(fixture.readBranch).toHaveBeenCalledWith({
      operation_id: fixture.request.operation_id,
      investigation_id: fixture.request.investigation_ref.id,
      principal,
    });
    expect(mocks.encodeResearchCoverageResult).toHaveBeenCalledWith(expect.objectContaining({
      open_research_debts: [fixture.debt],
    }));
  });

  it("rejects a committed debt ref that was not present in the freeze", async () => {
    const extraDebt = {
      debt_ref: { id: "post-freeze-debt", revision: 1 },
      kind: "coverage",
      blocked_refs: ["COUNTER"],
      basis_and_evidence_refs: [],
      owner: "research-owner",
      blocking_effect: "An additional branch remains unverified.",
      next_probe: "Run the counter branch.",
      review_condition: "Review the counter result.",
      status: "OPEN",
    };
    const fixture = setup(extraDebt);

    await expect(fixture.handler({
      request: fixture.request,
      principal,
      input_bytes: fixture.inputBytes,
      attempt_ref: "coverage-attempt-1",
      budget_receipt_ref: "budget-1",
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(mocks.encodeResearchCoverageResult).not.toHaveBeenCalled();
  });

  it("rejects changed debt details even when the debt ref still matches", async () => {
    const changedDebt = {
      debt_ref: { id: "debt-1", revision: 1 },
      kind: "coverage",
      blocked_refs: ["SUPPORT"],
      basis_and_evidence_refs: [],
      owner: "research-owner",
      blocking_effect: "The required support branch did not complete.",
      next_probe: "Use a different probe than the frozen checkpoint.",
      review_condition: "Review after the support branch completes.",
      status: "OPEN",
    };
    const fixture = setup(changedDebt);

    await expect(fixture.handler({
      request: fixture.request,
      principal,
      input_bytes: fixture.inputBytes,
      attempt_ref: "coverage-attempt-1",
      budget_receipt_ref: "budget-1",
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(mocks.encodeResearchCoverageResult).not.toHaveBeenCalled();
  });
});

describe("Research coverage installed protocol denominators", () => {
  function invoke(fixture: ReturnType<typeof setup>) {
    return fixture.handler({ request: fixture.request, principal, input_bytes: fixture.inputBytes,
      attempt_ref: "coverage-attempt-1", budget_receipt_ref: "budget-1" });
  }

  it("preserves a branchless legacy freeze without invoking an incompatible branch reader", async () => {
    const fixture = setup();
    const original = await fixture.contextReader.read();
    const branchless = { ...original, freeze: { ...original.freeze, open_research_debt_refs: [] } };
    delete branchless.branch_findings;
    fixture.contextReader.read.mockResolvedValue(branchless);
    fixture.readBranch.mockRejectedValue(new Error("Legacy receipt is not a branch checkpoint"));

    await expect(invoke(fixture)).resolves.toEqual(Uint8Array.of(7));
    expect(fixture.readBranch).not.toHaveBeenCalled();
    expect(mocks.encodeResearchCoverageResult).toHaveBeenCalledWith(expect.objectContaining({
      open_research_debts: [], coverage_receipt: expect.objectContaining({
        denominator_kind: "unknown", terminal_disposition: "INCOMPLETE_COVERAGE",
      }),
    }));
  });

  it("rejects branchless freeze debt refs before result encoding", async () => {
    const fixture = setup();
    const branchless = { ...await fixture.contextReader.read() };
    delete branchless.branch_findings;
    fixture.contextReader.read.mockResolvedValue(branchless);

    await expect(invoke(fixture)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(fixture.readBranch).not.toHaveBeenCalled();
    expect(mocks.encodeResearchCoverageResult).not.toHaveBeenCalled();
  });

  it.each(["evidence_review", "architecture_decision"] as const)(
    "preserves debt and unknown coverage for installed %s requirements", async (name) => {
      const fixture = setup(undefined, name);
      expect(fixture.protocol.coverage_denominator.required_source_classes.length).toBeGreaterThan(0);
      expect(fixture.protocol.coverage_denominator.required_question_branches.length).toBeGreaterThan(0);
      await expect(invoke(fixture)).resolves.toEqual(Uint8Array.of(7));
      expect(mocks.encodeResearchCoverageResult).toHaveBeenCalledWith(expect.objectContaining({
        open_research_debts: [fixture.debt], coverage_receipt: expect.objectContaining({
          denominator_kind: "unknown", terminal_disposition: "INCOMPLETE_COVERAGE",
        }),
      }));
    },
  );

  it.each(["missing class", "missing branch", "duplicate class", "duplicate branch",
    "wrong class", "wrong branch", "wrong completeness test", "foreign protocol", "foreign scope"])(
    "rejects %s before emitting a coverage result", async (change) => {
      const fixture = setup(undefined, "evidence_review");
      const denominator = fixture.protocol.coverage_denominator;
      switch (change) {
        case "missing class": denominator.required_source_classes.pop(); break;
        case "missing branch": denominator.required_question_branches.pop(); break;
        case "duplicate class": {
          const first = denominator.required_source_classes[0];
          if (first === undefined) throw new Error("Installed protocol has no source classes");
          denominator.required_source_classes[1] = first;
          break;
        }
        case "duplicate branch": {
          const first = denominator.required_question_branches[0];
          if (first === undefined) throw new Error("Installed protocol has no question branches");
          denominator.required_question_branches[1] = first;
          break;
        }
        case "wrong class": denominator.required_source_classes[0] = "undeclared-source-class"; break;
        case "wrong branch": denominator.required_question_branches[0] = "UNDECLARED_BRANCH"; break;
        case "wrong completeness test": denominator.completeness_test_ref = "undeclared-test"; break;
        case "foreign protocol": fixture.protocol.profile_definition_ref.id = "uninstalled-protocol"; break;
        case "foreign scope": denominator.frozen_scope_snapshot_ref.id = "foreign-scope"; break;
      }
      await expect(invoke(fixture)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
      expect(mocks.encodeResearchCoverageResult).not.toHaveBeenCalled();
    },
  );
});
