import type { EvidenceHandle, VersionedRef } from "@eliotr/contracts";

export type EvidenceAtomType =
  | "finding" | "decision" | "requirement" | "constraint" | "hypothesis" | "failed_approach"
  | "correction" | "benchmark" | "procedure" | "definition" | "causal_link" | "open_question";

export interface EvidenceAtomCandidate {
  readonly atom_ref: VersionedRef;
  readonly source_revision_ref: string;
  readonly atom_type: EvidenceAtomType;
  readonly subject_hint: string;
  readonly predicate: string;
  readonly object_value: string;
  readonly polarity: "positive" | "negative" | "mixed";
  readonly modality: string;
  readonly conditions: readonly string[];
  readonly population_or_scope?: string;
  readonly verbatim: string;
  readonly evidence_handle: EvidenceHandle;
  readonly extractor_generation: string;
}

export interface AtomValidationReceipt {
  readonly exact_span_resolved: boolean;
  readonly span_hash_matches: boolean;
  readonly numbers_present_in_support: boolean;
  readonly modality_preserved: boolean;
  readonly source_in_frozen_scope: boolean;
  readonly admitted: boolean;
  readonly reason_codes: readonly string[];
}

export interface EvidenceAtomCompiler {
  compile(candidate: EvidenceAtomCandidate): Promise<AtomValidationReceipt>;
}
