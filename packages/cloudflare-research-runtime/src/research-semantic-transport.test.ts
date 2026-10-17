import { describe, expect, it } from "vitest";
import type { ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import type { ResearchBranchQueryBudgetSelection } from
  "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import {
  createResearchSemanticComposition,
  createResearchSemanticWorkflowHandlerFactory,
  type ResearchSemanticCompositionDependencies,
  type ResearchSemanticWorkflowDependencies,
} from "./research-semantic-composition.js";
import { SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION } from "./research-stage-handlers.js";

// Construction-port fixture only: no canonical state, provider or native runtime acceptance.
const POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1, transport: "cloudflare-ai-gateway", api: "openai-responses", provider: "openai",
  model: "openai/gpt-4.1-mini", billing: { mode: "byok", alias: "default" },
  capabilities: { max_output_tokens_field: "max_output_tokens", reasoning_efforts: ["high"] },
};
const PARAMETERS = { prompt: "Use the supplied evidence.", max_tokens: 64 };
const branchBudgetSelection: ResearchBranchQueryBudgetSelection = {
  protocol: "eliotr.research.branch-query-budget-selection.v1",
  profile_id: "branch-profile-test",
  profile_generation: 2,
  budgets: {
    candidate_limit: 9,
    scan_limit: 23,
    evidence_limit: 2,
    max_evidence_bytes: 2048,
    max_query_legs: 3,
  },
  selected_configuration: {
    owner_ref: "principal-test",
    project_id: "project-test",
    configuration_ref: `rpmc-${"a".repeat(64)}`,
    configuration_sha256: "a".repeat(64),
    selection_revision: 7,
  },
};

function input(mode: "installed" | "override", selected: boolean): ResearchSemanticCompositionDependencies {
  const unavailable = () => { throw new Error("construction must not perform effects"); };
  const manifestService = { buildAndPersist: unavailable };
  const prompt = {
    ...(mode === "installed" ? { trusted_parameters: PARAMETERS } : {
      manifest_service: manifestService, build_manifest_input: unavailable, resolve_trusted_parameters: unavailable,
    }),
    request_timeout_ms: 1000,
    ...(selected ? { selected_transport_policy: POLICY, request_capabilities: POLICY.capabilities } : {}),
  };
  const stage = () => ({
    gateway: { reasoning_gateway_base_url: "https://gateway.example.invalid", gateway_token: "fixture-token" },
    prompt, spend_authorization: { read: unavailable }, prepare: unavailable,
  });
  return {
    database: { prepare: unavailable }, search_database: { prepare: unavailable },
    work_bucket: { head: unavailable, get: unavailable }, evidence_bucket: { get: unavailable },
    navigation: {
      scope: { snapshot_id: "scope-test", revision: 1, digest: "a".repeat(64) },
      access: { principal_ref: "principal-test", credential_generation: "credential-test", client_class: "OWNER" },
      current: unavailable, sources: unavailable,
    },
    ledger: { read: unavailable }, operation_id: "operation-test", investigation_id: "investigation-test",
    principal: { principal_ref: "principal-test", credential_generation: "credential-test", deployment_generation: "deployment-test" },
    retrieval_profile: {}, model_profile: { raw: "{}", provenance_ref: "profile-test" },
    semantic_config: { revision_ref: null, config_sha256: "a".repeat(64) },
    deployment_environment: "TEST", recheck_authority: unavailable,
    manifest: {
      store: { get: unavailable },
      residency_template: { scope_domain_id: "scope-test", access_domain_id: "principal-test" },
      max_context_bytes: 1024,
    },
    model: { synthesis: stage(), audit: stage() }, verification: { config: {} },
    audit: {
      normalization: { section_ref: { id: "section-test", revision: 1 }, required_precision: "exact", required_source_class: "primary" },
      verifier: {
        authority: {
          allowed_verifier_refs: ["verifier-test"], verifier_ref: "verifier-test", verifier_schema_generation: "verifier-schema-test",
          deployment: { route_ref: "dynamic/eliotr-economy", route_version: "v1", prompt_generation: "prompt-test",
            schema_generation: "schema-test", parameters_digest: "a".repeat(64), pricing_snapshot_ref: "pricing-test" },
          deployment_generation: "deployment-test", qualification_receipt_ref: "qualification-test",
          qualification_expires_at: "2030-01-01T00:00:00.000Z", qualified: true, current: true,
        },
        read_current: unavailable,
      },
      policy: { required_dimensions: [], source_requirement_applicable: true, excerpt_requirement_applicable: true,
        coverage_limitations: [], unsupported_precision: [] },
    },
  } as unknown as ResearchSemanticCompositionDependencies;
}

