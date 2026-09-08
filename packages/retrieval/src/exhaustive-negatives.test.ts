import { describe, expect, it } from "vitest";
import type { EvidenceHandle, ScopeSnapshot } from "@eliotr/contracts";
import {
  executeExhaustiveShard,
  planExhaustiveScan,
  type ExactScanPlan,
  type ExhaustiveShardOutcome,
} from "./exhaustive.js";
import type { PinnedSourceAuthority, VerifyPinnedExactInput } from "./evidence-resolver.js";
import {
  readerFor,
  scopeFixture,
  sectionHarness,
  settled,
} from "./exhaustive-harness.js";

async function runNegative(options: {
  fullText: string;
  anchor: EvidenceHandle["anchor"];
  scopeOverrides?: Partial<ScopeSnapshot>;
  sourceOverrides?: Partial<PinnedSourceAuthority>;
  coordinate_map?: VerifyPinnedExactInput["coordinate_map"] | undefined;
  revoked_mid_read?: boolean | undefined;
  forgedHandle?: boolean | undefined;
}): Promise<ExhaustiveShardOutcome> {
  const scope = scopeFixture({
    member_source_revision_refs: ["rev-1"],
    source_owner_generations: { "rev-1": "owner-gen-1" },
    ...(options.scopeOverrides ?? {}),
  });
  const harness = await sectionHarness({
    section_ref: "sec-1",
    source_revision_ref: "rev-1",
    source_owner_generation: "owner-gen-1",
    fullText: options.fullText,
    anchor: options.anchor,
    scope,
    ...(options.coordinate_map !== undefined ? { coordinate_map: options.coordinate_map } : {}),
    ...(options.revoked_mid_read !== undefined ? { revoked_mid_read: options.revoked_mid_read } : {}),
    ...(options.forgedHandle !== undefined ? { forgedHandle: options.forgedHandle } : {}),
  });
  const input = options.sourceOverrides === undefined
    ? harness.input
    : { ...harness.input, source: { ...harness.input.source, ...options.sourceOverrides } };
  const plan = planExhaustiveScan({ scope, probes: ["needle"], sections: [harness.descriptor] });
  return executeExhaustiveShard({
    shard: plan.shards[0] as ExactScanPlan["shards"][number],
    scope,
    probes: ["needle"],
    reader: { readSection: () => Promise.resolve(input) },
  });
}

