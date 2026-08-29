import type { EvidenceFreeze, VersionedRef } from "@eliotr/contracts";
import type { MaterialClaim } from "./claim-audit.js";

export type ArtifactKind =
  | "research_report" | "technical_audit" | "literature_review" | "architecture_report"
  | "hypothesis_dossier" | "comparison_report" | "wiki_generation";

export interface ArtifactSpec {
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly inquiry_protocol_ref: VersionedRef;
  readonly audience: string;
  readonly language: string;
  readonly section_contracts: readonly ArtifactSectionContract[];
  readonly citation_policy_ref: string;
  readonly verification_policy_ref: string;
  readonly include_counterevidence: boolean;
  readonly include_methodology: boolean;
  readonly length_policy_ref: string;
  readonly export_formats: readonly ("markdown" | "html" | "pdf" | "docx")[];
  readonly budget_ref: string;
}

export interface ArtifactSectionContract {
  readonly section_id: string;
  readonly title: string;
  readonly purpose: string;
  readonly required_claim_kinds: readonly MaterialClaim["kind"][];
  readonly required_evidence_classes: readonly string[];
  readonly maximum_utf8_bytes: number;
}

export interface ArtifactSectionRevision {
  readonly section_ref: VersionedRef;
  readonly contract_id: string;
  readonly body_object_ref: string;
  readonly body_sha256: string;
  readonly evidence_ledger_ref: string;
  readonly verification_receipt_ref: string;
  readonly reused_from_revision_ref?: VersionedRef;
}

export interface ArtifactRevision {
  readonly artifact_ref: VersionedRef;
  readonly spec_digest: string;
  readonly evidence_freeze_ref: VersionedRef;
  readonly sections: readonly ArtifactSectionRevision[];
  readonly dependency_manifest_ref: string;
  readonly deterministic_export_refs: Readonly<Record<string, string>>;
}

export interface ArtifactCompiler {
  compile(spec: ArtifactSpec, freeze: EvidenceFreeze): Promise<ArtifactRevision>;
  reviseSection(artifactRef: VersionedRef, sectionId: string, expectedArtifactRevision: number): Promise<ArtifactRevision>;
}
