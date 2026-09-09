import type { ScopeSnapshot } from "@eliotr/contracts";
import { mergeExhaustiveShards, type ExactScanPlan, type ExhaustiveShardOutcome } from "./exhaustive.js";
import { canonicalRetrievalJson, type RetrievalQueryAccess, type RetrievalQueryD1 } from "./query-persistence.js";
import { RetrievalQueryError, type RetrievalQueryErrorCode } from "./service.js";

function failJob(code: RetrievalQueryErrorCode, message: string, retryable = false): never {
  throw new RetrievalQueryError(code, message, retryable);
}

function mapJobStoreError(error: unknown): never {
  if (error instanceof RetrievalQueryError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("RETRIEVAL_AUTHORITY_STALE")) {
    failJob("RETRIEVAL_AUTHORITY_STALE", "scope authorization is denied, purged or expired");
  }
  if (message.includes("RETRIEVAL_CONFLICT") || message.includes("RETRIEVAL_IDEMPOTENCY_CONFLICT")) {
    failJob("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
  }
  failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkJobAccess(access: RetrievalQueryAccess): void {
  if (
    typeof access.principal_ref !== "string" || access.principal_ref.length === 0 ||
    (access.client_class !== "owner_pwa" && access.client_class !== "named_api_client" &&
      access.client_class !== "trusted_agent" && access.client_class !== "federation_client") ||
    typeof access.credential_generation !== "string" || access.credential_generation.length === 0
  ) {
    failJob("RETRIEVAL_INPUT_INVALID", "job access identity is invalid");
  }
}

function checkIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    failJob("RETRIEVAL_INPUT_INVALID", "idempotency-key is required");
  }
  return value;
}

function checkRequestDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    failJob("RETRIEVAL_INPUT_INVALID", "exhaustive job identity is invalid");
  }
  return value;
}

export interface ExhaustiveJobReceipt {
  readonly job_id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly coverage_claim: "COMPLETE";
  readonly coverage_denominator_ref: string;
  readonly denominator_shards: number;
  readonly settled_shards: number;
  readonly total_scanned_sections: number;
  readonly total_matches: number;
  readonly result_artifact_ref: string;
  readonly coverage_receipt_ref: string;
}

/** Persisted identity for a job whose denominator is still being settled. */
export interface ExhaustiveJobPending {
  readonly job_id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_digest: string;
  readonly plan_id: string;
  readonly coverage_denominator_ref: string;
  readonly denominator_shards: number;
  readonly settled_shards: number;
}

export type ExhaustiveJobLoad = ExhaustiveJobReceipt | ExhaustiveJobPending | null;

export interface ExhaustiveJobCoverage {
  readonly job: ExhaustiveJobLoad;
  readonly denominator_shard_ids: readonly string[];
  readonly settled_shard_ids: readonly string[];
}

/**
 * The plan scope must be the frozen scope, byte for byte on the binding
 * fields: a denominator earned over another scope never attaches here. Plan
 * shape is checked explicitly so a malformed denominator fails closed before
 * any D1 write; coverage itself is never recomputed here (see `finalize`).
 */
function requireDenominatorForScope(scope: ScopeSnapshot, plan: ExactScanPlan): readonly string[] {
  if (
    plan === null || typeof plan !== "object" ||
    typeof plan.plan_id !== "string" || plan.plan_id.length === 0 || plan.plan_id.length > 256 ||
    /[\u0000-\u0020\u007f]/u.test(plan.plan_id) ||
    typeof plan.coverage_denominator_ref !== "string" || plan.coverage_denominator_ref.length === 0 ||
    plan.coverage_denominator_ref.length > 256 ||
    !Array.isArray(plan.shards) || plan.shards.length === 0
  ) {
    failJob("RETRIEVAL_INPUT_INVALID", "exhaustive denominator does not match the frozen scope");
  }
  if (
    plan.scope_snapshot.snapshot_id !== scope.snapshot_id ||
    plan.scope_snapshot.revision !== scope.revision ||
    plan.scope_snapshot.digest !== scope.digest
  ) {
    failJob("RETRIEVAL_INPUT_INVALID", "exhaustive denominator does not match the frozen scope");
  }
  const ids = plan.shards.map((shard) => shard.shard_id);
  if (new Set(ids).size !== ids.length) {
    failJob("RETRIEVAL_INPUT_INVALID", "exhaustive denominator does not match the frozen scope");
  }
  return ids;
}

