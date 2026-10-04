import { describe, expect, it } from "vitest";
import {
  readResearchModelSpendPolicy,
  readResearchOwnerSpendPolicyTemplate,
} from "./research-model-spend-policy.js";
import { ModelAttemptError } from "./model-attempt-types.js";

function rule(stage: string) {
  return {
    stage,
    deployment: {
      route_ref: "dynamic/eliotr-economy",
      route_version: "v1",
      prompt_generation: "pg-1",
      schema_generation: "sg-1",
      parameters_digest: "a".repeat(64),
      pricing_snapshot_ref: "price-1",
    },
    max_input_bytes: 1024,
    max_output_bytes: 1024,
    quote: {
      estimated_model_calls: 1,
      estimated_input_tokens: 10,
      estimated_output_tokens: 10,
      estimated_embedding_tokens: 0,
      quoted_neurons: 0,
      platform_usd: 0,
      workers_ai_usd: 0,
      byok_usd: 0,
      max_total_usd: 0.01,
      workflow_steps: 1,
      expected_sources: 1,
      expected_sections: 1,
      confidence: 0.5,
    },
  };
}

function policyJson(stages: string[], provenance = "test-provenance"): string {
  return JSON.stringify({
    protocol: "eliotr.research-model-spend-policy.v1",
    approved: true,
    policy_ref: "policy-1",
    config_provenance_ref: provenance,
    principal_ref: "principal-1",
    client_class: "owner_pwa",
    credential_generation: "cred-1",
    deployment_generation: "dep-1",
    policy_generation: "polgen-1",
    policy_authority_ref: "auth-1",
    expires_at: "2030-01-01T00:00:00.000Z",
    rules: stages.map(rule),
  });
}

function templateJson(stages: string[], provenance = "test-provenance"): string {
  return JSON.stringify({
    protocol: "eliotr.research-owner-spend-template.v1",
    approved: true,
    policy_ref: "policy-1",
    config_provenance_ref: provenance,
    principal_ref: "principal-1",
    client_class: "owner_pwa",
    deployment_generation: "dep-1",
    expires_at: "2030-01-01T00:00:00.000Z",
    rules: stages.map(rule),
  });
}

function staleCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelAttemptError);
    return (error as ModelAttemptError).code;
  }
  throw new Error("expected the policy read to fail closed");
}

describe("readResearchModelSpendPolicy rule selection", () => {
  it("accepts the two legacy rules", () => {
    const policy = readResearchModelSpendPolicy(policyJson(["SYNTHESIZE", "AUDIT_CLAIMS"]), "test-provenance");
    expect(policy.rules.map((value) => value.stage)).toEqual(["SYNTHESIZE", "AUDIT_CLAIMS"]);
  });

  it("accepts three rules with one branch stage", () => {
    const policy = readResearchModelSpendPolicy(
      policyJson(["ANALYZE_BRANCHES", "SYNTHESIZE", "AUDIT_CLAIMS"]), "test-provenance");
    expect(policy.rules.map((value) => value.stage)).toEqual(["ANALYZE_BRANCHES", "SYNTHESIZE", "AUDIT_CLAIMS"]);
  });

  it("accepts four rules with both branch stages", () => {
    const policy = readResearchModelSpendPolicy(
      policyJson(["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"]), "test-provenance");
    expect(policy.rules).toHaveLength(4);
  });

  it("rejects duplicate stages", () => {
    expect(staleCode(() => readResearchModelSpendPolicy(
      policyJson(["SYNTHESIZE", "SYNTHESIZE", "AUDIT_CLAIMS"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });

  it("rejects a policy missing SYNTHESIZE", () => {
    expect(staleCode(() => readResearchModelSpendPolicy(
      policyJson(["AUDIT_CLAIMS", "ANALYZE_BRANCHES"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });

  it("rejects a policy missing AUDIT_CLAIMS", () => {
    expect(staleCode(() => readResearchModelSpendPolicy(
      policyJson(["SYNTHESIZE", "COUNTER_SEARCH"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });

  it("rejects more than four rules", () => {
    expect(staleCode(() => readResearchModelSpendPolicy(
      policyJson(["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS", "SYNTHESIZE"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });

  it("rejects a single rule", () => {
    expect(staleCode(() => readResearchModelSpendPolicy(policyJson(["SYNTHESIZE"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });

  it("rejects an unknown stage", () => {
    expect(staleCode(() => readResearchModelSpendPolicy(
      policyJson(["SYNTHESIZE", "AUDIT_CLAIMS", "NOPE"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });

  it("rejects provenance mismatch", () => {
    expect(staleCode(() => readResearchModelSpendPolicy(
      policyJson(["SYNTHESIZE", "AUDIT_CLAIMS"]), "other-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });
});

describe("readResearchOwnerSpendPolicyTemplate rule selection", () => {
  it("accepts four rules with both branch stages", () => {
    const template = readResearchOwnerSpendPolicyTemplate(
      templateJson(["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"]), "test-provenance");
    expect(template.rules).toHaveLength(4);
  });

  it("rejects duplicate stages", () => {
    expect(staleCode(() => readResearchOwnerSpendPolicyTemplate(
      templateJson(["AUDIT_CLAIMS", "AUDIT_CLAIMS"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });

  it("rejects a template missing SYNTHESIZE and AUDIT_CLAIMS", () => {
    expect(staleCode(() => readResearchOwnerSpendPolicyTemplate(
      templateJson(["ANALYZE_BRANCHES", "COUNTER_SEARCH"]), "test-provenance")))
      .toBe("MODEL_ATTEMPT_AUTHORITY_STALE");
  });
});
