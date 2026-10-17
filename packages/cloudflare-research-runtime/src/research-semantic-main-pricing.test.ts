import { describe, expect, it, vi } from "vitest";
import type { ModelGatewayPricingPort } from "@eliotr/cloudflare-ai";
import { researchSemanticNativeMainPricing } from "./research-semantic-main-pricing.js";

const price = (): ModelGatewayPricingPort => ({ quote: async () => { throw new Error("binding must not quote or dispatch"); } });

describe("semantic server main native pricing producer", () => {
  it("binds both main catalog price ports without branch-role configuration or a provider call", async () => {
    const synthesis = price(), audit = price();
    const read = vi.fn(async (stage: "SYNTHESIZE" | "AUDIT_CLAIMS") => stage === "SYNTHESIZE" ? synthesis : audit);
    const result = await researchSemanticNativeMainPricing({
      selections: new Map([['SYNTHESIZE', { candidate_kind: 'provider-native-v2' }], ['AUDIT_CLAIMS', { candidate_kind: 'provider-native-v2' }]]),
      pricingForStage: read,
    });
    expect(result).toEqual({ synthesis, audit });
    expect(read.mock.calls).toEqual([["SYNTHESIZE"], ["AUDIT_CLAIMS"]]);
  });

  it.each([undefined, "provider-native-v1", "dynamic"])("preserves legacy pricing for %s and makes no extra read", async kind => {
    const read = vi.fn(async () => price());
    expect(await researchSemanticNativeMainPricing({ selections: new Map([['SYNTHESIZE', { candidate_kind: kind }]]), pricingForStage: read })).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["SYNTHESIZE", "AUDIT_CLAIMS"] as const)("refuses missing trusted %s pricing instead of falling back", async stage => {
    await expect(researchSemanticNativeMainPricing({ selections: new Map([[stage, { candidate_kind: "provider-native-v2" }]]),
      pricingForStage: async () => undefined })).rejects.toMatchObject({ code: "WORKFLOW_CONFIGURATION_MISSING" });
  });
});
