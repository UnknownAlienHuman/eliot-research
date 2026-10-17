import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelGatewayPricingPort } from "@eliotr/cloudflare-ai";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ResolvedProviderNativeModelCatalogV2 } from "@eliotr/cloudflare-native-models";
import { createResearchOwnerRuntimeConfiguration } from "@eliotr/cloudflare-research-configuration";
import { resolveResearchOwnerSpendPolicy } from "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js";
import { parseResearchSemanticConfiguration } from "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js";
import { admissionTestConfiguration } from "../../../apps/eliotr-core/test/research-current-dispatch-config.js";
import { assembleResearchSemanticServerHandlers } from "../src/research-semantic-server.js";
import {
  createResearchSemanticNativeModelRuntime, prepareResearchSemanticNativeModelRunContext,
} from "../src/research-semantic-native-model-runtime.js";
import * as stageHandlers from "../src/research-stage-handlers.js";

type Stage = "SYNTHESIZE" | "AUDIT_CLAIMS";
type AssemblyInput = Parameters<typeof assembleResearchSemanticServerHandlers>[0];
const stages = ["SYNTHESIZE", "AUDIT_CLAIMS"] as const;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(missingPricing?: Stage) {
  const principal = { principal_ref: "assembly-owner", credential_generation: "assembly-session",
    deployment_generation: "assembly-deployment" };
  const base = admissionTestConfiguration(principal.deployment_generation, principal.principal_ref, "assembly");
  const prepared = base.transport_policies;
  if (prepared === undefined) throw new Error("Admission fixture must provide both main transports");
  const compiled = await createResearchOwnerRuntimeConfiguration({ ...base, transport_policies: {
    ...prepared, model_selections: prepared.model_selections.map((selection) => {
      const model = selection.stage === "SYNTHESIZE" ? "assembly-synthesis" : "assembly-audit";
      return { ...selection, provider: "custom-opencode-go", model, transport_policy: {
        version: 1, transport: "cloudflare-ai-gateway", api: "custom-chat-completions",
        provider: "custom-opencode-go", model, billing: { mode: "byok", alias: `eliotr-${"a".repeat(48)}` },
        capabilities: { max_output_tokens_field: selection.stage === "SYNTHESIZE" ? "max_completion_tokens" : "max_tokens",
          reasoning_efforts: selection.stage === "SYNTHESIZE" ? ["low"] : ["high"] },
      } };
    }),
  } });
  const value = (key: string): string => {
    const raw = compiled.vars[key];
    if (raw === undefined) throw new Error(`Admission fixture did not install ${key}`);
    return raw;
  };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const navigation: NavigationReadAuthority = {
    access: { ...principal, client_class: "owner_pwa" },
    scope: { snapshot_id: "assembly-scope", revision: 1, resolved_scope_expression: { kind: "PROJECT", project_id: "assembly-project" },
      participant_generations: {}, member_source_revision_refs: [], source_owner_generations: {},
      policy_authority_ref: "assembly-policy-authority", disclosure_closure_digest: "d".repeat(64),
      purge_ledger_revision: 0, digest: "e".repeat(64), created_at: new Date().toISOString(), expires_at: expires },
    current: vi.fn(async () => ({ authorization_receipt_ref: "assembly-grant", policy_authority_ref: "assembly-policy-authority",
      allowed_use: ["research"], disclosure_ceiling: "private", expires_at: expires })),
    sources: vi.fn(async () => []),
    timestamp: () => new Date().toISOString(),
  };
  const policy = resolveResearchOwnerSpendPolicy({ raw: value("ELIOTR_MODEL_SPEND_POLICY_JSON"),
    provenance: value("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"), access: navigation.access,
    deployment_generation: principal.deployment_generation, policy_generation: "assembly-policy",
    policy_authority_ref: navigation.scope.policy_authority_ref, scope_expires_at: expires,
    authorization: await navigation.current() }).policy;
  const transports = JSON.parse(value("ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON")) as typeof prepared;
  const selections = transports.model_selections.map((selection) => ({
    stage: selection.stage, route_ref: selection.route_ref, route_version: selection.route_version,
    transport_policy: selection.transport_policy,
    candidate_kind: "provider-native-v2" as const, candidate_ref: `candidate-${selection.stage}`,
    candidate_sha256: "a".repeat(64), qualification_ref: `qualification-${selection.stage}`, qualification_sha256: "b".repeat(64),
  }));
  // Snapshot admission and Core's Env/D1 wrapper are outside this package-boundary test.
  const run = { mode: "snapshot-v2" as const, configuration_ref: `rrc-${"c".repeat(24)}`, configuration_sha256: "c".repeat(64),
    project_owner_ref: principal.principal_ref, project_id: "assembly-project", project_configuration_ref: "assembly-config",
    project_configuration_sha256: "f".repeat(64), model_selections: selections };
  const price = (): ModelGatewayPricingPort => ({ quote: vi.fn(async () => {
    throw new Error("Assembly must not quote or dispatch a model");
  }) });
  const prices = { SYNTHESIZE: price(), AUDIT_CLAIMS: price() };
  // Only the I/O-bound catalog readback is substituted. The Native runtime, pricing
  // producer, semantic assembler, composition validator and handler factory are real.
  const resolvePinned = vi.fn(async ({ selection }: { selection: unknown }) => {
    const selected = selection as typeof selections[number];
    const deployment = policy.rules.find(rule => rule.stage === selected.stage)?.deployment;
    if (deployment === undefined) throw new Error("Unexpected branch-stage catalog read");
    return { candidate: { candidate: { candidate_kind: "provider-native-v2", preparation: { deployment } } },
      proof: { qualification: { qualification_tier: "LIVE", observation_ref: `observation-${selected.stage}`, expires_at: expires } },
      ...(missingPricing === selected.stage ? {} : { pricing_port: prices[selected.stage as Stage] }),
    } as unknown as ResolvedProviderNativeModelCatalogV2;
  });
  const nativeRuntime = createResearchSemanticNativeModelRuntime({
    context: prepareResearchSemanticNativeModelRunContext({ run_configuration: run, owner_ref: principal.principal_ref }),
    authority: undefined, catalog_authority: { resolvePinned },
  });
  const forbidden = vi.fn(() => { throw new Error("Unexpected external I/O during assembly"); });
  vi.stubGlobal("fetch", forbidden);
  const database = { prepare: vi.fn((sql: string) => {
    if (!sql.includes("FROM retrieval_scope_profile")) throw new Error(`Unexpected assembly SQL: ${sql}`);
    return { bind: (...parameters: unknown[]) => {
      expect(parameters).toEqual([navigation.scope.snapshot_id, navigation.scope.revision]);
      return { first: async () => ({ profile_version: "assembly-profile", max_sources: 1, max_results: 1 }) };
    } };
  }) } as unknown as D1Database;
  const bucket = { get: forbidden, head: forbidden, put: forbidden } as unknown as R2Bucket;
  const bind = vi.fn<AssemblyInput["bind_handlers"]>(handlers => handlers);
  const input: AssemblyInput = {
    database, search_database: database, work_bucket: bucket, evidence_bucket: bucket,
    ai_search: {} as AssemblyInput["ai_search"], operation_id: "assembly-run", investigation_id: "assembly-investigation",
    principal, navigation, ledger: { read: forbidden }, handler_generation: "research-handlers.exploratory.v4",
    initial_manifest: { object_ref: "assembly-manifest", sha256: "0".repeat(64), byte_length: 1,
      residency: { ...base.report.artifact_policy.manifest_residency,
        scope_domain_id: navigation.scope.snapshot_id, content_digest: { algorithm: "sha256", digest: "0".repeat(64) } } },
    run_configuration: run, native_model_runtime: nativeRuntime,
    gateway: { reasoning_gateway_base_url: "https://gateway.example.invalid", gateway_token: "local-fixture-only" },
    config: parseResearchSemanticConfiguration(value("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON")), policy,
    semantic_config: { revision_ref: null, config_sha256: "d".repeat(64) }, deployment_environment: "TEST",
    model_profile: { raw: value("ELIOTR_MODEL_PROFILE_DEFINITION_JSON"), provenance_ref: value("ELIOTR_MODEL_PROFILE_PROVENANCE_REF") },
    report_config: { raw: value("ELIOTR_RESEARCH_REPORT_CONFIG_JSON"), provenance_ref: value("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF") },
    recheck_authority: forbidden, require_client_execution: forbidden, route_external_agent_stages: forbidden, bind_handlers: bind,
  };
  return { input, prices, resolvePinned, forbidden, bind, selections };
}

