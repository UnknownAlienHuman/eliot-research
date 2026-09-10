import { describe, expect, it } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type {
  ExhaustiveJobInput,
  ExhaustiveJobReceipt,
  ExhaustiveJobStore,
  ExhaustiveShardOutcome,
  ExactScanPlan,
  RetrievalQueryAccess,
} from "@eliotr/retrieval";
import {
  EXHAUSTIVE_QUERY_BUDGET,
  createExhaustiveQueryService,
  parseExhaustiveQueryRequest,
  type ExhaustiveQueryRuntime,
} from "./exhaustive-query-service.js";
import { parseResearchQueryRequest } from "./research-session.js";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";

const DIGEST = "a".repeat(64);
const NOW = "2026-09-09T12:00:00.000Z";
const scope = {
  snapshot_id: "scope-1",
  revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
  participant_generations: { "source-1": "participant-1" },
  member_source_revision_refs: ["revision-1"],
  source_owner_generations: { "revision-1": "owner-generation-1" },
  policy_authority_ref: "policy-1",
  disclosure_closure_digest: DIGEST,
  purge_ledger_revision: 0,
  client_fence_ref: "fence-1",
  digest: DIGEST,
  created_at: NOW,
  expires_at: "2026-09-10T12:00:00.000Z",
} as unknown as ScopeSnapshot;

function context(key: string): AuthenticatedRequestContext {
  return {
    request: new Request("https://research.example/api/v1/research/query", {
      method: "POST",
      headers: { "idempotency-key": key },
    }),
    principal_ref: "owner-1",
    client_class: "owner_pwa",
    credential_generation: "credential-1",
    trace_id: `trace-${key}`,
  };
}

function request(query = "needle"): Record<string, unknown> {
  return {
    query,
    product: "EXHAUSTIVE_JOB",
    scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
    literals: [],
    evidence_grade: "E0",
    budget_ref: EXHAUSTIVE_QUERY_BUDGET,
    max_results: 8,
  };
}

function receipt(input: ExhaustiveJobInput, jobId: string): ExhaustiveJobReceipt {
  return {
    job_id: jobId,
    idempotency_key: input.idempotency_key,
    request_digest: input.request_digest,
    scope_snapshot_id: input.scope.snapshot_id,
    scope_snapshot_revision: input.scope.revision,
    coverage_claim: "COMPLETE",
    coverage_denominator_ref: input.plan.coverage_denominator_ref,
    denominator_shards: input.plan.shards.length,
    settled_shards: input.plan.shards.length,
    total_scanned_sections: input.plan.shards.reduce((total, shard) => total + shard.section_object_refs.length, 0),
    total_matches: 1,
    result_artifact_ref: `q7-result:${input.plan.plan_id}`,
    coverage_receipt_ref: `q7-coverage:${input.plan.plan_id}`,
  };
}

class MemoryJobStore implements ExhaustiveJobStore {
  private readonly outcomes: ExhaustiveShardOutcome[] = [];
  private input: ExhaustiveJobInput | null = null;
  private complete: ExhaustiveJobReceipt | null = null;

  load(key: string): Promise<ExhaustiveJobReceipt | null> {
    return Promise.resolve(this.complete?.idempotency_key === key ? this.complete : null);
  }

  start(input: ExhaustiveJobInput): Promise<{ job_id: string; state: "PENDING" | "COMPLETE"; receipt: ExhaustiveJobReceipt | null }> {
    if (this.input === null) this.input = input;
    if (this.complete !== null) return Promise.resolve({ job_id: this.complete.job_id, state: "COMPLETE", receipt: this.complete });
    return Promise.resolve({ job_id: "job-1", state: "PENDING", receipt: null });
  }

  settledOutcomes(): Promise<readonly ExhaustiveShardOutcome[]> {
    return Promise.resolve([...this.outcomes]);
  }

  recordSettledOutcome(_jobId: string, outcome: ExhaustiveShardOutcome): Promise<void> {
    this.outcomes.push(outcome);
    return Promise.resolve();
  }