describe("semantic selected transport handoff", () => {
  function nativeMainStages(): ResearchSemanticCompositionDependencies {
    const base = input("installed", true);
    const unavailable = () => { throw new Error("construction must not perform effects"); };
    const nativePolicy: ModelGatewayTransportPolicyV1 = { ...POLICY, api: "custom-responses", provider: "custom-opencode-go",
      model: "muse-spark-1.3-contributor", billing: { mode: "byok", alias: "existing-key" } };
    const selection = (stage: "SYNTHESIZE" | "AUDIT_CLAIMS") => ({ candidate_kind: "provider-native-v2" as const,
      stage, route_ref: "dynamic/eliotr-balanced", route_version: "native-test",
      candidate_ref: `provider-native-model-candidate-v2-${"a".repeat(64)}`, candidate_sha256: "a".repeat(64),
      qualification_ref: `provider-native-model-qualification-v2-${"b".repeat(64)}`, qualification_sha256: "b".repeat(64),
      transport_policy: nativePolicy });
    return { ...base, run_configuration: { mode: "snapshot-v2", configuration_ref: `rcc-${"c".repeat(64)}`,
      configuration_sha256: "c".repeat(64), project_owner_ref: "principal-test", project_id: "project-test",
      model_selections: [selection("SYNTHESIZE"), selection("AUDIT_CLAIMS")] },
      model: { ...base.model, synthesis: { ...base.model.synthesis, pricing: { quote: unavailable } },
        audit: { ...base.model.audit, pricing: { quote: unavailable } } } };
  }

  it("constructs native-v2 synthesis and audit with their own trusted pricing and no optional branch roles", () => {
    expect(() => createResearchSemanticComposition(nativeMainStages())).not.toThrow();
  });

  it.each(["synthesis", "audit"] as const)("still requires trusted %s pricing for a native-v2 main stage", stage => {
    const deps = nativeMainStages();
    const invalid = { ...deps, model: { ...deps.model, [stage]: { ...deps.model[stage], pricing: undefined } } };
    expect(() => createResearchSemanticComposition(invalid)).toThrowError(expect.objectContaining({ code: "WORKFLOW_CONFIGURATION_MISSING" }));
  });

  it("keeps native-v2 branch pricing mandatory", () => {
    const deps = nativeMainStages();
    const first = deps.run_configuration?.model_selections?.[0];
    if (!first) throw new Error("native fixture missing");
    const invalid = { ...deps, run_configuration: { ...deps.run_configuration,
      model_selections: [{ ...first, stage: "ANALYZE_BRANCHES" as const }] } };
    expect(() => createResearchSemanticComposition(invalid)).toThrowError(expect.objectContaining({ code: "WORKFLOW_CONFIGURATION_MISSING" }));
  });
  it.each(["installed", "override"] as const)("retains the exact selected policy for %s synthesis and audit compilers", (mode) => {
    const source = input(mode, true);
    const graph = createResearchSemanticComposition(source);
    for (const prompt of [graph.synthesis.model.prompt, graph.audit_claims.prompt]) {
      expect(prompt.selected_transport_policy).toBe(POLICY);
      expect(prompt.request_capabilities).toBe(POLICY.capabilities);
      expect(Object.isFrozen(prompt)).toBe(true);
      expect(prompt.request_timeout_ms).toBe(1000);
    }
    if (mode === "override") {
      expect(graph.synthesis.model.prompt.manifest_service).toBe(source.model.synthesis.prompt.manifest_service);
      expect(graph.audit_claims.prompt.manifest_service).toBe(source.model.audit.prompt.manifest_service);
      expect(graph.synthesis.model.prompt.build_manifest_input).toBe(source.model.synthesis.prompt.build_manifest_input);
      expect(graph.audit_claims.prompt.resolve_trusted_parameters).toBe(source.model.audit.prompt.resolve_trusted_parameters);
    }
  });

  function v9WorkflowInput(): ResearchSemanticWorkflowDependencies {
    const base = input("installed", true);
    return {
      ...base,
      ai_search: {} as never,
      retrieval_profile: { version: "scope-profile-test", max_sources: 8, max_results: 4 },
      handler_generation: SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION,
      run_configuration: {
        mode: "snapshot-v2",
        configuration_ref: "run-configuration-1",
        configuration_sha256: "b".repeat(64),
        project_owner_ref: "principal-test",
        project_id: "project-test",
        project_configuration_ref: branchBudgetSelection.selected_configuration.configuration_ref,
        project_configuration_sha256: branchBudgetSelection.selected_configuration.configuration_sha256,
        model_selections: [],
      },
      branch_query_budget_selection: branchBudgetSelection,
      report: {} as never,
    } as unknown as ResearchSemanticWorkflowDependencies;
  }

  it("installs the owner budget tuple and held-scope adapter on the V9 branch execution path", () => {
    const factory = createResearchSemanticWorkflowHandlerFactory(v9WorkflowInput());
    expect(factory("READ_AND_EXTRACT")).toBeTypeOf("function");
    expect(factory.native("READ_AND_EXTRACT")).toBeUndefined();
  });

  it("refuses V9 composition without captured owner provenance or managed primary", () => {
    const selected = v9WorkflowInput();
    const { branch_query_budget_selection: _capturedSelection, ...withoutSelection } = selected;
    void _capturedSelection;
    expect(() => createResearchSemanticWorkflowHandlerFactory(withoutSelection))
      .toThrow("WORKFLOW_CONFIGURATION_MISSING");
    expect(() => createResearchSemanticWorkflowHandlerFactory({
      ...selected,
      ai_search: undefined,
    })).toThrow("WORKFLOW_CONFIGURATION_MISSING");
    expect(() => createResearchSemanticWorkflowHandlerFactory({
      ...selected,
      branch_query_budget_selection: {
        ...branchBudgetSelection,
        selected_configuration: {
          ...branchBudgetSelection.selected_configuration,
          owner_ref: "foreign-owner",
        },
      },
    })).toThrow("WORKFLOW_AUTHORITY_STALE");
  });

  it.each(["installed", "override"] as const)("preserves absent selected policy for legacy %s callers", (mode) => {
    const graph = createResearchSemanticComposition(input(mode, false));
    for (const prompt of [graph.synthesis.model.prompt, graph.audit_claims.prompt]) {
      expect(Object.hasOwn(prompt, "selected_transport_policy")).toBe(false);
      expect(Object.hasOwn(prompt, "request_capabilities")).toBe(false);
    }
  });
});
