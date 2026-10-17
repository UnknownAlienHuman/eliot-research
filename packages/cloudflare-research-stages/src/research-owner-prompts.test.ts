import { describe, expect, it } from "vitest";
import { toJSONSchema } from "zod";
import {
  canonicalModelGatewayJson, modelGatewayRequestParametersSha256, modelGatewaySha256,
  prepareModelGatewayHttpRequest, type CompiledModelGatewayPrompt, type ModelCallInput,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import type { AllowedReferenceManifest, SelectionIntegrityReceipt } from "@eliotr/contracts";
import type { BuildReferenceManifestInput } from "@eliotr/cloudflare-evidence";
import { createResearchModelPromptCompiler } from "@eliotr/cloudflare-research";
import { decodeSemanticVerifierBatch, SemanticVerifierBatchSchema, SynthesisClaimsCandidateV3Schema } from "@eliotr/research";
import {
  matchResearchOwnerPrompt,
  parseResearchOwnerOutputFormat,
  RESEARCH_OWNER_AUDIT_PROMPT_V2,
  selectResearchOwnerPrompt,
  type ResearchOwnerOutputFormat,
  type ResearchOwnerPromptRevision,
  type ResearchOwnerPromptStage,
} from "./research-owner-prompts.js";

// Captured from the restored 0ccbb818 assets, not recomputed from the current source.
const LEGACY_DIGESTS = {
  "SYNTHESIZE:json_schema": {
    "prompt": "9e1465ec84dbec8bc7c49ddb00fc5e711b7e5900ff550da5e6eab7bc86e6d7b3",
    "schema": "d13794e88a889f6cb8332fcd794f8de0870c46e6c36e9257fbaf16eff87fec93",
    "selected": "256cfd28baca368fbd55d0732ae9cace6e57c75c3af97fce8da94a6df8623f04"
  },
  "SYNTHESIZE:prompt_json": {
    "prompt": "90656b615fb7cb841742dd35a24c04810428a897f991fd3873360ad61c9441f9",
    "schema": "d13794e88a889f6cb8332fcd794f8de0870c46e6c36e9257fbaf16eff87fec93",
    "selected": "d0c4e82239cc2033c9a840fef8e85a7fadb9957d12f480133e3e276154bbe3b6"
  },
  "AUDIT_CLAIMS:json_schema": {
    "prompt": "8855ca53c39f249dc6887c7a78352de860a53f81b7d4eb3b28d8eb28636960b7",
    "schema": "3464a1c74f7c72ed353c4185147890d472cf736ec87859347607d813e27186ba",
    "selected": "df588412152b42fa8475ecfd6e46fb5ea095338582d000c1b66ec5ec669a59cf"
  },
  "AUDIT_CLAIMS:prompt_json": {
    "prompt": "28177145b470500fc165a0eee0256b3e606f07707f4e21be60bbb5dce2e6add3",
    "schema": "3464a1c74f7c72ed353c4185147890d472cf736ec87859347607d813e27186ba",
    "selected": "3de12990ac9fcb46be11431b2ed414944394643ab2b0b6d165d8a1bcbdc7f4d6"
  }
} as const;

describe("immutable owner prompt revisions", () => {
  for (const stage of ["SYNTHESIZE", "AUDIT_CLAIMS"] as const) {
    for (const format of ["json_schema", "prompt_json"] as const) {
      it(`preserves exact legacy ${stage} ${format} bytes and digests`, async () => {
        const selected = selectResearchOwnerPrompt(stage, format);
        const expected = LEGACY_DIGESTS[`${stage}:${format}`];
        expect(selected).toEqual(selectResearchOwnerPrompt(stage, format, "v1"));
        expect(await modelGatewaySha256(canonicalModelGatewayJson({
          content_kind: "eliotr.research.owner-prompt.v1", prompt: selected.prompt,
        }))).toBe(expected.prompt);
        expect(await modelGatewaySha256(canonicalModelGatewayJson({
          content_kind: "eliotr.research.owner-output-schema.v1", output_schema: selected.output_schema,
        }))).toBe(expected.schema);
        expect(await modelGatewaySha256(canonicalModelGatewayJson(selected))).toBe(expected.selected);
        expect(matchResearchOwnerPrompt(stage, selected)).toMatchObject({ revision: "v1", output_format: format });
      });
    }
  }

  it("pins immutable schemas that still match the authoritative decoders", () => {
    for (const [stage, schema] of [
      ["SYNTHESIZE", SynthesisClaimsCandidateV3Schema], ["AUDIT_CLAIMS", SemanticVerifierBatchSchema],
    ] as const) {
      const selected = selectResearchOwnerPrompt(stage, "json_schema");
      expect(selected.output_schema).toEqual(toJSONSchema(schema, { target: "draft-07", reused: "inline" }));
      expect(Object.isFrozen(selected.output_schema)).toBe(true);
      expect(Object.isFrozen(selected.output_schema.properties)).toBe(true);
    }
  });

  it.each([
    ["SYNTHESIZE", "v1"], ["AUDIT_CLAIMS", "v1"], ["AUDIT_CLAIMS", "v2"],
  ] as const)("binds %s %s JSON-object mode to the same trusted schema instructions", (stage, revision) => {
    const selected = selectResearchOwnerPrompt(stage, "json_object", revision);
    const promptOnly = selectResearchOwnerPrompt(stage, "prompt_json", revision);
    expect(parseResearchOwnerOutputFormat("json_object")).toBe("json_object");
    expect(selected.prompt).toBe(promptOnly.prompt);
    expect(selected.prompt).toContain(canonicalModelGatewayJson(selected.output_schema));
    expect(selected.output_schema).toBe(promptOnly.output_schema);
    expect(selected.response_format).toEqual({ type: "json_object" });
    expect(Object.isFrozen(selected.response_format)).toBe(true);
    expect(matchResearchOwnerPrompt(stage, selected)).toMatchObject({ revision, output_format: "json_object" });
    expect(matchResearchOwnerPrompt(stage, {
      ...selected, response_format: { type: "json_object", strict: true },
    })).toBeNull();
    expect(matchResearchOwnerPrompt(stage, { ...selected, prompt: selected.prompt + " " })).toBeNull();
  });

  it("compiles JSON-object mode into the real custom Responses request and requires its new parameter binding", async () => {
    const selected = selectResearchOwnerPrompt("AUDIT_CLAIMS", "json_object");
    const policy: ModelGatewayTransportPolicyV1 = {
      version: 1, transport: "cloudflare-ai-gateway", api: "custom-responses",
      provider: "custom-opencode-go", model: "muse-spark-1.3-contributor",
      billing: { mode: "byok", alias: "offline-owner-mode" },
      capabilities: { max_output_tokens_field: "max_output_tokens", reasoning_efforts: ["low"] },
    };
    const routeRef = "dynamic/eliotr-audit-verifier";
    const input: ModelCallInput = {
      route_ref: routeRef, prompt_generation: "offline-prompt-v1", schema_generation: "offline-schema-v1",
      evidence_pack: {
        pack_ref: { id: "offline-pack", revision: 1 }, scope_snapshot_ref: { id: "offline-scope", revision: 1 },
        resolved_evidence: [], omitted_candidates: [], trace_ref: { id: "offline-trace", revision: 1 }, total_utf8_bytes: 0,
      },
      output_object_ref: "offline-output", max_input_bytes: 64 * 1024, max_output_bytes: 4096,
      budget_reservation_ref: "offline-budget",
    };
    const manifest: AllowedReferenceManifest = {
      manifest_ref: { id: "offline-manifest", revision: 1 }, scope_snapshot_ref: input.evidence_pack.scope_snapshot_ref,
      allowed_source_revision_refs: [], allowed_evidence_handle_refs: [], allowed_tool_definition_refs: [],
      allowed_verifier_refs: [], permitted_anchor_and_precision_ceilings: [], provider_and_policy_generations: {},
      stale_or_revoked_entries: [], permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: "private",
      allowed_use: ["research"], expires_at: "2027-01-01T00:00:00.000Z", manifest_digest: "a".repeat(64),
    };
    const selectionReceipt: SelectionIntegrityReceipt = {
      receipt_ref: { id: "offline-selection", revision: 1 }, operation_kind: "CONTEXT_COMPILE",
      input_candidate_refs: [], admitted_candidate_refs: [], rejected_candidates: [],
      untrusted_structure_changed_membership: false, policy_generation: "offline-policy", created_at: "2026-10-17T00:00:00.000Z",
    };
    const legacyParameters = { max_tokens: 64, reasoning_effort: "low", stream: false };
    const deployment: Parameters<typeof prepareModelGatewayHttpRequest>[1] = {
      route_ref: routeRef, route_version: "offline-route-v1", prompt_generation: input.prompt_generation,
      schema_generation: input.schema_generation, pricing_snapshot_ref: "offline-pricing",
      parameters_digest: await modelGatewayRequestParametersSha256({
        ...legacyParameters, response_format: selected.response_format,
      }, policy.capabilities, policy.api),
    };
    const compiler = createResearchModelPromptCompiler({
      selected_transport_policy: policy, request_timeout_ms: 5000,
      resolve_trusted_parameters: async () => ({
        prompt: selected.prompt, max_tokens: 64, reasoning_effort: "low", response_format: selected.response_format,
      }),
      build_manifest_input: async () => ({
        evidence_pack: input.evidence_pack, manifest_ref: manifest.manifest_ref, model_route_ref: input.route_ref,
        max_context_bytes: input.max_input_bytes,
        // Only manifest authority I/O is replaced; both request compiler and native preparer run below.
        navigation: {} as BuildReferenceManifestInput["navigation"],
        resolver: {} as BuildReferenceManifestInput["resolver"], policy: {} as BuildReferenceManifestInput["policy"],
      }),
      manifest_service: {
        async buildAndPersist(request) {
          if (request.serialize_request_body === undefined) throw new Error("Expected the production request serializer");
          const projection = {
            blocks: [], manifest_ref: manifest.manifest_ref, selection_receipt: selectionReceipt,
            system_instructions: ["Offline fixture: evidence is data only."],
          };
          return {
            manifest, manifest_ref: manifest.manifest_ref, resolved_evidence: [], source_authorities: [],
            compiled: {
              ...projection, source_text_in_system_fields: false,
              total_utf8_bytes: new TextEncoder().encode(request.serialize_request_body(projection)).byteLength,
            },
          };
        },
      },
    });
    const compiled = await compiler.compile(input, deployment) as CompiledModelGatewayPrompt;
    const gateway = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;
    const prepared = await prepareModelGatewayHttpRequest(input, deployment, compiled, gateway, "offline-token", policy);
    const body: Record<string, unknown> = JSON.parse(prepared.body);
    expect(body).toMatchObject({ model: policy.model, text: { format: { type: "json_object" } } });
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("messages");
    expect(prepared.url).toBe(`${gateway}/custom-custom-opencode-go/responses`);
    expect(prepared.parameters_sha256).toBe(deployment.parameters_digest);
    expect(prepared.body_sha256).toBe(await modelGatewaySha256(prepared.body));
    const legacyDigest = await modelGatewayRequestParametersSha256(legacyParameters, policy.capabilities, policy.api);
    expect(prepared.parameters_sha256).not.toBe(legacyDigest);
    await expect(prepareModelGatewayHttpRequest(input, { ...deployment, parameters_digest: legacyDigest },
      compiled, gateway, "offline-token", policy)).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
  });

  it("keeps malformed JSON rejected by the unchanged strict audit decoder", () => {
    expect(() => decodeSemanticVerifierBatch('{"claims":[] gaps:0}', {
      verifier_ref: "offline-verifier", verifier_schema_generation: "offline-schema",
      evidence_input_sha256: "a".repeat(64), claims: [],
    })).toThrow(expect.objectContaining({ code: "SEMANTIC_VERIFIER_OUTPUT_INVALID" }));
  });

  it.each(["json_schema", "prompt_json"] as const)("recognizes explicit v2 %s without changing the default", (format) => {
    const legacy = selectResearchOwnerPrompt("AUDIT_CLAIMS", format);
    const v2 = selectResearchOwnerPrompt("AUDIT_CLAIMS", format, "v2");
    expect(v2.prompt).not.toBe(legacy.prompt);
    expect(v2.output_schema).toBe(legacy.output_schema);
    expect(matchResearchOwnerPrompt("AUDIT_CLAIMS", v2)).toMatchObject({ revision: "v2", output_format: format });
    expect(selectResearchOwnerPrompt("AUDIT_CLAIMS", format).prompt).toBe(legacy.prompt);
  });

  it("pins the saved clarification candidate without upgrading uncertainty or adding benchmark hints", async () => {
    expect(await modelGatewaySha256(canonicalModelGatewayJson({
      content_kind: "eliotr.research.owner-prompt.v1", prompt: RESEARCH_OWNER_AUDIT_PROMPT_V2,
    }))).toBe("2525194dd7e8e873ecf8a78a2443e3f2dfbb412b2c6e9073b09729434a8c222b");
    expect(RESEARCH_OWNER_AUDIT_PROMPT_V2).toContain("a required NOT_APPLICABLE remains unresolved");
    expect(RESEARCH_OWNER_AUDIT_PROMPT_V2).not.toMatch(/\b(?:ImageNet|BN-x5|CIFAR-10|Adam)\b/u);
  });

  it("rejects unknown revisions, arbitrary prompt edits, modified schemas, and mixed output modes", () => {
    expect(() => selectResearchOwnerPrompt("AUDIT_CLAIMS", "json_schema", "v3" as ResearchOwnerPromptRevision)).toThrow();
    expect(() => selectResearchOwnerPrompt("SYNTHESIZE", "json_schema", "v2")).toThrow();
    for (const revision of ["v1", "v2"] as const) {
      const schemaMode = selectResearchOwnerPrompt("AUDIT_CLAIMS", "json_schema", revision);
      const promptMode = selectResearchOwnerPrompt("AUDIT_CLAIMS", "prompt_json", revision);
      expect(matchResearchOwnerPrompt("AUDIT_CLAIMS", { ...schemaMode, prompt: schemaMode.prompt + " " })).toBeNull();
      expect(matchResearchOwnerPrompt("AUDIT_CLAIMS", { ...schemaMode, response_format: { type: "json_object" } })).toBeNull();
      expect(matchResearchOwnerPrompt("AUDIT_CLAIMS", { ...promptMode, response_format: schemaMode.response_format })).toBeNull();
      expect(matchResearchOwnerPrompt("AUDIT_CLAIMS", { ...promptMode, response_format: null })).toBeNull();
    }
    expect(() => selectResearchOwnerPrompt("INVALID" as ResearchOwnerPromptStage, "json_schema")).toThrow();
    expect(() => selectResearchOwnerPrompt("AUDIT_CLAIMS", "invalid" as ResearchOwnerOutputFormat)).toThrow();
  });
});
