import { beforeEach, describe, expect, it, vi } from "vitest";
import { StageRequestSchema } from "@eliotr/cloudflare-workflows";
import {
  BranchQueryPlanSchema,
  BranchQueryResultSchema,
  type BranchQueryPlan,
  type BranchQueryResult,
  type ResearchBranchRole,
} from "@eliotr/contracts";
import {
  createResearchBranchRoleModelExecutor,
  deriveBranchRoleStageRequest,
  type ResearchBranchRoleModelDependencies,
  type ResearchBranchRoleModelInput,
} from "./research-branch-role-model.js";
import { parseBranchRoleModelOutputV2 } from "./research-branch-role-output.js";
import {
  createResearchModelStageHandler,
  type ResearchModelStageHandler,
  type ResearchModelStageHandlerDependencies,
} from "@eliotr/cloudflare-model-execution";

vi.mock("@eliotr/cloudflare-model-execution", () => ({
  createResearchModelStageHandler: vi.fn(),
}));

const createHandler = vi.mocked(createResearchModelStageHandler);

const REQUEST = StageRequestSchema.parse({
  protocol: "eliotr.workflow-stage.v1",
  operation_id: "op-1",
  investigation_ref: { id: "inv-1", revision: 2 },
  stage: "ANALYZE_BRANCHES",
  idempotency_key: "stage-key",
  handler_generation: "server-owned-branch-v1",
  input_manifest: {
    object_ref: "obj-1",
    sha256: "a".repeat(64),
    byte_length: 10,
    residency: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "conf-1",
      encryption_key_domain_id: "enc-1",
      retention_domain_id: "ret-1",
      erasure_domain_id: "era-1",
      content_digest: { algorithm: "sha256", digest: "a".repeat(64) },
    },
  },
});

const PRINCIPAL = { principal_ref: "principal-1", credential_generation: "cred-1", deployment_generation: "dep-1" };
const PROMPT_SUPPORT = { marker: "support-prompt" };
const PROMPT_COUNTER = { marker: "counter-prompt" };

describe("deriveBranchRoleStageRequest", () => {
  it("scopes the idempotency key per role", () => {
    const derived = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    expect(derived.idempotency_key).toBe("stage-key:branch-role:SUPPORT");
    expect(derived.operation_id).toBe(REQUEST.operation_id);
    expect(derived.stage).toBe(REQUEST.stage);
  });

  it("gives every role a distinct key", () => {
    const support = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const counter = deriveBranchRoleStageRequest(REQUEST, "COUNTER");
    expect(support.idempotency_key).not.toBe(counter.idempotency_key);
  });

  it("is deterministic: a restart replays the same key", () => {
    const first = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    const second = deriveBranchRoleStageRequest(REQUEST, "SUPPORT");
    expect(first.idempotency_key).toBe(second.idempotency_key);
  });

  it("rejects unknown roles", () => {
    expect(() => deriveBranchRoleStageRequest(REQUEST, "NOPE" as never))
      .toThrow();
  });
});

