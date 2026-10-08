import { describe, expect, it } from "vitest";
import type { ResearchArtifactSectionCitationAuditClaim } from "./research-run-api.js";
import { citedExcerptActionLabel, citedExcerptSummary, resolveClaimEvidenceCitations } from "./research-run-report.js";
import type { ResearchArtifactSectionCitationReauthorized } from "./research-run-reauthorization-api.js";
import { EVIDENCE_INTEGRITY_NOTE, evidenceSourceRevisionText, evidenceSourceTitle } from "./evidence-rail.js";

const claim: ResearchArtifactSectionCitationAuditClaim = {
  claim_ref: { id: "claim-1", revision: 1 },
  claim_text: "The reported change occurred in 2025.",
  claim_text_digest: "a".repeat(64),
  disposition: "CONTRADICTED",
  support_handle_refs: [{ id: "saved-support", revision: 1 }],
  counterevidence_handle_refs: [{ id: "saved-counter", revision: 2 }],
};

const supportCitation: ResearchArtifactSectionCitationReauthorized = {
  original_handle_ref: { id: "saved-support", revision: 1 },
  handle_ref: { id: "current-support", revision: 3 },
  excerpt_sha256: "b".repeat(64),
};
const counterCitation: ResearchArtifactSectionCitationReauthorized = {
  original_handle_ref: { id: "saved-counter", revision: 2 },
  handle_ref: { id: "current-counter", revision: 4 },
  excerpt_sha256: "c".repeat(64),
};

describe("Research evidence presentation", () => {
  it("counts cited excerpts without implying a count of unique documents", () => {
    expect(citedExcerptSummary(5)).toBe("5 cited excerpts. This is not a count of unique documents.");
    expect(citedExcerptActionLabel(0)).toBe("Open cited excerpt 1");
  });

  it("keeps support and counterevidence separate while using the current aliases", () => {
    const resolved = resolveClaimEvidenceCitations(claim, new Map([
      ["saved-support:1", supportCitation],
      ["saved-counter:2", counterCitation],
    ]));

    expect(resolved.support).toEqual([supportCitation]);
    expect(resolved.counterevidence).toEqual([counterCitation]);
    expect(resolved.support[0]?.handle_ref).toEqual({ id: "current-support", revision: 3 });
    expect(claim.disposition).toBe("CONTRADICTED");
  });

  it("leaves a missing reauthorization alias unavailable instead of guessing a handle", () => {
    const resolved = resolveClaimEvidenceCitations(claim, new Map());
    expect(resolved.support).toEqual([undefined]);
    expect(resolved.counterevidence).toEqual([undefined]);
  });

  it("shows the authorized title and exact revision separately from the claim verdict", () => {
    expect(evidenceSourceTitle("Annual report.pdf")).toBe("Annual report.pdf");
    expect(evidenceSourceTitle(undefined)).toBe("Authorized source excerpt");
    expect(evidenceSourceRevisionText("source-revision:1")).not.toBe(evidenceSourceRevisionText("source-revision:2"));
    expect(EVIDENCE_INTEGRITY_NOTE).toContain("excerpt bytes match");
    expect(EVIDENCE_INTEGRITY_NOTE).toContain("does not assess any report claim");
    expect(claim.disposition).toBe("CONTRADICTED");
  });
});
