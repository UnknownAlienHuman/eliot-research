import type { CompletionDisposition, CoverageReceipt, Investigation, VersionedRef } from "@eliotr/contracts";

export interface CoverageDenominator {
  readonly denominator_ref: VersionedRef;
  readonly frozen_scope_snapshot_ref: VersionedRef;
  readonly eligible_source_revision_refs: readonly string[];
  readonly required_source_classes: readonly string[];
  readonly required_question_branches: readonly string[];
  readonly acquisition_method_generations: Readonly<Record<string, string>>;
  readonly excluded_sources: readonly { source_ref: string; reason: string }[];
  readonly completeness_test_ref: string;
  readonly expires_at: string;
}

export interface CoverageCalculatorInput {
  readonly investigation: Investigation;
  readonly denominator: CoverageDenominator;
  readonly represented_source_refs: readonly string[];
  readonly cited_source_refs: readonly string[];
  readonly omitted_sources: readonly { source_ref: string; reason: string }[];
  readonly denominator_kind: CoverageReceipt["denominator_kind"];
  readonly proposed_disposition: CompletionDisposition;
}

export interface CoverageCalculator {
  calculate(input: CoverageCalculatorInput): Promise<CoverageReceipt>;
}
