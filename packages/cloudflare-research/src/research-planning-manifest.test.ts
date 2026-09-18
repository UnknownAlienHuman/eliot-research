import { describe, expect, it } from "vitest";
import { parseResearchPlanningManifest } from "@eliotr/contracts";
import { INSTALLED_INQUIRY_PROTOCOL_REFS, installedInquiryProtocolDefinition } from "./research-inquiry-protocol.js";
import { assertResearchPlanningManifestIdentity, createResearchPlanningManifest } from "./research-planning-manifest.js";

const BASE = {
  investigation_id: "investigation-planning-1",
  operation_id: "run-planning-1",
  question: "Which architecture should be selected?",
  scope_snapshot_ref: { id: "scope-planning-1", revision: 1 },
  scope_created_at: "2026-09-18T00:00:00.000Z",
} as const;

describe("research planning manifest", () => {
  it("builds a deterministic lookup manifest without hypotheses or paid branch roles", async () => {
    const ref = INSTALLED_INQUIRY_PROTOCOL_REFS.lookup;
    const first = await createResearchPlanningManifest({
      ...BASE,
      inquiry_protocol_ref: ref,
      definition: installedInquiryProtocolDefinition(ref),
      sources: [{
        source_revision_ref: "revision-1",
        source_id: "source-1",
        source_class: "document",
        source_namespace_id: "namespace-1",
        source_owner_generation: "owner-generation-1",
        origin_uri: "https://example.com/a#fragment",
      }],
    });
    const replay = await createResearchPlanningManifest({
      ...BASE,
      inquiry_protocol_ref: ref,
      definition: installedInquiryProtocolDefinition(ref),
      sources: [{
        source_revision_ref: "revision-1",
        source_id: "source-1",
        source_class: "document",
        source_namespace_id: "namespace-1",
        source_owner_generation: "owner-generation-1",
        origin_uri: "https://EXAMPLE.com:443/a",
      }],
    });
    expect(replay).toEqual(first);
    expect(first.questions).toHaveLength(1);
    expect(first.hypotheses).toEqual([]);
    expect(first.required_branch_roles).toEqual([]);
    await expect(assertResearchPlanningManifestIdentity(first)).resolves.toEqual(first);
  });

  it("retains required branches, rivals, missing source classes and shared origins", async () => {
    const ref = INSTALLED_INQUIRY_PROTOCOL_REFS.architecture_decision;
    const manifest = await createResearchPlanningManifest({
      ...BASE,
      inquiry_protocol_ref: ref,
      definition: installedInquiryProtocolDefinition(ref),
      sources: [
        {
          source_revision_ref: "revision-1",
          source_id: "source-1",
          source_class: "project-evidence",
          source_namespace_id: "namespace-1",
          source_owner_generation: "owner-generation-1",
          origin_uri: "https://example.com/project",
        },
        {
          source_revision_ref: "revision-2",
          source_id: "source-2",
          source_class: "project-evidence",
          source_namespace_id: "namespace-2",
          source_owner_generation: "owner-generation-2",
          origin_uri: "https://example.com/project#copy",
        },
      ],
    });
    expect(manifest.required_branch_roles).toEqual(["ALTERNATIVE", "COUNTER", "IMPLEMENTATION", "SOURCE_AUDIT", "SUPPORT"]);
    expect(manifest.questions.map((item) => item.kind)).toEqual(["primary", "alternative", "counter", "implementation", "source_audit", "support"]);
    expect(manifest.hypotheses).toHaveLength(2);
    expect(manifest.hypotheses[0]?.alternative_hypothesis_ids).toEqual([manifest.hypotheses[1]?.hypothesis_id]);
    expect(manifest.source_portfolio.missing_source_classes).toEqual(["normative-or-empirical-evidence"]);
    expect(new Set(manifest.source_portfolio.members.map((item) => item.source_family_ref)).size).toBe(1);
    expect(manifest.source_portfolio.members.every((item) => item.independence === "KNOWN_SHARED_ORIGIN")).toBe(true);
  });

  it("rejects substituted manifest identity and cyclic question dependencies", async () => {
    const ref = INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review;
    const manifest = await createResearchPlanningManifest({
      ...BASE,
      inquiry_protocol_ref: ref,
      definition: installedInquiryProtocolDefinition(ref),
      sources: [],
    });
    await expect(assertResearchPlanningManifestIdentity({ ...manifest, operation_id: "run-substituted" }))
      .rejects.toThrow("planning manifest identity digest is invalid");
    const [primary, branch] = manifest.questions;
    expect(primary).toBeDefined();
    expect(branch).toBeDefined();
    expect(() => parseResearchPlanningManifest({
      ...manifest,
      questions: [
        { ...primary, dependency_question_ids: [branch?.question_id] },
        { ...branch, dependency_question_ids: [primary?.question_id] },
      ],
    })).toThrow("question graph is cyclic");
  });
});
