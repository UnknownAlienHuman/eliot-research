import { describe, expect, it } from "vitest";
import { createAiSearchScopeFilter } from "../packages/platform-cloudflare/src/ai-search-scope-filter.js";

const GENERATION = "g2-qwen3-2026-09-03";

describe("bounded native AI Search scope filters", () => {
  it("uses existing scalar metadata, sorts a copy, and freezes the complete filter", () => {
    const members = ["source-b", "source-a"];
    const filter = createAiSearchScopeFilter(members, GENERATION);
    expect(filter).toEqual({ source_revision_ref: { $in: ["source-a", "source-b"] }, projection_generation: GENERATION });
    expect(members).toEqual(["source-b", "source-a"]);
    expect(Object.isFrozen(filter)).toBe(true);
    expect(Object.isFrozen(filter.source_revision_ref)).toBe(true);
    expect(Object.isFrozen(filter.source_revision_ref.$in)).toBe(true);
    members.push("later-source");
    expect(filter.source_revision_ref.$in).toEqual(["source-a", "source-b"]);
  });

  it("represents empty membership without an omitted predicate or wildcard", () => {
    expect(createAiSearchScopeFilter([], GENERATION).source_revision_ref).toEqual({ $in: [] });
  });

  it("accepts 64-byte identities without truncation and rejects 65-byte identities", () => {
    expect(createAiSearchScopeFilter(["s".repeat(64)], "g".repeat(64)).source_revision_ref.$in).toEqual(["s".repeat(64)]);
    expect(() => createAiSearchScopeFilter(["s".repeat(65)], GENERATION)).toThrow(RangeError);
    expect(() => createAiSearchScopeFilter(["source-a"], "g".repeat(65))).toThrow(RangeError);
  });

  it("rejects unsupported identifier characters and duplicate revisions", () => {
    expect(() => createAiSearchScopeFilter(["source a"], GENERATION)).toThrow(RangeError);
    expect(() => createAiSearchScopeFilter(["source-🐧"], GENERATION)).toThrow(RangeError);
    expect(() => createAiSearchScopeFilter(["source-a\\"], GENERATION)).toThrow(RangeError);
    expect(() => createAiSearchScopeFilter(["source-a", "source-a"], GENERATION)).toThrow(/duplicate/u);
  });

  it("enforces 2047/2048 compact JSON bytes on the entire filter", () => {
    const members = Array.from({ length: 29 }, (_, i) => `s${String(i).padStart(2, "0")}${"a".repeat(61)}`);
    const used = JSON.stringify(createAiSearchScopeFilter(members, "g")).length;
    const tailBytes = 2047 - used - 3;
    expect(tailBytes).toBeGreaterThan(0);
    expect(tailBytes).toBeLessThan(64);
    const boundary = [...members, "z".repeat(tailBytes)];
    expect(new TextEncoder().encode(JSON.stringify(createAiSearchScopeFilter(boundary, "g"))).byteLength).toBe(2047);
    expect(() => createAiSearchScopeFilter([...members, "z".repeat(tailBytes + 1)], "g")).toThrow(/2048/u);
  });
});
