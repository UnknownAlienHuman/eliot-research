import { describe, expect, it } from "vitest";
import {
  EXACT_SCAN_LIMITS,
  ExhaustiveMergeError,
  ExhaustivePlanError,
  executeExhaustiveShard,
  mergeExhaustiveShards,
  planExhaustiveScan,
  type ExactScanPlan,
  type ExhaustiveSectionReader,
  type ExhaustiveShardOutcome,
} from "./exhaustive.js";
import { createD1ScopePorts } from "./query-persistence.js";
import {
  ACCESS,
  CREATED,
  hex64,
  openDatabase,
  planError,
  planErrorSync,
  readerFor,
  scopeFixture,
  sectionHarness,
  seedAuthority,
  settled,
} from "./exhaustive-harness.js";

describe("Q5 sharded exhaustive plan", () => {
  it("shards a frozen scope within target/hard/section bounds with a scope-derived denominator", () => {
    const scope = scopeFixture();
    const plan = planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [
        { section_ref: "sec-1", source_revision_ref: "rev-1", uncompressed_bytes: 512 * 1024 },
        { section_ref: "sec-2", source_revision_ref: "rev-1", uncompressed_bytes: 512 * 1024 },
        { section_ref: "sec-3", source_revision_ref: "rev-2", uncompressed_bytes: 256 * 1024 },
      ],
    });
    // 1.25 MiB total fits one target shard; every member is represented.
    expect(plan.shards).toHaveLength(1);
    const shard = plan.shards[0];
    expect(shard?.section_object_refs).toEqual(["sec-1", "sec-2", "sec-3"]);
    expect(shard?.source_revision_refs).toEqual(["rev-1", "rev-2"]);
    expect(shard?.target_uncompressed_bytes).toBe(EXACT_SCAN_LIMITS.target_uncompressed_bytes);
    expect(shard?.hard_uncompressed_bytes).toBe(EXACT_SCAN_LIMITS.hard_uncompressed_bytes);
    expect(shard?.max_sections).toBe(EXACT_SCAN_LIMITS.max_sections);
    expect(plan.coverage_denominator_ref).toContain(scope.snapshot_id);
    expect(plan.coverage_denominator_ref).toContain(scope.digest.slice(0, 16));
    expect(plan.output_manifest_ref).toContain(plan.plan_id);
  });

  it("splits a shard that would exceed its hard bound instead of stretching it", () => {
    const scope = scopeFixture();
    const each = 3 * 1024 * 1024;
    const plan = planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [
        { section_ref: "sec-1", source_revision_ref: "rev-1", uncompressed_bytes: each },
        { section_ref: "sec-2", source_revision_ref: "rev-1", uncompressed_bytes: each },
        { section_ref: "sec-3", source_revision_ref: "rev-2", uncompressed_bytes: 1024 },
      ],
    });
    expect(plan.shards.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const shard of plan.shards) {
      const sizes: Record<string, number> = { "sec-1": each, "sec-2": each, "sec-3": 1024 };
      const bytes = shard.section_object_refs.reduce((sum, ref) => sum + (sizes[ref] ?? 0), 0);
      expect(bytes).toBeLessThanOrEqual(EXACT_SCAN_LIMITS.hard_uncompressed_bytes);
      expect(shard.section_object_refs.length).toBeLessThanOrEqual(EXACT_SCAN_LIMITS.max_sections);
      seen.push(...shard.section_object_refs);
    }
    expect(seen.sort()).toEqual(["sec-1", "sec-2", "sec-3"]);
  });

  it("derives the denominator from the frozen scope, not from reached bytes", () => {
    const scope = scopeFixture();
    const sections = [
      { section_ref: "sec-1", source_revision_ref: "rev-1", uncompressed_bytes: 64 },
      { section_ref: "sec-2", source_revision_ref: "rev-2", uncompressed_bytes: 64 },
    ];
    const first = planExhaustiveScan({ scope, probes: ["needle"], sections });
    const second = planExhaustiveScan({ scope, probes: ["needle"], sections });
    expect(second.coverage_denominator_ref).toBe(first.coverage_denominator_ref);
    // A different frozen scope earns a different denominator, even over identical bytes.
    const rotated = planExhaustiveScan({
      scope: scopeFixture({ snapshot_id: "snap-q5-b", digest: hex64("9") }),
      probes: ["needle"],
      sections,
    });
    expect(rotated.coverage_denominator_ref).not.toBe(first.coverage_denominator_ref);
  });

  it("fails closed on out-of-scope, uncovered-member, oversized and duplicate sections", () => {
    const scope = scopeFixture();
    const ok = [
      { section_ref: "sec-1", source_revision_ref: "rev-1", uncompressed_bytes: 64 },
      { section_ref: "sec-2", source_revision_ref: "rev-2", uncompressed_bytes: 64 },
    ];
    expect(planErrorSync(() => planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [...ok, { section_ref: "sec-x", source_revision_ref: "rev-foreign", uncompressed_bytes: 64 }],
    })).code).toBe("EXHAUSTIVE_SECTION_OUT_OF_SCOPE");
    expect(planErrorSync(() => planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [{ section_ref: "sec-1", source_revision_ref: "rev-1", uncompressed_bytes: 64 }],
    })).code).toBe("EXHAUSTIVE_SCOPE_MEMBER_UNCOVERED");
    expect(planErrorSync(() => planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [
        { section_ref: "sec-1", source_revision_ref: "rev-1", uncompressed_bytes: EXACT_SCAN_LIMITS.hard_uncompressed_bytes + 1 },
        { section_ref: "sec-2", source_revision_ref: "rev-2", uncompressed_bytes: 64 },
      ],
    })).code).toBe("EXHAUSTIVE_SECTION_OVERSIZED");
    expect(planErrorSync(() => planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [...ok, { section_ref: "sec-1", source_revision_ref: "rev-2", uncompressed_bytes: 64 }],
    })).code).toBe("EXHAUSTIVE_SECTION_DUPLICATE");
    expect(planErrorSync(() => planExhaustiveScan({ scope, probes: [], sections: ok })).code)
      .toBe("EXHAUSTIVE_PROBES_INVALID");
    expect(planErrorSync(() => planExhaustiveScan({
      scope: scopeFixture({ member_source_revision_refs: [] }),
      probes: ["needle"],
      sections: [],
    })).code).toBe("EXHAUSTIVE_EMPTY_SCOPE");
  });

  it("freezes a scope from real D1 and plans shards from the frozen row", async () => {
    const { raw, d1 } = openDatabase();
    const scope = scopeFixture({
      member_source_revision_refs: ["rev-1"],
      source_owner_generations: { "rev-1": "owner-gen-1" },
    });
    seedAuthority(raw, scope);
    const ports = createD1ScopePorts(d1, ACCESS, () => CREATED);
    const frozen = await ports.freezeScope({
      raw_query: "needle",
      product: "RESEARCH",
      scope_snapshot: scope,
      literals: ["needle"],
      requested_limit: 10,
      deadline_ms: 1000,
    });
    const plan = planExhaustiveScan({
      scope: frozen,
      probes: ["needle"],
      sections: [
        { section_ref: "sec-1", source_revision_ref: "rev-1", uncompressed_bytes: 1024 },
        { section_ref: "sec-2", source_revision_ref: "rev-1", uncompressed_bytes: 2048 },
      ],
    });
    expect(plan.scope_snapshot.digest).toBe(scope.digest);
    expect(plan.shards).toHaveLength(1);
    expect(plan.shards[0]?.section_object_refs).toEqual(["sec-1", "sec-2"]);
    expect(plan.coverage_denominator_ref).toContain(scope.snapshot_id);
  });
});