describe("createResearchBranchRoleModelExecutor", () => {
  let createdDeps: ResearchModelStageHandlerDependencies[];
  let handlerInputs: unknown[];
  let prepareCalls: Array<{ context: unknown; role: ResearchBranchRole }>;

  beforeEach(() => {
    vi.clearAllMocks();
    createdDeps = [];
    handlerInputs = [];
    prepareCalls = [];
    createHandler.mockImplementation((dependencies) => {
      createdDeps.push(dependencies);
      const fake: ResearchModelStageHandler = {
        handler: async (input) => {
          handlerInputs.push(input);
          return new TextEncoder().encode("role-output-bytes");
        },
        recoverStartedAttempt: async () => null,
      };
      return fake;
    });
  });

  function dependencies(): ResearchBranchRoleModelDependencies {
    return {
      database: {} as never,
      work_bucket: {} as never,
      gateway: {} as never,
      prompt: ((role: ResearchBranchRole) =>
        (role === "SUPPORT" ? PROMPT_SUPPORT : PROMPT_COUNTER)) as never,
      prepare: (async (context: unknown, role: ResearchBranchRole) => {
        prepareCalls.push({ context, role });
        return { marker: "reservation" };
      }) as never,
      spend_authorization: {} as never,
      pricing: {} as never,
    } as unknown as ResearchBranchRoleModelDependencies;
  }

  function input(role: ResearchBranchRole): ResearchBranchRoleModelInput {
    return {
      role,
      request: REQUEST,
      principal: PRINCIPAL,
      attempt_ref: "attempt-1",
      budget_receipt_ref: "budget-1",
      input_bytes: new Uint8Array(),
    };
  }

  it("creates one handler per role and reuses the cached handler per role", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("COUNTER"));
    expect(createHandler).toHaveBeenCalledTimes(2);
    expect(handlerInputs).toHaveLength(3);
    const keys = handlerInputs.map(
      (seen) => (seen as { request: { idempotency_key: string } }).request.idempotency_key,
    );
    expect(keys).toEqual([
      "stage-key:branch-role:SUPPORT",
      "stage-key:branch-role:SUPPORT",
      "stage-key:branch-role:COUNTER",
    ]);
  });

  it("returns the handler's raw output bytes", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    const bytes = await executor.executeRole(input("SUPPORT"));
    expect(bytes).toEqual(new TextEncoder().encode("role-output-bytes"));
  });

  it("binds the prepare closure to each role so one role's handler never prepares another role", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("COUNTER"));
    expect(createdDeps).toHaveLength(2);
    const [supportDeps, counterDeps] = createdDeps;
    if (supportDeps === undefined || counterDeps === undefined) {
      throw new Error("expected one handler per role");
    }
    const context = { marker: "context" };
    await supportDeps.prepare(context as never);
    await counterDeps.prepare(context as never);
    expect(prepareCalls).toEqual([
      { context, role: "SUPPORT" },
      { context, role: "COUNTER" },
    ]);
  });

  it("installs the per-role prompt compiler dependencies", async () => {
    const executor = createResearchBranchRoleModelExecutor(dependencies());
    await executor.executeRole(input("SUPPORT"));
    await executor.executeRole(input("COUNTER"));
    expect(createdDeps).toHaveLength(2);
    const [supportDeps, counterDeps] = createdDeps;
    if (supportDeps === undefined || counterDeps === undefined) {
      throw new Error("expected one handler per role");
    }
    expect(supportDeps.prompt).toBe(PROMPT_SUPPORT);
    expect(counterDeps.prompt).toBe(PROMPT_COUNTER);
  });

  it("passes exact counter query context to the dynamic prompt without replacing stage input bytes", async () => {
    const branchQuery = {
      plan: { role: "COUNTER" },
      result: { role: "COUNTER" },
    } as unknown as { readonly plan: BranchQueryPlan; readonly result: BranchQueryResult };
    const originalAnalysisBytes = new TextEncoder().encode("committed-analysis-v2-bytes");
    const counterRequest = StageRequestSchema.parse({ ...REQUEST, stage: "COUNTER_SEARCH" });
    const dynamicPrompt = vi.fn<NonNullable<ResearchBranchRoleModelDependencies["prompt_for_stage_input"]>>(
      () => PROMPT_COUNTER as never,
    );
    const executor = createResearchBranchRoleModelExecutor({
      ...dependencies(),
      prompt_for_stage_input: dynamicPrompt,
    });

    await executor.executeRole({
      ...input("COUNTER"),
      request: counterRequest,
      input_bytes: originalAnalysisBytes,
      branch_query: branchQuery,
    });

    expect(dynamicPrompt).toHaveBeenCalledWith("COUNTER", "COUNTER_SEARCH", originalAnalysisBytes, branchQuery);
    expect((handlerInputs[0] as { readonly input_bytes: Uint8Array }).input_bytes).toBe(originalAnalysisBytes);
  });
});

