import { describe, expect, it, vi } from "vitest";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-research";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type { Env } from "../src/env.js";
import type { ResearchStageHandlerFactory } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import {
  bindHandlersToRunConfiguration,
  bindResearchSemanticStageModelTransports,
} from "../src/research-semantic-run-configuration-bindings.js";

const { readRunConfiguration } = vi.hoisted(() => ({ readRunConfiguration: vi.fn() }));
vi.mock("../src/research-run-configuration.js", () => ({ readResearchRunConfiguration: readRunConfiguration }));

type Stage = "ANALYZE_BRANCHES" | "COUNTER_SEARCH" | "SYNTHESIZE" | "AUDIT_CLAIMS";

function selection(stage: Stage, suffix: string, maxOutputField: string, efforts: string[]) {
  return {
    stage,
    route_ref: `dynamic/${suffix}`,
    route_version: `version-${suffix}`,
    candidate_ref: `candidate-${suffix}`,
    candidate_sha256: "a".repeat(64),
    qualification_ref: `qualification-${suffix}`,
    qualification_sha256: "b".repeat(64),
    transport_policy: {
      version: 1,
      transport: "cloudflare-ai-gateway",
      api: "compat-chat-completions",
      provider: "zai",
      model: `glm-${suffix}`,
      billing: { mode: "unified" },
      capabilities: { max_output_tokens_field: maxOutputField, reasoning_efforts: efforts },
    },
  };
}

function spendRules(selected: readonly ReturnType<typeof selection>[]) {
  return selected.map(({ stage, route_ref, route_version }) => ({
    stage,
    deployment: { route_ref, route_version },
  }));
}

const actor = Object.freeze({
  operation_id: "semantic-bind-run-1",
  investigation_id: "semantic-bind-investigation-1",
  principal_ref: "semantic-bind-owner-1",
  deployment_generation: "semantic-bind-deployment-1",
});

