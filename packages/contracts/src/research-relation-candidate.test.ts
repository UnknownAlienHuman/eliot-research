import { describe, expect, it } from "vitest";
import {
  ResearchRelationCandidateSchema,
  digestResearchRelationBytes,
  digestResearchRelationFactText,
  researchRelationCandidateIdentityDigest,
  verifyResearchRelationCandidateIdentity,
  type ResearchRelationTarget,
} from "./research-relation-candidate.js";

const SHA = "a".repeat(64);

function unknownFact(handleId: string, factText: string) {
  return {
    fact_text: factText,
    fact_text_sha256: SHA,
    source_span_ref: {
      evidence_handle_ref: { id: handleId, revision: 1 },
      source_revision_ref: `source-${handleId}`,
      anchor: { kind: "normalized_byte_range" as const, start: 0, end: 1 },
    },
    context: {
      units: { state: "UNKNOWN" as const },
      population: { state: "UNKNOWN" as const },
      conditions: { state: "UNKNOWN" as const },
      polarity: { state: "UNKNOWN" as const },
      observed_interval: { state: "UNKNOWN" as const },
      validity_interval: { state: "UNKNOWN" as const },
    },
  };
}

function unknownCandidate() {
  return {
    protocol: "eliotr.research.relation-candidate.v1" as const,
    candidate_ref: { id: `eliotr.research.relation-candidate-${SHA}`, revision: 1 },
    identity_digest: SHA,
    target: {
      kind: "QUESTION" as const,
      question_ref: { id: "question-1", revision: 1 },
      question_sha256: SHA,
    },
    relation_kind: "QUALIFIES" as const,
    left: unknownFact("handle-left", "  unchanged source fact A  "),
    right: unknownFact("handle-right", "unchanged source fact B"),
    assessment: {
      units: "UNKNOWN" as const,
      population: "UNKNOWN" as const,
      conditions: "UNKNOWN" as const,
      polarity: "UNKNOWN" as const,
      observed_time: "UNKNOWN" as const,
      validity_time: "UNKNOWN" as const,
    },
  };
}

function knownText(value: string, sourceId: string) {
  return { state: "KNOWN" as const, value, source_refs: [{ id: sourceId, revision: 1 }] };
}

function knownConditions(values: string[], sourceId: string) {
  return { state: "KNOWN" as const, values, source_refs: [{ id: sourceId, revision: 1 }] };
}

async function candidateWithValidDigests(target: ResearchRelationTarget = unknownCandidate().target) {
  const candidate = { ...unknownCandidate(), target };
  const left = {
    ...candidate.left,
    fact_text_sha256: await digestResearchRelationFactText(candidate.left.fact_text),
  };
  const right = {
    ...candidate.right,
    fact_text_sha256: await digestResearchRelationFactText(candidate.right.fact_text),
  };
  const identity = {
    protocol: candidate.protocol,
    target: candidate.target,
    relation_kind: candidate.relation_kind,
    left,
    right,
    assessment: candidate.assessment,
  };
  const identityDigest = await researchRelationCandidateIdentityDigest(identity);
  return {
    ...identity,
    candidate_ref: { id: `eliotr.research.relation-candidate-${identityDigest}`, revision: 1 },
    identity_digest: identityDigest,
  };
}

