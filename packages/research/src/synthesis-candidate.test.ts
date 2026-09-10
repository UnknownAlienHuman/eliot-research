import { describe, expect, it } from "vitest";
import {
  decodeSynthesisClaimsCandidateV2,
  normalizeSynthesisClaimsCandidateV2,
  SynthesisClaimsCandidateError,
  type SynthesisClaimsCandidateV2,
} from "./synthesis-candidate.js";

const allowed: [{ id: string; revision: number }, { id: string; revision: number }] = [
  { id: "handle-a", revision: 1 }, { id: "handle-b", revision: 1 },
];
const baseClaim = {
  text: "A claim with a hedge.", kind: "observation" as const,
  support_handle_refs: [allowed[0]], counterevidence_handle_refs: [allowed[1]], span: { start: 0, end: 21 },
};
const base: SynthesisClaimsCandidateV2 = {
  schema: "eliotr.research.synthesis-claims-candidate.v2" as const,
  section_text: "A claim with a hedge.",
  material_claims: [baseClaim],
};

function normalize(candidate = base, operation_id = "operation-1") {
  return normalizeSynthesisClaimsCandidateV2({ candidate, operation_id, section_ref: { id: "section-1", revision: 1 },
    allowed_handle_refs: allowed, required_precision: "exact-excerpt", required_source_class: "official" });
}

describe("versioned synthesis claims candidate v2", () => {
  it("normalizes server identity and derives the exact citation union", async () => {
    const normalized = await normalize();
    expect(normalized.claims).toHaveLength(1);
    expect(normalized.claims[0]?.claim_ref.id).toMatch(/^research-claim:[a-f0-9]{64}$/u);
    expect(normalized.claims[0]?.text_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(normalized.claims[0]?.required_precision).toBe("exact-excerpt");
    expect(normalized.cited_handle_refs).toEqual([...allowed]);
  });

  it("requires the explicit span to contain the exact claim text", async () => {
    await expect(normalize({ ...base, material_claims: [{ ...baseClaim, span: { start: 0, end: 7 } }] }))
      .rejects.toMatchObject({ code: "SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID" });
  });

  it("rejects duplicate or non-frozen refs and model-supplied audit fields", async () => {
    await expect(normalize({ ...base, material_claims: [{ ...baseClaim, support_handle_refs: [allowed[0]], counterevidence_handle_refs: [allowed[0]] }] }))
      .rejects.toMatchObject({ code: "SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID" });
    await expect(normalize({ ...base, material_claims: [{ ...baseClaim, support_handle_refs: [{ id: "handle-not-frozen", revision: 1 }] }] }))
      .rejects.toMatchObject({ code: "SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID" });
    expect(() => decodeSynthesisClaimsCandidateV2(JSON.stringify({ ...base, disposition: "SUPPORTED" })))
      .toThrow(SynthesisClaimsCandidateError);
  });

  it("scopes derived identity to the trusted operation and section", async () => {
    const first = await normalize();
    const second = await normalize(base, "operation-2");
    expect(second.claims[0]?.claim_ref).not.toEqual(first.claims[0]?.claim_ref);
    expect(second.claims[0]?.text_digest).not.toEqual(first.claims[0]?.text_digest);
  });
});
