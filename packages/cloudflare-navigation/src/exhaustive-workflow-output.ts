import type { AuthenticatedRequestContext, ExhaustiveQueryResult } from "@eliotr/interfaces";
import {
  canonicalRetrievalJson,
  readExhaustiveJobCoverage,
} from "@eliotr/retrieval";

interface CanonicalJob {
  readonly job_id: string;
  readonly [key: string]: unknown;
}

interface ExhaustiveJobCoverage {
  readonly job: CanonicalJob | null;
  readonly denominator_shard_ids: readonly string[];
  readonly settled_shard_ids: readonly string[];
}

export interface ExhaustiveWorkflowOutputBinding {
  readonly job_id: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Decode only the published Q8 result shapes; no unknown fields are retained. */
export function decodeExhaustiveWorkflowOutput(output: unknown): ExhaustiveQueryResult | null {
  if (!isRecord(output) || !exactKeys(output, ["protocol", "job"]) || output.protocol !== "eliotr.exhaustive-query.v1" || !isRecord(output.job)) {
    return null;
  }
  const job = output.job;
  if (job.status === "COMPLETE") {
    const receipt = job.receipt;
    if (!exactKeys(job, ["status", "receipt"]) || !isRecord(receipt) || !exactKeys(receipt, [
      "job_id", "idempotency_key", "request_digest", "scope_snapshot_id", "scope_snapshot_revision",
      "coverage_claim", "coverage_denominator_ref", "denominator_shards", "settled_shards",
      "total_scanned_sections", "total_matches", "result_artifact_ref", "coverage_receipt_ref",
    ]) || receipt.coverage_claim !== "COMPLETE" || typeof receipt.job_id !== "string" ||
      !/^exhaustive-job-[a-f0-9]{48}$/u.test(receipt.job_id) || !boundedText(receipt.idempotency_key) ||
      typeof receipt.request_digest !== "string" || !/^[a-f0-9]{64}$/u.test(receipt.request_digest) ||
      !boundedText(receipt.scope_snapshot_id) || !nonNegativeSafeInteger(receipt.scope_snapshot_revision) ||
      !boundedText(receipt.coverage_denominator_ref) || !Number.isSafeInteger(receipt.denominator_shards) ||
      (receipt.denominator_shards as number) < 1 || !Number.isSafeInteger(receipt.settled_shards) ||
      receipt.settled_shards !== receipt.denominator_shards || !nonNegativeSafeInteger(receipt.total_scanned_sections) ||
      !nonNegativeSafeInteger(receipt.total_matches) || !boundedText(receipt.result_artifact_ref) ||
      !boundedText(receipt.coverage_receipt_ref)) return null;
  } else if (job.status === "UNFINISHED") {
    if (!exactKeys(job, ["status", "job_id", "coverage_denominator_ref", "denominator_shards", "settled_shards", "unsettled_shard_ids"]) ||
      typeof job.job_id !== "string" || !/^exhaustive-job-[a-f0-9]{48}$/u.test(job.job_id) ||
      !boundedText(job.coverage_denominator_ref) || !Number.isSafeInteger(job.denominator_shards) ||
      (job.denominator_shards as number) < 1 || !Number.isSafeInteger(job.settled_shards) ||
      (job.settled_shards as number) < 0 || (job.settled_shards as number) > (job.denominator_shards as number) ||
      !Array.isArray(job.unsettled_shard_ids) || new Set(job.unsettled_shard_ids).size !== job.unsettled_shard_ids.length ||
      job.unsettled_shard_ids.some((id) => !boundedText(id)) ||
      job.unsettled_shard_ids.length !== (job.denominator_shards as number) - (job.settled_shards as number)) return null;
  } else return null;
  return output as unknown as ExhaustiveQueryResult;
}

async function readCanonicalCoverage(
  database: D1Database,
  binding: ExhaustiveWorkflowOutputBinding,
  context: AuthenticatedRequestContext,
): Promise<ExhaustiveJobCoverage | null> {
  const row = await database.prepare(
    "SELECT idempotency_key,principal_ref,client_class,credential_generation,state " +
    "FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
  ).bind(binding.job_id).first<{
    readonly idempotency_key: unknown;
    readonly principal_ref: unknown;
    readonly client_class: unknown;
    readonly credential_generation: unknown;
    readonly state: unknown;
  }>();
  if (row === null || row.state === "INVALIDATED" || typeof row.idempotency_key !== "string" ||
      row.principal_ref !== binding.principal_ref || row.client_class !== "owner_pwa" ||
      row.credential_generation !== binding.credential_generation || row.principal_ref !== context.principal_ref ||
      row.credential_generation !== context.credential_generation) return null;
  try {
    return await readExhaustiveJobCoverage(database, {
      principal_ref: context.principal_ref,
      client_class: "owner_pwa",
      credential_generation: context.credential_generation,
    }, row.idempotency_key) as ExhaustiveJobCoverage | null;
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === "RETRIEVAL_SCOPE_STALE" || code === "RETRIEVAL_AUTHORITY_STALE") return null;
    throw error;
  }
}

function matchesCanonical(result: ExhaustiveQueryResult, coverage: ExhaustiveJobCoverage | null): boolean {
  const canonical = coverage?.job;
  if (canonical === null || canonical === undefined) return false;
  if (result.job.status === "COMPLETE") {
    return result.job.receipt.job_id === canonical.job_id && "coverage_claim" in canonical && canonical.coverage_claim === "COMPLETE" &&
      canonicalRetrievalJson(result.job.receipt) === canonicalRetrievalJson(canonical);
  }
  if ("coverage_claim" in canonical) return false;
  if (coverage === null) return false;
  if (result.job.job_id !== canonical.job_id) return false;
  const expectedUnsettled = coverage.denominator_shard_ids.filter((id) => !coverage.settled_shard_ids.includes(id));
  return result.job.coverage_denominator_ref === canonical.coverage_denominator_ref &&
    result.job.denominator_shards === coverage.denominator_shard_ids.length &&
    result.job.settled_shards === coverage.settled_shard_ids.length &&
    canonicalRetrievalJson(result.job.unsettled_shard_ids) === canonicalRetrievalJson(expectedUnsettled);
}

/**
 * Workflow output is eligible for exposure only after strict decoding and a
 * persisted Q7 identity/denominator readback. Callers re-run this after their
 * currentness fence to close the mutation-during-callback window.
 */
export async function validateExhaustiveWorkflowOutput(
  database: D1Database,
  binding: ExhaustiveWorkflowOutputBinding,
  context: AuthenticatedRequestContext,
  output: unknown,
): Promise<ExhaustiveQueryResult | null> {
  const result = decodeExhaustiveWorkflowOutput(output);
  if (result === null) return null;
  const coverage = await readCanonicalCoverage(database, binding, context);
  return matchesCanonical(result, coverage) ? result : null;
}
