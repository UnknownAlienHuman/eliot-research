import { describe, expect, it } from "vitest";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import {
  createProviderNativeModelCatalogCandidateBundleV2,
  decodeProviderNativeModelCatalogPreparationV2,
  decodeProviderNativeModelCatalogSelectionV2,
  type ProviderNativeModelCatalogPreparationV2,
  type ProviderNativeModelCatalogObservationV2,
} from "./provider-native-model-catalog-v2.js";

const ownerOperation = "a0000000-0000-4000-8000-000000000001";
const providerOperation = "b0000000-0000-4000-8000-000000000002";
const modelId = "muse-spark-1.3-contributor";
const policy = Object.freeze({
  version: 1 as const,
  transport: "cloudflare-ai-gateway" as const,
  api: "custom-chat-completions" as const,
  provider: "custom-opencode-go",
  model: modelId,
  billing: Object.freeze({ mode: "byok" as const, alias: "eliotr-" + "a".repeat(48) }),
  capabilities: Object.freeze({ max_output_tokens_field: "max_tokens" as const,
    reasoning_efforts: Object.freeze(["low", "medium", "high"] as const) }),
});

async function fixture() {
  const preparation: ProviderNativeModelCatalogPreparationV2 = Object.freeze({
    protocol: "eliotr.provider-native-model-preparation.v2",
    owner_ref: "owner-1",
    project_id: "project-1",
    owner_operation_id: ownerOperation,
    consent_operation_id: ownerOperation,
    stage: "SYNTHESIZE",
    provider_id: "opencode-go",
    provider_slug: "custom-opencode-go",
    provider_operation_id: providerOperation,
    model_id: modelId,
    prepared_at: "2026-10-16T18:00:00.000Z",
    preparation_expires_at: "2026-10-16T18:05:00.000Z",
    pricing_snapshot_expires_at: "2026-10-17T18:00:00.000Z",
    deployment: Object.freeze({ route_ref: "dynamic/eliotr-balanced", route_version: "rev-1",
      prompt_generation: "prompt-1", schema_generation: "schema-1", parameters_digest: "1".repeat(64),
      pricing_snapshot_ref: "modelsdev-opencodego-muse-1" }),
    probe_deployment: Object.freeze({ route_ref: "dynamic/eliotr-balanced", route_version: "rev-1",
      prompt_generation: "probe-prompt-1", schema_generation: "probe-schema-1", parameters_digest: "2".repeat(64),
      pricing_snapshot_ref: "modelsdev-opencodego-muse-1" }),
    transport_policy: policy,
    key_binding: Object.freeze({ protocol: "eliotr.research-provider-key-configuration.v1",
      owner_ref: "owner-1", project_id: "project-1", operation_id: providerOperation,
      provider_id: "opencode-go", provider_slug: "custom-opencode-go", account_id: "c".repeat(32),
      gateway_id: "eliotr-reasoning", alias: "eliotr-" + "a".repeat(48), provider_config_id: "provider-config-1",
      configuration_metadata_sha256: "3".repeat(64) }),
    pricing_snapshot_ref: "modelsdev-opencodego-muse-1",
    pricing_snapshot_sha256: "4".repeat(64),
    catalog_sdk: "@ai-sdk/openai-compatible",
    sdk_base_url: "https://opencode.ai/inference/go/openai/v1",
    catalog_metadata_sha256: "d".repeat(64),
    request_sha256: "5".repeat(64),
    prompt_sha256: "6".repeat(64),
    schema_sha256: "7".repeat(64),
    parameters_sha256: "1".repeat(64),
    probe_prompt_sha256: "8".repeat(64),
    probe_schema_sha256: "9".repeat(64),
    probe_parameters_sha256: "2".repeat(64),
  });
  const preparationJson = canonicalModelGatewayJson(preparation);
  const preparationSha = await modelGatewaySha256(preparationJson);
  const observation: ProviderNativeModelCatalogObservationV2 = Object.freeze({
    protocol: "eliotr.provider-native-model-observation.v2",
    qualification_purpose: "structured-output-connectivity",
    api: "custom-chat-completions",
    provider_id: "opencode-go",
    provider_slug: "custom-opencode-go",
    model_id: modelId,
    consent_request_sha256: preparation.request_sha256,
    request_body_sha256: "a".repeat(64),
    response_body_sha256: "b".repeat(64),
    response_model: modelId,
    gateway_log_id: "gw-log-1",
    input_tokens: 12,
    output_tokens: 8,
    verified_at: "2026-10-16T18:01:00.000Z",
    expires_at: "2026-10-17T18:00:00.000Z",
  });
  const bundle = await createProviderNativeModelCatalogCandidateBundleV2({ preparation,
    preparation_ref: `provider-native-model-preparation-v2-${preparationSha}`,
    preparation_sha256: preparationSha, observation });
  return { preparation, observation, bundle };
}

