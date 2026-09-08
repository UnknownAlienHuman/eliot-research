import { describe, expect, it } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import {
  executeExhaustiveShard,
  planExhaustiveScan,
  type ExactScanPlan,
  type ExactScanShard,
  type ExhaustiveShardOutcome,
} from "./exhaustive.js";
import {
  createD1RetrievalResultStore,
  createD1ScopePorts,
} from "./query-persistence.js";
import {
  createD1ExhaustiveJobStore,
  exhaustiveRequestDigest,
  reconcileExhaustiveJob,
  type ExhaustiveJobStore,
  type ExhaustiveReconcilePorts,
} from "./exhaustive-reconcile.js";
import { RetrievalQueryError, type RetrievalResult } from "./service.js";
import {
  ACCESS,
  CREATED,
  hex64,
  openDatabase,
  readerFor,
  scopeFixture,
  sectionHarness,
  seedAuthority,
  settled,
  type RawDatabase,
} from "./exhaustive-harness.js";

function count(database: RawDatabase, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function jobState(database: RawDatabase, key: string): string | null {
  const row = database.prepare(
    "SELECT state FROM retrieval_exhaustive_job WHERE idempotency_key = ?1",
  ).get(key) as { state: string } | undefined;
  return row?.state ?? null;
}

function unsettled(shardId: string): ExhaustiveShardOutcome {
  return {
    shard_id: shardId,
    disposition: "UNSETTLED",
    reason_code: "TIMEOUT",
    scanned_sections: 0,
    matches: 0,
    section_outcomes: [],
  };
}

async function twoShardWorld(): Promise<{
  scope: ScopeSnapshot;
  plan: ExactScanPlan;
  digest: string;
  store: ExhaustiveJobStore;
  ports: ExhaustiveReconcilePorts;
  raw: RawDatabase;
  calls: Map<string, number>;
}> {
  const { raw, d1 } = openDatabase();
  const scope = scopeFixture({
    member_source_revision_refs: ["rev-1"],
    source_owner_generations: { "rev-1": "owner-gen-1" },
  });
  seedAuthority(raw, scope);
  const first = await sectionHarness({
    section_ref: "sec-1", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
    fullText: "alpha needle beta", anchor: { kind: "normalized_byte_range", start: 0, end: 17 }, scope,
  });
  const second = await sectionHarness({
    section_ref: "sec-2", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
    fullText: "plain bytes here!", anchor: { kind: "normalized_byte_range", start: 0, end: 17 }, scope,
  });
  const big = 3 * 1024 * 1024;
  const plan = planExhaustiveScan({
    scope,
    probes: ["needle"],
    plan_id: "reconcile-plan",
    sections: [
      { ...first.descriptor, uncompressed_bytes: big },
      { ...second.descriptor, uncompressed_bytes: big },
    ],
  });
  if (plan.shards.length !== 2) throw new Error("expected a two-shard denominator");
  const reader = readerFor([first, second]);
  const digest = await exhaustiveRequestDigest({
    plan_id: plan.plan_id, scope_digest: scope.digest, probes: plan.probes,
  });
  const store = createD1ExhaustiveJobStore(d1, ACCESS, () => CREATED);
  const frozen = createD1ScopePorts(d1, ACCESS, () => CREATED);
  const calls = new Map<string, number>();
  const ports: ExhaustiveReconcilePorts = {
    requireCurrentScope: (snapshot) => frozen.requireCurrentScope(snapshot),
    checkBudget: () => {},
    executeShard: async (shard: ExactScanShard) => {
      calls.set(shard.shard_id, (calls.get(shard.shard_id) ?? 0) + 1);
      return executeExhaustiveShard({ shard, scope, probes: ["needle"], reader });
    },
  };
  return { scope, plan, digest, store, ports, raw, calls };
}

async function jobError(promise: Promise<unknown>): Promise<RetrievalQueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RetrievalQueryError) return error;
    throw new Error(`expected RetrievalQueryError, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected the job to fail");
}

describe("Q7 ordered reconcile loop over migration 0023", () => {
  it("persists an earned COMPLETE with its denominator and reads it back", async () => {
    const world = await twoShardWorld();
    const status = await reconcileExhaustiveJob({
      store: world.store,
      ports: world.ports,
      idempotency_key: "job-1",
      request_digest: world.digest,
      scope: world.scope,
      plan: world.plan,
    });
    if (status.status !== "COMPLETE") throw new Error("expected COMPLETE");
    expect(status.receipt.coverage_claim).toBe("COMPLETE");
    expect(status.receipt.coverage_denominator_ref).toBe(world.plan.coverage_denominator_ref);
    expect(status.receipt.denominator_shards).toBe(2);
    expect(status.receipt.settled_shards).toBe(2);
    expect(status.receipt.total_scanned_sections).toBe(2);
    expect(status.receipt.total_matches).toBe(1);
    expect(status.receipt.result_artifact_ref).toContain(world.plan.plan_id);
    const replayed = await world.store.load("job-1");
    expect(replayed).toEqual(status.receipt);
    expect(jobState(world.raw, "job-1")).toBe("COMPLETE");
    expect(count(world.raw, "retrieval_exhaustive_shard")).toBe(2);
    // No weaker parallel claim: the Q3 result table stays empty.
    expect(count(world.raw, "retrieval_query_result")).toBe(0);
  });

  it("replays a COMPLETE job without re-executing shards or duplicating rows", async () => {
    const world = await twoShardWorld();
    const input = {
      store: world.store,
      ports: world.ports,
      idempotency_key: "job-1",
      request_digest: world.digest,
      scope: world.scope,
      plan: world.plan,
    };
    const first = await reconcileExhaustiveJob(input);
    if (first.status !== "COMPLETE") throw new Error("expected COMPLETE");
    expect([...world.calls.values()].reduce((sum, n) => sum + n, 0)).toBe(2);
    const callsAfterFirst = new Map(world.calls);
    const second = await reconcileExhaustiveJob(input);
    if (second.status !== "COMPLETE") throw new Error("expected COMPLETE replay");
    expect(second.receipt).toEqual(first.receipt);
    expect(world.calls).toEqual(callsAfterFirst);
    expect(count(world.raw, "retrieval_exhaustive_job")).toBe(1);
    expect(count(world.raw, "retrieval_exhaustive_shard")).toBe(2);
  });

  it("resumes a partially settled job without double-counting", async () => {
    const world = await twoShardWorld();
    const secondShard = world.plan.shards[1]?.shard_id as string;
    let failOpen = true;
    const flaky: ExhaustiveReconcilePorts = {
      ...world.ports,
      executeShard: async (shard, plan) => {
        if (failOpen && shard.shard_id === secondShard) return unsettled(shard.shard_id);
        return world.ports.executeShard(shard, plan);
      },
    };
    const input = {
      store: world.store,
      idempotency_key: "job-1",
      request_digest: world.digest,
      scope: world.scope,
      plan: world.plan,
    };
    const partial = await reconcileExhaustiveJob({ ...input, ports: flaky });
    if (partial.status !== "UNFINISHED") throw new Error("expected UNFINISHED");
    expect(partial.settled_shards).toBe(1);
    expect(partial.unsettled_shard_ids).toEqual([secondShard]);
    expect(await world.store.load("job-1")).toBeNull();
    failOpen = false;
    const resumed = await reconcileExhaustiveJob({ ...input, ports: flaky });
    if (resumed.status !== "COMPLETE") throw new Error("expected COMPLETE after resume");
    expect(resumed.receipt.settled_shards).toBe(2);
    expect(resumed.receipt.total_scanned_sections).toBe(2);
    expect(resumed.receipt.total_matches).toBe(1);
    // The journaled shard never re-executed; the unknown shard retried once.
    expect(world.calls.get(world.plan.shards[0]?.shard_id as string)).toBe(1);
    expect(world.calls.get(secondShard)).toBe(1);
    expect(count(world.raw, "retrieval_exhaustive_shard")).toBe(2);
  });

  it("leaves the job unfinished on an unsettled shard and persists no weaker final claim", async () => {
    const world = await twoShardWorld();
    const secondShard = world.plan.shards[1]?.shard_id as string;
    const status = await reconcileExhaustiveJob({
      store: world.store,
      ports: {
        ...world.ports,
        executeShard: async (shard, plan) =>
          shard.shard_id === secondShard ? unsettled(shard.shard_id) : world.ports.executeShard(shard, plan),
      },
      idempotency_key: "job-1",
      request_digest: world.digest,
      scope: world.scope,
      plan: world.plan,
    });
    if (status.status !== "UNFINISHED") throw new Error("expected UNFINISHED");
    expect(status.settled_shards).toBe(1);
    expect(status.unsettled_shard_ids).toEqual([secondShard]);
    expect(await world.store.load("job-1")).toBeNull();
    expect(jobState(world.raw, "job-1")).toBe("PENDING");
    expect(count(world.raw, "retrieval_exhaustive_shard")).toBe(1);
    expect(count(world.raw, "retrieval_query_result")).toBe(0);
  });

  it("refuses a denominator that does not match the frozen scope", async () => {
    const world = await twoShardWorld();
    const foreign = scopeFixture({ snapshot_id: "snap-foreign", digest: hex64("9") });
    const failure = await jobError(world.store.start({
      idempotency_key: "job-1",
      request_digest: world.digest,
      scope: foreign,
      plan: world.plan,
    }));
    expect(failure.code).toBe("RETRIEVAL_INPUT_INVALID");
    expect(failure.message).toBe("exhaustive denominator does not match the frozen scope");
    expect(count(world.raw, "retrieval_exhaustive_job")).toBe(0);
  });

  it("refuses a denominator-less COMPLETE through the Q3 result store exactly as today", async () => {
    const { d1 } = openDatabase();
    const scope = scopeFixture();
    const traceRef = { id: `query-${hex64("c").slice(0, 48)}`, revision: 1 };
    const forged = {
      evidence_pack: {
        pack_ref: { id: "pack-1", revision: 1 },
        scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
        resolved_evidence: [],
        omitted_candidates: [],
        trace_ref: traceRef,
        total_utf8_bytes: 0,
      },
      trace: {
        trace_ref: traceRef,
        raw_query: "needle",
        scope_snapshot: scope,
        query_product: "RESEARCH",
        lanes_used: [],
        lanes_skipped: [],
        exact_probes: [],
        index_generations: [],
        context_expansion: 0,
        candidates_by_lane: {},
        expansion_refs: [],
        represented_source_refs: [],
        omitted_sources: [],
        stale_or_degraded_channels: [],
        budget_receipt_ref: "budget-1",
      },
      coverage_claim: "COMPLETE",
    } as unknown as RetrievalResult;
    const failure = await jobError(
      createD1RetrievalResultStore(d1, ACCESS, () => CREATED).store({
        request_digest: hex64("d"),
        idempotency_key: "forged-complete",
        result: forged,
      }),
    );
    expect(failure.code).toBe("RETRIEVAL_INPUT_INVALID");
    expect(failure.message).toBe("coverage stronger than SAMPLED is never stored");
  });

  it("refuses to finalize a partial denominator instead of persisting a weaker claim", async () => {
    const world = await twoShardWorld();
    const started = await world.store.start({
      idempotency_key: "job-1",
      request_digest: world.digest,
      scope: world.scope,
      plan: world.plan,
    });
    expect(started.state).toBe("PENDING");
    const firstShard = world.plan.shards[0] as ExactScanShard;
    const outcome = settled(await world.ports.executeShard(firstShard, world.plan));
    await world.store.recordSettledOutcome(started.job_id, outcome);
    const failure = await jobError(world.store.finalize({
      job_id: started.job_id,
      plan: world.plan,
      outcomes: [outcome],
    }));
    expect(failure.code).toBe("RETRIEVAL_INPUT_INVALID");
    expect(failure.message).toBe("exhaustive merge did not earn COMPLETE; the job stays unfinished");
    expect(jobState(world.raw, "job-1")).toBe("PENDING");
    expect(await world.store.load("job-1")).toBeNull();
  });
});
