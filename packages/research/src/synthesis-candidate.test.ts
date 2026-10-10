import { describe, expect, it } from "vitest";
import {
  decodeSynthesisClaimsCandidateV2,
  decodeSynthesisClaimsCandidateV3,
  decodeSynthesisSectionCandidateV1,
  normalizeSynthesisClaimsCandidateV2,
  normalizeSynthesisClaimsCandidateV3,
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

describe("legacy synthesis section candidate v1", () => {
  it("decodes the strict bounded section shape", () => {
    expect(decodeSynthesisSectionCandidateV1(JSON.stringify({
      schema: "eliotr.research.synthesis-section-candidate.v1",
      section_text: "Grounded section.",
      cited_handle_refs: [allowed[0]],
    }))).toMatchObject({ section_text: "Grounded section.", cited_handle_refs: [allowed[0]] });
  });

  it("rejects unknown fields and malformed UTF-16", () => {
    expect(() => decodeSynthesisSectionCandidateV1(JSON.stringify({
      schema: "eliotr.research.synthesis-section-candidate.v1", section_text: "Grounded section.",
      cited_handle_refs: [allowed[0]], disposition: "SUPPORTED",
    }))).toThrow(SynthesisClaimsCandidateError);
    const loneSurrogate = String.fromCharCode(0xd800);
    expect(() => decodeSynthesisSectionCandidateV1(JSON.stringify({
      schema: "eliotr.research.synthesis-section-candidate.v1", section_text: loneSurrogate,
      cited_handle_refs: [allowed[0]],
    }))).toThrow(SynthesisClaimsCandidateError);
  });
});

describe("versioned synthesis claims candidate v2", () => {
  it("normalizes server identity and derives the exact citation union", async () => {
    const normalized = await normalize();
    expect(normalized.claims).toHaveLength(1);
    expect(normalized.claims[0]?.claim_ref.id).toMatch(/^research-claim:[a-f0-9]{64}$/u);
    expect(normalized.claims[0]?.text_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(normalized.claims[0]?.required_precision).toBe("exact-excerpt");
    expect(normalized.cited_handle_refs).toEqual([...allowed]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(baseClaim.text));
    expect(normalized.claims[0]?.text_digest).toBe(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    expect(Object.isFrozen(normalized.section_ref)).toBe(true);
    expect(Object.isFrozen(normalized.claims[0]?.support_handle_refs)).toBe(true);
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
    expect(second.claims[0]?.text_digest).toEqual(first.claims[0]?.text_digest);
  });

  it("uses UTF-16 spans without allowing surrogate-pair splits", async () => {
    const candidate = { ...base, section_text: "😀 claim", material_claims: [{ ...baseClaim, text: "😀", span: { start: 0, end: 1 } }] };
    await expect(normalize(candidate)).rejects.toMatchObject({ code: "SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID" });
    const loneSurrogate = String.fromCharCode(0xd800);
    await expect(normalize({ ...base, section_text: loneSurrogate, material_claims: [{ ...baseClaim, text: loneSurrogate, span: { start: 0, end: 1 } }] }))
      .rejects.toMatchObject({ code: "SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID" });
  });

  it("preserves Unicode scalar bytes and captured v2/v3 identities", async () => {
    const text = "\uFEFF\u0000e\u0301😀";
    const decodedSection = decodeSynthesisSectionCandidateV1(JSON.stringify({
      schema: "eliotr.research.synthesis-section-candidate.v1",
      section_text: text,
      cited_handle_refs: [allowed[0]],
    }));
    expect(decodedSection.section_text).toBe(text);
    expect(Array.from(new TextEncoder().encode(decodedSection.section_text)))
      .toEqual([0xef, 0xbb, 0xbf, 0x00, 0x65, 0xcc, 0x81, 0xf0, 0x9f, 0x98, 0x80]);

    const candidateV2 = {
      ...base,
      section_text: text,
      material_claims: [{ ...baseClaim, text, span: { start: 0, end: text.length } }],
    };
    expect(decodeSynthesisClaimsCandidateV2(JSON.stringify(candidateV2)).material_claims[0]?.text).toBe(text);
    const normalizedV2 = await normalize(candidateV2);
    expect(normalizedV2.claims[0]).toMatchObject({
      claim_ref: { id: "research-claim:d082a64da9aa23de045fdda2af6979f6e1b4b6778353d3edb17d9092d1b3692d" },
      text,
      text_digest: "28ae8acebeb038878c3903b43ca9d34b7ed927ea9eef1b5ee30c70c889c7ccce",
      span: { start: 0, end: 6 },
    });

    const candidateV3 = {
      schema: "eliotr.research.synthesis-claims-candidate.v3" as const,
      material_claims: [{
        text,
        kind: "observation" as const,
        support_handle_refs: [allowed[0]],
        counterevidence_handle_refs: [allowed[1]],
      }],
    };
    expect(decodeSynthesisClaimsCandidateV3(JSON.stringify(candidateV3)).material_claims[0]?.text).toBe(text);
    const normalizedV3 = await normalizeSynthesisClaimsCandidateV3({
      candidate: candidateV3,
      operation_id: "operation-1",
      section_ref: { id: "section-1", revision: 1 },
      allowed_handle_refs: allowed,
      required_precision: "exact-excerpt",
      required_source_class: "official",
    });
    expect(normalizedV3.claims[0]).toMatchObject({
      claim_ref: { id: "research-claim:0aef0d231dc9dfb6be21c17a2e09c49d7c1925a56adaa618cc3c5144e93fcc82" },
      text,
      text_digest: "28ae8acebeb038878c3903b43ca9d34b7ed927ea9eef1b5ee30c70c889c7ccce",
      span: { start: 0, end: 6 },
    });
  });
});