describe("research semantic run configuration bindings", () => {
  it("binds each snapshot stage to its exact spend route and keeps synthesis/audit separate", () => {
    const selections = [
      selection("ANALYZE_BRANCHES", "branch", "max_completion_tokens", ["low"]),
      selection("COUNTER_SEARCH", "counter", "max_tokens", ["medium"]),
      selection("SYNTHESIZE", "synthesis", "max_completion_tokens", ["low", "high"]),
      selection("AUDIT_CLAIMS", "audit", "max_tokens", ["high", "max"]),
    ] as const;
    const gateway = { reasoning_gateway_base_url: "https://gateway.example.invalid", gateway_token: "server-token" };
    const bindings = bindResearchSemanticStageModelTransports({
      gateway: gateway as ResearchModelGatewayRuntimeConfig,
      policy_rules: spendRules(selections) as never,
      run_configuration: { mode: "snapshot-v2", model_selections: selections },
      include_branch_stages: true,
    });

    expect(bindings.synthesis_gateway).not.toBe(bindings.audit_gateway);
    expect(bindings.synthesis_gateway.transport_policy?.model).toBe("glm-synthesis");
    expect(bindings.audit_gateway.transport_policy?.model).toBe("glm-audit");
    expect(bindings.synthesis_transport?.request_capabilities).toEqual({
      max_output_tokens_field: "max_completion_tokens", reasoning_efforts: ["low", "high"],
    });
    expect(bindings.branch_gateway_for_stage?.("ANALYZE_BRANCHES").transport_policy?.model).toBe("glm-branch");
    expect(bindings.branch_gateway_for_stage?.("COUNTER_SEARCH").transport_policy?.model).toBe("glm-counter");
    expect(bindings.branch_transport_for_stage?.("COUNTER_SEARCH").request_capabilities.max_output_tokens_field)
      .toBe("max_tokens");

    const wrongSpendRoutes = spendRules(selections).map((rule) => rule.stage === "COUNTER_SEARCH"
      ? { ...rule, deployment: { ...rule.deployment, route_version: "different-version" } } : rule);
    expect(() => bindResearchSemanticStageModelTransports({
      gateway: gateway as ResearchModelGatewayRuntimeConfig,
      policy_rules: wrongSpendRoutes as never,
      run_configuration: { mode: "snapshot-v2", model_selections: selections },
      include_branch_stages: true,
    })).toThrow();
  });

  it("accepts a two-stage immutable snapshot when branch-role prompts are omitted", () => {
    const selections = [
      selection("SYNTHESIZE", "synthesis-only", "max_completion_tokens", ["low", "high"]),
      selection("AUDIT_CLAIMS", "audit-only", "max_tokens", ["high", "max"]),
    ] as const;
    const gateway = { reasoning_gateway_base_url: "https://gateway.example.invalid", gateway_token: "server-token" };
    const bindings = bindResearchSemanticStageModelTransports({
      gateway: gateway as ResearchModelGatewayRuntimeConfig,
      policy_rules: spendRules(selections) as never,
      run_configuration: { mode: "snapshot-v2", model_selections: selections },
      include_branch_stages: false,
    });

    expect(bindings.synthesis_gateway.transport_policy?.model).toBe("glm-synthesis-only");
    expect(bindings.audit_gateway.transport_policy?.model).toBe("glm-audit-only");
    expect(bindings.branch_gateway_for_stage).toBeUndefined();
    expect(bindings.branch_transport_for_stage).toBeUndefined();
  });

  it("keeps the legacy gateway path and rechecks the complete actor/configuration tuple before handlers and recovery", async () => {
    const gateway = { reasoning_gateway_base_url: "https://gateway.example.invalid", gateway_token: "server-token" };
    const legacyBindings = bindResearchSemanticStageModelTransports({
      gateway: gateway as ResearchModelGatewayRuntimeConfig,
      policy_rules: [{ stage: "SYNTHESIZE", deployment: { route_ref: "legacy-s", route_version: "v1" } },
        { stage: "AUDIT_CLAIMS", deployment: { route_ref: "legacy-a", route_version: "v1" } }] as never,
      include_branch_stages: false,
    });
    expect(legacyBindings.synthesis_gateway).toBe(gateway);
    expect(legacyBindings.audit_gateway).toBe(gateway);
    expect(legacyBindings.branch_gateway_for_stage).toBeUndefined();

    const expected = {
      env: {} as Env, mode: "snapshot-v2" as const, configuration_ref: "run-config-1",
      configuration_sha256: "c".repeat(64), model_selections: [],
      project_configuration_ref: "project-config-1", project_configuration_sha256: "d".repeat(64),
      project_owner_ref: actor.principal_ref, project_id: "semantic-bind-project-1",
    };
    readRunConfiguration.mockReset().mockResolvedValue(expected);
    const invoke = vi.fn(async () => "handled");
    const recover = vi.fn(async () => null);
    const handlers = Object.assign(() => invoke, { recoverStartedAttempt: recover }) as unknown as ResearchStageHandlerFactory;
    const env = {} as Env;
    const wrapped = bindHandlersToRunConfiguration(env, actor, expected, handlers);
    const call = {
      request: { operation_id: actor.operation_id, investigation_ref: { id: actor.investigation_id } },
      principal: { principal_ref: actor.principal_ref, deployment_generation: actor.deployment_generation } as WorkflowPrincipal,
    };

    await expect(wrapped("SYNTHESIZE")(call as never)).resolves.toBe("handled");
    expect(readRunConfiguration).toHaveBeenCalledWith(env, actor);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(wrapped("SYNTHESIZE")({ ...call,
      request: { ...call.request, investigation_ref: { id: "other-investigation" } },
    } as never)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(invoke).toHaveBeenCalledTimes(1);

    const recovery = wrapped.recoverStartedAttempt;
    if (recovery === undefined) throw new Error("started-attempt recovery was not preserved");
    await expect(recovery({ request: { operation_id: actor.operation_id }, principal_ref: actor.principal_ref,
      deployment_generation: actor.deployment_generation } as never)).resolves.toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
    await expect(recovery({ request: { operation_id: actor.operation_id }, principal_ref: "other-principal",
      deployment_generation: actor.deployment_generation } as never)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(recover).toHaveBeenCalledTimes(1);

    readRunConfiguration.mockResolvedValue({ ...expected, configuration_sha256: "e".repeat(64) });
    await expect(wrapped("SYNTHESIZE")(call as never)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