describe("provider-native catalog v2 evidence", () => {
  it("creates an exact custom-provider candidate and readback selection", async () => {
    const { preparation, bundle } = await fixture();
    expect(bundle.selection.candidate_kind).toBe("provider-native-v2");
    expect(bundle.selection.transport_policy.provider).toBe("custom-opencode-go");
    expect(bundle.selection.transport_policy.model).toBe(modelId);
    expect(bundle.qualification.provider_operation_id).toBe(providerOperation);
    expect(bundle.qualification.consent_operation_id).toBe(ownerOperation);
    expect(bundle.qualification.catalog_sdk).toBe("@ai-sdk/openai-compatible");
    expect(bundle.qualification.catalog_metadata_sha256).toBe("d".repeat(64));
    expect(preparation.pricing_snapshot_sha256).toBe("4".repeat(64));
    expect(decodeProviderNativeModelCatalogSelectionV2(bundle.selection)).toEqual(bundle.selection);
  });

  it("rejects a response that reports another selected model", async () => {
    const { preparation, observation, bundle } = await fixture();
    await expect(createProviderNativeModelCatalogCandidateBundleV2({
      preparation,
      preparation_ref: bundle.candidate.preparation_ref,
      preparation_sha256: bundle.candidate.preparation_sha256,
      observation: { ...observation, response_model: "another-model" },
    })).rejects.toMatchObject({ code: "PROOF_INVALID" });
  });

  it("keeps v2 named-BYOK requirements strict", () => {
    expect(() => decodeProviderNativeModelCatalogSelectionV2({
      candidate_kind: "provider-native-v2", stage: "SYNTHESIZE", route_ref: "dynamic/eliotr-balanced",
      route_version: "rev-1", candidate_ref: "candidate-1", candidate_sha256: "a".repeat(64),
      qualification_ref: "qualification-1", qualification_sha256: "b".repeat(64),
      transport_policy: { ...policy, billing: { mode: "byok", alias: "default" } },
    })).toThrow();
  });

  it("requires the logical ID, physical slug, saved operation and transport to agree", async () => {
    const { preparation } = await fixture();
    expect(() => decodeProviderNativeModelCatalogPreparationV2({
      ...preparation,
      transport_policy: { ...policy, provider: "opencode-go" },
    })).toThrow();
    expect(() => decodeProviderNativeModelCatalogPreparationV2({
      ...preparation,
      key_binding: { ...preparation.key_binding, operation_id: ownerOperation },
    })).toThrow();
  });

  it("accepts only the exact custom Responses and Anthropic SDK-selected APIs", () => {
    for (const [api, maxOutput] of [
      ["custom-responses", "max_output_tokens"],
      ["custom-anthropic-messages", "max_tokens"],
    ] as const) {
      const selection = decodeProviderNativeModelCatalogSelectionV2({
        candidate_kind: "provider-native-v2", stage: "SYNTHESIZE", route_ref: "dynamic/eliotr-balanced",
        route_version: "revision-1", candidate_ref: "candidate-1", candidate_sha256: "a".repeat(64),
        qualification_ref: "qualification-1", qualification_sha256: "b".repeat(64),
        transport_policy: { ...policy, api, capabilities: { ...policy.capabilities, max_output_tokens_field: maxOutput } },
      });
      expect(selection.transport_policy.api).toBe(api);
    }
  });
});
