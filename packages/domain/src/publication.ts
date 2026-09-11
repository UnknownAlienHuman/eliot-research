import type { ArtifactRevision, EvidenceLabel, WikiPageRevision } from "@eliotr/contracts";

export type DraftRiskClass =
  | "D0_MECHANICAL"
  | "D1_LOW_RISK_ADDITIVE"
  | "D2_ANALYTICAL"
  | "D3_AUTHORITY_SENSITIVE";

export type WikiPublicationIssue =
  | "STATUS_NOT_DRAFT"
  | "PAGE_REFERENCE_INVALID"
  | "REVISION_LINEAGE_INVALID"
  | "TITLE_INVALID"
  | "BODY_REFERENCE_INVALID"
  | "BODY_DIGEST_INVALID"
  | "STATEMENT_LABELS_EMPTY"
  | "STATEMENT_LABEL_INVALID"
  | "REDACTED_DEPENDENCY_PRESENT"
  | "EVIDENCE_MAP_INVALID"
  | "COVERAGE_REFERENCE_INVALID"
  | "COUNTERPOSITION_INVALID"
  | "CONTESTED_WITHOUT_COUNTERPOSITION"
  | "LIMITATION_INVALID"
  | "UNRESOLVED_WITHOUT_LIMITATION"
  | "DEPENDENCY_INVALID"
  | "DEPENDENCY_SELF_REFERENCE"
  | "GENERATOR_INVALID"
  | "PUBLICATION_METADATA_INVALID";

export interface WikiAutoPromotionAuthority {
  readonly explicit_project_policy: boolean;
  readonly policy_receipt_ref: string;
  readonly exact_evidence_complete: boolean;
  readonly evidence_receipt_ref: string;
  readonly dependency_closure_complete: boolean;
  readonly coverage_complete: boolean;
  readonly independent_verifier_receipt_ref: string;
  readonly conflict_count: number;
  readonly changes_current_state: boolean;
}

