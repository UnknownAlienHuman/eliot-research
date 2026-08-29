import type { ScopeSnapshot } from "@eliotr/contracts";

export interface ExactScanShard {
  readonly shard_id: string;
  readonly source_revision_refs: readonly string[];
  readonly section_object_refs: readonly string[];
  readonly target_uncompressed_bytes: number;
  readonly hard_uncompressed_bytes: number;
  readonly max_sections: number;
}

export interface ExactScanPlan {
  readonly plan_id: string;
  readonly scope_snapshot: ScopeSnapshot;
  readonly probes: readonly string[];
  readonly shards: readonly ExactScanShard[];
  readonly coverage_denominator_ref: string;
  readonly output_manifest_ref: string;
}

export interface ExhaustiveScanPlanner {
  plan(scope: ScopeSnapshot, probes: readonly string[]): Promise<ExactScanPlan>;
}

export interface ExhaustiveScanExecutor {
  executeShard(shard: ExactScanShard, probes: readonly string[]): Promise<{ partial_result_ref: string; scanned_sections: number; matches: number }>;
  merge(plan: ExactScanPlan, partialResultRefs: readonly string[]): Promise<{ result_artifact_ref: string; coverage_receipt_ref: string }>;
}

export const EXACT_SCAN_LIMITS = {
  target_uncompressed_bytes: 2 * 1024 * 1024,
  hard_uncompressed_bytes: 8 * 1024 * 1024,
  max_sections: 128,
} as const;
