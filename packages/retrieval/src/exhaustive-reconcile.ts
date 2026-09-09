// IMPLEMENTED_NOT_LIVE: ER-07 ordered exhaustive reconcile loop over migration 0023 with earned COMPLETE persistence; Worker/HTTP composition and live qualification remain separate.
import type { ScopeSnapshot } from "@eliotr/contracts";
import { mergeExhaustiveShards, type ExactScanPlan, type ExactScanShard, type ExhaustiveSectionDescriptor, type ExhaustiveShardOutcome } from "./exhaustive.js";
import { canonicalRetrievalJson } from "./query-persistence.js";
import type { ExhaustiveJobReceipt, ExhaustiveJobStore } from "./exhaustive-job-store.js";

export { createD1ExhaustiveJobStore, exhaustiveJobId, readExhaustiveJobCoverage } from "./exhaustive-job-store.js";
export type { ExhaustiveJobStore, ExhaustiveJobInput, ExhaustiveJobReceipt, ExhaustiveJobPending, ExhaustiveJobLoad, ExhaustiveJobCoverage } from "./exhaustive-job-store.js";

export type ExhaustiveReconcileStatus =
  | { readonly status: "COMPLETE"; readonly receipt: ExhaustiveJobReceipt }
  | {
    readonly status: "UNFINISHED";
    readonly job_id: string;
    readonly coverage_denominator_ref: string;
    readonly denominator_shards: number;
    readonly settled_shards: number;
    readonly unsettled_shard_ids: readonly string[];
  };

export interface ExhaustiveReconcilePorts {
  requireCurrentScope(scope: ScopeSnapshot): Promise<void>;
  checkBudget(): void;
  executeShard(shard: ExactScanShard, plan: ExactScanPlan): Promise<ExhaustiveShardOutcome>;
}

function unfinished(
  jobId: string,
  plan: ExactScanPlan,
  settled: readonly ExhaustiveShardOutcome[],
): Extract<ExhaustiveReconcileStatus, { status: "UNFINISHED" }> {
  const settledIds = new Set(settled.map((outcome) => outcome.shard_id));
  return {
    status: "UNFINISHED",
    job_id: jobId,
    coverage_denominator_ref: plan.coverage_denominator_ref,
    denominator_shards: plan.shards.length,
    settled_shards: settled.length,
    unsettled_shard_ids: plan.shards.map((shard) => shard.shard_id).filter((id) => !settledIds.has(id)),
  };
}

/**
 * Ordered reconcile: start (or resume) the PENDING job, settle every
 * denominator shard in plan order through the injected executor, run the Q5
 * merge exactly once over the planned denominator, and persist COMPLETE with
 * its denominator only when the merge earns it. Anything else — an unsettled
 * shard, a missing outcome, a merge below COMPLETE — returns UNFINISHED and
 * persists no final claim, so a weaker result can never later read as final.
 * A COMPLETE replay returns the stored receipt without executing any shard.
 */
export async function reconcileExhaustiveJob(input: {
  store: ExhaustiveJobStore;
  ports: ExhaustiveReconcilePorts;
  idempotency_key: string;
  request_digest: string;
  scope: ScopeSnapshot;
  plan: ExactScanPlan;
}): Promise<ExhaustiveReconcileStatus> {
  const started = await input.store.start({
    idempotency_key: input.idempotency_key,
    request_digest: input.request_digest,
    scope: input.scope,
    plan: input.plan,
  });
  if (started.state === "COMPLETE" && started.receipt !== null) {
    return { status: "COMPLETE", receipt: started.receipt };
  }
  await input.ports.requireCurrentScope(input.scope);
  input.ports.checkBudget();
  const journaled = await input.store.settledOutcomes(started.job_id);
  const journaledIds = new Set(journaled.map((outcome) => outcome.shard_id));
  for (const shard of input.plan.shards) {
    if (journaledIds.has(shard.shard_id)) continue;
    input.ports.checkBudget();
    await input.ports.requireCurrentScope(input.scope);
    const outcome = await input.ports.executeShard(shard, input.plan);
    if (outcome.disposition !== "SETTLED") {
      return unfinished(started.job_id, input.plan, await input.store.settledOutcomes(started.job_id));
    }
    await input.store.recordSettledOutcome(started.job_id, outcome);
  }
  const outcomes = await input.store.settledOutcomes(started.job_id);
  const merged = mergeExhaustiveShards({ plan: input.plan, outcomes });
  if (merged.coverage_claim !== "COMPLETE") {
    return unfinished(started.job_id, input.plan, outcomes);
  }
  const receipt = await input.store.finalize({ job_id: started.job_id, plan: input.plan, outcomes });
  return { status: "COMPLETE", receipt };
}

export async function exhaustiveRequestDigest(input: {
  readonly plan_id: string;
  readonly scope_digest: string;
  readonly probes: readonly string[];
  /** Bind the caller's canonical scope expression to the idempotency identity. */
  readonly scope_expression?: unknown;
  /** Bind every authority tuple, not only the non-cryptographic plan label. */
  readonly inventory?: readonly ExhaustiveSectionDescriptor[];
}): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRetrievalJson({
    plan_id: input.plan_id,
    scope_digest: input.scope_digest,
    probes: [...input.probes],
    ...(input.scope_expression === undefined ? {} : { scope_expression: input.scope_expression }),
    ...(input.inventory === undefined ? {} : {
      inventory: input.inventory.map((section) => ({
        section_ref: section.section_ref,
        source_revision_ref: section.source_revision_ref,
        item_key: section.item_key,
        content_sha256: section.content_sha256,
        projection_generation: section.projection_generation,
        normalized_start_byte: section.normalized_start_byte,
        normalized_end_byte: section.normalized_end_byte,
        uncompressed_bytes: section.uncompressed_bytes,
      })),
    }),
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