describe("actual semantic main-pricing producer assembly (package boundary)", () => {
  it("passes each native-v2 main stage's trusted pricing and capabilities into real handlers without optional roles", async () => {
    const f = await fixture();
    // Observe arguments while calling through; do not replace the producer or factory.
    const factory = vi.spyOn(stageHandlers, "createResearchStageHandlerFactory");
    const handlers = await assembleResearchSemanticServerHandlers(f.input);
    expect(factory).toHaveBeenCalledOnce();
    expect(f.bind).toHaveBeenCalledWith(handlers);
    const mode = factory.mock.calls[0]?.[0];
    if (mode?.kind !== "server-owned-exploratory" || mode.synthesis === undefined || mode.audit_claims === undefined) {
      throw new Error("Actual assembly did not construct both main stage dependencies");
    }
    expect(mode.generation).toBe("research-handlers.exploratory.v4");
    expect(mode.branch_execution).not.toHaveProperty("role_model");
    expect(mode).not.toHaveProperty("acquisition_route");
    for (const stage of stages) {
      const deps = stage === "SYNTHESIZE" ? mode.synthesis.model : mode.audit_claims;
      const selected = f.selections.find(selection => selection.stage === stage);
      expect(deps.pricing).toBe(f.prices[stage]);
      expect(deps.prompt.request_capabilities).toEqual(selected?.transport_policy.capabilities);
      expect(deps.prompt.selected_transport_policy).toEqual(selected?.transport_policy);
      expect(deps.gateway.transport_policy).toEqual(selected?.transport_policy);
      expect(deps.gateway.gateway_token).toBe("local-fixture-only");
      expect(deps.catalog_native_model_authority_v2).toBe(f.input.native_model_runtime.catalog_authority);
      expect(handlers(stage)).toBeTypeOf("function");
      expect(f.prices[stage].quote).not.toHaveBeenCalled();
    }
    expect(f.resolvePinned.mock.calls.map(([request]) => (request.selection as { stage: string }).stage))
      .toEqual(["AUDIT_CLAIMS", "SYNTHESIZE", "AUDIT_CLAIMS"]);
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each(stages)("rejects missing trusted %s pricing before handlers are bound", async stage => {
    const f = await fixture(stage);
    const factory = vi.spyOn(stageHandlers, "createResearchStageHandlerFactory");
    await expect(assembleResearchSemanticServerHandlers(f.input)).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
    expect(factory).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.resolvePinned.mock.calls.some(([request]) => (request.selection as { stage: string }).stage === stage)).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();
  });
});