describe("parseBranchRoleModelOutputV2", () => {
  it("rejects a schema-valid query result whose executed leg does not match its declared plan", () => {
    const planDigest = "a".repeat(64);
    const scopeRef = { id: "scope-1", revision: 1 };
    const scopeDigest = "b".repeat(64);
    const rootQuestion = {
      question_ref: { id: "root-question", revision: 1 },
      text: "What happened?",
      text_sha256: "c".repeat(64),
    };
    const branchQuestion = {
      question_ref: { id: "branch-question", revision: 1 },
      text: "What supports it?",
      text_sha256: "d".repeat(64),
    };
    const plan = BranchQueryPlanSchema.parse({
      protocol: "eliotr.research.branch-query-plan.v1",
      query_plan_ref: { id: "eliotr.research.branch-query-plan-" + planDigest, revision: 1 },
      identity_digest: planDigest,
      branch_ref: { id: "branch-1", revision: 1 },
      role: "SUPPORT",
      planning_manifest_ref: { id: "manifest-1", revision: 1 },
      planning_manifest_digest: "e".repeat(64),
      inquiry_protocol_ref: { id: "protocol-1", revision: 1 },
      protocol_digest: "f".repeat(64),
      scope_snapshot_ref: scopeRef,
      scope_snapshot_digest: scopeDigest,
      root_question: rootQuestion,
      branch_question: branchQuestion,
      question_refs: [rootQuestion.question_ref, branchQuestion.question_ref],
      hypothesis_refs: [],
      query_legs: [{
        query_id: "planned-query",
        query_sha256: "1".repeat(64),
        query: "supporting query",
        literal_probes: [],
      }],
      retrieval_product: "RESEARCH",
      budgets: {
        candidate_limit: 8,
        scan_limit: 64,
        evidence_limit: 4,
        max_evidence_bytes: 4096,
        max_query_legs: 4,
      },
      required: true,
      stop_rule: "EXHAUST_QUERY_LEGS",
      proposal_disposition: "NOT_PROPOSED",
      plan_generation: "server.branch-query-planner.v1",
    });
    const resultDigest = "2".repeat(64);
    const result = BranchQueryResultSchema.parse({
      protocol: "eliotr.research.branch-query-result.v1",
      query_result_ref: { id: "eliotr.research.branch-query-result-" + resultDigest, revision: 1 },
      identity_digest: resultDigest,
      query_plan_ref: plan.query_plan_ref,
      query_plan_digest: plan.identity_digest,
      role: plan.role,
      scope_snapshot_ref: plan.scope_snapshot_ref,
      scope_snapshot_digest: plan.scope_snapshot_digest,
      query_legs: [{
        status: "FAILED",
        query_id: "foreign-query",
        query_sha256: "3".repeat(64),
        retrieval_request_digest: "4".repeat(64),
        scope_snapshot_ref: plan.scope_snapshot_ref,
        scope_snapshot_digest: plan.scope_snapshot_digest,
        failure_code: "QUERY_FAILED",
        resolved_handle_refs: [],
        omitted_candidates: [],
        stop_reason: "LEG_FAILED",
      }],
      resolved_evidence: [],
      omitted_candidate_refs: [],
      total_utf8_bytes: 0,
      stop_reason: "ALL_LEGS_FAILED",
      failure_disposition: "ALL_FAILED",
    });
    const modelOutput = {
      protocol: "eliotr.research.branch-role-output.v2",
      role: plan.role,
      root_question_ref: plan.root_question.question_ref,
      root_question_sha256: plan.root_question.text_sha256,
      branch_question_ref: plan.branch_question.question_ref,
      branch_question_sha256: plan.branch_question.text_sha256,
      query_plan_ref: plan.query_plan_ref,
      query_plan_digest: plan.identity_digest,
      finding: {
        protocol: "eliotr.research.branch-finding-draft.v1",
        role: plan.role,
        question_ref: plan.branch_question.question_ref,
        question_sha256: plan.branch_question.text_sha256,
        kind: "SUPPORT",
        state: "BLOCKED",
        statement: "",
        conditions: [],
        scope: plan.branch_question.text,
        evidence_handle_refs: [],
        unknowns: ["No admissible evidence."],
        limitations: [],
      },
    };

    expect(() => parseBranchRoleModelOutputV2(
      new TextEncoder().encode(JSON.stringify(modelOutput)),
      plan as BranchQueryPlan,
      result as BranchQueryResult,
    )).toThrow();
  });
});
