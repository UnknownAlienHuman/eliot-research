import { describe, expect, it } from "vitest";
import { evidenceSha256Bytes, evidenceUtf8Bytes, type CandidateAnchorAuthority,
  type MaterializedEvidenceExcerpt } from "@eliotr/cloudflare-evidence";
import { materializeSavedCitationRange, savedCitationAnchor, savedCitationParentSpan } from "./artifact-saved-citation-range.js";

async function fixture() {
  const text = "prefix · точная цитата · suffix";
  const wholeBytes = evidenceUtf8Bytes(text), quote = evidenceUtf8Bytes("точная цитата");
  const offset = evidenceUtf8Bytes("prefix · ").byteLength;
  const parent: CandidateAnchorAuthority = { anchor: { kind: "normalized_byte_range", start: 100, end: 100 + wholeBytes.byteLength },
    item_key: "parent", projection_generation: "generation", content_sha256: await evidenceSha256Bytes(wholeBytes),
    coordinate_map_ref: `normalized-bytes:100:${100 + wholeBytes.byteLength}` };
  const whole: MaterializedEvidenceExcerpt = { exact_excerpt: text, excerpt_byte_length: wholeBytes.byteLength,
    excerpt_sha256: parent.content_sha256, normalized_object_ref: "normalized", normalized_object_ref_digest: "a".repeat(64),
    source_object_size: wholeBytes.byteLength, source_object_sha256: "b".repeat(64) };
  const saved = { anchor: { kind: "normalized_byte_range" as const, start: 100 + offset, end: 100 + offset + quote.byteLength },
    coordinate_map_ref: parent.coordinate_map_ref, excerpt_sha256: await evidenceSha256Bytes(quote), excerpt_byte_length: quote.byteLength };
  return { parent, whole, saved };
}

describe("saved exact citation subrange", () => {
  it("retains the parent coordinate witness and derives exact UTF-8 quote bytes", async () => {
    const f = await fixture();
    expect(savedCitationParentSpan(f.saved)).toEqual({ start: 100, end: f.parent.anchor.kind === "normalized_byte_range" ? f.parent.anchor.end : 0 });
    expect(savedCitationAnchor(f.parent, f.saved)).toMatchObject({ anchor: f.saved.anchor, content_sha256: f.saved.excerpt_sha256,
      coordinate_map_ref: f.parent.coordinate_map_ref, item_key: f.parent.item_key });
    const excerpt = await materializeSavedCitationRange(f.parent, f.whole, f.saved);
    expect(excerpt).toEqual({ ...f.whole, exact_excerpt: "точная цитата", excerpt_byte_length: f.saved.excerpt_byte_length,
      excerpt_sha256: f.saved.excerpt_sha256 });
  });
  it("keeps exact full-section citations working", async () => {
    const f = await fixture();
    const saved = { ...f.saved, anchor: f.parent.anchor, excerpt_sha256: f.whole.excerpt_sha256, excerpt_byte_length: f.whole.excerpt_byte_length };
    expect(await materializeSavedCitationRange(f.parent, f.whole, saved)).toEqual(f.whole);
  });
  it("rejects a saved range outside its parent", async () => {
    const f = await fixture();
    expect(() => savedCitationParentSpan({ ...f.saved, anchor: { ...f.saved.anchor, start: 99 } })).toThrow();
  });
  it("rejects a different coordinate-map witness", async () => {
    const f = await fixture();
    expect(() => savedCitationAnchor({ ...f.parent, coordinate_map_ref: "normalized-bytes:0:999" }, f.saved)).toThrow();
  });
  it("verifies the parent digest before deriving the leaf", async () => {
    const f = await fixture();
    await expect(materializeSavedCitationRange(f.parent, { ...f.whole, exact_excerpt: f.whole.exact_excerpt.replace("prefix", "PREFIX") }, f.saved))
      .rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_INTEGRITY" });
  });
  it("rejects changed quote digests and byte lengths", async () => {
    const f = await fixture();
    await expect(materializeSavedCitationRange(f.parent, f.whole, { ...f.saved, excerpt_sha256: "0".repeat(64) })).rejects.toThrow();
    expect(() => savedCitationParentSpan({ ...f.saved, excerpt_byte_length: 1 })).toThrow();
  });
  it("rejects a range that splits a UTF-8 code point", async () => {
    const f = await fixture();
    const saved = { ...f.saved, anchor: { ...f.saved.anchor, start: f.saved.anchor.start + 1 }, excerpt_byte_length: f.saved.excerpt_byte_length - 1 };
    await expect(materializeSavedCitationRange(f.parent, f.whole, saved)).rejects.toMatchObject({ code: "ARTIFACT_DRAFT_READ_INTEGRITY" });
  });
});
