import { describe, expect, it } from "vitest";
import { parseResearchRunModelSelections } from "./research-run-model-selection-codec.js";

const base = {
  stage: "SYNTHESIZE",
  route_ref: "dynamic/eliotr-balanced",
  route_version: "revision-1",
  candidate_ref: "candidate-1",
  candidate_sha256: "a".repeat(64),
  qualification_ref: "qualification-1",
  qualification_sha256: "b".repeat(64),
};
const second = {
  ...base,
  stage: "AUDIT_CLAIMS",
  route_ref: "dynamic/eliotr-audit-verifier",
  candidate_ref: "candidate-2",
  candidate_sha256: "c".repeat(64),
  qualification_ref: "qualification-2",
  qualification_sha256: "d".repeat(64),
};

const customPolicy = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "custom-chat-completions",
  provider: "custom-opencode-go",
  model: "muse-spark-1.3-contributor",
  billing: { mode: "byok", alias: "eliotr-" + "a".repeat(48) },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low", "medium", "high"] },
};

describe("research run provider-native model selection codec", () => {
  it("preserves a provider-native v2 custom endpoint pin with the saved alias", () => {
    const [selection] = parseResearchRunModelSelections([
      { ...base, candidate_kind: "provider-native-v2", transport_policy: customPolicy },
      { ...second, candidate_kind: "provider-native-v2", transport_policy: customPolicy },
    ]);
    expect(selection?.candidate_kind).toBe("provider-native-v2");
    expect(selection?.transport_policy).toMatchObject({
      api: "custom-chat-completions", provider: "custom-opencode-go", model: "muse-spark-1.3-contributor",
    });
  });

  it("keeps provider-native v1 free-only OpenRouter restrictions unchanged", () => {
    expect(() => parseResearchRunModelSelections([
      { ...base, candidate_kind: "provider-native-v1",
        transport_policy: { ...customPolicy, api: "openrouter-chat-completions", provider: "openrouter" } },
      { ...second, candidate_kind: "provider-native-v1",
        transport_policy: { ...customPolicy, api: "openrouter-chat-completions", provider: "openrouter" } },
    ])).toThrow();
  });

  it("rejects default aliases and compatibility transport for v2", () => {
    expect(() => parseResearchRunModelSelections([
      { ...base, candidate_kind: "provider-native-v2", transport_policy: { ...customPolicy, billing: { mode: "byok", alias: "default" } } },
      { ...second, candidate_kind: "provider-native-v2", transport_policy: { ...customPolicy, billing: { mode: "byok", alias: "default" } } },
    ])).toThrow();
    expect(() => parseResearchRunModelSelections([
      { ...base, candidate_kind: "provider-native-v2", transport_policy: { ...customPolicy, api: "compat-chat-completions", provider: "compat" } },
      { ...second, candidate_kind: "provider-native-v2", transport_policy: { ...customPolicy, api: "compat-chat-completions", provider: "compat" } },
    ])).toThrow();
  });
});