export async function exhaustiveJobId(access: RetrievalQueryAccess, idempotencyKey: string): Promise<string> {
  return `exhaustive-job-${(await sha256Hex(
    canonicalRetrievalJson({
      principal: access.principal_ref,
      client: access.client_class,
      credential: access.credential_generation,
      key: idempotencyKey,
    }),
  )).slice(0, 48)}`;
}

interface ExhaustiveJobRow {
  readonly job_id: unknown;
  readonly idempotency_key: unknown;
  readonly request_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly scope_digest: unknown;
  readonly plan_id: unknown;
  readonly coverage_denominator_ref: unknown;
  readonly denominator_shard_ids_json: unknown;
  readonly state: unknown;
  readonly denominator_shards: unknown;
  readonly settled_shards: unknown;
  readonly total_scanned_sections: unknown;
  readonly total_matches: unknown;
  readonly result_artifact_ref: unknown;
  readonly coverage_receipt_ref: unknown;
}

function decodeJobReceipt(row: ExhaustiveJobRow, idempotencyKey: string): ExhaustiveJobReceipt {
  if (row.state === "INVALIDATED") {
    failJob("RETRIEVAL_SCOPE_STALE", "stored exhaustive scope is invalidated");
  }
  if (typeof row.job_id !== "string" || typeof idempotencyKey !== "string") {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  if (
    row.state !== "COMPLETE" || typeof row.request_digest !== "string" ||
    typeof row.scope_snapshot_id !== "string" || typeof row.scope_snapshot_revision !== "number" ||
    typeof row.coverage_denominator_ref !== "string" ||
    typeof row.denominator_shards !== "number" || typeof row.settled_shards !== "number" ||
    typeof row.total_scanned_sections !== "number" || typeof row.total_matches !== "number" ||
    typeof row.result_artifact_ref !== "string" || typeof row.coverage_receipt_ref !== "string"
  ) {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  if (row.settled_shards !== row.denominator_shards) {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  return {
    job_id: row.job_id,
    idempotency_key: idempotencyKey,
    request_digest: row.request_digest,
    scope_snapshot_id: row.scope_snapshot_id,
    scope_snapshot_revision: row.scope_snapshot_revision,
    coverage_claim: "COMPLETE",
    coverage_denominator_ref: row.coverage_denominator_ref,
    denominator_shards: row.denominator_shards,
    settled_shards: row.settled_shards,
    total_scanned_sections: row.total_scanned_sections,
    total_matches: row.total_matches,
    result_artifact_ref: row.result_artifact_ref,
    coverage_receipt_ref: row.coverage_receipt_ref,
  };
}

function decodePendingJob(row: ExhaustiveJobRow, idempotencyKey: string): ExhaustiveJobPending {
  if (row.state === "INVALIDATED") {
    failJob("RETRIEVAL_SCOPE_STALE", "stored exhaustive scope is invalidated");
  }
  if (
    row.state !== "PENDING" || typeof row.job_id !== "string" || typeof idempotencyKey !== "string" ||
    typeof row.request_digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.request_digest) ||
    typeof row.scope_snapshot_id !== "string" || typeof row.scope_snapshot_revision !== "number" ||
    !Number.isSafeInteger(row.scope_snapshot_revision) || typeof row.scope_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.scope_digest) || typeof row.plan_id !== "string" ||
    typeof row.coverage_denominator_ref !== "string" || typeof row.denominator_shards !== "number" ||
    !Number.isSafeInteger(row.denominator_shards) || row.denominator_shards < 1 ||
    (row.settled_shards !== null &&
      (typeof row.settled_shards !== "number" || !Number.isSafeInteger(row.settled_shards) ||
        row.settled_shards < 0 || row.settled_shards > row.denominator_shards))
  ) {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive pending job is unavailable", true);
  }
  return {
    job_id: row.job_id,
    idempotency_key: idempotencyKey,
    request_digest: row.request_digest,
    scope_snapshot_id: row.scope_snapshot_id,
    scope_snapshot_revision: row.scope_snapshot_revision,
    scope_digest: row.scope_digest,
    plan_id: row.plan_id,
    coverage_denominator_ref: row.coverage_denominator_ref,
    denominator_shards: row.denominator_shards,
    // Migration 0023 deliberately keeps this column NULL while PENDING;
    // callers receive the journal count from load() below.
    settled_shards: row.settled_shards === null ? 0 : row.settled_shards,
  };
}

async function readJobRow(database: RetrievalQueryD1, jobId: string): Promise<ExhaustiveJobRow | null> {
  try {
    return await database.prepare(
      "SELECT job_id, idempotency_key, request_digest, scope_snapshot_id, scope_snapshot_revision, scope_digest, " +
      "plan_id, coverage_denominator_ref, denominator_shard_ids_json, state, denominator_shards, " +
      "settled_shards, total_scanned_sections, total_matches, result_artifact_ref, " +
      "coverage_receipt_ref FROM retrieval_exhaustive_job WHERE job_id = ?1 LIMIT 1",
    ).bind(jobId).first<ExhaustiveJobRow>();
  } catch {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
  }
}

function jobRowKey(row: ExhaustiveJobRow): string {
  if (typeof row.idempotency_key !== "string") {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  return row.idempotency_key;
}

export interface ExhaustiveJobInput {
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly scope: ScopeSnapshot;
  readonly plan: ExactScanPlan;
}

export interface ExhaustiveJobStore {
  load(idempotencyKey: string): Promise<ExhaustiveJobLoad>;
  start(input: ExhaustiveJobInput): Promise<{ job_id: string; state: "PENDING" | "COMPLETE"; receipt: ExhaustiveJobReceipt | null }>;
  settledOutcomes(jobId: string): Promise<readonly ExhaustiveShardOutcome[]>;
  recordSettledOutcome(jobId: string, outcome: ExhaustiveShardOutcome): Promise<void>;
  finalize(input: { job_id: string; plan: ExactScanPlan; outcomes: readonly ExhaustiveShardOutcome[] }): Promise<ExhaustiveJobReceipt>;
}

export function createD1ExhaustiveJobStore(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  now: () => string = () => new Date().toISOString(),
): ExhaustiveJobStore {
  checkJobAccess(access);
  return {
    async load(idempotencyKey: string): Promise<ExhaustiveJobLoad> {
      const key = checkIdempotencyKey(idempotencyKey);
      const row = await readJobRow(database, await exhaustiveJobId(access, key));
      if (row === null) return null;
      if (row.state === "PENDING") {
        const pending = decodePendingJob(row, jobRowKey(row));
        const count = await database.prepare(
          "SELECT COUNT(*) AS n FROM retrieval_exhaustive_shard WHERE job_id = ?1",
        ).bind(pending.job_id).first<{ readonly n: unknown }>().catch(() => {
          failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
        });
        if (count === null || typeof count.n !== "number" || !Number.isSafeInteger(count.n) || count.n < 0 || count.n > pending.denominator_shards) {
          failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive pending job is unavailable", true);
        }
        return { ...pending, settled_shards: count.n };
      }
      return decodeJobReceipt(row, jobRowKey(row));
    },
    async start(input: ExhaustiveJobInput): Promise<{ job_id: string; state: "PENDING" | "COMPLETE"; receipt: ExhaustiveJobReceipt | null }> {
      const key = checkIdempotencyKey(input.idempotency_key);
      const digest = checkRequestDigest(input.request_digest);
      const denominatorIds = requireDenominatorForScope(input.scope, input.plan);
      const denominatorJson = canonicalRetrievalJson(denominatorIds);
      if (new TextEncoder().encode(denominatorJson).byteLength > 65536) {
        failJob("RETRIEVAL_INPUT_INVALID", "exhaustive denominator exceeds its bound");
      }
      const jobId = await exhaustiveJobId(access, key);
      const createdAt = now();
      try {
        await database.prepare(
          "INSERT INTO retrieval_exhaustive_job (job_id, principal_ref, client_class, " +
          "credential_generation, idempotency_key, request_digest, scope_snapshot_id, " +
          "scope_snapshot_revision, scope_digest, plan_id, coverage_denominator_ref, " +
          "denominator_shard_ids_json, state, denominator_shards, created_at, expires_at) VALUES " +
          "(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'PENDING',?13,?14,?15) " +
          "ON CONFLICT DO NOTHING",
        ).bind(
          jobId, access.principal_ref, access.client_class, access.credential_generation,
          key, digest, input.scope.snapshot_id, input.scope.revision, input.scope.digest,
          input.plan.plan_id, input.plan.coverage_denominator_ref, denominatorJson,
          denominatorIds.length, createdAt, input.scope.expires_at,
        ).run();
      } catch (error) {
        mapJobStoreError(error);
      }
      const settled = await readJobRow(database, jobId);
      if (settled === null) {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
      }
      if (
        settled.request_digest !== digest || settled.scope_snapshot_id !== input.scope.snapshot_id ||
        settled.scope_snapshot_revision !== input.scope.revision || settled.scope_digest !== input.scope.digest ||
        settled.plan_id !== input.plan.plan_id ||
        settled.coverage_denominator_ref !== input.plan.coverage_denominator_ref ||
        settled.denominator_shard_ids_json !== denominatorJson
      ) {
        failJob("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
      }
      if (settled.state === "COMPLETE") return { job_id: jobId, state: "COMPLETE", receipt: decodeJobReceipt(settled, key) };
      if (settled.state === "PENDING") return { job_id: jobId, state: "PENDING", receipt: null };
      failJob("RETRIEVAL_SCOPE_STALE", "stored exhaustive scope is invalidated");
    },
    async settledOutcomes(jobId: string): Promise<readonly ExhaustiveShardOutcome[]> {
      const row = await readJobRow(database, jobId);
      if (row === null) {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
      }
      if (row.state === "INVALIDATED") {
        failJob("RETRIEVAL_SCOPE_STALE", "stored exhaustive scope is invalidated");
      }
      if (typeof row.denominator_shard_ids_json !== "string") {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
      }
      let denominatorIds: unknown;
      try {
        denominatorIds = JSON.parse(row.denominator_shard_ids_json);
      } catch {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
      }
      if (!Array.isArray(denominatorIds) || denominatorIds.some((id) => typeof id !== "string")) {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
      }
      let outcomeRows: readonly { readonly shard_id: unknown; readonly outcome_json: unknown; readonly outcome_digest: unknown }[];
      try {
        outcomeRows = (await database.prepare(
          "SELECT shard_id, outcome_json, outcome_digest FROM retrieval_exhaustive_shard WHERE job_id = ?1",
        ).bind(jobId).all<{ readonly shard_id: unknown; readonly outcome_json: unknown; readonly outcome_digest: unknown }>()).results;
      } catch {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
      }
      const byShard = new Map<string, ExhaustiveShardOutcome>();
      for (const outcomeRow of outcomeRows) {
        if (typeof outcomeRow.shard_id !== "string" || typeof outcomeRow.outcome_json !== "string") {
          failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(outcomeRow.outcome_json);
        } catch {
          failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
        }
        if (canonicalRetrievalJson(parsed) !== outcomeRow.outcome_json) {
          failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
        }
        if (await sha256Hex(outcomeRow.outcome_json) !== outcomeRow.outcome_digest) {
          failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
        }
        byShard.set(outcomeRow.shard_id, parsed as ExhaustiveShardOutcome);
      }
      return (denominatorIds as readonly string[])
        .map((shardId) => byShard.get(shardId))
        .filter((outcome): outcome is ExhaustiveShardOutcome => outcome !== undefined);
    },
    async recordSettledOutcome(jobId: string, outcome: ExhaustiveShardOutcome): Promise<void> {
      if (outcome === null || typeof outcome !== "object" || outcome.disposition !== "SETTLED") {
        failJob("RETRIEVAL_INPUT_INVALID", "only settled shard outcomes are journaled; unknown outcomes keep their denominator seat");
      }
      const row = await readJobRow(database, jobId);
      if (row === null) {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
      }
      if (row.state === "INVALIDATED") {
        failJob("RETRIEVAL_SCOPE_STALE", "stored exhaustive scope is invalidated");
      }
      if (typeof row.denominator_shard_ids_json !== "string") {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
      }
      const denominatorIds = JSON.parse(row.denominator_shard_ids_json) as readonly string[];
      if (!denominatorIds.includes(outcome.shard_id)) {
        failJob("RETRIEVAL_INPUT_INVALID", "exhaustive outcome is outside the planned denominator");
      }
      const outcomeJson = canonicalRetrievalJson(outcome);
      if (new TextEncoder().encode(outcomeJson).byteLength > 262144) {
        failJob("RETRIEVAL_INPUT_INVALID", "exhaustive outcome exceeds its bound");
      }
      const outcomeDigest = await sha256Hex(outcomeJson);
      if (row.state !== "PENDING") {
        // A finished job gains no new outcomes: a byte-identical replay of a
        // journaled shard is a no-op, anything else is a conflict.
        const existing = await database.prepare(
          "SELECT outcome_json, outcome_digest FROM retrieval_exhaustive_shard WHERE job_id = ?1 AND shard_id = ?2 LIMIT 1",
        ).bind(jobId, outcome.shard_id).first<{ readonly outcome_json: unknown; readonly outcome_digest: unknown }>().catch(() => {
          failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
        });
        if (existing !== null && existing.outcome_json === outcomeJson && existing.outcome_digest === outcomeDigest) return;
        failJob("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
      }
      try {
        await database.prepare(
          "INSERT INTO retrieval_exhaustive_shard (job_id, shard_id, outcome_json, outcome_digest, created_at) " +
          "VALUES (?1,?2,?3,?4,?5) ON CONFLICT DO NOTHING",
        ).bind(jobId, outcome.shard_id, outcomeJson, outcomeDigest, now()).run();
      } catch (error) {
        mapJobStoreError(error);
      }
      const journaled = await database.prepare(
        "SELECT outcome_json, outcome_digest FROM retrieval_exhaustive_shard WHERE job_id = ?1 AND shard_id = ?2 LIMIT 1",
      ).bind(jobId, outcome.shard_id).first<{ readonly outcome_json: unknown; readonly outcome_digest: unknown }>().catch(() => {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
      });
      if (journaled === null || journaled.outcome_json !== outcomeJson || journaled.outcome_digest !== outcomeDigest) {
        failJob("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
      }
    },
    async finalize(input: { job_id: string; plan: ExactScanPlan; outcomes: readonly ExhaustiveShardOutcome[] }): Promise<ExhaustiveJobReceipt> {
      const row = await readJobRow(database, input.job_id);
      if (row === null) {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
      }
      if (row.state === "COMPLETE") return decodeJobReceipt(row, jobRowKey(row));
      if (row.state !== "PENDING") {
        failJob("RETRIEVAL_SCOPE_STALE", "stored exhaustive scope is invalidated");
      }
      const denominatorIds = requireDenominatorForScope(input.plan.scope_snapshot, input.plan);
      if (
        row.plan_id !== input.plan.plan_id ||
        row.coverage_denominator_ref !== input.plan.coverage_denominator_ref ||
        row.denominator_shard_ids_json !== canonicalRetrievalJson(denominatorIds) ||
        row.scope_snapshot_id !== input.plan.scope_snapshot.snapshot_id ||
        row.scope_snapshot_revision !== input.plan.scope_snapshot.revision ||
        row.scope_digest !== input.plan.scope_snapshot.digest
      ) {
        failJob("RETRIEVAL_INPUT_INVALID", "exhaustive denominator does not match the recorded job");
      }
      let merged: ReturnType<typeof mergeExhaustiveShards>;
      try {
        merged = mergeExhaustiveShards({ plan: input.plan, outcomes: input.outcomes });
      } catch (error) {
        if (error instanceof RetrievalQueryError) throw error;
        failJob("RETRIEVAL_INPUT_INVALID", error instanceof Error ? error.message : "exhaustive merge is invalid");
      }
      if (merged.coverage_claim !== "COMPLETE") {
        failJob("RETRIEVAL_INPUT_INVALID", "exhaustive merge did not earn COMPLETE; the job stays unfinished");
      }
      if (merged.coverage_denominator_ref !== input.plan.coverage_denominator_ref) {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
      }
      try {
        await database.prepare(
          "UPDATE retrieval_exhaustive_job SET state = 'COMPLETE', settled_shards = ?2, " +
          "total_scanned_sections = ?3, total_matches = ?4, result_artifact_ref = ?5, " +
          "coverage_receipt_ref = ?6 WHERE job_id = ?1 AND state = 'PENDING'",
        ).bind(
          input.job_id, merged.settled_shards, merged.total_scanned_sections, merged.total_matches,
          merged.result_artifact_ref, merged.coverage_receipt_ref,
        ).run();
      } catch (error) {
        mapJobStoreError(error);
      }
      const settled = await readJobRow(database, input.job_id);
      if (settled === null) {
        failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "exhaustive job settlement is uncertain", true);
      }
      if (
        settled.settled_shards !== merged.settled_shards ||
        settled.total_scanned_sections !== merged.total_scanned_sections ||
        settled.total_matches !== merged.total_matches ||
        settled.result_artifact_ref !== merged.result_artifact_ref ||
        settled.coverage_receipt_ref !== merged.coverage_receipt_ref
      ) {
        failJob("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
      }
      const receipt = decodeJobReceipt(settled, jobRowKey(settled));
      return receipt;
    },
  };
}

/**
 * Read the persisted denominator and journal through the same store authority
 * used by reconcile. Transport adapters use this to compare a Workflow's
 * pending coverage claim without maintaining a second denominator decoder.
 */
export async function readExhaustiveJobCoverage(
  database: RetrievalQueryD1,
  access: RetrievalQueryAccess,
  idempotencyKey: string,
): Promise<ExhaustiveJobCoverage | null> {
  const key = checkIdempotencyKey(idempotencyKey);
  const row = await readJobRow(database, await exhaustiveJobId(access, key));
  if (row === null) return null;
  const store = createD1ExhaustiveJobStore(database, access);
  const job = await store.load(key);
  if (job === null) return null;
  if (typeof row.denominator_shard_ids_json !== "string") {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  let denominator: unknown;
  try {
    denominator = JSON.parse(row.denominator_shard_ids_json);
  } catch {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  if (!Array.isArray(denominator) || denominator.length === 0 || denominator.some((id) => typeof id !== "string") ||
      new Set(denominator).size !== denominator.length || canonicalRetrievalJson(denominator) !== row.denominator_shard_ids_json) {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  const denominatorIds = denominator as string[];
  if (typeof row.job_id !== "string") {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  const settled = await store.settledOutcomes(row.job_id);
  const settledIds = settled.map((outcome) => outcome.shard_id);
  if (new Set(settledIds).size !== settledIds.length || settledIds.some((id) => !denominatorIds.includes(id))) {
    failJob("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored exhaustive receipt is unavailable", true);
  }
  return {
    job,
    denominator_shard_ids: denominatorIds,
    settled_shard_ids: settledIds,
  };
}
