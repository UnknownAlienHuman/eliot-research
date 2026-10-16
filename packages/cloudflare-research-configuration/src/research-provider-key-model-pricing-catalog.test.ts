import { describe, expect, it } from "vitest";
import { assertVerifiedZeroPriceCatalogBytes } from "./research-provider-key-model-pricing-catalog.js";

const MODEL_ID = "dots-studio/dots-3-note-preview:free";

function bytes(endpointOverrides: Record<string, unknown> = {}, modelId = MODEL_ID): Uint8Array {
  const response = {
    data: {
      id: modelId,
      name: "Dots Studio: Dots3-Note Preview (free)",
      created: 1786680361,
      description: "Dots3-Note Preview is an open-weight mixture-of-experts model.",
      architecture: {
        tokenizer: "Other",
        instruct_type: null,
        modality: "text+image->text",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
      },
      endpoints: [{
        name: "AtlasCloud | dots-studio/dots-3-note-preview-20260813:free",
        model_id: modelId,
        model_name: "Dots Studio: Dots3-Note Preview",
        context_length: 512000,
        pricing: { prompt: "0", completion: "0", discount: 0 },
        provider_name: "AtlasCloud",
        tag: "atlas-cloud/fp8",
        service_tier: null,
        quantization: "fp8",
        max_completion_tokens: 460800,
        max_prompt_tokens: null,
        supported_parameters: [
          "reasoning", "include_reasoning", "max_tokens", "temperature", "top_p", "response_format",
          "structured_outputs", "tools", "tool_choice",
        ],
        supports_tool_choice: { none: true, auto: true, required: false, function: false },
        status: 0,
        uptime_last_30m: 100,
        uptime_last_5m: 100,
        uptime_last_1d: 99.01616303583978,
        supports_implicit_caching: false,
        native_tools: {},
        supports_voice_cloning: false,
        supports_multiple_audio_references: false,
        supports_image_reference: false,
        supports_diarization: false,
        latency_last_30m: null,
        throughput_last_30m: null,
        ...endpointOverrides,
      }],
    },
  };
  return new TextEncoder().encode(JSON.stringify(response));
}

describe("OpenRouter zero-price catalog interoperability", () => {
  it("accepts the exact free model and current endpoint metadata with native reasoning support", () => {
    expect(() => assertVerifiedZeroPriceCatalogBytes(bytes(), MODEL_ID)).not.toThrow();
  });

  it("rejects nonzero pricing, a different model identity, and missing native request capabilities", () => {
    expect(() => assertVerifiedZeroPriceCatalogBytes(bytes({ pricing: { prompt: "0.01", completion: "0", discount: 0 } }), MODEL_ID))
      .toThrow(expect.objectContaining({ code: "FREE_PRICE_NOT_ZERO" }));
    expect(() => assertVerifiedZeroPriceCatalogBytes(bytes(), "stealth/space-bunny-alpha"))
      .toThrow(expect.objectContaining({ code: "FREE_PRICE_NOT_PROVEN" }));
    expect(() => assertVerifiedZeroPriceCatalogBytes(bytes({
      supported_parameters: ["max_tokens", "reasoning_effort", "response_format"],
    }), MODEL_ID)).toThrow(expect.objectContaining({ code: "FREE_PRICE_NOT_PROVEN" }));
  });
});
