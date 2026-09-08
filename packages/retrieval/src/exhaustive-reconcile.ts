// IMPLEMENTED_NOT_LIVE: ER-07 ordered exhaustive reconcile loop over migration 0023 with earned COMPLETE persistence; Worker/HTTP composition and live qualification remain separate.
import type { ScopeSnapshot } from "@eliotr/contracts";
import {
  mergeExhaustiveShards,
  type ExactScanPlan,
  type ExactScanShard,
  type ExhaustiveShardOutcome,
} from "./exhaustive.js";
import {
  canonicalRetrievalJson,
  type RetrievalQueryAccess,
  type RetrievalQueryD1,
} from "./query-persistence.js";
import { RetrievalQueryError, type RetrievalQueryErrorCode } from "./service.js";

/**
 * Q7 ordered reconcile loop: shards settle in planned denominator order, the
 * Q5 merge runs once over the planned denominator, and an earned COMPLETE is
 * persisted with the denominator that earned it.
 *
 * Entry-point decision (the M20 open design question), with evidence:
 *
 * - CHOSEN: a retrieval-local D1-backed job port plus this loop in
 *   `packages/retrieval`, entered through direct port calls; Worker/HTTP
 *   composition is deferred. `research-session.ts` rejects anything but the
 *   ORIENT/E0 metadata profile (`RESEARCH_PROFILE_UNSUPPORTED`, 422), so an
 *   exhaustive scan cannot enter through `research.query` without widening the
 *   ORIENT DTO to carry a different product; `planner.ts` already treats
 *   `EXHAUSTIVE_JOB` as its own product with its own lanes. The only host
 *   that needs no contract widening and no slice enablement is this package
 *   behind injected ports — the same pattern Q3 (pure service plus D1 ports)
 *   and Q5 (pure plan/execute/merge) followed.
 * - REJECTED: loosening `parseResearchQueryRequest` to admit EXHAUSTIVE (it
 *   would widen the ORIENT contract and its 64-source metadata-Lens bound);
 *   enabling the RETRIEVAL slice or touching the slice lists (forbidden);
 *   a second coverage calculation in this loop (it would drift from
 *   `mergeExhaustiveShards`, the single coverage authority); persisting
 *   COMPLETE into `retrieval_query_result` (its 0021 CHECK caps stored
 *   coverage at SAMPLED and rebuilding an applied table violates
 *   additive-only, so earned COMPLETE rows live in the additive 0023
 *   tables); a new Worker HTTP route (ER-24 composition, out of scope).
 *
 * Guard decision: the Q3 result-store check
 * ("coverage stronger than SAMPLED is never stored") is intentionally left
 * byte-identical — its record shape carries no denominator channel and its
 * table cannot hold COMPLETE, so a COMPLETE presented there is still refused
 * exactly as before. Discrimination lives here, on the only path that
 * carries a denominator: COMPLETE is stored only with the planned
 * denominator, only when the plan scope equals the frozen scope, and only
 * when `mergeExhaustiveShards` earns COMPLETE over every denominator shard.
 * A COMPLETE without that proof, or with a denominator from another scope,
 * is refused with a typed fail-closed error and persists nothing.
 *
 * Every mutation is Intent -> Attempt -> Receipt -> Readback ->
 * Reconciliation over single D1 statements: no HTTP, model or R2 effect
 * occurs inside a D1 statement, and shard execution itself is a
 * caller-injected port outside every statement. A scan mints no source
 * grants: the 0023 authority trigger requires a pre-existing ACTIVE grant.
 * Small canonical helpers (sha, access check, error mapping) mirror
 * `query-persistence.ts` so that module stays untouched; the mapping
 * preserves every typed code that module defines.
 */

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

async function exhaustiveJobId(access: RetrievalQueryAccess, idempotencyKey: string): Promise<string> {
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
  load(idempotencyKey: string): Promise<ExhaustiveJobReceipt | null>;
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
    async load(idempotencyKey: string): Promise<ExhaustiveJobReceipt | null> {
      const key = checkIdempotencyKey(idempotencyKey);
      const row = await readJobRow(database, await exhaustiveJobId(access, key));
      if (row === null || row.state === "PENDING") return null;
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
}): Promise<string> {
  return sha256Hex(canonicalRetrievalJson({
    plan_id: input.plan_id,
    scope_digest: input.scope_digest,
    probes: [...input.probes],
  }));
}
