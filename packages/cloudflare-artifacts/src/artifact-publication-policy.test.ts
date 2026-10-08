import { describe, expect, it } from "vitest";
import type { ArtifactRevision } from "@eliotr/contracts";
import type { ArtifactDraftSectionCitationsReauthorizedRead } from "./artifact-draft-citations-reauthorization.js";
import { assertArtifactPublicationReady, ArtifactPublicationReadinessError } from "./artifact-publication-policy.js";

type ExecutedCitations = Extract<ArtifactDraftSectionCitationsReauthorizedRead, { readonly semantic_verification: "EXECUTED" }>;
const sectionRef = { id: "section-1", revision: 1 } as const;

function revision(overrides: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return {
    artifact_ref: { id: "artifact-1", revision: 1 },
    spec_ref: { id: "spec-1", revision: 1 },
    spec_digest: "a".repeat(64),
    evidence_freeze_ref: { id: "freeze-1", revision: 1 },
    sections: [{
      section_ref: sectionRef,
      contract_id: "summary",
      body_object_ref: "body-1",
      body_sha256: "b".repeat(64),
      statement_labels: { "claim-1": "SOURCE_SUPPORTED" },
      evidence_ledger_ref: "ledger-1",
      verification_receipt_ref: "verification-1",
    }],
    dependency_manifest_ref: "dependency-1",
    deterministic_export_refs: { markdown: "export-1" },
    status: "DRAFT",
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function citations(overrides: Partial<Omit<ExecutedCitations, "semantic_verification" | "audit">> & { readonly audit?: ExecutedCitations["audit"] } = {}): ExecutedCitations {
  return {
    protocol: "eliotr.artifact-draft-citations-reauthorization.v1",
    artifact_ref: { id: "artifact-1", revision: 1 },
    section_ref: sectionRef,
    original_scope_snapshot_ref: { id: "scope-1", revision: 1 },
    authorization_scope_snapshot_ref: { id: "scope-2", revision: 1 },
    authorization: {
      authorization_receipt_ref: "auth-1",
      policy_authority_ref: "policy-1",
      allowed_use: ["research"],
      disclosure_ceiling: "owner_only",
      expires_at: "2026-10-02T00:00:00.000Z",
    },
    deployment_generation: "deployment-1",
    verification_receipt_ref: "verification-1",
    cited_evidence: [{
      original_handle_ref: { id: "handle-1", revision: 1 },
      handle_ref: { id: "handle-1", revision: 1 },
      excerpt_sha256: "c".repeat(64),
    }],
    semantic_verification: "EXECUTED",
    audit: {
      stage_attempt_ref: "attempt-1",
      stage_request_sha256: "d".repeat(64),
      output_sha256: "e".repeat(64),
      synthesis_output_sha256: "f".repeat(64),
      normalization_binding_sha256: "1".repeat(64),
      verifier_ref: "verifier-1",
      verifier_schema_generation: "verifier-v1",
      model_receipt_ref: "model-1",
      claims: [{
        claim_ref: { id: "claim-1", revision: 1 },
        claim_text: "The cited source supports the statement.",
        claim_text_digest: "2".repeat(64),
        disposition: "SUPPORTED",
        support_handle_refs: [{ id: "handle-1", revision: 1 }],
        counterevidence_handle_refs: [],
      }],
    },
    ...overrides,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("publication fixture item missing");
  return value;
}

describe("artifact publication readiness", () => {
  it("accepts only executed audit claims that exactly cover and agree with statement labels", () => {
    expect(() => assertArtifactPublicationReady(
      revision(), new Map([["section-1:1", citations()]]),
    )).not.toThrow();
  });

  it("rejects a persisted v1 receipt without executed semantic verification", () => {
    const v1 = { ...citations(), semantic_verification: "NOT_EXECUTED" as const };
    expect(() => assertArtifactPublicationReady(
      revision(), new Map([["section-1:1", v1 as ArtifactDraftSectionCitationsReauthorizedRead]]),
    )).toThrowError(ArtifactPublicationReadinessError);
  });

  it("rejects audit evidence that is missing, mismatched, or contradictory without counterevidence", () => {
    const uncovered = revision({ sections: [{
      ...required(revision().sections[0]), statement_labels: { "claim-unreviewed": "SOURCE_SUPPORTED" },
    }] });
    expect(() => assertArtifactPublicationReady(uncovered, new Map([["section-1:1", citations()]])))
      .toThrowError(ArtifactPublicationReadinessError);

    const audit = citations().audit;
    const contradicted = citations({ audit: {
      ...audit,
      claims: [{ ...required(audit.claims[0]), disposition: "CONTRADICTED", counterevidence_handle_refs: [] }],
    } });
    expect(() => assertArtifactPublicationReady(revision({ sections: [{
      ...required(revision().sections[0]), statement_labels: { "claim-1": "CONTESTED" },
    }] }), new Map([["section-1:1", contradicted]])))
      .toThrowError(ArtifactPublicationReadinessError);
  });

  it("does not treat redacted dependency labels or zero sections as acceptable", () => {
    const redacted = revision({ sections: [{
      ...required(revision().sections[0]), statement_labels: { "claim-1": "REDACTED_DEPENDENCY" },
    }] });
    expect(() => assertArtifactPublicationReady(redacted, new Map([["section-1:1", citations()]])))
      .toThrowError(ArtifactPublicationReadinessError);
    expect(() => assertArtifactPublicationReady(revision({ sections: [] }), new Map()))
      .toThrowError(ArtifactPublicationReadinessError);
  });
});
