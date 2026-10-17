import { describe, expect, it } from "vitest";
import {
  createResearchOwnerDocumentPreset,
  type ResearchOwnerDocumentPresetInput,
} from "./research-owner-document-preset.js";
import { createResearchOwnerSemanticConfiguration } from "./research-owner-semantic-config.js";

const requiredDimensions = [
  "value_or_measurement_verification",
  "specification_compliance",
  "method_artifact_alignment",
] as const;

function input(): ResearchOwnerDocumentPresetInput {
  const owner = "owner-1";
  const scope = { id: "scope-1", revision: 1 };
  const residency = {
    scope_domain_id: scope.id,
    access_domain_id: owner,
    confidentiality_domain_id: "private",
    encryption_key_domain_id: "key-1",
    retention_domain_id: "retention-1",
    erasure_domain_id: "erasure-1",
  };
  return {
    owner: { principal_ref: owner, scope_snapshot_ref: scope },
    synthesis: { max_tokens: 512, request_timeout_ms: 30_000 },
    audit: {
      max_tokens: 512,
      request_timeout_ms: 30_000,
      verifier_ref: "owner-document-verifier-v1",
      verifier_schema_generation: "owner-document-verifier-schema-v1",
      allowed_verifier_refs: ["owner-document-verifier-v1"],
      policy: {
        required_dimensions: [...requiredDimensions],
        source_requirement_applicable: false,
        excerpt_requirement_applicable: false,
        coverage_limitations: [],
        unsupported_precision: [],
      },
    },
    normalization: {
      section_ref: { id: "owner-document-section-v1", revision: 1 },
      required_precision: "exact-excerpt",
      required_source_class: "owner_document",
    },
    report: {
      citation_policy_ref: "citation-v1",
      verification_policy_ref: "verification-v1",
      length_policy_ref: "length-v1",
      budget_ref: "budget-v1",
      section_residency: residency,
      manifest_residency: residency,
    },
  };
}

describe("research owner document preset audit role", () => {
  it("keeps source and excerpt support mandatory while leaving method alignment to its own evaluator", () => {
    const config = createResearchOwnerDocumentPreset(input()).semantic;

    expect(config.audit.policy.required_dimensions).toEqual([
      "value_or_measurement_verification",
      "specification_compliance",
    ]);
    expect(config.audit.policy.source_requirement_applicable).toBe(true);
    expect(config.audit.policy.excerpt_requirement_applicable).toBe(true);
  });

  it("preserves the generic three-dimension audit contract outside the document preset", () => {
    const documentInput = input();
    const config = createResearchOwnerSemanticConfiguration({
      synthesis: documentInput.synthesis,
      audit: documentInput.audit,
      normalization: documentInput.normalization,
    });

    expect(config.audit.policy.required_dimensions).toEqual(requiredDimensions);
    expect(config.audit.policy.source_requirement_applicable).toBe(false);
    expect(config.audit.policy.excerpt_requirement_applicable).toBe(false);
  });
});
