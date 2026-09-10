import type { VersionedRef, WikiPageRevision } from "@eliotr/contracts";

export type { EvidenceLabel as StatementLabel, WikiPageRevision, WikiPageType } from "@eliotr/contracts";

export type DraftRiskClass = "D0_MECHANICAL" | "D1_LOW_RISK_ADDITIVE" | "D2_ANALYTICAL" | "D3_AUTHORITY_SENSITIVE";

export interface WikiPublisher {
  propose(page: WikiPageRevision, riskClass: DraftRiskClass): Promise<VersionedRef>;
  publish(proposalRef: VersionedRef, expectedHeadRevision: number, committerRef: string): Promise<WikiPageRevision>;
}
