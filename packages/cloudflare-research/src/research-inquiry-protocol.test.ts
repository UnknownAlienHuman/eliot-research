import { describe, expect, it } from "vitest";

import {
  INSTALLED_INQUIRY_PROTOCOL_REFS,
  InstalledInquiryProtocolError,
  assertInstalledInquiryProtocolProfile,
  compileInstalledInquiryProtocol,
  installedInquiryProtocolDefinition,
} from "./research-inquiry-protocol.js";

describe("installed InquiryProtocol profiles", () => {
  it("keeps the historical lookup profile byte-compatible while explicit v2 adds obligations", async () => {
    const legacy = await compileInstalledInquiryProtocol({
      definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup,
      question: "Where is the exact evidence?",
      evidence_grade: "E2",
      model_profile_ref: "model-profile-v1",
      include_obligations: false,
    });
    const explicit = await compileInstalledInquiryProtocol({
      definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup,
      question: "Where is the exact evidence?",
      evidence_grade: "E2",
      model_profile_ref: "model-profile-v1",
    });

    expect(legacy.profile).not.toHaveProperty("obligations");
    expect(legacy.ledger_obligations).toHaveLength(2);
    expect(explicit.profile.obligations?.map((item) => item.obligation_id)).toEqual([
      "lookup:grounding",
      "lookup:coverage",
    ]);
    expect(explicit.identity_digest).not.toBe(legacy.identity_digest);
    expect(assertInstalledInquiryProtocolProfile(
      INSTALLED_INQUIRY_PROTOCOL_REFS.lookup,
      legacy.profile,
    ).name).toBe("lookup");
  });

  it("compiles distinct evidence-review and architecture-decision obligations deterministically", async () => {
    const reviewInput = {
      definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review,
      question: "Review support and counterevidence.",
      evidence_grade: "E1" as const,
      model_profile_ref: "model-profile-v1",
    };
    const first = await compileInstalledInquiryProtocol(reviewInput);
    const replay = await compileInstalledInquiryProtocol(reviewInput);
    const architecture = await compileInstalledInquiryProtocol({
      definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision,
      question: "Choose between the documented architecture alternatives.",
      evidence_grade: "E2",
      model_profile_ref: "model-profile-v1",
    });

    expect(replay).toEqual(first);
    expect(first.profile.counter_search_required).toBe(true);
    expect(first.ledger_obligations.map((item) => item.obligation_id)).toEqual([
      "evidence_review:grounding",
      "evidence_review:counterevidence",
      "evidence_review:coverage",
    ]);
    expect(first.ledger_obligations[1]?.dependency_obligation_ids).toEqual([
      "evidence_review:grounding",
    ]);
    expect(architecture.profile.alternatives_required).toBe(true);
    expect(architecture.profile.falsification_required).toBe(true);
    expect(architecture.ledger_obligations.map((item) => item.kind)).toEqual([
      "exact-evidence-grounding",
      "counterevidence-search",
      "rival-alternatives",
      "implementation-state-separation",
      "coverage-accounting",
    ]);
    expect(architecture.identity_digest).not.toBe(first.identity_digest);
  });

  it("rejects unknown profiles, unsupported grades and profile substitution", async () => {
    expect(() => installedInquiryProtocolDefinition({ id: "unknown-profile", revision: 1 }))
      .toThrowError(InstalledInquiryProtocolError);
    await expect(compileInstalledInquiryProtocol({
      definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review,
      question: "Review evidence.",
      evidence_grade: "E0",
      model_profile_ref: "model-profile-v1",
    })).rejects.toMatchObject({ code: "INQUIRY_PROTOCOL_GRADE_UNSUPPORTED" });

    const compiled = await compileInstalledInquiryProtocol({
      definition_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision,
      question: "Review architecture.",
      evidence_grade: "E2",
      model_profile_ref: "model-profile-v1",
    });
    expect(() => assertInstalledInquiryProtocolProfile(
      INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision,
      { ...compiled.profile, counter_search_required: false },
    )).toThrowError(InstalledInquiryProtocolError);
  });
});
