import type { VersionedRef } from "@eliotr/contracts";

export type WikiPageType =
  | "Project" | "Topic" | "Source" | "Method" | "Hypothesis" | "Comparison" | "Audit"
  | "Contradiction" | "Timeline" | "Report" | "FailedPath" | "OpenQuestion" | "Glossary";
export type StatementLabel =
  | "SOURCE_SUPPORTED" | "DERIVED_INFERENCE" | "HYPOTHESIS" | "CONTESTED" | "UNRESOLVED"
  | "EDITORIAL_RECOMMENDATION" | "REDACTED_DEPENDENCY";

export interface WikiPageRevision {
  readonly page_ref: VersionedRef;
  readonly page_type: WikiPageType;
  readonly title: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly body_object_ref: string;
  readonly statement_labels: Readonly<Record<string, StatementLabel>>;
  readonly evidence_map_ref: string;
  readonly counterposition_refs: readonly string[];
  readonly coverage_receipt_ref: VersionedRef;
  readonly limitation_refs: readonly string[];
  readonly dependency_refs: readonly string[];
  readonly generator_generation: string;
  readonly reviewer_ref?: string;
  readonly status: "DRAFT" | "PUBLISHED" | "SUPERSEDED" | "PENDING_REVALIDATION" | "REDACTED_DEPENDENCY";
  readonly supersedes_ref?: VersionedRef;
}

export type DraftRiskClass = "D0_MECHANICAL" | "D1_LOW_RISK_ADDITIVE" | "D2_ANALYTICAL" | "D3_AUTHORITY_SENSITIVE";

export interface WikiPublisher {
  propose(page: WikiPageRevision, riskClass: DraftRiskClass): Promise<VersionedRef>;
  publish(proposalRef: VersionedRef, expectedHeadRevision: number, committerRef: string): Promise<WikiPageRevision>;
}
