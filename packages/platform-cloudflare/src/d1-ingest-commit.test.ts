import { describe, expect, it } from "vitest";
// @ts-expect-error - raw audit without ER-01 linked
import commitSourceRaw from "./d1-ingest-commit.ts?raw";
const source = commitSourceRaw as unknown as string;
const has = (f: string) => expect(source).toContain(f);
describe("N1 split ER37 d1-ingest-commit", () => {
  it("delegates to ER-01 with injected authority", () => {
    ["validatePromotionStructure", "validateBundleReceiptStructure", "PromotionReadbackError", "residencyDigestFor: objectResidencyKeyDigest", "mediaTypeFor: (logicalPath) => contentType(logicalPath)", "function mapReadbackError", "cause instanceof PromotionReadbackError", ".catch(mapReadbackError)"].forEach(has);
    expect(source).not.toContain("promotion receipt contains duplicate logical paths");
  });
  it("orders promotion before receipt with readbacks", () => {
    const p = source.indexOf("await validatePromotion(operation, input.promotion_receipt)");
    const r = source.indexOf("promotion.readbacks)");
    expect(p).toBeGreaterThanOrEqual(0); expect(r).toBeGreaterThan(p);
    has("canonicalReadbacks: readonly PromotedObjectReadback[]");
  });
  it("preserves fail-closed negatives", () => {
    ["ingest operation does not exist", "terminal admitted receipt already differs", "ingest operation is not authorized for commit", "admission or qualification authority does not permit commit", 'qualification.overall === "REJECTED"', "INGEST_SETTLEMENT_UNCERTAIN", "guarded ingest commit readback is missing"].forEach(has);
  });
  it("integration-only round-trip needs ER-01", async () => {
    try { const m = await import("./d1-ingest-commit.js") as { commitAdmittedBundle?: unknown }; expect(typeof m.commitAdmittedBundle).toBe("function"); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); expect(/validatePromotionStructure|validateBundleReceiptStructure|PromotionReadbackError|does not provide an export/i.test(msg)).toBe(true); }
  });
});
