import type { ArtifactRevision, WikiPageRevision } from "@eliotr/contracts";

export function expectedHeadMatches(currentRevision: number | null, expectedRevision: number | null): boolean {
  return currentRevision === expectedRevision;
}

export function artifactMayBeAccepted(artifact: ArtifactRevision): boolean {
  return artifact.sections.length > 0
    && artifact.sections.every((section: ArtifactRevision["sections"][number]) => section.verification_receipt_ref.length > 0)
    && artifact.status === "VERIFIED";
}

export function wikiMayBePublished(page: WikiPageRevision): boolean {
  if (page.status !== "DRAFT") return false;
  if (Object.keys(page.statement_labels).length === 0) return false;
  if (page.dependency_refs.some((dependency: WikiPageRevision["dependency_refs"][number]) => dependency.length === 0)) return false;
  return page.evidence_map_ref.length > 0;
}
