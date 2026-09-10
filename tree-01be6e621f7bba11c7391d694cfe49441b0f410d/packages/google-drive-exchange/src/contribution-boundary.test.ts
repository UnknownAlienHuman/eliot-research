import { describe, expect, it } from "vitest";
import type { DriveRequestRow } from "@eliotr/contracts";
import { assembleContribution, parsePayloadPartCells, parseRequestCells } from "./contribution.js";
import { serializeAtomicContribution } from "./serializer.js";

import { exchangeFixture, contributionFixture, payloadFixture } from "./drive-test-fixture.js";

function cells(request = contributionFixture()): unknown[] {
  return serializeAtomicContribution(exchangeFixture(), request, [])[0]?.appendCells.rows[0]?.values
    .map(({ userEnteredValue: value }) => value.stringValue ?? value.numberValue) ?? [];
}

describe("Drive contribution transport guard", () => {
  it("preserves the existing sixteen/five-column atomic wire format and round-trips Unicode", () => {
    expect(parseRequestCells(cells())).toEqual(contributionFixture());
    const request = { ...contributionFixture(), body_encoding: "chunked_utf8" as const, inline_body: "", payload_id: "payload-1", part_count: 1 };
    const batch = serializeAtomicContribution(exchangeFixture(), request, [payloadFixture()]);
    expect(batch.map((item) => item.appendCells.sheetId)).toEqual([1001, 1002]);
    expect(batch.every((item) => item.appendCells.fields === "userEnteredValue")).toBe(true);
    const partCells = batch[1]?.appendCells.rows[0]?.values.map(({ userEnteredValue: value }) => value.stringValue ?? value.numberValue) ?? [];
    expect(assembleContribution(request, [parsePayloadPartCells(partCells)]).body).toBe(payloadFixture().utf8_text);
  });
  it("rejects the packet's six-part and oversize negatives before serialization", () => {
    const part = payloadFixture(); const request = { ...contributionFixture(), body_encoding: "chunked_utf8" as const,
      inline_body: "", payload_id: part.payload_id, part_count: 6 };
    expect(() => serializeAtomicContribution(exchangeFixture(), request,
      Array.from({ length: 6 }, (_, index) => ({ ...part, part_index: index, part_count: 6 })))).toThrow();
    expect(() => serializeAtomicContribution(exchangeFixture(), { ...contributionFixture(), inline_body: "x".repeat(128 * 1024 + 1) }, [])).toThrow();
  });
  it("rejects unknown fields and invalid runtime types even when TS callers assert the DTO", () => {
    expect(() => serializeAtomicContribution(exchangeFixture(), { ...contributionFixture(), granted: true } as DriveRequestRow, [])).toThrow();
    expect(() => serializeAtomicContribution(exchangeFixture(), { ...contributionFixture(), part_count: "0" } as unknown as DriveRequestRow, [])).toThrow();
  });
  it("does not coerce numeric IDs, boolean cells, objects, nulls or count strings into authority fields", () => {
    for (const [index, value] of [[1, 123], [1, { toString: () => "request-1" }], [11, "0"], [11, false], [11, null], [0, null]] as const) {
      const row = cells(); row[index] = value; expect(() => parseRequestCells(row)).toThrow();
    }
    const row = cells(); delete row[11]; expect(() => parseRequestCells(row)).toThrow();
    expect(() => parsePayloadPartCells(["payload-1", "0", 1, "text", "2026-09-05T12:00:00Z"])).toThrow();
  });
  it("rejects mixed encodings, missing payload identity, duplicate indices and silent discarded content", () => {
    const part = payloadFixture();
    expect(() => assembleContribution({ ...contributionFixture(), part_count: 1, payload_id: part.payload_id }, [part])).toThrow();
    expect(() => assembleContribution({ ...contributionFixture(), body_encoding: "chunked_utf8", inline_body: "" }, [])).toThrow();
    expect(() => assembleContribution({ ...contributionFixture(), body_encoding: "chunked_utf8", part_count: 1, payload_id: part.payload_id }, [part])).toThrow();
    expect(() => assembleContribution({ ...contributionFixture(), body_encoding: "chunked_utf8", inline_body: "", part_count: 2,
      payload_id: part.payload_id }, [{ ...part, part_count: 2 }, { ...part, part_count: 2 }])).toThrow();
  });
  it("rejects lone surrogates rather than hashing/replacing corrupt text", () => {
    expect(() => serializeAtomicContribution(exchangeFixture(), { ...contributionFixture(), inline_body: "\ud800" }, [])).toThrow();
    expect(() => parsePayloadPartCells(["payload-1", 0, 1, "\udfff", "2026-09-05T12:00:00Z"])).toThrow();
  });
  it("enforces UTF-8 contribution size and per-cell limits including metadata", () => {
    const part = payloadFixture(); const request = { ...contributionFixture(), body_encoding: "chunked_utf8" as const,
      inline_body: "", payload_id: part.payload_id, part_count: 5 };
    const parts = Array.from({ length: 5 }, (_, index) => ({ ...part, part_count: 5, part_index: index, utf8_text: "x".repeat(26000) }));
    expect(assembleContribution(request, parts).utf8_bytes).toBe(130000);
    expect(() => assembleContribution({ ...request, requested_budget_json: "x".repeat(30000) }, parts)).toThrow();
    expect(() => assembleContribution(request, parts.map((p) => ({ ...p, utf8_text: "ж".repeat(26000) })))).toThrow();
    expect(() => serializeAtomicContribution(exchangeFixture(), { ...contributionFixture(), inline_body: "x".repeat(30001) }, [])).toThrow();
  });
  it("rejects aliased/nonnative sheet IDs and non-active generations", () => {
    const generation = exchangeFixture();
    for (const changed of [{ ...generation, status: "retired" as const }, { ...generation, status: "draining" as const },
      { ...generation, sheet_ids: { ...generation.sheet_ids, payload_parts: generation.sheet_ids.requests } },
      { ...generation, sheet_ids: { ...generation.sheet_ids, requests: 2147483648 } }]) {
      expect(() => serializeAtomicContribution(changed, contributionFixture(), [])).toThrow();
    }
  });
});