  finalize(input: { job_id: string; plan: ExactScanPlan; outcomes: readonly ExhaustiveShardOutcome[] }): Promise<ExhaustiveJobReceipt> {
    if (this.input === null) throw new Error("missing job input");
    this.complete = receipt({ ...this.input, plan: input.plan }, input.job_id);
    return Promise.resolve(this.complete);
  }
}

function runtimeFor(readSection: ExhaustiveQueryRuntime["readSection"]): ExhaustiveQueryRuntime {
  return {
    freezeScope: async () => scope,
    requireCurrentScope: async () => undefined,
    inventorySections: async () => [{
      section_ref: "section-1", source_revision_ref: "revision-1", item_key: "item-1",
      content_sha256: DIGEST, projection_generation: "projection-1",
      normalized_start_byte: 0, normalized_end_byte: 6, uncompressed_bytes: 6,
    }],
    readSection,
    checkBudget: () => undefined,
  };
}

async function completeSection() {
  const excerptDigest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("needle")))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
  return {
    handle: {
      handle_ref: { id: "handle-1", revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-generation-1",
      source_revision_ref: "revision-1",
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      anchor: { kind: "normalized_byte_range" as const, start: 0, end: 6 },
      excerpt_sha256: excerptDigest,
      excerpt_byte_length: 6,
      object_residency_key_digest: "b".repeat(64),
      source_assurance_ceiling: "EXACT" as const,
      materializer_assurance_ceiling: "EXACT" as const,
      terminal_state: "LIVE" as const,
      created_at: NOW,
    },
    scope,
    source: {
      source_revision_ref: "revision-1",
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-generation-1",
      content_sha256: DIGEST,
      object_residency_key_digest: "b".repeat(64),
      purge_state: "LIVE" as const,
    },
    materialized: {
      exact_excerpt: "needle",
      excerpt_sha256: excerptDigest,
      excerpt_byte_length: 6,
      source_object_size: 6,
      source_object_sha256: DIGEST,
    },
  };
}

describe("ER-24 exhaustive query composition", () => {
  it("keeps ORIENT parsing separate and accepts only the versioned exhaustive profile", () => {
    expect(parseExhaustiveQueryRequest(request())).toMatchObject({ product: "EXHAUSTIVE_JOB", budget_ref: EXHAUSTIVE_QUERY_BUDGET });
    expect(() => parseResearchQueryRequest({ ...request(), budget_ref: ORIENTATION_PROFILE })).toThrow("ORIENT metadata profile");
    expect(() => parseExhaustiveQueryRequest({ ...request(), injected_plan: {} })).toThrow("unknown or missing fields");
  });

  it("runs Q7 through an authoritative runtime, returns COMPLETE and replays without a second shard", async () => {
    const store = new MemoryJobStore();
    let reads = 0;
    const service = createExhaustiveQueryService({ CORE_DB: {} as D1Database }, {
      runtime: () => runtimeFor(async () => { reads += 1; return completeSection(); }),
      storeFactory: (_access: RetrievalQueryAccess) => store,
    });
    const first = await service.query(context("exhaustive-1"), request());
    const second = await service.query(context("exhaustive-1"), request());
    expect(first.protocol).toBe("eliotr.exhaustive-query.v1");
    expect(first.job.status).toBe("COMPLETE");
    expect(second).toEqual(first);
    expect(reads).toBe(1);
  });

  it("retains denominator uncertainty as UNFINISHED when a section read is lost", async () => {
    const store = new MemoryJobStore();
    const service = createExhaustiveQueryService({ CORE_DB: {} as D1Database }, {
      runtime: () => runtimeFor(async () => { throw new Error("R2_READ_TIMEOUT"); }),
      storeFactory: () => store,
    });
    const output = await service.query(context("exhaustive-uncertain"), request());
    expect(output.job).toMatchObject({ status: "UNFINISHED", denominator_shards: 1, settled_shards: 0 });
  });
});