describe("Q5 named negatives settle fail-closed with the denominator intact", () => {
  it("unicode: Cyrillic/emoji lines resolve with UTF-8 byte offsets", async () => {
    const text = "﻿Привет\r\n😀 needle\r\nlast";
    const scope = scopeFixture({
      member_source_revision_refs: ["rev-1"],
      source_owner_generations: { "rev-1": "owner-gen-1" },
    });
    const harness = await sectionHarness({
      section_ref: "sec-1", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
      fullText: text, anchor: { kind: "normalized_line_range", start_line: 1, end_line: 2 }, scope,
    });
    const plan = planExhaustiveScan({ scope, probes: ["needle"], sections: [harness.descriptor] });
    const outcome = settled(await executeExhaustiveShard({
      shard: plan.shards[0] as ExactScanPlan["shards"][number],
      scope,
      probes: ["needle"],
      reader: readerFor([harness]),
    }));
    expect(outcome.section_outcomes).toHaveLength(1);
    expect(outcome.section_outcomes[0]?.status).toBe("MATCHED");
  });

  it("table-cell: admitted map resolves, missing map narrows, corrupt map fails closed", async () => {
    const fullText = "cell-A|needle-B";
    const good = await runNegative({
      fullText,
      anchor: { kind: "table_cell", table_id: "table-1", row: 0, column: 1 },
      coordinate_map: { map_ref: "map-1", entries: { "table:table-1:0:1": { start: 7, end: 15 } } },
    });
    const settledGood = settled(good);
    expect(settledGood.section_outcomes[0]?.status).toBe("MATCHED");
    const missing = settled(await runNegative({
      fullText,
      anchor: { kind: "table_cell", table_id: "table-1", row: 0, column: 1 },
      coordinate_map: null,
    }));
    expect(missing.section_outcomes[0]).toMatchObject({
      status: "FAILED_CLOSED",
      failure_code: "EXACT_COORDINATE_MAP_MISSING",
    });
    const corrupt = settled(await runNegative({
      fullText,
      anchor: { kind: "table_cell", table_id: "table-1", row: 0, column: 1 },
      coordinate_map: { map_ref: "map-1", entries: { "table:table-1:0:1": { start: 0, end: 10_000_000 } } },
    }));
    expect(corrupt.section_outcomes[0]?.status).toBe("FAILED_CLOSED");
    expect(corrupt.section_outcomes[0]?.failure_code).toMatch(/EXACT_(RANGE_INVALID|COORDINATE_MAP_CORRUPT)/u);
  });

  it("old-revision: an advanced head rejects the pinned handle, never follows it", async () => {
    const outcome = settled(await runNegative({
      fullText: "head one!!",
      anchor: { kind: "normalized_byte_range", start: 0, end: 10 },
      sourceOverrides: { source_revision_ref: "revision-2" },
    }));
    expect(outcome.section_outcomes[0]).toMatchObject({
      status: "FAILED_CLOSED",
      failure_code: "EXACT_REVISION_MISMATCH",
    });
  });

  it("range-mismatch: an anchor beyond the admitted object fails closed", async () => {
    const outcome = settled(await runNegative({
      fullText: "0123456789",
      anchor: { kind: "normalized_byte_range", start: 0, end: 999 },
    }));
    expect(outcome.section_outcomes[0]).toMatchObject({
      status: "FAILED_CLOSED",
      failure_code: "EXACT_RANGE_INVALID",
    });
  });

  it("forged-handle: strict contract validation rejects before pinned bytes matter", async () => {
    const outcome = settled(await runNegative({
      fullText: "alpha needle",
      anchor: { kind: "normalized_byte_range", start: 0, end: 12 },
      forgedHandle: true,
    }));
    expect(outcome.section_outcomes[0]).toMatchObject({
      status: "FAILED_CLOSED",
      failure_code: "EXACT_FORGED_HANDLE",
    });
  });

  it("revocation: mid-read revocation fails closed with no bytes returned", async () => {
    const outcome = settled(await runNegative({
      fullText: "alpha needle",
      anchor: { kind: "normalized_byte_range", start: 0, end: 12 },
      revoked_mid_read: true,
    }));
    expect(outcome.section_outcomes[0]).toMatchObject({
      status: "FAILED_CLOSED",
      failure_code: "EXACT_REVOKED_MID_READ",
    });
  });

  it("corrupt-map entry for a byte anchor fails closed via the admitted map", async () => {
    const outcome = settled(await runNegative({
      fullText: "cell-A|cell-B",
      anchor: { kind: "table_cell", table_id: "table-1", row: 0, column: 9 },
      coordinate_map: { map_ref: "map-1", entries: {} },
    }));
    expect(outcome.section_outcomes[0]).toMatchObject({
      status: "FAILED_CLOSED",
      failure_code: "EXACT_COORDINATE_MAP_CORRUPT",
    });
  });

  it("mid-resolution byte mutation refuses through the shard path, never substitutes", async () => {
    const scope = scopeFixture({
      member_source_revision_refs: ["rev-1"],
      source_owner_generations: { "rev-1": "owner-gen-1" },
    });
    const harness = await sectionHarness({
      section_ref: "sec-1", source_revision_ref: "rev-1", source_owner_generation: "owner-gen-1",
      fullText: "pinned revision alpha", anchor: { kind: "normalized_byte_range", start: 0, end: 21 }, scope,
    });
    const tampered = new TextEncoder().encode("current bytes BETA!!!!");
    const plan = planExhaustiveScan({ scope, probes: ["alpha"], sections: [harness.descriptor] });
    const outcome = settled(await executeExhaustiveShard({
      shard: plan.shards[0] as ExactScanPlan["shards"][number],
      scope,
      probes: ["alpha"],
      reader: {
        readSection: () => Promise.resolve({ ...harness.input, pinned_object_bytes: tampered }),
      },
    }));
    expect(outcome.section_outcomes[0]).toMatchObject({
      status: "FAILED_CLOSED",
      failure_code: "EXACT_CURRENT_BYTE_SUBSTITUTION",
    });
  });
});
