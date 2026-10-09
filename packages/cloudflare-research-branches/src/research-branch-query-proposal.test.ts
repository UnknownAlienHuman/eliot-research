import { describe, expect, it } from "vitest";
import { StageRequestSchema, type WorkflowStageHandler } from "@eliotr/cloudflare-workflows";
import { BRANCH_QUERY_HANDLER_GENERATION } from "./research-branch-execution.js";
import {
  produceResearchBranchQueryProposal,
  type ResearchBranchQueryProposalInput,
} from "./research-branch-query-proposal.js";

const ROOT_QUESTION = {
  question_ref: { id: "question-root", revision: 1 },
  text: "What happened?",
  text_sha256: "a".repeat(64),
};
const BRANCH_QUESTION = {
  question_ref: { id: "question-support", revision: 1 },
  text: "What supports the claim?",
  text_sha256: "b".repeat(64),
};
const REQUEST = StageRequestSchema.parse({
  protocol: "eliotr.workflow-stage.v1",
  operation_id: "op-1",
  investigation_ref: { id: "inv-1", revision: 2 },
  stage: "READ_AND_EXTRACT",
  idempotency_key: "stage-key",
  handler_generation: BRANCH_QUERY_HANDLER_GENERATION,
  input_manifest: {
    object_ref: "obj-1",
    sha256: "c".repeat(64),
    byte_length: 0,
    residency: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "conf-1",
      encryption_key_domain_id: "enc-1",
      retention_domain_id: "ret-1",
      erasure_domain_id: "era-1",
      content_digest: { algorithm: "sha256", digest: "c".repeat(64) },
    },
  },
});
const PRINCIPAL = {
  principal_ref: "principal-1",
  credential_generation: "cred-1",
  deployment_generation: "dep-1",
};

function input(required = true): ResearchBranchQueryProposalInput {
  return {
    plan: {
      role: "SUPPORT",
      root_question: ROOT_QUESTION,
      branch_question: BRANCH_QUESTION,
      required,
      proposal_disposition: "NOT_PROPOSED",
    },
    request: REQUEST,
    principal: PRINCIPAL,
    attempt_ref: "attempt-1",
    budget_receipt_ref: "budget-1",
  };
}

describe("produceResearchBranchQueryProposal", () => {
  it("uses one stable role-scoped read attempt, skips optional roles, and propagates failures without retry", async () => {
    const proposal = {
      protocol: "eliotr.research.branch-query-proposal.v1",
      role: "SUPPORT",
      root_question_ref: ROOT_QUESTION.question_ref,
      root_question_sha256: ROOT_QUESTION.text_sha256,
      branch_question_ref: BRANCH_QUESTION.question_ref,
      branch_question_sha256: BRANCH_QUESTION.text_sha256,
      query_legs: [{ query: "supporting source", literal_probes: ["claim"] }],
    };
    const calls: Parameters<WorkflowStageHandler>[0][] = [];
    const selectedAttempt: WorkflowStageHandler = async (attemptInput) => {
      calls.push(attemptInput);
      return new TextEncoder().encode(JSON.stringify(proposal));
    };

    const candidate = await produceResearchBranchQueryProposal(input(), selectedAttempt);
    expect(candidate).toEqual(proposal);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.stage).toBe("READ_AND_EXTRACT");
    expect(calls[0]?.request.idempotency_key).toBe("stage-key:branch-role:SUPPORT");
    expect(calls[0]?.attempt_ref).toBe("attempt-1");
    expect(calls[0]?.budget_receipt_ref).toBe("budget-1");
    const proposalCall = calls[0];
    expect(proposalCall).toBeDefined();
    if (proposalCall === undefined) throw new Error("selected attempt was not called");
    const proposalContext = JSON.parse(new TextDecoder().decode(proposalCall.input_bytes)) as Record<string, unknown>;
    expect(proposalContext).toMatchObject({
      protocol: "eliotr.research.branch-query-proposal-request.v1",
      output_protocol: "eliotr.research.branch-query-proposal.v1",
      role: "SUPPORT",
      root_question: ROOT_QUESTION,
      branch_question: BRANCH_QUESTION,
    });

    await expect(produceResearchBranchQueryProposal(input(false), selectedAttempt)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);

    const failure = new Error("selected attempt failed");
    let failedCalls = 0;
    const failedAttempt: WorkflowStageHandler = async () => {
      failedCalls += 1;
      throw failure;
    };
    await expect(produceResearchBranchQueryProposal(input(), failedAttempt)).rejects.toBe(failure);
    expect(failedCalls).toBe(1);
  });
});