const EVIDENCE_LABELS: readonly EvidenceLabel[] = [
  "SOURCE_SUPPORTED",
  "DERIVED_INFERENCE",
  "HYPOTHESIS",
  "CONTESTED",
  "UNRESOLVED",
  "EDITORIAL_RECOMMENDATION",
  "REDACTED_DEPENDENCY",
];
const SHA256 = /^[a-f0-9]{64}$/u;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function validRef(value: unknown): value is { readonly id: string; readonly revision: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as { readonly id?: unknown; readonly revision?: unknown };
  return nonEmpty(ref.id) && Number.isSafeInteger(ref.revision) && (ref.revision as number) > 0;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasDuplicateOrInvalid(values: unknown): boolean {
  if (!Array.isArray(values)) return true;
  const seen = new Set<string>();
  for (const value of values) {
    if (!nonEmpty(value) || seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}

function statementLabels(page: WikiPageRevision): readonly EvidenceLabel[] | null {
  if (!isPlainRecord(page.statement_labels)) return null;
  const entries = Object.entries(page.statement_labels);
  if (entries.length === 0) return [];
  const labels: EvidenceLabel[] = [];
  for (const [claimRef, label] of entries) {
    if (!nonEmpty(claimRef) || typeof label !== "string" || !EVIDENCE_LABELS.includes(label as EvidenceLabel)) {
      return null;
    }
    labels.push(label as EvidenceLabel);
  }
  return labels;
}

export function expectedHeadMatches(currentRevision: number | null, expectedRevision: number | null): boolean {
  return currentRevision === expectedRevision;
}

export function artifactMayBeAccepted(artifact: ArtifactRevision): boolean {
  return artifact.sections.length > 0
    && artifact.sections.every((section: ArtifactRevision["sections"][number]) => section.verification_receipt_ref.length > 0)
    && artifact.status === "VERIFIED";
}

/** Deterministic semantic validation after strict wire-schema parsing. */
export function wikiPublicationIssues(page: WikiPageRevision): readonly WikiPublicationIssue[] {
  const issues: WikiPublicationIssue[] = [];
  if (page.status !== "DRAFT") issues.push("STATUS_NOT_DRAFT");
  if (!validRef(page.page_ref) || !validRef(page.scope_snapshot_ref)) issues.push("PAGE_REFERENCE_INVALID");
  if (!nonEmpty(page.title)) issues.push("TITLE_INVALID");
  if (!nonEmpty(page.body_object_ref)) issues.push("BODY_REFERENCE_INVALID");
  if (typeof page.body_sha256 !== "string" || !SHA256.test(page.body_sha256)) issues.push("BODY_DIGEST_INVALID");

  const labels = statementLabels(page);
  if (labels !== null && labels.length === 0) issues.push("STATEMENT_LABELS_EMPTY");
  if (labels === null) issues.push("STATEMENT_LABEL_INVALID");
  if (labels?.includes("REDACTED_DEPENDENCY") === true) issues.push("REDACTED_DEPENDENCY_PRESENT");

  if (!nonEmpty(page.evidence_map_ref)) issues.push("EVIDENCE_MAP_INVALID");
  if (!validRef(page.coverage_receipt_ref)) issues.push("COVERAGE_REFERENCE_INVALID");
  if (hasDuplicateOrInvalid(page.counterposition_refs)) issues.push("COUNTERPOSITION_INVALID");
  if (labels?.includes("CONTESTED") === true && page.counterposition_refs.length === 0) {
    issues.push("CONTESTED_WITHOUT_COUNTERPOSITION");
  }
  if (hasDuplicateOrInvalid(page.limitations)) issues.push("LIMITATION_INVALID");
  if (labels?.some((label) => label === "UNRESOLVED" || label === "CONTESTED") === true && page.limitations.length === 0) {
    issues.push("UNRESOLVED_WITHOUT_LIMITATION");
  }
  if (hasDuplicateOrInvalid(page.dependency_refs)) issues.push("DEPENDENCY_INVALID");
  if (validRef(page.page_ref)) {
    const selfRefs = new Set([page.page_ref.id, `${page.page_ref.id}:${page.page_ref.revision}`]);
    if (page.dependency_refs.some((dependency) => selfRefs.has(dependency))) issues.push("DEPENDENCY_SELF_REFERENCE");
  }
  if (!nonEmpty(page.generator_generation)) issues.push("GENERATOR_INVALID");
  if (!isPlainRecord(page.publication_metadata)) issues.push("PUBLICATION_METADATA_INVALID");

  if (validRef(page.page_ref)) {
    const supersedes = page.supersedes_ref;
    if (page.page_ref.revision === 1) {
      if (supersedes !== undefined) issues.push("REVISION_LINEAGE_INVALID");
    } else if (!validRef(supersedes)
      || supersedes.id !== page.page_ref.id
      || supersedes.revision !== page.page_ref.revision - 1) {
      issues.push("REVISION_LINEAGE_INVALID");
    }
  }
  return Object.freeze(issues);
}

export function wikiMayBePublished(page: WikiPageRevision): boolean {
  return wikiPublicationIssues(page).length === 0;
}

/**
 * Bind a candidate revision to the one head it may replace. Revision zero is represented by null.
 * This is a precondition only; the authoritative store still performs an atomic expected-head CAS.
 */
export function wikiTargetsExpectedHead(
  page: WikiPageRevision,
  currentRevision: number | null,
  expectedRevision: number | null,
): boolean {
  if (!expectedHeadMatches(currentRevision, expectedRevision) || !validRef(page.page_ref)) return false;
  if (expectedRevision === null) {
    return page.page_ref.revision === 1 && page.supersedes_ref === undefined;
  }
  return Number.isSafeInteger(expectedRevision)
    && expectedRevision > 0
    && page.page_ref.revision === expectedRevision + 1
    && validRef(page.supersedes_ref)
    && page.supersedes_ref.id === page.page_ref.id
    && page.supersedes_ref.revision === expectedRevision;
}

/** D2/D3 are unconditionally review-only. D0/D1 still require explicit, receipt-backed policy. */
export function wikiMayAutoPromote(
  page: WikiPageRevision,
  riskClass: DraftRiskClass,
  authority: WikiAutoPromotionAuthority,
): boolean {
  if (!wikiMayBePublished(page)) return false;
  if (riskClass === "D2_ANALYTICAL" || riskClass === "D3_AUTHORITY_SENSITIVE") return false;
  if (riskClass !== "D0_MECHANICAL" && riskClass !== "D1_LOW_RISK_ADDITIVE") return false;
  if (!authority.explicit_project_policy
    || !nonEmpty(authority.policy_receipt_ref)
    || !authority.exact_evidence_complete
    || !nonEmpty(authority.evidence_receipt_ref)
    || !authority.dependency_closure_complete
    || !authority.coverage_complete
    || !nonEmpty(authority.independent_verifier_receipt_ref)
    || !Number.isSafeInteger(authority.conflict_count)
    || authority.conflict_count !== 0
    || authority.changes_current_state) {
    return false;
  }
  const labels = statementLabels(page);
  if (labels === null || labels.length === 0) return false;
  if (riskClass === "D0_MECHANICAL") {
    return labels.every((label) => label === "SOURCE_SUPPORTED" || label === "EDITORIAL_RECOMMENDATION");
  }
  return (page.page_type === "Source" || page.page_type === "Glossary")
    && labels.every((label) => label === "SOURCE_SUPPORTED");
}
