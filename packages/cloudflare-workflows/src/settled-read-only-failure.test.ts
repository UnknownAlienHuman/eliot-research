import { describe, expect, it } from "vitest";
import {
  settledReadOnlyWorkflowFailure,
  settledReadOnlyWorkflowFailureCode,
  workflowFailure,
  WorkflowFailureOutcomeSchema,
} from "./failures.js";

describe("proven pre-dispatch read-only stage stop", () => {
  it("maps only the read-only stop codes and leaves every other code unmapped", () => {
    expect(settledReadOnlyWorkflowFailureCode("RETRIEVAL_BUDGET_STOP")).toBe("WORKFLOW_BUDGET_STOP");
    expect(settledReadOnlyWorkflowFailureCode("RETRIEVAL_INPUT_INVALID")).toBe("WORKFLOW_INPUT_INVALID");
    // Resolution uncertainty stays uncertain: the code itself means "cannot tell",
    // so it must never be rewritten as a settled non-dispatch.
    expect(settledReadOnlyWorkflowFailureCode("RETRIEVAL_RESOLUTION_UNCERTAIN")).toBeNull();
    // Dispatch-capable and unknown codes must never be settled by this classifier.
    for (const code of ["RETRIEVAL_AUTHORITY_STALE", "RETRIEVAL_IDEMPOTENCY_CONFLICT", "RETRIEVAL_CANCELLED",
      "RETRIEVAL_TRACE_CORRUPT", "MODEL_GATEWAY_TRANSPORT_FAILED", "WORKFLOW_EFFECT_UNCERTAIN", "", undefined, 7]) {
      expect(settledReadOnlyWorkflowFailureCode(code)).toBeNull();
    }
  });

  it("retains the truthful cause without claiming retry authority", () => {
    const settled = settledReadOnlyWorkflowFailure({ code: "WORKFLOW_BUDGET_STOP", stage: "RETRIEVE_BRANCHES" });
    expect(settled).toEqual({
      protocol: "eliotr.workflow-failure-outcome.v1",
      code: "WORKFLOW_BUDGET_STOP",
      phase: "STAGE",
      stage: "RETRIEVE_BRANCHES",
      retryable: false,
      dispatch_state: "NOT_STARTED",
      references_intact: "INTACT",
      recovery_action: "NONE",
    });
    expect(WorkflowFailureOutcomeSchema.safeParse(settled).success).toBe(true);
  });

  it("keeps the generic path for the same error without the settlement proof", () => {
    const stop = Object.assign(new Error("query budget is exhausted"), { code: "RETRIEVAL_BUDGET_STOP" });
    expect(workflowFailure(stop, "STAGE", "RETRIEVE_BRANCHES")).toEqual({
      protocol: "eliotr.workflow-failure-outcome.v1",
      code: "WORKFLOW_EFFECT_UNCERTAIN",
      phase: "STAGE",
      stage: "RETRIEVE_BRANCHES",
      retryable: false,
      dispatch_state: "OUTCOME_UNKNOWN",
      references_intact: "UNKNOWN",
      recovery_action: "RECONCILE",
    });
  });

  it("does not let a retrieval code alone change the classification", () => {
    // The classifier is the enum bridge only. Without the composition's dispatch
    // proof, workflowFailure must still refuse to settle a dispatched stop.
    for (const code of ["RETRIEVAL_BUDGET_STOP", "RETRIEVAL_INPUT_INVALID", "RETRIEVAL_RESOLUTION_UNCERTAIN"]) {
      const error = Object.assign(new Error("read-only retrieval stop"), { code });
      expect(workflowFailure(error, "STAGE", "RETRIEVE_BRANCHES").code).toBe("WORKFLOW_EFFECT_UNCERTAIN");
      expect(workflowFailure(error, "STAGE", "RETRIEVE_BRANCHES").dispatch_state).toBe("OUTCOME_UNKNOWN");
    }
  });
});