describe("Q5 shard execution over pinned bytes", () => {
  it("resolves pinned bytes through the shared Q2 verifier, miss stays a miss", async () => {
    const scope = scopeFixture({
      member_source_revision_refs: ["rev-1"],
      source_owner_generations: { "rev-1": "owner-gen-1" },
    });
    const first = await sectionHarness({
      section_ref: "sec-1", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
      fullText: "alpha needle beta", anchor: { kind: "normalized_byte_range", start: 0, end: 17 }, scope,
    });
    const second = await sectionHarness({
      section_ref: "sec-2", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
      fullText: "nothing here!!", anchor: { kind: "normalized_byte_range", start: 0, end: 14 }, scope,
    });
    const plan = planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [first.descriptor, second.descriptor],
    });
    const outcome = settled(await executeExhaustiveShard({
      shard: plan.shards[0] as ExactScanPlan["shards"][number],
      scope,
      probes: ["needle"],
      reader: readerFor([first, second]),
    }));
    expect(outcome.scanned_sections).toBe(2);
    expect(outcome.matches).toBeGreaterThan(0);
    expect(outcome.section_outcomes).toContainEqual({ section_ref: "sec-1", status: "MATCHED", matches: 1 });
    expect(outcome.section_outcomes).toContainEqual({ section_ref: "sec-2", status: "NO_MATCH", matches: 0 });
    expect(outcome.partial_result_ref).toContain(outcome.shard_id);
  });

  it("treats a transport timeout as unknown outcome, never as a miss", async () => {
    const scope = scopeFixture({
      member_source_revision_refs: ["rev-1"],
      source_owner_generations: { "rev-1": "owner-gen-1" },
    });
    const first = await sectionHarness({
      section_ref: "sec-1", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
      fullText: "alpha needle beta", anchor: { kind: "normalized_byte_range", start: 0, end: 17 }, scope,
    });
    const plan = planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [
        first.descriptor,
        { section_ref: "sec-2", source_revision_ref: "rev-1", uncompressed_bytes: 32 },
      ],
    });
    const reader: ExhaustiveSectionReader = {
      async readSection(section_ref: string) {
        if (section_ref === "sec-1") return first.input;
        const timeout = new Error("R2 range read timed out");
        timeout.name = "TimeoutError";
        (timeout as unknown as { code: string }).code = "TIMEOUT";
        throw timeout;
      },
    };
    const outcome = await executeExhaustiveShard({
      shard: plan.shards[0] as ExactScanPlan["shards"][number],
      scope,
      probes: ["needle"],
      reader,
    });
    expect(outcome.disposition).toBe("UNSETTLED");
    if (outcome.disposition !== "UNSETTLED") throw new Error("expected UNSETTLED");
    expect(outcome.reason_code).toBe("TIMEOUT");
    // The settled section keeps its known outcome; the timed-out section is unknown, not a miss.
    expect(outcome.scanned_sections).toBe(1);
    expect(outcome.section_outcomes).toHaveLength(1);
  });

  it("honours cancellation as unknown outcome", async () => {
    const scope = scopeFixture({
      member_source_revision_refs: ["rev-1"],
      source_owner_generations: { "rev-1": "owner-gen-1" },
    });
    const first = await sectionHarness({
      section_ref: "sec-1", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
      fullText: "alpha needle beta", anchor: { kind: "normalized_byte_range", start: 0, end: 17 }, scope,
    });
    const plan = planExhaustiveScan({
      scope,
      probes: ["needle"],
      sections: [first.descriptor],
    });
    const controller = new AbortController();
    controller.abort();
    const outcome = await executeExhaustiveShard({
      shard: plan.shards[0] as ExactScanPlan["shards"][number],
      scope,
      probes: ["needle"],
      reader: readerFor([first]),
      signal: controller.signal,
    });
    expect(outcome.disposition).toBe("UNSETTLED");
    if (outcome.disposition !== "UNSETTLED") throw new Error("expected UNSETTLED");
    expect(outcome.reason_code).toBe("CANCELLED");
  });
});

