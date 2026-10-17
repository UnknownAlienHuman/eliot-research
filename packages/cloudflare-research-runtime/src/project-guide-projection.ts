import type { CoverageReceipt, VersionedRef } from "@eliotr/contracts";
import { ProjectGuideDocumentSchema, type ProjectGuideDocument, type ProjectGuideClaim } from "@eliotr/contracts/project-guide";
import { evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import type { ResearchArtifactSectionCitationAuditClaim } from "@eliotr/interfaces";

export class ProjectGuideProjectionError extends Error {
  readonly code = "PROJECT_GUIDE_OUTPUT_INVALID";
}
export interface ProjectGuideVerifiedSection {
  readonly section_ref: VersionedRef; readonly body: Uint8Array; readonly body_sha256: string;
  readonly statement_labels: Readonly<Record<string, string>>;
  readonly semantic_verification: "EXECUTED" | "NOT_EXECUTED";
  readonly claims: readonly ResearchArtifactSectionCitationAuditClaim[];
  readonly citations: readonly { original_handle_ref: VersionedRef; handle_ref: VersionedRef }[];
}
const key = (ref: VersionedRef) => `${ref.id}:${ref.revision}`;
function invalid(): never { throw new ProjectGuideProjectionError("The saved report is not a verified combined project guide"); }
function corrupt(): never { throw new CatalogInputError("PROJECT_GUIDE_REPORT_CORRUPT", "Saved guide report integrity is invalid", 503); }

/** Exact audited report text only. No new claim classification or model call. */
export async function projectGuideFromReport(sections: readonly ProjectGuideVerifiedSection[], coverage: CoverageReceipt,
  sourceTitles: Readonly<Record<string, string>>): Promise<ProjectGuideDocument> {
  const summary: ProjectGuideClaim[] = [], questions: ProjectGuideClaim[] = [];
  const seen = new Set<string>(), seenQuestions = new Set<string>();
  for (const section of sections) {
    if (await evidenceSha256Bytes(section.body) !== section.body_sha256) corrupt();
    if (section.semantic_verification !== "EXECUTED") invalid();
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(section.body); } catch { corrupt(); }
    const handles = new Map(section.citations.map(citation => [key(citation.original_handle_ref), citation.handle_ref]));
    const claims = section.claims.map(claim => ({ claim, offset: text.indexOf(claim.claim_text) })).sort((a, b) => a.offset - b.offset);
    let end = 0;
    for (const { claim, offset } of claims) {
      const label = section.statement_labels[claim.claim_ref.id];
      if (seen.has(key(claim.claim_ref)) || offset < end || offset < 0 ||
          text.indexOf(claim.claim_text, offset + 1) !== -1 ||
          await evidenceSha256Bytes(new TextEncoder().encode(claim.claim_text)) !== claim.claim_text_digest) corrupt();
      if (claim.disposition !== "SUPPORTED" || claim.support_handle_refs.length === 0 ||
          !["SOURCE_SUPPORTED", "DERIVED_INFERENCE", "EDITORIAL_RECOMMENDATION"].includes(label ?? "")) invalid();
      seen.add(key(claim.claim_ref)); end = offset + claim.claim_text.length;
      const fresh = (ref: VersionedRef) => handles.get(key(ref)) ?? corrupt();
      const projected: ProjectGuideClaim = {
        claim_ref: claim.claim_ref, section_ref: section.section_ref, text: claim.claim_text,
        label: label as ProjectGuideClaim["label"],
        support_handle_refs: claim.support_handle_refs.map(fresh),
        counterevidence_handle_refs: claim.counterevidence_handle_refs.map(fresh),
      };
      if (label === "EDITORIAL_RECOMMENDATION") {
        if (!claim.claim_text.trimEnd().endsWith("?") || seenQuestions.has(claim.claim_text)) invalid();
        seenQuestions.add(claim.claim_text); questions.push(projected);
      } else summary.push(projected);
    }
  }
  const source_basis = coverage.represented_source_refs.map(ref => ({ source_revision_ref: ref, title: sourceTitles[ref] ?? corrupt() }));
  const result = ProjectGuideDocumentSchema.safeParse({ summary, questions, coverage, source_basis });
  return result.success ? result.data : invalid();
}
