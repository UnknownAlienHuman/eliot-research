import { describe, expect, it } from "vitest";
import type { ResearchArtifactReportPolicy } from "./research-artifact-metadata.js";
import type { ResearchReportAdmissionPolicy } from "./research-report-admission.js";
import {
  createResearchReportConfigSource,
  ResearchReportConfigError,
  RESEARCH_REPORT_CONFIG_SCHEMA,
} from "./research-report-config.js";

const provenance = "server-report-policy-v1";
const expiry = "2030-01-01T00:00:00.000Z";
const residency = {
  scope_domain_id: "scope-1", access_domain_id: "owner-1", confidentiality_domain_id: "private",
  encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
} as const;

const admission: ResearchReportAdmissionPolicy = {
  schema: "eliotr.research.report-admission.v1", policy_ref: "report-policy-v1", policy_revision: 1,
  config_provenance_ref: provenance, principal_ref: "owner-1", client_class: "owner_pwa",
  policy_generation: "policy-generation-1", policy_authority_ref: "policy-authority-1", allowed_use: ["research"],
  disclosure_ceiling: "owner-only", requested_output_class: "private-draft", purpose: "research-report-materialization",
  expires_at: expiry,
};

const artifact: ResearchArtifactReportPolicy = {
  kind: "technical_audit", title: "Private report", audience: "owner", language: "en",
  section_contract: { section_id: "summary", title: "Summary", purpose: "Summary", required_claim_kinds: ["claim"], required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 },
  statement_labels: { claim: "UNRESOLVED" }, citation_policy_ref: "citation-v1", verification_policy_ref: "verification-v1",
  length_policy_ref: "length-v1", export_formats: ["markdown"], include_counterevidence: true, include_methodology: true,
  budget_ref: "report-budget-configured", section_residency: residency, manifest_residency: residency,
};

function rawConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: RESEARCH_REPORT_CONFIG_SCHEMA, admission_policy: admission, artifact_policy: artifact, ...overrides });
}

describe("server-owned REPORT configuration source", () => {
  it("returns independent parsed snapshots for both policies", async () => {
    const source = createResearchReportConfigSource({ raw: rawConfig(), provenance_ref: provenance });
    const first = await source.read();
    const artifactPolicy = await source.readArtifactPolicy();
    expect(first).toEqual(admission);
    expect(artifactPolicy).toEqual(artifact);
    if (first === null || artifactPolicy === null) throw new Error("valid REPORT configuration was not read");
    (first as unknown as { policy_ref: string }).policy_ref = "mutated";
    (artifactPolicy as unknown as { title: string }).title = "mutated";
    expect(await source.read()).toEqual(admission);
    expect(await source.readArtifactPolicy()).toEqual(artifact);
  });

  it("distinguishes an uninstalled source from an invalid installed document", async () => {
    const missing = createResearchReportConfigSource({ raw: undefined, provenance_ref: provenance });
    await expect(missing.read()).resolves.toBeNull();
    await expect(missing.readArtifactPolicy()).resolves.toBeNull();

    expect(() => createResearchReportConfigSource({ raw: "{", provenance_ref: provenance }))
      .toThrowError(ResearchReportConfigError);
    try { createResearchReportConfigSource({ raw: "{", provenance_ref: provenance }); }
    catch (error) { expect(error).toMatchObject({ code: "REPORT_CONFIG_INVALID" }); }
  });

  it("rejects unknown fields and provenance substitution before any policy is read", () => {
    expect(() => createResearchReportConfigSource({ raw: rawConfig({ unexpected: true }), provenance_ref: provenance }))
      .toThrowError(ResearchReportConfigError);
    expect(() => createResearchReportConfigSource({ raw: rawConfig(), provenance_ref: "other-provenance" }))
      .toThrowError(/provenance/iu);
    expect(() => createResearchReportConfigSource({ raw: 42 as unknown as string, provenance_ref: provenance }))
      .toThrowError(ResearchReportConfigError);
  });
});
