import { describe, expect, it } from "vitest";
import type { ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { createResearchSemanticComposition, type ResearchSemanticCompositionDependencies } from "./research-semantic-composition.js";

// Construction-port fixture only: no canonical state, provider or native runtime acceptance.
const POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1, transport: "cloudflare-ai-gateway", api: "openai-responses", provider: "openai",
  model: "openai/gpt-4.1-mini", billing: { mode: "byok", alias: "default" },
  capabilities: { max_output_tokens_field: "max_output_tokens", reasoning_efforts: ["high"] },
};
const PARAMETERS = { prompt: "Use the supplied evidence.", max_tokens: 64 };

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

  it.each(["installed", "override"] as const)("preserves absent selected policy for legacy %s callers", (mode) => {
    const graph = createResearchSemanticComposition(input(mode, false));
    for (const prompt of [graph.synthesis.model.prompt, graph.audit_claims.prompt]) {
      expect(Object.hasOwn(prompt, "selected_transport_policy")).toBe(false);
      expect(Object.hasOwn(prompt, "request_capabilities")).toBe(false);
    }
  });
});