describe("ResearchRelationCandidate strict source-bound assessment", () => {
  it("keeps missing context UNKNOWN and rejects promoting it to CONTRADICTS", () => {
    const candidate = unknownCandidate();
    const parsed = ResearchRelationCandidateSchema.safeParse(candidate);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    if (parsed.success) expect(parsed.data.left.fact_text).toBe("  unchanged source fact A  ");

    expect(ResearchRelationCandidateSchema.safeParse({ ...candidate, relation_kind: "CONTRADICTS" }).success).toBe(false);
    expect(ResearchRelationCandidateSchema.safeParse({
      ...candidate,
      assessment: { ...candidate.assessment, units: "MATCH" },
    }).success).toBe(false);
  });

  it("rejects MATCH when known units or population values differ exactly", () => {
    const candidate = unknownCandidate();
    const differentUnits = {
      ...candidate,
      left: { ...candidate.left, context: { ...candidate.left.context, units: knownText("kg", "unit-left") } },
      right: { ...candidate.right, context: { ...candidate.right.context, units: knownText("lb", "unit-right") } },
      assessment: { ...candidate.assessment, units: "MATCH" as const },
    };
    const differentPopulation = {
      ...candidate,
      left: { ...candidate.left, context: { ...candidate.left.context, population: knownText("adults", "population-left") } },
      right: { ...candidate.right, context: { ...candidate.right.context, population: knownText("children", "population-right") } },
      assessment: { ...candidate.assessment, population: "MATCH" as const },
    };
    const whitespaceKnown = {
      ...candidate,
      left: { ...candidate.left, context: { ...candidate.left.context, units: knownText("   ", "unit-left") } },
    };

    expect(ResearchRelationCandidateSchema.safeParse(differentUnits).success).toBe(false);
    expect(ResearchRelationCandidateSchema.safeParse(differentPopulation).success).toBe(false);
    expect(ResearchRelationCandidateSchema.safeParse(whitespaceKnown).success).toBe(false);
  });

  it("requires condition descriptor sets in unique canonical order", () => {
    const candidate = unknownCandidate();
    const outOfOrder = {
      ...candidate,
      left: { ...candidate.left, context: { ...candidate.left.context, conditions: knownConditions(["B", "A"], "conditions-left") } },
    };
    const duplicate = {
      ...candidate,
      left: { ...candidate.left, context: { ...candidate.left.context, conditions: knownConditions(["A", "A"], "conditions-left") } },
    };
    const blank = {
      ...candidate,
      left: { ...candidate.left, context: { ...candidate.left.context, conditions: knownConditions([" "], "conditions-left") } },
    };

    expect(ResearchRelationCandidateSchema.safeParse(outOfOrder).success).toBe(false);
    expect(ResearchRelationCandidateSchema.safeParse(duplicate).success).toBe(false);
    expect(ResearchRelationCandidateSchema.safeParse(blank).success).toBe(false);
  });

  it("verifies exact fact bytes and canonical candidate identity without claiming source verification", async () => {
    expect(await digestResearchRelationBytes(new TextEncoder().encode("abc")))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    const candidate = await candidateWithValidDigests();
    await expect(verifyResearchRelationCandidateIdentity(candidate)).resolves.toEqual({
      candidate_schema_valid: true,
      fact_text_digests_match: true,
      canonical_identity_matches: true,
      source_references_verified: false,
    });

    const tamperedText = {
      ...candidate,
      left: { ...candidate.left, fact_text: `${candidate.left.fact_text}!` },
    };
    await expect(verifyResearchRelationCandidateIdentity(tamperedText)).resolves.toEqual({
      candidate_schema_valid: true,
      fact_text_digests_match: false,
      canonical_identity_matches: false,
      source_references_verified: false,
    });
  });

  it("binds CLAIM targets to the existing claim ID and text digest", async () => {
    const claimTarget: ResearchRelationTarget = {
      kind: "CLAIM",
      claim_id: "claim-1",
      claim_text_digest: "b".repeat(64),
    };
    const candidate = await candidateWithValidDigests(claimTarget);

    expect(ResearchRelationCandidateSchema.safeParse(candidate).success).toBe(true);
    await expect(verifyResearchRelationCandidateIdentity(candidate)).resolves.toMatchObject({
      candidate_schema_valid: true,
      fact_text_digests_match: true,
      canonical_identity_matches: true,
      source_references_verified: false,
    });

    const changedClaimId = {
      ...candidate,
      target: { ...claimTarget, claim_id: "claim-2" },
    };
    const changedClaimDigest = {
      ...candidate,
      target: { ...claimTarget, claim_text_digest: "c".repeat(64) },
    };
    const missingClaimDigest = {
      ...candidate,
      target: { kind: "CLAIM" as const, claim_id: claimTarget.claim_id },
    };

    await expect(verifyResearchRelationCandidateIdentity(changedClaimId)).resolves.toMatchObject({
      candidate_schema_valid: true,
      canonical_identity_matches: false,
      source_references_verified: false,
    });
    await expect(verifyResearchRelationCandidateIdentity(changedClaimDigest)).resolves.toMatchObject({
      candidate_schema_valid: true,
      canonical_identity_matches: false,
      source_references_verified: false,
    });
    expect(ResearchRelationCandidateSchema.safeParse(missingClaimDigest).success).toBe(false);
  });

  it("rejects distinct lone surrogates before their fact-text digests can collide", async () => {
    const firstMalformedText = "\uD800";
    const secondMalformedText = "\uD801";
    expect(new TextEncoder().encode(firstMalformedText))
      .toEqual(new TextEncoder().encode(secondMalformedText));

    const candidate = unknownCandidate();
    const malformedFirst = {
      ...candidate,
      left: { ...candidate.left, fact_text: firstMalformedText },
    };
    const malformedSecond = {
      ...candidate,
      left: { ...candidate.left, fact_text: secondMalformedText },
    };

    expect(ResearchRelationCandidateSchema.safeParse(malformedFirst).success).toBe(false);
    expect(ResearchRelationCandidateSchema.safeParse(malformedSecond).success).toBe(false);
    await expect(digestResearchRelationFactText(firstMalformedText)).rejects.toThrow();
    await expect(digestResearchRelationFactText(secondMalformedText)).rejects.toThrow();
    await expect(verifyResearchRelationCandidateIdentity(malformedFirst)).resolves.toMatchObject({
      candidate_schema_valid: false,
      fact_text_digests_match: false,
      canonical_identity_matches: false,
      source_references_verified: false,
    });
    await expect(verifyResearchRelationCandidateIdentity(malformedSecond)).resolves.toMatchObject({
      candidate_schema_valid: false,
      fact_text_digests_match: false,
      canonical_identity_matches: false,
      source_references_verified: false,
    });
  });
});
