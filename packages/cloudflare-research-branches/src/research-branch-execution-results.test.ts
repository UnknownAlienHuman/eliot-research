import { describe, expect, it } from "vitest";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import {
  branchRoleFailureDisposition,
  executeBranchRolesWithFailureDisposition,
} from "./research-branch-execution-results.js";

type RoleOutcome =
  | { readonly role: string; readonly state: "CANDIDATE_READY" }
  | { readonly role: string; readonly state: "BLOCKED"; readonly kind: string; readonly code: string };

describe("executeBranchRolesWithFailureDisposition", () => {
  it("keeps successful siblings around one typed uncertain role outcome without relaunching it", async () => {
    const calls: string[] = [];
    const outcomes = await executeBranchRolesWithFailureDisposition<RoleOutcome>(
      ["SUPPORT", "COUNTER", "ALTERNATIVE"],
      async (role): Promise<RoleOutcome> => {
        calls.push(role);
        if (role === "COUNTER") throw new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN");
        return { role, state: "CANDIDATE_READY" as const };
      },
      async (role, failure): Promise<RoleOutcome> => ({ role, state: failure.outcome, kind: failure.kind, code: failure.code }),
    );

    expect(calls).toEqual(["SUPPORT", "COUNTER", "ALTERNATIVE"]);
    expect(outcomes).toEqual([
      { role: "SUPPORT", state: "CANDIDATE_READY" },
      { role: "COUNTER", state: "BLOCKED", kind: "OUTCOME_UNKNOWN", code: "WORKFLOW_EFFECT_UNCERTAIN" },
      { role: "ALTERNATIVE", state: "CANDIDATE_READY" },
    ]);
  });

  it("propagates cancellation and credential failures instead of turning them into blocked success", () => {
    expect(branchRoleFailureDisposition(new WorkflowCheckpointError("WORKFLOW_CANCELLED"))).toBeNull();
    expect(branchRoleFailureDisposition(new WorkflowCheckpointError("WORKFLOW_CREDENTIALS_INVALID"))).toBeNull();
  });
});
