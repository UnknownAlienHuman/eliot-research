import { describe, expect, it } from "vitest";
import { toJSONSchema } from "zod";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { SemanticVerifierBatchSchema, SynthesisClaimsCandidateV3Schema } from "@eliotr/research";
import {
  matchResearchOwnerPrompt,
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
