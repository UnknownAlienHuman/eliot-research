import type { ResolvedEvidence } from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";

/** Source identity retained across a fresh exact resolution of the same handle. */
export function sourceBoundEvidenceMaterial(evidence: ResolvedEvidence) {
  // Resolution receipt/time and display metadata may change during freeze's
  // exact re-resolution. The immutable handle, content, scope and authority
  // ceilings must still describe the committed branch-query evidence.
  return {
    handle: evidence.handle,
    exact_excerpt: evidence.exact_excerpt,
    credential_generation: evidence.credential_generation,
    source_revision_content_sha256: evidence.source_revision_content_sha256,
    scope_snapshot_digest: evidence.scope_snapshot_digest,
    instruction_taint: evidence.instruction_taint,
    allowed_effects: evidence.allowed_effects,
  };
}

export function sourceBoundEvidenceIdentity(evidence: ResolvedEvidence): string {
  return canonicalEvidenceJson(sourceBoundEvidenceMaterial(evidence));
}
