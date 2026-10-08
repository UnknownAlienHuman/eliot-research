import type { EvidenceLabel } from "@eliotr/contracts";
import type { ArtifactDraftSemanticAudit } from "@eliotr/cloudflare-artifacts";
import type { NormalizedSynthesisClaims } from "@eliotr/research";

/** Project performed audit dispositions; this does not classify or verify claims. */
export function artifactStatementLabels(claims: readonly {
  readonly claim_id: string;
  readonly claim_kind: NormalizedSynthesisClaims["claims"][number]["kind"];
  readonly disposition: ArtifactDraftSemanticAudit["claims"][number]["disposition"];
}[]): Record<string, EvidenceLabel> {
  return Object.fromEntries(claims.map((item) => {
    const label: EvidenceLabel = item.disposition === "SUPPORTED"
      ? item.claim_kind === "recommendation" ? "EDITORIAL_RECOMMENDATION"
        : item.claim_kind === "interpretation" ? "DERIVED_INFERENCE"
          : item.claim_kind === "assumption" ? "HYPOTHESIS" : "SOURCE_SUPPORTED"
      : item.disposition === "PARTIALLY_SUPPORTED" || item.disposition === "CONTRADICTED" ? "CONTESTED"
        : item.disposition === "UNSUPPORTED" ? "HYPOTHESIS" : "UNRESOLVED";
    return [item.claim_id, label];
  }));
}