describe("Q5 merge earns its coverage claim", () => {
  async function twoShardWorld(): Promise<{ plan: ExactScanPlan; settled: ExhaustiveShardOutcome[] }> {
    const scope = scopeFixture({
      member_source_revision_refs: ["rev-1"],
      source_owner_generations: { "rev-1": "owner-gen-1" },
    });
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
      plan_id: "merge-plan",
      sections: [
        { ...first.descriptor, uncompressed_bytes: big },
        { ...second.descriptor, uncompressed_bytes: big },
      ],
    });
    expect(plan.shards).toHaveLength(2);
    const reader = readerFor([first, second]);
    const settledOutcomes: ExhaustiveShardOutcome[] = [];
    for (const shard of plan.shards) {
      settledOutcomes.push(await executeExhaustiveShard({ shard, scope, probes: ["needle"], reader }));
    }
    return { plan, settled: settledOutcomes };
  }

  it("earns COMPLETE only when every denominator shard settled", async () => {
    const { plan, settled } = await twoShardWorld();
    expect(settled.every((outcome) => outcome.disposition === "SETTLED")).toBe(true);
    const merged = mergeExhaustiveShards({ plan, outcomes: settled });
    expect(merged.coverage_claim).toBe("COMPLETE");
    expect(merged.denominator_shards).toBe(2);
    expect(merged.settled_shards).toBe(2);
    expect(merged.unsettled_shard_ids).toEqual([]);
    expect(merged.total_scanned_sections).toBe(2);
    expect(merged.total_matches).toBe(1);
    expect(merged.coverage_denominator_ref).toBe(plan.coverage_denominator_ref);
    expect(merged.result_artifact_ref).toContain(plan.plan_id);
    expect(merged.coverage_receipt_ref).toContain(plan.plan_id);
  });

  it("degrades honestly when a shard is unsettled without shrinking the denominator", async () => {
    const { plan, settled } = await twoShardWorld();
    const unsettled: ExhaustiveShardOutcome = {
      shard_id: settled[1]?.shard_id as string,
      disposition: "UNSETTLED",
      reason_code: "TIMEOUT",
      scanned_sections: 0,
      matches: 0,
      section_outcomes: [],
    };
    const merged = mergeExhaustiveShards({ plan, outcomes: [settled[0] as ExhaustiveShardOutcome, unsettled] });
    expect(merged.coverage_claim).toBe("SAMPLED");
    expect(merged.denominator_shards).toBe(2);
    expect(merged.settled_shards).toBe(1);
    expect(merged.unsettled_shard_ids).toEqual([settled[1]?.shard_id as string]);
    // Unsettled partials never inflate totals and never read as misses.
    expect(merged.total_scanned_sections).toBe(1);
  });

  it("treats a missing outcome as unknown, never as a miss", async () => {
    const { plan, settled } = await twoShardWorld();
    const merged = mergeExhaustiveShards({ plan, outcomes: [settled[0] as ExhaustiveShardOutcome] });
    expect(merged.coverage_claim).toBe("SAMPLED");
    expect(merged.unsettled_shard_ids).toEqual([settled[1]?.shard_id as string]);
    const empty = mergeExhaustiveShards({ plan, outcomes: [] });
    expect(empty.coverage_claim).toBe("NONE");
    expect(empty.unsettled_shard_ids).toHaveLength(2);
    expect(empty.total_matches).toBe(0);
  });

  it("rejects outcomes outside the denominator and duplicates", async () => {
    const { plan, settled } = await twoShardWorld();
    expect(() => mergeExhaustiveShards({
      plan,
      outcomes: [...settled, {
        shard_id: "exhaustive-shard-foreign:0000",
        disposition: "UNSETTLED",
        reason_code: "TIMEOUT",
        scanned_sections: 0,
        matches: 0,
        section_outcomes: [],
      }],
    })).toThrow(ExhaustiveMergeError);
    expect(() => mergeExhaustiveShards({
      plan,
      outcomes: [settled[0] as ExhaustiveShardOutcome, settled[0] as ExhaustiveShardOutcome],
    })).toThrow(ExhaustiveMergeError);
  });

  it("never reports COMPLETE over a partially settled denominator, even with matches", async () => {
    const { plan, settled } = await twoShardWorld();
    // The settled shard holds the only match; the claim must still degrade.
    expect(settled[0]?.matches).toBe(1);
    const merged = mergeExhaustiveShards({ plan, outcomes: [settled[0] as ExhaustiveShardOutcome] });
    expect(merged.coverage_claim).not.toBe("COMPLETE");
    expect(merged.total_matches).toBe(1);
  });

  it("keeps the unused async plan-error helper honest", async () => {
    const failure = await planError(Promise.reject(new ExhaustivePlanError("EXHAUSTIVE_EMPTY_SCOPE", "empty")));
    expect(failure.code).toBe("EXHAUSTIVE_EMPTY_SCOPE");
  });
});
